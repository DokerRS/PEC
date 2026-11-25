import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  getRoutingPresets,
  getRoutingPresetsPath,
  saveRoutingPresets,
  clearRoutingPresetsCache,
} from "../src/storage.js";
import {
  expandRuleDomains,
  generatePacScript,
  materializePresetSources,
  isWithinPresetEntryLimit,
  MAX_ROUTING_PRESET_ENTRIES,
  GEO_PRESETS,
} from "../src/routing.js";
import { createRoutingRouter } from "../src/routes/routingRoutes.js";
import { withHttpServer } from "./helpers/http-server.js";
import type { PresetSource, RoutingPresetItem, RoutingRule, RoutingProfile, ProxyConfiguration } from "../src/types.js";

/**
 * GEO-PRESET-UX-2: layered preset model (sources[]).
 * Covers: legacy migration (3 inference branches + idempotency + backup),
 * materialization union/dedup/limit, POST sources shape validation,
 * refresh-scopes-url-layers-only (the RED case of the old whole-replace
 * refresh), and export/import-preset round-trips.
 */

function makeTempPresetsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pec-sources-"));
  return path.join(dir, "routing_presets.json");
}

function writeLegacyPresetsFile(filePath: string, items: any[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(items, null, 2), "utf-8");
}

test.describe("materializePresetSources (single materialization function)", () => {
  test("unions layers in order and dedups across layers (first contributor wins)", () => {
    const sources: PresetSource[] = [
      { kind: "file", name: "a.txt", entries: ["alpha.com", "shared.com"] },
      { kind: "manual", entries: ["shared.com", "beta.org"] },
    ];
    assert.deepEqual(materializePresetSources(sources, []), ["alpha.com", "shared.com", "beta.org"]);
  });

  test("geo-tag layers resolve live from GEO_PRESETS", () => {
    const ai = GEO_PRESETS.find((p) => p.id === "preset:ai_services");
    assert.ok(ai);
    const sources: PresetSource[] = [{ kind: "geo-tag", ref: "preset:ai_services" }];
    assert.deepEqual(materializePresetSources(sources, []), ai.domains);
    // unknown ref -> empty contribution (no crash)
    assert.deepEqual(materializePresetSources([{ kind: "geo-tag", ref: "preset:missing" }], []), []);
  });

  test("empty/absent sources fall back to the flat entries projection", () => {
    assert.deepEqual(materializePresetSources(undefined, ["a.com"]), ["a.com"]);
    assert.deepEqual(materializePresetSources([], ["a.com"]), ["a.com"]);
    assert.deepEqual(materializePresetSources([], []), []);
  });

  test("materialized union is hard-capped at MAX_ROUTING_PRESET_ENTRIES", () => {
    assert.equal(isWithinPresetEntryLimit(MAX_ROUTING_PRESET_ENTRIES), true);
    assert.equal(isWithinPresetEntryLimit(MAX_ROUTING_PRESET_ENTRIES + 1), false);
    assert.equal(MAX_ROUTING_PRESET_ENTRIES, 500_000);

    const big: string[] = [];
    for (let i = 0; i < 300_000; i++) big.push(`domain-${i}.example`);
    const big2: string[] = [];
    for (let i = 200_000; i < 500_000; i++) big2.push(`domain-${i}.example`);
    const union = materializePresetSources(
      [
        { kind: "manual", entries: big },
        { kind: "manual", entries: big2 },
      ],
      []
    );
    assert.equal(union.length, MAX_ROUTING_PRESET_ENTRIES, "union must be capped at 500k");
  });
});

test.describe("legacy flat -> sources migration (3 inference branches)", () => {
  test("branch 1: sourceUrl -> url layer (with tag); branch 2: only sourceTag -> file layer; branch 3: neither -> manual layer", () => {
    const filePath = makeTempPresetsPath();
    process.env.ROUTING_PRESETS_PATH = filePath;
    clearRoutingPresetsCache();

    writeLegacyPresetsFile(filePath, [
      {
        id: "legacy:remote",
        name: "Legacy Remote",
        category: "custom",
        description: "",
        type: "domain",
        source: "remote",
        sourceUrl: "https://example.com/list.txt",
        sourceTag: "RU",
        entries: ["legacy-remote.com"],
        domains: ["legacy-remote.com"],
      },
      {
        id: "legacy:file",
        name: "Legacy File",
        category: "custom",
        description: "",
        type: "domain",
        source: "file",
        sourceTag: "NEWS",
        entries: ["legacy-file.com"],
        domains: ["legacy-file.com"],
      },
      {
        id: "legacy:manual",
        name: "Legacy Handmade",
        category: "custom",
        description: "",
        type: "domain",
        source: "file",
        entries: ["handmade.com", "handmade.com"],
        domains: ["handmade.com"],
      },
    ]);

    try {
      const loaded = getRoutingPresets();
      const remote = loaded.find((p) => p.id === "legacy:remote") as any;
      const file = loaded.find((p) => p.id === "legacy:file") as any;
      const manual = loaded.find((p) => p.id === "legacy:manual") as any;

      assert.ok(remote && Array.isArray(remote.sources) && remote.sources.length === 1);
      assert.equal(remote.sources[0].kind, "url");
      assert.equal(remote.sources[0].url, "https://example.com/list.txt");
      assert.equal(remote.sources[0].tag, "RU");
      assert.deepEqual(remote.sources[0].entries, ["legacy-remote.com"]);

      assert.ok(file && Array.isArray(file.sources) && file.sources.length === 1);
      assert.equal(file.sources[0].kind, "file");
      assert.equal(file.sources[0].tag, "NEWS");
      assert.deepEqual(file.sources[0].entries, ["legacy-file.com"]);

      assert.ok(manual && Array.isArray(manual.sources) && manual.sources.length === 1);
      assert.equal(manual.sources[0].kind, "manual");
      // migration wraps the RAW flat snapshot (no silent dedup); the union
      // projection is deduped by the single materialization function instead.
      assert.deepEqual(manual.sources[0].entries, ["handmade.com", "handmade.com"]);
      assert.deepEqual(manual.entries, ["handmade.com", "handmade.com"]);

      // flat projection stays byte-identical after migration
      assert.deepEqual(remote.entries, ["legacy-remote.com"]);
      assert.equal(remote.sourceUrl, "https://example.com/list.txt");
    } finally {
      clearRoutingPresetsCache();
      delete process.env.ROUTING_PRESETS_PATH;
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  test("migration is idempotent and leaves a backup copy of the legacy file", () => {
    const filePath = makeTempPresetsPath();
    process.env.ROUTING_PRESETS_PATH = filePath;
    clearRoutingPresetsCache();

    writeLegacyPresetsFile(filePath, [
      {
        id: "legacy:one",
        name: "Legacy One",
        category: "custom",
        description: "",
        type: "domain",
        source: "file",
        entries: ["one.com"],
        domains: ["one.com"],
      },
    ]);

    try {
      const first = getRoutingPresets();
      assert.equal(fs.existsSync(filePath), true);
      const backups = fs.readdirSync(path.dirname(filePath)).filter((f) => f.includes("backup-"));
      assert.equal(backups.length, 1, "exactly one backup copy must be created");
      const backupContent = JSON.parse(fs.readFileSync(path.join(path.dirname(filePath), backups[0]), "utf-8"));
      assert.equal(backupContent[0].sources, undefined, "backup must hold the legacy flat shape");

      // second read: no additional backup, sources preserved as-is
      const second = getRoutingPresets();
      const backupsAfter = fs.readdirSync(path.dirname(filePath)).filter((f) => f.includes("backup-"));
      assert.equal(backupsAfter.length, 1, "migration must not re-run for already-migrated items");
      assert.deepEqual((second[0] as any).sources, (first[0] as any).sources);
      assert.equal(second.length, 1);
    } finally {
      clearRoutingPresetsCache();
      delete process.env.ROUTING_PRESETS_PATH;
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });
});

test.describe("Presets API: layered sources contract", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir: string;
  let app: express.Express;
  let server: Server;
  let baseUrl: string;

  test.beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `pec-test-sources-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.DATA_DIR = tempDir;
    delete process.env.ROUTING_PRESETS_PATH;
    clearRoutingPresetsCache();

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
    clearRoutingPresetsCache();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function postPreset(body: any): Promise<{ status: number; data: any }> {
    const res = await fetch(`${baseUrl}/api/routing/presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  }

  test("POST accepts sources[] and GET returns sources + flat materialized entries + entriesCount", async () => {
    const created = await postPreset({
      id: "preset:layered",
      name: "Layered Preset",
      type: "domain",
      sources: [
        { kind: "manual", entries: ["one.com", "dup.com"] },
        { kind: "file", name: "b.txt", entries: ["dup.com", "two.com"] },
        { kind: "geo-tag", ref: "preset:ai_services" },
      ],
    });
    assert.equal(created.status, 200);
    assert.equal(created.data.ok, true);
    assert.equal(created.data.preset.sources.length, 3);
    assert.ok(created.data.preset.entries.includes("one.com"));
    assert.ok(created.data.preset.entries.includes("two.com"));
    assert.ok(created.data.preset.entries.includes("openai.com"), "geo-tag layer materializes live");
    // dedup across layers
    assert.equal(created.data.preset.entries.filter((e: string) => e === "dup.com").length, 1);

    const res = await fetch(`${baseUrl}/api/routing/presets/preset:layered`);
    const data = await res.json();
    assert.equal(data.entriesCount, data.entries.length);
    assert.equal(data.sources.length, 3);
    // geo-tag entries are inlined for the UI round-trip
    const geoLayer = data.sources.find((s: any) => s.kind === "geo-tag");
    assert.ok(Array.isArray(geoLayer.entries) && geoLayer.entries.includes("openai.com"));

    const listRes = await fetch(`${baseUrl}/api/routing/presets`);
    const list = await listRes.json();
    const listed = list.find((p: any) => p.id === "preset:layered");
    assert.ok(listed);
    assert.equal(listed.entriesCount, data.entriesCount);
    assert.ok(Array.isArray(listed.sources));
  });

  test("POST sources shape validation: bad kind, unknown geo-tag ref, missing entries -> 400", async () => {
    const badKind = await postPreset({
      id: "preset:badkind",
      name: "Bad Kind",
      sources: [{ kind: "database", ref: "x" }],
    });
    assert.equal(badKind.status, 400);
    assert.match(badKind.data.error, /kind/);

    const badRef = await postPreset({
      id: "preset:badref",
      name: "Bad Ref",
      sources: [{ kind: "geo-tag", ref: "preset:does_not_exist" }],
    });
    assert.equal(badRef.status, 400);
    assert.match(badRef.data.error, /geo-tag/);

    const noEntries = await postPreset({
      id: "preset:noentries",
      name: "No Entries",
      sources: [{ kind: "manual", entries: [] }],
    });
    assert.equal(noEntries.status, 400);

    const emptySources = await postPreset({
      id: "preset:emptysources",
      name: "Empty Sources",
      sources: [],
    });
    assert.equal(emptySources.status, 400);
  });

  test("type isolation: geoip/CIDR layers cannot land in domain presets and vice versa", async () => {
    const geoipInDomain = await postPreset({
      id: "preset:geoip_domain",
      name: "GeoIP in domain",
      type: "domain",
      sources: [{ kind: "geo-tag", ref: "preset:corporate_internal" }],
    });
    assert.equal(geoipInDomain.status, 400);
    assert.match(geoipInDomain.data.error, /geoip|CIDR/);

    const cidrInDomain = await postPreset({
      id: "preset:cidr_domain",
      name: "CIDR in domain",
      type: "domain",
      sources: [{ kind: "manual", entries: ["10.0.0.0/8"] }],
    });
    assert.equal(cidrInDomain.status, 400);

    const domainInCidr = await postPreset({
      id: "preset:domain_cidr",
      name: "Domain in cidr",
      type: "cidr",
      sources: [{ kind: "manual", entries: ["example.com"] }],
    });
    assert.equal(domainInCidr.status, 400);

    // matching combination is accepted
    const okCidr = await postPreset({
      id: "preset:ok_cidr",
      name: "OK cidr",
      type: "cidr",
      sources: [
        { kind: "geo-tag", ref: "preset:corporate_internal" },
        { kind: "manual", entries: ["192.168.10.0/24"] },
      ],
    });
    assert.equal(okCidr.status, 200);
    assert.ok(okCidr.data.preset.entries.includes("192.168.10.0/24"));
  });

  test("plain entries payload is wrapped as a manual layer (backward compat)", async () => {
    const created = await postPreset({
      id: "preset:legacy_shape",
      name: "Legacy Shape",
      type: "domain",
      entries: ["legacy.com"],
    });
    assert.equal(created.status, 200);
    assert.equal(created.data.preset.sources.length, 1);
    assert.equal(created.data.preset.sources[0].kind, "manual");
    assert.deepEqual(created.data.preset.sources[0].entries, ["legacy.com"]);
  });

  test("preset type is immutable on update; mismatched layers are rejected against the stored type", async () => {
    const created = await postPreset({
      id: "preset:typed",
      name: "Typed",
      type: "domain",
      entries: ["a.com"],
    });
    assert.equal(created.status, 200);

    // requesting cidr type on update is ignored (stored type wins) -> cidr layer rejected
    const updated = await postPreset({
      id: "preset:typed",
      name: "Typed v2",
      type: "cidr",
      sources: [{ kind: "manual", entries: ["10.0.0.0/8"] }],
    });
    assert.equal(updated.status, 400);

    const reRead = await fetch(`${baseUrl}/api/routing/presets/preset:typed`);
    const data = await reRead.json();
    assert.equal(data.type, "domain", "stored type must not change via POST");
    assert.equal(data.name, "Typed", "rejected update must not mutate the preset");
  });

  test("RED case of old refresh bug: refresh updates ONLY url layers, manual/file layers survive", async () => {
    const mockHttp = await withHttpServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("fresh-url-entry.example\n");
    });
    try {
      const created = await postPreset({
        id: "preset:mixed_layers",
        name: "Mixed Layers",
        type: "domain",
        sources: [
          { kind: "manual", entries: ["manual-entry.example", "shared.example"] },
          { kind: "file", name: "snapshot.txt", entries: ["file-entry.example"] },
          { kind: "url", url: `${mockHttp.url}/live.txt`, entries: ["stale-url-entry.example"] },
        ],
      });
      assert.equal(created.status, 200);

      const refreshRes = await fetch(`${baseUrl}/api/routing/presets/preset:mixed_layers/refresh`, { method: "POST" });
      assert.equal(refreshRes.status, 200);
      const refreshed = await refreshRes.json();
      const entries: string[] = refreshed.preset.entries;

      // url layer refreshed from the live source...
      assert.ok(entries.includes("fresh-url-entry.example"), "url layer must be re-downloaded");
      assert.ok(!entries.includes("stale-url-entry.example"), "old url snapshot must be replaced");
      // ...while manual/file snapshots are untouched (old code wiped them - :511)
      assert.ok(entries.includes("manual-entry.example"), "manual layer must survive refresh");
      assert.ok(entries.includes("file-entry.example"), "file layer must survive refresh");
      assert.ok(entries.includes("shared.example"), "dedup projection stays intact");

      const urlLayer = refreshed.preset.sources.find((s: any) => s.kind === "url");
      assert.deepEqual(urlLayer.entries, ["fresh-url-entry.example"]);
      assert.ok(urlLayer.lastUpdated);
      const fileLayer = refreshed.preset.sources.find((s: any) => s.kind === "file");
      assert.deepEqual(fileLayer.entries, ["file-entry.example"], "file snapshot must not be touched");
    } finally {
      await mockHttp.close();
    }
  });

  test("refresh on a manual-only preset returns 400 (no refreshable layers)", async () => {
    await postPreset({
      id: "preset:manual_only",
      name: "Manual Only",
      type: "domain",
      sources: [{ kind: "manual", entries: ["a.example"] }],
    });
    const res = await fetch(`${baseUrl}/api/routing/presets/preset:manual_only/refresh`, { method: "POST" });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /refreshable/);
  });

  test("export/import-preset round-trip preserves sources; import never overwrites on id collision", async () => {
    const sources = [
      { kind: "manual", entries: ["round-a.com"] },
      { kind: "file", name: "round.txt", entries: ["round-b.com"] },
      { kind: "geo-tag", ref: "preset:ai_services" },
    ];
    const created = await postPreset({
      id: "preset:roundtrip",
      name: "RoundTrip",
      type: "domain",
      sources,
    });
    assert.equal(created.status, 200);

    const exportRes = await fetch(`${baseUrl}/api/routing/presets/preset:roundtrip/export`);
    assert.equal(exportRes.status, 200);
    const exportPayload = await exportRes.json();
    assert.equal(exportPayload.format, "pec-preset");
    assert.equal(exportPayload.preset.name, "RoundTrip");
    assert.equal(exportPayload.preset.sources.length, 3);

    // import the same payload twice: both succeed, both get distinct fresh ids
    const import1 = await fetch(`${baseUrl}/api/routing/presets/import-preset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exportPayload),
    });
    assert.equal(import1.status, 200);
    const import1Data = await import1.json();
    assert.equal(import1Data.ok, true);
    assert.notEqual(import1Data.preset.id, "preset:roundtrip", "import must not overwrite by id");
    assert.deepEqual(
      import1Data.preset.sources.map((s: any) => [s.kind, s.ref || s.url || s.name, (s.entries || []).length]),
      exportPayload.preset.sources.map((s: any) => [s.kind, s.ref || s.url || s.name, (s.entries || []).length]),
      "sources must round-trip"
    );

    const import2 = await fetch(`${baseUrl}/api/routing/presets/import-preset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exportPayload),
    });
    assert.equal(import2.status, 200);
    const import2Data = await import2.json();
    assert.notEqual(import2Data.preset.id, import1Data.preset.id, "collision must yield a fresh id");

    const all = await (await fetch(`${baseUrl}/api/routing/presets`)).json();
    const count = all.filter((p: any) => p.name === "RoundTrip").length;
    assert.equal(count, 3, "original + two imports must coexist");
  });

  test("layered presets expand through the PAC path as flat strings", async () => {
    await postPreset({
      id: "preset:pac_layers",
      name: "PAC Layers",
      type: "domain",
      sources: [
        { kind: "manual", entries: ["pac-a.example", "pac-dup.example"] },
        { kind: "file", name: "p.txt", entries: ["pac-dup.example", "pac-b.example"] },
      ],
    });

    const rule: RoutingRule = {
      id: "rule_pac_layers",
      name: "PAC layered rule",
      targetType: "preset",
      pattern: "preset:pac_layers",
      action: "proxy",
      enabled: true,
    };
    const expanded = expandRuleDomains(rule);
    assert.deepEqual(expanded.sort(), ["pac-a.example", "pac-b.example", "pac-dup.example"]);

    const profile: RoutingProfile = {
      id: "prof_pac_layers",
      name: "PAC Layers Profile",
      description: "test",
      defaultPolicy: "direct",
      rules: [rule],
      targetScope: "all",
      updatedAt: new Date().toISOString(),
    };
    const proxyConfig: ProxyConfiguration = {
      enabled: true,
      protocol: "http",
      host: "proxy.corp",
      port: 8080,
      bypassList: [],
      pacScript: "",
      pacUrl: "http://127.0.0.1:8080/pac",
      syncIntervalMs: 60000,
      killSwitch: false,
      updatedAt: new Date().toISOString(),
    };
    const pac = generatePacScript(profile, proxyConfig);
    assert.match(pac, /pac-a\.example/);
    assert.match(pac, /pac-b\.example/);
  });
});
