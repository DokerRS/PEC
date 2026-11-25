import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getGeofilesDir, readGeofile, getGeofileName, getRoutingPresets } from "../src/storage.js";
import { materializePresetSources } from "../src/routing.js";
import { createRoutingRouter } from "../src/routes/routingRoutes.js";
import { withHttpServer } from "./helpers/http-server.js";
import type { PresetSource, RoutingPresetItem } from "../src/types.js";

/**
 * GEO-BUILDER-UX-3: content-addressed geofile storage + live file layers.
 * Covers: sha256 dedup on upload, availableTags endpoints, live layer
 * re-parse on tag change, legacy snapshot fallback, and export round-trip
 * degradation rules.
 */

// Minimal valid geosite protobuf buffer with two tags (same encoder approach
// as presetsApi.test.ts).
function encodeVarint(val: number): Buffer {
  const bytes: number[] = [];
  let current = val;
  while (current > 0x7f) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current & 0x7f);
  return Buffer.from(bytes);
}

function encodeLengthDelimited(fieldNum: number, data: Buffer): Buffer {
  const tag = (fieldNum << 3) | 2;
  return Buffer.concat([encodeVarint(tag), encodeVarint(data.length), data]);
}

function makeMockGeoSiteBuffer(tag: string, domains: string[]): Buffer {
  const domainBuffers = domains.map((d) =>
    Buffer.concat([
      encodeVarint((1 << 3) | 0),
      encodeVarint(0),
      encodeLengthDelimited(2, Buffer.from(d, "utf-8")),
    ])
  );
  const siteBuffer = Buffer.concat([
    encodeLengthDelimited(1, Buffer.from(tag, "utf-8")),
    ...domainBuffers.map((db) => encodeLengthDelimited(2, db)),
  ]);
  return Buffer.concat([encodeLengthDelimited(1, siteBuffer)]);
}

test.describe("Geofiles storage & live file layers", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir: string;
  let app: express.Express;
  let server: Server;
  let baseUrl: string;

  test.beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `pec-test-geofiles-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.DATA_DIR = tempDir;
    delete process.env.ROUTING_PRESETS_PATH;
    delete process.env.GEOFILES_DIR;

    app = express();
    app.use(express.json({ limit: "50mb" }));
    app.use(createRoutingRouter());

    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  test.afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function importFileContent(content: Buffer, tag?: string) {
    return fetch(`${baseUrl}/api/routing/presets/import-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "geosite test.dat",
        content: content.toString("base64"),
        ...(tag ? { tag } : {}),
        name: "Geofile Preset",
      }),
    });
  }

  test("import-file stores the upload content-addressed (sha256) and returns fileId/availableTags", async () => {
    const buf = makeMockGeoSiteBuffer("TELEGRAM", ["t.me", "telegram.org"]);
    const res = await importFileContent(buf, "TELEGRAM");
    assert.equal(res.status, 200);
    const data = await res.json();

    const expectedHash = crypto.createHash("sha256").update(buf).digest("hex");
    assert.equal(data.fileId, expectedHash, "fileId must be the sha256 of the content");
    // response fileName is the ORIGINAL upload name (display source name);
    // the STORED file is content-addressed: data/geofiles/<sha256>.dat
    assert.equal(data.fileName, "geosite test.dat");
    assert.equal(getGeofileName(expectedHash), `${expectedHash}.dat`);
    assert.ok(Array.isArray(data.availableTags));
    const tg = data.availableTags.find((t: any) => t.tag === "TELEGRAM");
    assert.ok(tg, "availableTags must list TELEGRAM");
    assert.equal(tg.count, 2, "per-tag entry counts must be reported");

    // the file physically lives in data/geofiles/<sha256>.dat
    const storedPath = path.join(getGeofilesDir(), `${expectedHash}.dat`);
    assert.equal(fs.existsSync(storedPath), true);
    assert.equal(readGeofile(expectedHash)!.equals(buf), true);

    // the created preset carries a LIVE file layer
    const layer = data.preset.sources[0];
    assert.equal(layer.kind, "file");
    assert.equal(layer.fileId, expectedHash);
    assert.equal(layer.fileName, "geosite test.dat");
    assert.deepEqual(layer.tags, ["TELEGRAM"]);
  });

  test("re-uploading identical content dedupes into the same fileId", async () => {
    const buf = makeMockGeoSiteBuffer("NEWS", ["bbc.co.uk"]);
    const res1 = await importFileContent(buf, "NEWS");
    const res2 = await importFileContent(buf, "NEWS");
    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);
    const d1 = await res1.json();
    const d2 = await res2.json();
    assert.equal(d1.fileId, d2.fileId, "identical content must dedupe to one fileId");
    assert.equal(d2.deduped, true, "second upload must be reported as deduped");
    const files = fs.readdirSync(getGeofilesDir()).filter((f) => f.startsWith(d1.fileId));
    assert.equal(files.length, 1, "exactly one stored file per content hash");
  });

  test("GET /api/routing/geofiles/:fileId/tags lists tags with counts; 404 on unknown id", async () => {
    const buf = makeMockGeoSiteBuffer("YOUTUBE", ["youtube.com", "googlevideo.com"]);
    const imported = await importFileContent(buf, "YOUTUBE");
    const { fileId } = await imported.json();

    const res = await fetch(`${baseUrl}/api/routing/geofiles/${fileId}/tags`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.fileId, fileId);
    const yt = data.availableTags.find((t: any) => t.tag === "YOUTUBE");
    assert.ok(yt && yt.count === 2);

    const unknown = await fetch(`${baseUrl}/api/routing/geofiles/${"a".repeat(64)}/tags`);
    assert.equal(unknown.status, 404);
    const malformed = await fetch(`${baseUrl}/api/routing/geofiles/../etc/tags`);
    assert.ok([400, 404].includes(malformed.status), "malformed ids must not pass");
  });

  test("live file layer re-materializes from the stored geofile when tags change", async () => {
    const buf = Buffer.concat([
      makeMockGeoSiteBuffer("TELEGRAM", ["t.me"]),
      makeMockGeoSiteBuffer("NEWS", ["bbc.co.uk", "cnn.com"]),
    ]);
    const imported = await importFileContent(buf, "TELEGRAM");
    const importedData = await imported.json();
    const fileId = importedData.fileId;

    // upsert a preset holding a LIVE file layer with tags=[TELEGRAM]
    const created = await fetch(`${baseUrl}/api/routing/presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "preset:live_file",
        name: "Live File Preset",
        type: "domain",
        sources: [{ kind: "file", fileId, fileName: "geosite test.dat", tags: ["TELEGRAM"] }],
      }),
    });
    assert.equal(created.status, 200);
    const createdData = await created.json();
    assert.deepEqual(createdData.preset.entries, ["t.me"], "materialization re-parses the file by tags");

    // switch tags to NEWS -> the layer rebuilds from the SAME stored file
    const updated = await fetch(`${baseUrl}/api/routing/presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "preset:live_file",
        name: "Live File Preset",
        sources: [{ kind: "file", fileId, fileName: "geosite test.dat", tags: ["NEWS"] }],
      }),
    });
    assert.equal(updated.status, 200);
    const updatedData = await updated.json();
    assert.deepEqual(updatedData.preset.entries.sort(), ["bbc.co.uk", "cnn.com"], "tag change must rebuild the layer");
    // the persisted layer keeps the snapshot in sync for export round-trips
    assert.deepEqual(updatedData.preset.sources[0].tags, ["NEWS"]);
    assert.deepEqual(updatedData.preset.sources[0].entries.sort(), ["bbc.co.uk", "cnn.com"]);

    // resolve-layer fileId mode also re-parses (the ✎-editor save path)
    const resolved = await fetch(`${baseUrl}/api/routing/presets/resolve-layer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: { kind: "file", fileId, tags: ["TELEGRAM"] }, type: "domain" }),
    });
    assert.equal(resolved.status, 200);
    const resolvedData = await resolved.json();
    assert.deepEqual(resolvedData.source.entries, ["t.me"]);
    assert.ok(resolvedData.availableTags.some((t: any) => t.tag === "NEWS"));
  });

  test("legacy snapshot layer (no fileId) materializes from its entries fallback", () => {
    const sources: PresetSource[] = [
      { kind: "file", name: "old-import.dat", tag: "RU", entries: ["legacy-a.example", "legacy-b.example"] },
    ];
    assert.deepEqual(materializePresetSources(sources, []), ["legacy-a.example", "legacy-b.example"]);

    // a live layer pointing at a MISSING file (import on another server)
    // degrades to its entries snapshot
    const foreign: PresetSource[] = [
      { kind: "file", fileId: "f".repeat(64), fileName: "foreign.dat", tags: ["RU"], entries: ["snap.example"] },
    ];
    assert.deepEqual(materializePresetSources(foreign, []), ["snap.example"]);
  });

  test("export carries the entries snapshot + degradation note; import-preset accepts fileId layers", async () => {
    const buf = makeMockGeoSiteBuffer("TELEGRAM", ["t.me", "telegram.org"]);
    const imported = await importFileContent(buf, "TELEGRAM");
    const { fileId, preset } = await (await imported.json()) as any;

    const exportRes = await fetch(`${baseUrl}/api/routing/presets/${encodeURIComponent(preset.id)}/export`);
    assert.equal(exportRes.status, 200);
    const payload = await exportRes.json();
    assert.equal(payload.version, 2);
    assert.match(payload.note, /snapshot/);
    const fileLayer = payload.preset.sources[0];
    assert.equal(fileLayer.fileId, fileId);
    assert.ok(Array.isArray(fileLayer.entries) && fileLayer.entries.length === 2, "snapshot entries must be inlined for export");

    // import into the same server: layer re-binds live by fileId
    const reimport = await fetch(`${baseUrl}/api/routing/presets/import-preset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(reimport.status, 200);
    const reimportData = await reimport.json();
    const reLayer = reimportData.preset.sources[0];
    assert.equal(reLayer.fileId, fileId, "content-addressed re-bind on the same server");
    assert.deepEqual(reLayer.entries, ["t.me", "telegram.org"]);
    assert.equal(reimportData.preset.entriesCount, 2);

    // unknown preset 404 on export
    const missing = await fetch(`${baseUrl}/api/routing/presets/preset%3Amissing/export`);
    assert.equal(missing.status, 404);
  });

  test("getRoutingPresets still serves presets whose file layer materializes via the PAC path", async () => {
    const buf = makeMockGeoSiteBuffer("RU", ["pac-live.example"]);
    const imported = await importFileContent(buf, "RU");
    const { fileId } = await imported.json();

    const created = await fetch(`${baseUrl}/api/routing/presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "preset:pac_geofile",
        name: "PAC Geofile",
        type: "domain",
        sources: [{ kind: "file", fileId, fileName: "geosite test.dat", tags: ["RU"] }],
      }),
    });
    assert.equal(created.status, 200);

    const stored = getRoutingPresets().find((p) => p.id === "preset:pac_geofile") as RoutingPresetItem;
    assert.ok(stored);
    const entries = materializePresetSources(stored.sources, []);
    assert.deepEqual(entries, ["pac-live.example"]);
  });
});
