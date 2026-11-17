import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getAppBuildConfig, saveAppBuildConfig, buildAppProfile } from "../src/appPackager.js";
import { getBuildConfig, saveBuildConfig } from "../src/packager.js";
import { getServerThemePath } from "../src/storage.js";
import { saveServerTheme } from "../src/serverTheme.js";
import { createAppSyncRouter } from "../src/routes/appSyncRoutes.js";
import { createCredsRouter } from "../src/routes/credsRoutes.js";
import { createServerThemeRouter } from "../src/routes/serverThemeRoutes.js";
import { createTokenAuthMiddleware } from "../src/middleware/security.js";
import { TEST_TOKEN, TEST_ADMIN_TOKEN } from "./helpers/setup.js";
import { APP_PALETTES, APP_THEME_PRESETS } from "../src/client/dashboard/core/theme.js";

/**
 * THEME-SRC-QA: independent verification matrix for the dashboard-as-source
 * theme propagation (THEME-SRC-1..4). Deliberately distinct from the
 * implementer's test/serverThemeSync.test.ts:
 * - the dashboard appearance is driven through the REAL admin endpoint
 *   (POST /api/server-theme behind adminAuth), never via saveServerTheme();
 * - expectations are derived from the client canon (theme.ts APP_PALETTES /
 *   APP_THEME_PRESETS) — not from the server-side registries under test;
 * - the user case (blue panel, previously purple popup) runs as an explicit
 *   RED->GREEN contrast: the same constructor config delivers Dark Obsidian
 *   #c084fc while sync is OFF and flips to the panel accent #2563eb the
 *   moment the toggle goes ON — between two syncs, no rebuild.
 */

function clearStore() {
  fs.rmSync(getServerThemePath(), { force: true });
}

async function postAppearance(baseUrl: string, body: object, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/server-theme`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function getAppearance(baseUrl: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/server-theme`, { headers });
  return { status: res.status, body: await res.json() };
}

async function extSync(baseUrl: string, instanceId: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ext-token": TEST_TOKEN, "x-instance-id": instanceId },
    body: JSON.stringify({ instanceId, version: "1.3.0" }),
  });
  assert.strictEqual(res.status, 200);
  return await res.json();
}

async function appSync(baseUrl: string, appInstanceId: string, instanceToken?: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/app/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fleet-token": TEST_TOKEN,
      // After the first sync the instance is enrolled: the issued token
      // (rotated on every response) is required for the next ones.
      ...(instanceToken ? { "x-instance-token": instanceToken } : {}),
    },
    body: JSON.stringify({ appInstanceId, hostname: "HOST-QAM", username: "CORP\\qam", version: "2.2.0" }),
  });
  if (res.status !== 200) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`appSync(${appInstanceId}) -> HTTP ${res.status}: ${err.error || "unknown error"}`);
  }
  const body = await res.json();
  assert.strictEqual(body.ok, true);
  return body;
}

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  const adminAuth = createTokenAuthMiddleware(() => TEST_ADMIN_TOKEN, "x-admin-token");
  // Production mount shape (server.ts:294): prefix + router-wide admin auth.
  app.use("/api/server-theme", createServerThemeRouter(adminAuth));
  app.use(createAppSyncRouter(() => TEST_TOKEN, () => TEST_ADMIN_TOKEN));
  app.use(createCredsRouter(() => TEST_TOKEN));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(baseUrl);
  } finally {
    if (typeof (server as any).closeAllConnections === "function") (server as any).closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("THEME-SRC-QA (a) user case RED->GREEN: OFF delivers constructor purple, endpoint flip to ON+light serves #2563eb on all channels instantly", async () => {
  clearStore();
  const prevExt = getBuildConfig();
  const prevApp = getAppBuildConfig();
  try {
    // The user's constructor setup that produced the complaint: Dark Obsidian
    // (purple #c084fc) everywhere, while the dashboard panel is blue/light.
    saveBuildConfig({ colorPalette: "obsidian", themeColor: "#c084fc", themeSyncEnabled: false });
    saveAppBuildConfig({ presetStyle: "dark-obsidian", themeColor: "#c084fc", themeSyncEnabled: false });

    await withApp(async (base) => {
      // RED side: sync OFF -> the constructor purple rides every channel.
      const off = await postAppearance(base, { syncEnabled: false }, { "x-admin-token": TEST_ADMIN_TOKEN });
      assert.equal(off.status, 200);
      assert.equal(off.body.syncEnabled, false);

      const extOff = await extSync(base, "inst_qam_red");
      assert.equal(extOff.theme.palette, "obsidian");
      assert.equal(extOff.theme.primary, "#c084fc", "RED side: constructor purple is what the user saw");
      const appOff = await appSync(base, "app_qam_red");
      assert.equal(appOff.theme.primary, "#c084fc", "RED side: /api/app/sync delivers constructor purple too");
      const profOff: any = buildAppProfile(getAppBuildConfig(), "http://127.0.0.1:3000");
      assert.equal(profOff.Theme.primary, "#c084fc");

      // GREEN side: the dashboard pushes its appearance through the real
      // endpoint — palette light + ON. No rebuild happens anywhere.
      const on = await postAppearance(
        base,
        { palette: "light", mode: "light", syncEnabled: true },
        { "x-admin-token": TEST_ADMIN_TOKEN }
      );
      assert.equal(on.status, 200);
      assert.deepEqual({ palette: on.body.palette, mode: on.body.mode, syncEnabled: on.body.syncEnabled }, {
        palette: "light",
        mode: "light",
        syncEnabled: true,
      });

      // The very next syncs already carry the panel theme.
      const extOn = await extSync(base, "inst_qam_green");
      assert.equal(extOn.colorPalette, "light", "extension colorPalette must follow the panel palette");
      assert.equal(extOn.theme.palette, "light");
      assert.equal(extOn.theme.mode, "light");
      assert.equal(extOn.theme.primary, "#2563eb", "/api/sync accent must be the blue panel accent (user case fixed)");
      assert.equal(extOn.theme.preset, "enterprise-light");

      const appOn = await appSync(base, "app_qam_green");
      assert.equal(appOn.theme.mode, "light");
      assert.equal(appOn.theme.primary, "#2563eb", "/api/app/sync accent must follow the panel without a rebuild");
      assert.equal(appOn.theme.preset, "enterprise-light");

      const profOn: any = buildAppProfile(getAppBuildConfig(), "http://127.0.0.1:3000");
      assert.equal(profOn.Theme.preset, "enterprise-light", ".pbprofile preset must follow the panel");
      assert.equal(profOn.Theme.mode, "light");
      assert.equal(profOn.Theme.primary, "#2563eb", ".pbprofile accent must be the panel accent");

      // The store is readable back through the endpoint.
      const read = await getAppearance(base, { "x-admin-token": TEST_ADMIN_TOKEN });
      assert.equal(read.status, 200);
      assert.equal(read.body.exists, true);
      assert.equal(read.body.palette, "light");
    });
  } finally {
    saveBuildConfig({ ...prevExt, themeSyncEnabled: prevExt.themeSyncEnabled });
    saveAppBuildConfig({ ...prevApp, themeSyncEnabled: prevApp.themeSyncEnabled });
    clearStore();
  }
});

test("THEME-SRC-QA (b) OFF: constructor themes are delivered on every channel (Dark Obsidian #c084fc)", async () => {
  clearStore();
  const prevExt = getBuildConfig();
  const prevApp = getAppBuildConfig();
  try {
    saveBuildConfig({ colorPalette: "obsidian", themeColor: "#c084fc", themeSyncEnabled: true });
    saveAppBuildConfig({ presetStyle: "dark-obsidian", themeColor: "#c084fc", themeSyncEnabled: true });
    // Global OFF wins over the per-config true flags.
    saveServerTheme({ syncEnabled: false });
    await withApp(async (base) => {
      const ext = await extSync(base, "inst_qam_off_ext");
      assert.equal(ext.theme.palette, "obsidian", "OFF must deliver the constructor palette, not the panel's");
      assert.equal(ext.theme.primary, "#c084fc");

      const app = await appSync(base, "app_qam_off");
      assert.equal(app.theme.preset, "dark-obsidian");
      assert.equal(app.theme.primary, "#c084fc", "OFF must deliver the constructor Dark Obsidian accent");

      const prof: any = buildAppProfile(getAppBuildConfig(), "http://127.0.0.1:3000");
      assert.equal(prof.Theme.preset, "dark-obsidian");
      assert.equal(prof.Theme.primary, "#c084fc", ".pbprofile must keep the constructor Dark Obsidian theme");
    });
  } finally {
    saveBuildConfig({ ...prevExt, themeSyncEnabled: prevExt.themeSyncEnabled });
    saveAppBuildConfig({ ...prevApp, themeSyncEnabled: prevApp.themeSyncEnabled });
    clearStore();
  }
});

test("THEME-SRC-QA (c) no config anywhere -> neutral cyber-blue defaults", async () => {
  clearStore(); // dashboard never spoke
  const { resolveSyncThemeForClients, resolveThemeSyncEnabled } = await import("../src/serverTheme.js");

  // Pure-neutral contract: no global store, empty constructor config.
  assert.equal(resolveThemeSyncEnabled(undefined), true, "with no store and no legacy flag the gate defaults to ON");

  const neutral = resolveSyncThemeForClients({});
  // themeSyncOn reports "panel theme was delivered" — with no store it is
  // false even though the gate defaults to ON (nothing to deliver).
  assert.equal(neutral.themeSyncOn, false, "no store means no panel theme was delivered");
  assert.equal(neutral.theme.palette, "cyber");
  assert.equal(neutral.theme.preset, "cyber-blue");
  assert.equal(neutral.theme.mode, "dark");
  assert.equal(neutral.theme.primary, "#38bdf8", "neutral accent must be the cyber-blue accent");
  assert.equal(neutral.theme.background, "#0b1120");
  assert.equal(neutral.theme.card, "#131d36");

  await withApp(async (base) => {
    const read = await getAppearance(base, { "x-admin-token": TEST_ADMIN_TOKEN });
    assert.equal(read.status, 200);
    assert.equal(read.body.exists, false, "GET must report store absence explicitly");
    assert.equal(read.body.palette, "cyber");
    assert.equal(read.body.mode, "dark");
    assert.equal(read.body.syncEnabled, true);
  });
});

test("THEME-SRC-QA (d) legacy per-config fallback when no global store; global wins when it exists", async () => {
  clearStore();
  const prevExt = getBuildConfig();
  const prevApp = getAppBuildConfig();
  try {
    // Legacy: no global store, per-config themeSyncEnabled=false -> constructor
    // themes even though the default is ON (migration keeps old installs).
    saveBuildConfig({ colorPalette: "obsidian", themeColor: "#c084fc", themeSyncEnabled: false });
    saveAppBuildConfig({ presetStyle: "dark-obsidian", themeColor: "#c084fc", themeSyncEnabled: false });
    await withApp(async (base) => {
      const ext = await extSync(base, "inst_qam_legacy");
      assert.equal(ext.theme.primary, "#c084fc", "legacy per-config OFF must deliver the constructor theme");

      // Global store appears (dashboard pushed once): it wins over the
      // per-config false -> panel theme is delivered.
      const on = await postAppearance(base, { palette: "nord", mode: "dark", syncEnabled: true }, { "x-admin-token": TEST_ADMIN_TOKEN });
      assert.equal(on.status, 200);
      const ext2 = await extSync(base, "inst_qam_legacy");
      assert.equal(ext2.theme.palette, "nord", "global ON must win over legacy per-config OFF");
      assert.equal(ext2.theme.primary, "#88c0d0");

      // Global flips OFF: it wins again (per-config true would say ON).
      const off = await postAppearance(base, { syncEnabled: false }, { "x-admin-token": TEST_ADMIN_TOKEN });
      assert.equal(off.status, 200);
      const ext3 = await extSync(base, "inst_qam_legacy");
      assert.equal(ext3.theme.primary, "#c084fc", "global OFF must win over legacy per-config ON");
    });
  } finally {
    saveBuildConfig({ ...prevExt, themeSyncEnabled: prevExt.themeSyncEnabled });
    saveAppBuildConfig({ ...prevApp, themeSyncEnabled: prevApp.themeSyncEnabled });
    clearStore();
  }
});

test("THEME-SRC-QA (e) all 6 dashboard palettes map correctly dashboard -> extension -> app", async () => {
  clearStore();
  const prevExt = getBuildConfig();
  const prevApp = getAppBuildConfig();
  try {
    saveBuildConfig({ colorPalette: "obsidian", themeColor: "#c084fc", themeSyncEnabled: true });
    saveAppBuildConfig({ presetStyle: "dark-obsidian", themeColor: "#c084fc", themeSyncEnabled: true });

    // Canon style key per palette id comes straight from theme.ts
    // APP_PALETTES[p].style (the alias entries in APP_THEME_PRESETS must not
    // be inverted — 'amber' would shadow 'sunset-amber').
    const styleOf: Record<string, string> = {};
    for (const [palette, canon] of Object.entries(APP_PALETTES)) {
      styleOf[palette] = canon.style;
    }

    await withApp(async (base) => {
      let instanceToken: string | undefined;
      for (const [palette, canon] of Object.entries(APP_PALETTES)) {
        const style = styleOf[palette];
        assert.ok(style, `palette ${palette} must map to a style key in the canon`);
        const presetDef = APP_THEME_PRESETS[style];

        const write = await postAppearance(base, { palette, mode: "dark", syncEnabled: true }, { "x-admin-token": TEST_ADMIN_TOKEN });
        assert.equal(write.status, 200);
        assert.equal(write.body.palette, palette);

        const ext = await extSync(base, "inst_qam_map_ext");
        assert.equal(ext.theme.palette, palette, `[${palette}] extension must receive the dashboard palette id`);
        assert.equal(ext.theme.preset, style, `[${palette}] extension preset must be the canon style`);
        assert.equal(ext.theme.primary.toLowerCase(), canon.accent.toLowerCase(), `[${palette}] extension accent must equal the canon accent`);
        // The extension channel carries the panel surfaces WITHOUT the app-side
        // luminance clamp: for the light palette that is the light surface
        // (canon lightBg/lightCard), for the dark palettes the dark surfaces.
        const expectExtBg = palette === "light" ? canon.lightBg : canon.bg;
        const expectExtCard = palette === "light" ? canon.lightCard : canon.card;
        assert.equal(ext.theme.background.toLowerCase(), expectExtBg.toLowerCase(), `[${palette}] extension background must equal the panel surface`);
        assert.equal(ext.theme.card.toLowerCase(), expectExtCard.toLowerCase(), `[${palette}] extension card must equal the panel surface`);

        const app = await appSync(base, "app_qam_map", instanceToken);
        instanceToken = app.instanceToken ?? instanceToken;
        assert.equal(app.theme.preset, style, `[${palette}] app preset must equal the canon style`);
        assert.equal(app.theme.primary.toLowerCase(), presetDef.accent.toLowerCase(), `[${palette}] app accent must equal APP_THEME_PRESETS accent`);
        // Dark mode keeps readable surfaces: the light palette's #f1f5f9/#ffffff
        // surfaces are THEME-WEB-3 clamped to the canon dark fallback
        // (APP_PALETTES.light bg/card) on the app channel by design.
        const expectAppBg = palette === "light" ? APP_PALETTES.light.bg : presetDef.bg;
        const expectAppCard = palette === "light" ? APP_PALETTES.light.card : presetDef.card;
        assert.equal(app.theme.background.toLowerCase(), expectAppBg.toLowerCase(), `[${palette}] app background must equal the dark-mode effective surface`);
        assert.equal(app.theme.card.toLowerCase(), expectAppCard.toLowerCase(), `[${palette}] app card must equal the dark-mode effective surface`);

        const prof: any = buildAppProfile(getAppBuildConfig(), "http://127.0.0.1:3000");
        assert.equal(prof.Theme.preset, style, `[${palette}] .pbprofile preset must follow the panel`);
        assert.equal(prof.Theme.primary.toLowerCase(), canon.accent.toLowerCase(), `[${palette}] .pbprofile accent must equal the canon accent`);
      }

      // Mode passthrough: light mode rides the channels for a dark palette.
      await postAppearance(base, { palette: "cyber", mode: "light", syncEnabled: true }, { "x-admin-token": TEST_ADMIN_TOKEN });
      const extLight = await extSync(base, "inst_qam_map_ext");
      assert.equal(extLight.theme.palette, "cyber");
      assert.equal(extLight.theme.mode, "light", "panel mode must ride /api/sync");
      const appLight = await appSync(base, "app_qam_map", instanceToken);
      assert.equal(appLight.theme.mode, "light", "panel mode must ride /api/app/sync");
    });
  } finally {
    saveBuildConfig({ ...prevExt, themeSyncEnabled: prevExt.themeSyncEnabled });
    saveAppBuildConfig({ ...prevApp, themeSyncEnabled: prevApp.themeSyncEnabled });
    clearStore();
  }
});

test("THEME-SRC-QA auth: the appearance endpoint is admin-only — fleet token gets 401 on read and write", async () => {
  clearStore();
  try {
    await withApp(async (base) => {
      // Seed a known state as admin first.
      const seed = await postAppearance(base, { palette: "nord", mode: "dark", syncEnabled: true }, { "x-admin-token": TEST_ADMIN_TOKEN });
      assert.equal(seed.status, 200);

      // Fleet token on write -> 401, and the store must not change.
      const fleetWrite = await postAppearance(base, { palette: "light" }, { "x-ext-token": TEST_TOKEN });
      assert.equal(fleetWrite.status, 401, "fleet token must NOT be able to write the dashboard appearance");
      const after = await getAppearance(base, { "x-admin-token": TEST_ADMIN_TOKEN });
      assert.equal(after.body.palette, "nord", "a rejected write must not mutate the store");

      // Fleet token on read -> 401 (router-wide adminAuth).
      const fleetRead = await getAppearance(base, { "x-ext-token": TEST_TOKEN });
      assert.equal(fleetRead.status, 401, "fleet token must not read the appearance store either");

      // No credentials at all -> 401 on both verbs.
      const anonWrite = await postAppearance(base, { palette: "light" }, {});
      assert.equal(anonWrite.status, 401);
      const anonRead = await getAppearance(base);
      assert.equal(anonRead.status, 401);

      // Wrong admin credential -> 401.
      const badWrite = await postAppearance(base, { palette: "light" }, { "x-admin-token": "not-the-token" });
      assert.equal(badWrite.status, 401);

      // Admin still works after all rejections.
      const adminWrite = await postAppearance(base, { palette: "amber" }, { "x-admin-token": TEST_ADMIN_TOKEN });
      assert.equal(adminWrite.status, 200);
      assert.equal(adminWrite.body.palette, "amber");
    });
  } finally {
    clearStore();
  }
});

test("THEME-SRC-QA write whitelist: garbage palette/mode/syncEnabled never corrupt the store", async () => {
  clearStore();
  try {
    await withApp(async (base) => {
      const seed = await postAppearance(base, { palette: "emerald", mode: "dark", syncEnabled: false }, { "x-admin-token": TEST_ADMIN_TOKEN });
      assert.equal(seed.status, 200);

      const garbage = await postAppearance(
        base,
        { palette: "banana", mode: "batmode", syncEnabled: "yes", extra: { deep: true } },
        { "x-admin-token": TEST_ADMIN_TOKEN }
      );
      assert.equal(garbage.status, 200, "garbage fields must be ignored, not rejected with 500");
      assert.equal(garbage.body.palette, "emerald", "invalid palette must keep the current value");
      assert.equal(garbage.body.mode, "dark", "invalid mode must keep the current value");
      assert.equal(garbage.body.syncEnabled, false, "non-boolean syncEnabled must keep the current value");

      // Partial update: only the given whitelisted key changes.
      const partial = await postAppearance(base, { mode: "light" }, { "x-admin-token": TEST_ADMIN_TOKEN });
      assert.equal(partial.status, 200);
      assert.equal(partial.body.palette, "emerald", "partial update must not touch other keys");
      assert.equal(partial.body.mode, "light");
      assert.equal(partial.body.syncEnabled, false);
    });
  } finally {
    clearStore();
  }
});
