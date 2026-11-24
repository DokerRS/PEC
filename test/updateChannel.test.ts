import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import express, { Request, Response, NextFunction } from "express";
import { createReleasesRouter } from "../src/routes/releasesRoutes.js";
import { createTokenAuthMiddleware } from "../src/middleware/security.js";
import { recordRelease, resetReleasesStore } from "../src/releases.js";
import { renderDashboardHtml } from "../src/views/dashboardView.js";
import { TEST_ADMIN_TOKEN } from "./helpers/setup.js";

/**
 * REL-OBS-1: observability of the extension update channel.
 * (a) GET /api/releases/update-channel reports the LIVE facts from
 *     /updates/updates.xml + the CRX bytes, cross-checked with the recorded
 *     release (kills the "built != published != installed" confusion).
 * (d) golden DOM: the Releases tab carries the "Канал обновлений" card.
 */

const UPDATE_XML = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='testappid'>
    <updatecheck codebase='https://fleet.corp.example/updates/extension.crx' version='1.0.21' />
  </app>
</gupdate>`;

function setupEnv(): { updatesDir: string; metaPath: string; crxBytes: Buffer } {
  const updatesDir = fs.mkdtempSync(path.join(process.env.TEST_TMP_DIR || ".", "upd-"));
  const metaPath = path.join(updatesDir, "releases_meta.json");
  const crxBytes = Buffer.concat([Buffer.from("CRXFAKE"), crypto.randomBytes(64)]);
  fs.writeFileSync(path.join(updatesDir, "updates.xml"), UPDATE_XML, "utf-8");
  fs.writeFileSync(path.join(updatesDir, "extension.crx"), crxBytes);
  process.env.PEC_UPDATES_DIR = updatesDir;
  process.env.RELEASES_META_PATH = metaPath;
  return { updatesDir, metaPath, crxBytes };
}

function setupApp() {
  const app = express();
  app.use(express.json());
  const adminAuth = createTokenAuthMiddleware(() => TEST_ADMIN_TOKEN, "x-admin-token");
  app.use("/api", (req: Request, res: Response, next: NextFunction) => adminAuth(req, res, next));
  app.use(createReleasesRouter(() => TEST_ADMIN_TOKEN, undefined, () => "fleet-token-x"));
  return app;
}

async function withTestServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = setupApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function getChannel(baseUrl: string, withAuth = true): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/releases/update-channel`, {
    headers: withAuth ? { "x-admin-token": TEST_ADMIN_TOKEN } : {},
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test("REL-OBS-1 (a): update-channel reports live updates.xml facts with schema", async () => {
  resetReleasesStore();
  const { crxBytes } = setupEnv();
  await withTestServer(async (baseUrl) => {
    const { status, body } = await getChannel(baseUrl);
    assert.equal(status, 200);
    assert.equal(body.ok, true, "endpoint must respond ok");
    assert.equal(body.exists, true);

    const ch = body.channel;
    assert.equal(ch.extensionVersion, "1.0.21", "version must be parsed from the live updates.xml");
    assert.equal(ch.crxSha256, crypto.createHash("sha256").update(crxBytes).digest("hex"), "sha256 must be computed from the live CRX bytes");
    assert.equal(ch.crxSize, crxBytes.length, "crxSize must be the live CRX length");
    assert.ok(!Number.isNaN(Date.parse(ch.publishedAt)), "publishedAt must be an ISO date");
    assert.equal(ch.updatesXmlUrl, "/updates/updates.xml", "relative curl-able url");
    assert.ok(String(ch.updatesXmlAbsUrl).includes("/updates/updates.xml"), "absolute url must end with /updates/updates.xml");
    assert.equal(ch.codebase, "https://fleet.corp.example/updates/extension.crx", "codebase must come from updates.xml");
    assert.equal(ch.matchesRecorded, null, "no recorded release -> null mismatch flag");
    assert.equal(body.recorded, null);
  });
});

test("REL-OBS-1 (a): mismatch flag fires when the published CRX differs from the recorded build", async () => {
  resetReleasesStore();
  const { crxBytes } = setupEnv();
  const recordedSha = crypto.createHash("sha256").update(Buffer.from("A DIFFERENT BUILD")).digest("hex");
  recordRelease({
    type: "extension",
    version: "1.0.21",
    builtAt: new Date().toISOString(),
    sha256: recordedSha,
    fileName: "pec-extension.crx",
    filePath: path.join(process.env.PEC_UPDATES_DIR!, "ext.crx"),
    isActive: true,
    notes: "recorded build",
  });

  await withTestServer(async (baseUrl) => {
    const { body } = await getChannel(baseUrl);
    assert.equal(body.channel.matchesRecorded, false, "diverging sha256 must fire the mismatch flag");
    assert.equal(body.recorded.sha256, recordedSha);
    assert.equal(body.recorded.version, "1.0.21");
  });
  void crxBytes;
});

test("REL-OBS-1 (a): match flag is true when the published CRX equals the recorded build", async () => {
  resetReleasesStore();
  const { crxBytes } = setupEnv();
  const sha = crypto.createHash("sha256").update(crxBytes).digest("hex");
  recordRelease({
    type: "extension",
    version: "1.0.21",
    builtAt: new Date().toISOString(),
    sha256: sha,
    fileName: "pec-extension.crx",
    filePath: path.join(process.env.PEC_UPDATES_DIR!, "ext.crx"),
    isActive: true,
  });

  await withTestServer(async (baseUrl) => {
    const { body } = await getChannel(baseUrl);
    assert.equal(body.channel.matchesRecorded, true, "identical sha256 must be reported as matching");
  });
});

test("REL-OBS-1 (a): admin auth is enforced on the update-channel endpoint", async () => {
  resetReleasesStore();
  setupEnv();
  await withTestServer(async (baseUrl) => {
    const { status } = await getChannel(baseUrl, false);
    assert.equal(status, 401, "fleet/anon access must be rejected with 401");
  });
});

test("REL-OBS-1 (d): golden DOM — Releases tab carries the update-channel card", () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="updateChannelCard"'), "the update-channel card must exist on the Releases tab");
  assert.ok(html.includes('id="updateChannelBody"'), "card body container must exist");
  assert.ok(html.includes('onclick="loadUpdateChannel()"'), "card must wire the refresh action");
  assert.ok(html.includes('data-i18n="titleUpdateChannel"'), "card title must be i18n-wired");
  assert.ok(html.includes('data-i18n="descUpdateChannel"'), "card description must be i18n-wired");

  // The labels are rendered client-side into updateChannelBody (isRu inline
  // pattern of telemetry.ts) - assert the i18n dictionary carries them in
  // both languages instead of the rendered HTML.
  const i18n = fs.readFileSync(path.resolve("src/client/dashboard/core/i18n.ts"), "utf-8");
  for (const key of ["titleUpdateChannel", "descUpdateChannel", "lblChVer", "lblChPublished", "lblChSha", "lblChSize", "lblChXmlUrl", "lblChMismatch", "btnChCopy"]) {
    const occurrences = i18n.split(`        ${key}:`).length - 1;
    assert.equal(occurrences, 2, `i18n key ${key} must exist in BOTH en and ru dictionaries (found ${occurrences})`);
  }
});
