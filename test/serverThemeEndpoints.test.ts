import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import type { AddressInfo } from "node:net";
import { createServerThemeRouter } from "../src/routes/serverThemeRoutes.js";
import { loadServerTheme, saveServerTheme, DEFAULT_SERVER_THEME } from "../src/serverTheme.js";
import { getServerThemePath } from "../src/storage.js";
import { TEST_TOKEN, TEST_ADMIN_TOKEN } from "./helpers/setup.js";

/**
 * THEME-SRC-1: server-side store for the dashboard appearance.
 * Writes are admin-only (the fleet token must get 401); values are strictly
 * whitelisted; the store is absent until the dashboard pushes for the first
 * time (absence drives legacy fallback semantics in THEME-SRC-3).
 */

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createServerThemeRouter((req: any, res: any, next: any) => {
    const token = req.headers["x-admin-token"];
    if (token && token === TEST_ADMIN_TOKEN) return next();
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }));
  return app;
}

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = buildApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(base);
  } finally {
    if (typeof (server as any).closeAllConnections === "function") (server as any).closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("SRC-1: store is absent until first push; loader returns null (legacy fallback anchor)", () => {
  fs.rmSync(getServerThemePath(), { force: true });
  assert.strictEqual(loadServerTheme(), null, "no file -> no global theme (dashboard never spoke)");
});

test("SRC-1: admin POST persists {palette, mode, syncEnabled} atomically; GET reflects it", async () => {
  fs.rmSync(getServerThemePath(), { force: true });
  await withServer(async (base) => {
    const post = await fetch(`${base}/api/server-theme`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": TEST_ADMIN_TOKEN },
      body: JSON.stringify({ palette: "nord", mode: "light", syncEnabled: true }),
    });
    assert.strictEqual(post.status, 200);
    const body = await post.json();
    assert.equal(body.ok, true);
    assert.equal(body.palette, "nord");
    assert.equal(body.mode, "light");
    assert.equal(body.syncEnabled, true);

    // Atomic store on disk
    const onDisk = JSON.parse(fs.readFileSync(getServerThemePath(), "utf-8"));
    assert.deepEqual(onDisk, { palette: "nord", mode: "light", syncEnabled: true });

    const get = await fetch(`${base}/api/server-theme`, { headers: { "x-admin-token": TEST_ADMIN_TOKEN } });
    assert.strictEqual(get.status, 200);
    const getBody = await get.json();
    assert.equal(getBody.exists, true);
    assert.equal(getBody.palette, "nord");
    assert.equal(getBody.mode, "light");
  });
  fs.rmSync(getServerThemePath(), { force: true });
});

test("SRC-1: fleet token is rejected on write (admin-only perimeter)", async () => {
  await withServer(async (base) => {
    const fleetWrite = await fetch(`${base}/api/server-theme`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ext-token": TEST_TOKEN, "x-fleet-token": TEST_TOKEN },
      body: JSON.stringify({ palette: "amber" }),
    });
    assert.strictEqual(fleetWrite.status, 401, "fleet token must NOT have write access");
    const anonWrite = await fetch(`${base}/api/server-theme`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ palette: "amber" }),
    });
    assert.strictEqual(anonWrite.status, 401, "anonymous write must be rejected");
  });
});

test("SRC-1: palette/mode are strictly whitelisted; garbage never lands in the store", async () => {
  fs.rmSync(getServerThemePath(), { force: true });
  saveServerTheme({ palette: "cyber", mode: "dark", syncEnabled: false });
  await withServer(async (base) => {
    for (const payload of [
      { palette: "<script>alert(1)</script>" },
      { palette: "amber'; DROP TABLE" },
      { palette: 123 },
      { mode: "sepia" },
      { mode: { $gt: "" } },
      { syncEnabled: "banana" },
    ]) {
      const res = await fetch(`${base}/api/server-theme`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": TEST_ADMIN_TOKEN },
        body: JSON.stringify(payload),
      });
      assert.strictEqual(res.status, 200, "endpoint accepts the body but sanitizes values");
    }
    const stored = loadServerTheme();
    assert.ok(stored, "store must exist after pushes");
    assert.ok((["cyber", "obsidian", "nord", "emerald", "amber", "light"] as string[]).includes(stored!.palette), "palette must be whitelisted");
    assert.ok(stored!.mode === "dark" || stored!.mode === "light", "mode must be whitelisted");
    assert.equal(typeof stored!.syncEnabled, "boolean", "syncEnabled must coerce to boolean");
    const raw = fs.readFileSync(getServerThemePath(), "utf-8");
    assert.ok(!raw.includes("<script>") && !raw.includes("DROP TABLE") && !raw.includes("sepia"), "no garbage on disk");
  });
  fs.rmSync(getServerThemePath(), { force: true });
});

test("SRC-1: partial updates merge with current state; defaults hold for absent keys", () => {
  fs.rmSync(getServerThemePath(), { force: true });
  saveServerTheme({ palette: "amber" });
  let state = loadServerTheme();
  assert.equal(state!.palette, "amber");
  assert.equal(state!.mode, DEFAULT_SERVER_THEME.mode, "mode defaults to dark");
  assert.equal(state!.syncEnabled, true, "syncEnabled defaults to true");

  saveServerTheme({ syncEnabled: false });
  state = loadServerTheme();
  assert.equal(state!.palette, "amber", "partial update keeps palette");
  assert.equal(state!.syncEnabled, false);
  fs.rmSync(getServerThemePath(), { force: true });
});
