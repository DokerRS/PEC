import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRoutingRouter } from "../src/routes/routingRoutes.js";

/**
 * GEO-BUILDER-UX-4: full geobase editor endpoints on top of the geofile
 * store — manifest (all lists with counts), paged list entries preview,
 * combined search (list names + domains), and the live dedup union counter.
 */

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
    Buffer.concat([encodeVarint((1 << 3) | 0), encodeVarint(0), encodeLengthDelimited(2, Buffer.from(d, "utf-8"))])
  );
  const siteBuffer = Buffer.concat([
    encodeLengthDelimited(1, Buffer.from(tag, "utf-8")),
    ...domainBuffers.map((db) => encodeLengthDelimited(2, db)),
  ]);
  return Buffer.concat([encodeLengthDelimited(1, siteBuffer)]);
}

test.describe("Geobase editor endpoints", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir: string;
  let app: express.Express;
  let server: Server;
  let baseUrl: string;
  let fileId: string;

  test.beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `pec-test-geoedit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.DATA_DIR = tempDir;
    delete process.env.GEOFILES_DIR;

    app = express();
    app.use(express.json({ limit: "50mb" }));
    app.use(createRoutingRouter());

    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    // fixture geofile: vpn(4 domains, cross-list duplicates), telegram(2),
    // category-ai-chat(1) + 60 small "common-N" lists for the search limit
    const parts = [
      makeMockGeoSiteBuffer("vpn", ["t.me", "telegram.com", "vpn-gw.example", "shared.example"]),
      makeMockGeoSiteBuffer("telegram", ["t.me", "extra.example"]),
      makeMockGeoSiteBuffer("category-ai-chat", ["shared.example"]),
    ];
    for (let i = 0; i < 60; i++) {
      parts.push(makeMockGeoSiteBuffer(`common-${String(i).padStart(2, "0")}`, [`host-${i}.example`]));
    }
    const buf = Buffer.concat(parts);
    const res = await fetch(`${baseUrl}/api/routing/presets/import-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "geosite big.dat", content: buf.toString("base64"), tag: "vpn", name: "Editor Fixture" }),
    });
    assert.equal(res.status, 200);
    fileId = (await res.json()).fileId;
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

  test("manifest returns ALL lists with counts, sorted; 404 on unknown id", async () => {
    const res = await fetch(`${baseUrl}/api/routing/geofiles/${fileId}/manifest`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.fileId, fileId);
    assert.equal(data.type, "geosite");
    assert.equal(data.totalEntries, 7 + 60, "7 cross-list entries + 60 common lists");

    const vpn = data.lists.find((l: any) => l.tag === "VPN");
    assert.ok(vpn && vpn.count === 4);
    const telegram = data.lists.find((l: any) => l.tag === "TELEGRAM");
    assert.ok(telegram && telegram.count === 2);
    assert.equal(data.lists.length, 63, "all lists present (3 named + 60 common)");

    // sorted by count desc
    const counts = data.lists.map((l: any) => l.count);
    const sorted = [...counts].sort((a: number, b: number) => b - a);
    assert.deepEqual(counts, sorted);

    const missing = await fetch(`${baseUrl}/api/routing/geofiles/${"0".repeat(64)}/manifest`);
    assert.equal(missing.status, 404);
  });

  test("entries endpoint pages list domains with a 200-per-page cap", async () => {
    const page1 = await fetch(`${baseUrl}/api/routing/geofiles/${fileId}/lists/VPN/entries?offset=0&limit=2`);
    assert.equal(page1.status, 200);
    const p1 = await page1.json();
    assert.equal(p1.tag, "VPN");
    assert.equal(p1.total, 4);
    assert.equal(p1.offset, 0);
    assert.equal(p1.limit, 2);
    assert.deepEqual(p1.items, ["t.me", "telegram.com"]);

    const page2 = await fetch(`${baseUrl}/api/routing/geofiles/${fileId}/lists/VPN/entries?offset=2&limit=2`);
    const p2 = await page2.json();
    assert.deepEqual(p2.items, ["vpn-gw.example", "shared.example"]);

    // limit is capped at 200 per page
    const capped = await fetch(`${baseUrl}/api/routing/geofiles/${fileId}/lists/VPN/entries?offset=0&limit=500`);
    const c = await capped.json();
    assert.equal(c.limit, 200, "limit must be capped at 200 per page");

    const unknownTag = await fetch(`${baseUrl}/api/routing/geofiles/${fileId}/lists/nope/entries`);
    assert.equal(unknownTag.status, 404);
    const unknownFile = await fetch(`${baseUrl}/api/routing/geofiles/${"1".repeat(64)}/lists/VPN/entries`);
    assert.equal(unknownFile.status, 404);
  });

  test("search matches list names AND domains (substring, case-insensitive) and reports where a domain lives", async () => {
    // by list name (case-insensitive substring)
    const byName = await fetch(`${baseUrl}/api/routing/geofiles/${fileId}/search?q=TELE`);
    const nameData = await byName.json();
    assert.ok(nameData.lists.some((l: any) => l.tag === "TELEGRAM"));
    assert.ok(nameData.domains.length >= 1, "domain search runs alongside the list search");

    // by domain substring: where does t.me live?
    const byDomain = await fetch(`${baseUrl}/api/routing/geofiles/${fileId}/search?q=t.me`);
    const domainData = await byDomain.json();
    const tme = domainData.domains.find((d: any) => d.domain === "t.me");
    assert.ok(tme, "domain hit must be reported");
    assert.deepEqual(tme.lists.sort(), ["TELEGRAM", "VPN"], "domain hit must list every list it lives in");

    // wildcard substring + case-insensitivity
    const wild = await fetch(`${baseUrl}/api/routing/geofiles/${fileId}/search?q=HOST-1`);
    const wildData = await wild.json();
    assert.ok(wildData.domains.some((d: any) => d.domain === "host-1.example"), "case-insensitive substring search");

    // 60 common lists match "common-" -> list results capped at 50
    const capped = await fetch(`${baseUrl}/api/routing/geofiles/${fileId}/search?q=common-`);
    const cappedData = await capped.json();
    assert.equal(cappedData.lists.length, 50, "list matches must be capped at 50");

    // empty query -> empty result set
    const empty = await fetch(`${baseUrl}/api/routing/geofiles/${fileId}/search?q=`);
    const emptyData = await empty.json();
    assert.equal(emptyData.lists.length, 0);
    assert.equal(emptyData.domains.length, 0);
  });

  test("union-count reports the DEDUPED size of the selected lists", async () => {
    const res = await fetch(`${baseUrl}/api/routing/geofiles/${fileId}/union-count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["VPN", "TELEGRAM", "CATEGORY-AI-CHAT"] }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    // vpn: t.me, telegram.com, vpn-gw.example, shared.example
    // telegram: t.me, extra.example
    // category-ai-chat: shared.example
    // union = {t.me, telegram.com, vpn-gw.example, shared.example, extra.example} = 5
    assert.equal(data.count, 5, "union must dedupe cross-list entries (raw sum is 7)");

    const empty = await fetch(`${baseUrl}/api/routing/geofiles/${fileId}/union-count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [] }),
    });
    const emptyData = await empty.json();
    assert.equal(emptyData.count, 0);
  });

  test("plaintext geofiles manifest as type=plaintext with no tagged lists", async () => {
    const res = await fetch(`${baseUrl}/api/routing/presets/import-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "plain-list.txt",
        content: Buffer.from("plain-a.example\nplain-b.example\n").toString("base64"),
        name: "Plain Preset",
      }),
    });
    assert.equal(res.status, 200);
    const { fileId: plainId } = await res.json();

    const manifest = await fetch(`${baseUrl}/api/routing/geofiles/${plainId}/manifest`);
    const data = await manifest.json();
    assert.equal(data.type, "plaintext");
    assert.deepEqual(data.lists, []);
    assert.equal(data.totalEntries, 2);
  });
});
