import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getAppBuildConfig, saveAppBuildConfig, buildAppProfile } from "../src/appPackager.js";
import { saveServerTheme, loadServerTheme, resolveFleetTheme, resolveSyncThemeForClients, APP_STYLE_SURFACES, PALETTE_TO_APP_STYLE } from "../src/serverTheme.js";
import { getServerThemePath } from "../src/storage.js";
import { EXTENSION_STYLES_MAP, getBuildConfig } from "../src/packager.js";
import { createAppSyncRouter } from "../src/routes/appSyncRoutes.js";
import { createCredsRouter } from "../src/routes/credsRoutes.js";
import { TEST_TOKEN, TEST_ADMIN_TOKEN } from "./helpers/setup.js";

/**
 * THEME-SRC-3 core: dashboard-as-source. Global sync ON -> the panel theme
 * rides every sync channel (/api/sync, /api/app/sync, buildAppProfile);
 * OFF -> constructor themes (classic, replacing the THEME-WEB-1 neutral
 * semantics); no global store -> legacy per-config fallback; absent config
 * keys -> neutral defaults. The hex registry in serverTheme.ts is pinned to
 * the packager EXTENSION_STYLES_MAP (single-value-source guard).
 */

function clearStore() {
  fs.rmSync(getServerThemePath(), { force: true });
}

async function appSyncOnce(baseUrl: string, appInstanceId: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/app/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fleet-token": TEST_TOKEN },
    body: JSON.stringify({
      appInstanceId,
      hostname: "HOST-SRC3",
      username: "CORP\\src3",
      version: "2.2.0",
    }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.ok, true);
  return body;
}

async function extSyncOnce(baseUrl: string, instanceId: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ext-token": TEST_TOKEN, "x-instance-id": instanceId },
    body: JSON.stringify({ instanceId, version: "1.3.0" }),
  });
  assert.strictEqual(res.status, 200);
  return await res.json();
}

test("SRC-3: APP_STYLE_SURFACES registry is hex-parity with packager EXTENSION_STYLES_MAP", () => {
  for (const [style, surface] of Object.entries(APP_STYLE_SURFACES)) {
    const ext = EXTENSION_STYLES_MAP[style];
    assert.ok(ext, `${style} must exist in EXTENSION_STYLES_MAP`);
    assert.equal(surface.primary.toLowerCase(), ext.primary.toLowerCase(), `${style} primary parity`);
    assert.equal(surface.background.toLowerCase(), ext.bg.toLowerCase(), `${style} background parity`);
    assert.equal(surface.card.toLowerCase(), ext.card.toLowerCase(), `${style} card parity`);
  }
  // Every dashboard palette maps to a defined style with surfaces
  for (const [palette, style] of Object.entries(PALETTE_TO_APP_STYLE)) {
    assert.ok(APP_STYLE_SURFACES[style], `palette ${palette} -> ${style} must have surfaces`);
  }
});

test("SRC-3 (a) user case: dashboard palette cyber->light + ON -> sync channels deliver #2563eb/light", async () => {
  const prevCfg = getAppBuildConfig();
  clearStore();
  try {
    // The dashboard pushed its appearance (THEME-SRC-2 endpoint contract)
    saveServerTheme({ palette: "light", mode: "light", syncEnabled: true });

    const fleet = resolveFleetTheme();
    assert.ok(fleet, "store must resolve");
    assert.equal(fleet!.style, "enterprise-light");
    assert.equal(fleet!.primary, "#2563eb", "dashboard accent must map to the fleet accent");

    const prof: any = buildAppProfile(getAppBuildConfig(), "http://127.0.0.1:3000");
    assert.equal(prof.Theme.preset, "enterprise-light", "profile preset must follow the dashboard palette");
    assert.equal(prof.Theme.mode, "light");
    assert.equal(prof.Theme.primary, "#2563eb", ".pbprofile accent must be the dashboard accent");

    const app = express();
    app.use(express.json());
    app.use(createAppSyncRouter(() => TEST_TOKEN, () => TEST_ADMIN_TOKEN));
    app.use(createCredsRouter(() => TEST_TOKEN));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const appBody = await appSyncOnce(base, "app_src3_light");
      assert.equal(appBody.theme.mode, "light");
      assert.equal(appBody.theme.primary, "#2563eb", "/api/app/sync accent must follow the dashboard without a rebuild");

      const extBody = await extSyncOnce(base, "inst_src3_light");
      assert.equal(extBody.theme.palette, "light", "/api/sync must deliver the dashboard palette id");
      assert.equal(extBody.theme.mode, "light");
      assert.equal(extBody.theme.primary, "#2563eb", "/api/sync accent must follow the dashboard");
      assert.equal(extBody.colorPalette, "light", "legacy colorPalette field must follow the dashboard too");
    } finally {
      if (typeof (server as any).closeAllConnections === "function") (server as any).closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  } finally {
    clearStore();
    saveAppBuildConfig({ ...prevCfg, themeSyncEnabled: true });
  }
});

test("SRC-3 (b,c) OFF / no store: constructor themes are delivered (Dark Obsidian case), neutral defaults hold", async () => {
  const prevCfg = getAppBuildConfig();
  clearStore();
  try {
    // OFF via the global store, constructor wants Dark Obsidian
    saveServerTheme({ palette: "cyber", mode: "dark", syncEnabled: false });
    saveAppBuildConfig({ presetStyle: "dark-obsidian", themeColor: "#c084fc", themeBackground: "#0d1117", themeCard: "#161b22" });

    const src = resolveSyncThemeForClients(getAppBuildConfig() as any);
    assert.equal(src.themeSyncOn, false);
    assert.equal(src.theme.preset, "dark-obsidian", "constructor theme is the OFF source");
    assert.equal(src.theme.primary, "#c084fc", "Dark Obsidian accent must ride while OFF");

    const prof: any = buildAppProfile(getAppBuildConfig(), "http://127.0.0.1:3000");
    assert.equal(prof.Theme.preset, "dark-obsidian");
    assert.equal(prof.Theme.primary, "#c084fc");

    // No global store at all: neutral defaults (cyber-blue surfaces)
    clearStore();
    saveAppBuildConfig({ presetStyle: "cyber-blue", themeColor: "#38bdf8", themeBackground: "#0b1120", themeCard: "#131d36" });
    const neutral = resolveSyncThemeForClients(getAppBuildConfig() as any);
    assert.equal(neutral.theme.preset, "cyber-blue", "neutral constructor theme is cyber-blue");
    assert.equal(neutral.theme.primary, "#38bdf8");
    assert.equal(neutral.theme.background, "#0b1120");
    assert.equal(neutral.theme.card, "#131d36");
  } finally {
    clearStore();
    saveAppBuildConfig({ ...prevCfg, themeSyncEnabled: true });
  }
});

test("SRC-3 (d) legacy per-config fallback applies only when no global store exists", () => {
  const prevCfg = getAppBuildConfig();
  clearStore();
  try {
    // Legacy flag OFF + no global store -> constructor themes, sync stays off
    saveAppBuildConfig({ themeSyncEnabled: false, presetStyle: "dark-obsidian" });
    const legacy = resolveSyncThemeForClients(getAppBuildConfig() as any);
    assert.equal(legacy.themeSyncOn, false);
    assert.equal(legacy.theme.preset, "dark-obsidian");

    // Global store appears (even ON) -> it wins over the legacy OFF flag
    saveServerTheme({ palette: "emerald", mode: "dark", syncEnabled: true });
    const global = resolveSyncThemeForClients(getAppBuildConfig() as any);
    assert.equal(global.themeSyncOn, true, "global store must win over the legacy per-config flag");
    assert.equal(global.theme.preset, "emerald-secops");
    assert.equal(global.theme.primary, "#34d399");
  } finally {
    clearStore();
    saveAppBuildConfig({ ...prevCfg, themeSyncEnabled: true });
  }
});

test("SRC-3 (e) mapping: every dashboard palette delivers its app style surfaces", () => {
  clearStore();
  try {
    for (const [palette, style] of Object.entries(PALETTE_TO_APP_STYLE)) {
      saveServerTheme({ palette: palette as any, mode: "dark", syncEnabled: true });
      const fleet = resolveFleetTheme();
      assert.equal(fleet!.style, style);
      assert.equal(fleet!.primary.toLowerCase(), APP_STYLE_SURFACES[style].primary.toLowerCase());
      const prof: any = buildAppProfile(getAppBuildConfig(), "http://127.0.0.1:3000");
      assert.equal(prof.Theme.preset, style, `palette ${palette} must map to preset ${style} in the profile`);
      assert.equal(prof.Theme.primary.toLowerCase(), APP_STYLE_SURFACES[style].primary.toLowerCase());
    }
  } finally {
    clearStore();
  }
});

test("SRC-3 (f) sync OFF stops panel-theme delivery immediately after palette change (no rebuild needed)", async () => {
  const prevCfg = getAppBuildConfig();
  clearStore();
  try {
    saveServerTheme({ palette: "cyber", mode: "dark", syncEnabled: true });
    saveAppBuildConfig({ presetStyle: "dark-obsidian", themeColor: "#c084fc" });

    const app = express();
    app.use(express.json());
    app.use(createAppSyncRouter(() => TEST_TOKEN, () => TEST_ADMIN_TOKEN));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const on = await appSyncOnce(base, "app_src3_toggle_on");
      assert.equal(on.theme.preset, "cyber-blue", "ON delivers the panel theme (cyber-blue)");
      assert.equal(on.theme.primary, "#38bdf8");

      // Operator flips the global toggle OFF - next sync serves the constructor
      saveServerTheme({ syncEnabled: false });
      const off = await appSyncOnce(base, "app_src3_toggle_off");
      assert.equal(off.theme.preset, "dark-obsidian", "OFF immediately serves the constructor theme");
      assert.equal(off.theme.primary, "#c084fc");
    } finally {
      if (typeof (server as any).closeAllConnections === "function") (server as any).closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  } finally {
    clearStore();
    saveAppBuildConfig({ ...prevCfg, themeSyncEnabled: true });
  }
});
