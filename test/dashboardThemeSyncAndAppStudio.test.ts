import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express, { Request, Response, NextFunction } from "express";
import { fileURLToPath } from "node:url";
import { renderDashboardHtml } from "../src/views/dashboardView.js";
import { createAppBuilderRouter } from "../src/routes/appBuilderRoutes.js";
import { createTokenAuthMiddleware } from "../src/middleware/security.js";
import { getAppBuildConfig, buildAppProfile } from "../src/appPackager.js";
import { TEST_TOKEN, TEST_ADMIN_TOKEN } from "./helpers/setup.js";
import { setupDashboardDom } from "./helpers/dashboardDom.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function setupApp() {
  const app = express();
  app.use(express.json());
  const adminAuth = createTokenAuthMiddleware(() => TEST_ADMIN_TOKEN, "x-admin-token");
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    return adminAuth(req, res, next);
  });
  const router = createAppBuilderRouter(
    () => TEST_TOKEN,
    () => TEST_ADMIN_TOKEN
  );
  app.use(router);
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

test("Dashboard Theme Modes & Corporate Sync UI elements exist", () => {
  const html = renderDashboardHtml({});

  // Brand header icon
  assert.ok(html.includes('id="dashboardBrandIcon"'), 'dashboardBrandIcon must exist');

  // Customization popover: Light / Dark Mode Switcher
  assert.ok(html.includes('id="optModeDarkCard"'), 'optModeDarkCard must exist');
  assert.ok(html.includes('id="optModeLightCard"'), 'optModeLightCard must exist');
  assert.ok(html.includes('setServerThemeMode(\'dark\')'), 'Dark mode click handler must exist');
  assert.ok(html.includes('setServerThemeMode(\'light\')'), 'Light mode click handler must exist');

  // Global Brand Icon & Sync Checkbox
  assert.ok(html.includes('id="optBrandIconPreset"'), 'optBrandIconPreset must exist');
  assert.ok(html.includes('id="optBrandIconCustom"'), 'optBrandIconCustom must exist');
  assert.ok(html.includes('id="boxBrandIconPreset"'), 'boxBrandIconPreset must exist');
  assert.ok(html.includes('id="boxBrandIconCustom"'), 'boxBrandIconCustom must exist');
  assert.ok(html.includes('id="globalBrandIconSelect"'), 'globalBrandIconSelect must exist');
  assert.ok(html.includes('id="globalBrandIconFileInput"'), 'globalBrandIconFileInput must exist');
  assert.ok(html.includes('id="globalBrandCustomPreviewBox"'), 'globalBrandCustomPreviewBox must exist');
  assert.ok(html.includes('id="globalBrandCustomPreviewImg"'), 'globalBrandCustomPreviewImg must exist');
  assert.ok(html.includes('id="chkSyncThemeWithApps"'), 'chkSyncThemeWithApps must exist');
  assert.ok(html.includes('toggleSyncThemeWithApps(this.checked)'), 'toggleSyncThemeWithApps call must exist');

  // App Studio custom icon elements
  assert.ok(html.includes('id="appIconFileInput"'), 'appIconFileInput must exist');
  assert.ok(html.includes('id="btnAppUploadIcon"'), 'btnAppUploadIcon must exist');
  assert.ok(html.includes('id="appCustomIconPreviewBox"'), 'appCustomIconPreviewBox must exist');
  assert.ok(html.includes('id="appCustomIconPreviewImg"'), 'appCustomIconPreviewImg must exist');

  // Lock banners in constructors
  assert.ok(html.includes('id="builderThemeLockedNotice"'), 'builderThemeLockedNotice must exist');
  assert.ok(html.includes('id="builderThemeCardContainer"'), 'builderThemeCardContainer must exist');
  assert.ok(html.includes('id="appThemeLockedNotice"'), 'appThemeLockedNotice must exist');
  assert.ok(html.includes('id="appThemeCardContainer"'), 'appThemeCardContainer must exist');

  // App Studio server sync interval setting
  assert.ok(html.includes('id="appSyncIntervalMinutes"'), 'appSyncIntervalMinutes must exist in App Studio');
});

test("CSS styles for light theme mode and lock state are defined", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public/dashboard.css"), "utf-8");

  assert.ok(css.includes('body[data-theme-mode="light"]'), 'CSS must define body[data-theme-mode="light"]');
  assert.ok(css.includes('body:not([data-theme-mode="light"])[data-theme="light"]'), 'Enterprise Light must have dark mode styles');
  assert.ok(css.includes('body[data-theme-mode="light"][data-theme="light"]'), 'Enterprise Light must have light mode styles');
  assert.ok(css.includes('.theme-sync-lock-banner'), 'CSS must define .theme-sync-lock-banner');
  assert.ok(css.includes('.locked-by-sync'), 'CSS must define .locked-by-sync');
  assert.ok(css.includes('max-height: calc(100vh - 80px)'), 'Popover must have max-height constraint');
});

test("dashboardThemeSyncAndAppStudio: theme mode and sync functions are exposed on window by the shipped bundle", () => {
  // AUDIT-QA-1: behavioral contract (was source-shape asserts on the orphaned
  // monolith). Inline HTML handlers (onclick="setServerThemeMode('dark')" etc.)
  // require runtime window exposures in public/dashboard.min.js.
  const env = setupDashboardDom({ autoEval: true });
  try {
    const exposed = [
      "setServerThemeMode",
      "setGlobalBrandIcon",
      "setGlobalBrandIconSource",
      "setGlobalBrandCustomIcon",
      "onGlobalBrandIconFileSelected",
      "setAppCustomIconDataUrl",
      "onAppIconFileSelected",
      "applyThemeSyncToConstructors",
      "closeCustomizationPopover",
    ];
    for (const fn of exposed) {
      assert.equal(typeof env.window[fn], "function", `${fn} must be exposed on window by dashboard.min.js`);
    }
  } finally {
    env.teardown();
  }
});

test("REGRESSION HANDOFF (AUDIT-QA-1 -> agent-general-worker): customization popover and theme-sync handlers must be exposed on window", () => {
  // Found during AUDIT-QA-1 migration: dashboardView.ts emits inline handlers
  //   <button id="btnCustomization" onclick="toggleCustomizationPopover(event)">
  //   <input id="chkSyncThemeWithApps" onchange="toggleSyncThemeWithApps(this.checked)">
  // but the modular bundle (src/client/dashboard) lost these two functions in
  // the UI-MODULAR-1 port (both exist in the orphaned monolith). Clicking the
  // customization button or toggling theme sync throws ReferenceError in the
  // shipped dashboard. This test stays RED until the production fix lands
  // (see Delegated Subtasks in .agents/project_knowledge/tasks.md).
  const env = setupDashboardDom({ autoEval: true });
  try {
    assert.equal(typeof env.window.toggleCustomizationPopover, "function", "toggleCustomizationPopover must be exposed (btnCustomization onclick)");
    assert.equal(typeof env.window.toggleSyncThemeWithApps, "function", "toggleSyncThemeWithApps must be exposed (chkSyncThemeWithApps onchange)");
  } finally {
    env.teardown();
  }
});

test("appBuilderRoutes: validates and persists syncIntervalMinutes", async () => {
  await withTestServer(async (baseUrl) => {
    // 1. Rejects non-numeric syncIntervalMinutes
    const badRes = await fetch(`${baseUrl}/api/app-builder/config`, {
      method: "POST",
      headers: {
        "x-admin-token": TEST_ADMIN_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        syncIntervalMinutes: -5,
      }),
    });
    assert.equal(badRes.status, 400);

    // 2. Rejects > 1440
    const tooHighRes = await fetch(`${baseUrl}/api/app-builder/config`, {
      method: "POST",
      headers: {
        "x-admin-token": TEST_ADMIN_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        syncIntervalMinutes: 2000,
      }),
    });
    assert.equal(tooHighRes.status, 400);

    // 3. Valid syncIntervalMinutes and customIconDataUrl
    const samplePng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const validRes = await fetch(`${baseUrl}/api/app-builder/config`, {
      method: "POST",
      headers: {
        "x-admin-token": TEST_ADMIN_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        syncIntervalMinutes: 30,
        customIconDataUrl: samplePng,
      }),
    });
    assert.equal(validRes.status, 200);
    const body = await validRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.syncIntervalMinutes, 30);
    assert.equal(body.customIconDataUrl, samplePng);

    // Verify persisted
    const cfg = getAppBuildConfig();
    assert.equal(cfg.syncIntervalMinutes, 30);
    assert.equal(cfg.customIconDataUrl, samplePng);
  });
});

test("Theme synchronization and profile builder: handles all preset and mode combinations cleanly", () => {
  // AUDIT-QA-1: pointed at the shipped bundle; esbuild minification rewrites
  // string quotes ('x' -> "x") and drops spaces after ':' in object literals.
  const js = fs.readFileSync(path.join(__dirname, "../public/dashboard.min.js"), "utf-8");

  // Verify APP_THEME_PRESETS enterprise-light has dark fallback
  assert.ok(js.includes('"enterprise-light":{'), "enterprise-light must be defined in APP_THEME_PRESETS");
  assert.ok(js.includes('background:"#0b1120"'), "enterprise-light must have dark background");
  assert.ok(js.includes('card:"#131d36"'), "enterprise-light must have dark card");

  // Verify APP_PALETTES light has dark fallback
  assert.ok(
    /light:\s*\{\s*accent:\s*"#2563eb",\s*bg:\s*"#0b1120",\s*card:\s*"#131d36"/.test(js),
    "APP_PALETTES.light must have dark bg and card"
  );

  // Test combinations with buildAppProfile
  const presets = [
    "cyber-blue",
    "dark-obsidian",
    "nordic-arctic",
    "emerald-secops",
    "enterprise-light",
    "sunset-amber"
  ] as const;

  for (const preset of presets) {
    // 1. Dark mode
    const darkCfg = {
      ...getAppBuildConfig(),
      presetStyle: preset,
      defaultThemeMode: "dark" as const,
      themeBackground: "#0b1120",
      themeCard: "#131d36"
    };
    const darkProf: any = buildAppProfile(darkCfg, "http://127.0.0.1:3000");
    assert.equal(darkProf.Theme.mode, "dark", `Preset ${preset} in dark mode must produce mode 'dark'`);
    assert.ok(darkProf.Theme.background.toLowerCase() !== "#ffffff", `Preset ${preset} in dark mode must not have white bg`);
    assert.ok(darkProf.Theme.card.toLowerCase() !== "#ffffff", `Preset ${preset} in dark mode must not have white card`);

    // 2. Light mode
    const lightCfg = {
      ...getAppBuildConfig(),
      presetStyle: preset,
      defaultThemeMode: "light" as const,
      themeBackground: "#f1f5f9",
      themeCard: "#ffffff"
    };
    const lightProf: any = buildAppProfile(lightCfg, "http://127.0.0.1:3000");
    assert.equal(lightProf.Theme.mode, "light", `Preset ${preset} in light mode must produce mode 'light'`);
    assert.ok(lightProf.Theme.background.startsWith("#f") || lightProf.Theme.background.startsWith("#e"), `Preset ${preset} in light mode must have light bg`);
    assert.equal(lightProf.Theme.card.toLowerCase(), "#ffffff", `Preset ${preset} in light mode must have light card`);
  }
});

test("THEME-WEB-1: themeSyncEnabled round-trips through both config endpoints and gates corporate theme push", async () => {
  const { saveAppBuildConfig } = await import("../src/appPackager.js");
  const { createBuilderRouter } = await import("../src/routes/builderRoutes.js");
  const { createAppSyncRouter } = await import("../src/routes/appSyncRoutes.js");
  const { getBuildConfig } = await import("../src/packager.js");

  const prevAppCfg = getAppBuildConfig();
  try {
    // 1. Default behavior: Theme present when the flag is absent
    const profBefore: any = buildAppProfile(prevAppCfg, "http://127.0.0.1:3000");
    assert.ok(profBefore.Theme, "Theme section must be present when themeSyncEnabled is not set (default true)");

    await withTestServer(async (baseUrl) => {
      const auth = { "x-admin-token": TEST_ADMIN_TOKEN, "content-type": "application/json" };

      // 2. Toggle off via POST /api/app-builder/config
      const off = await fetch(`${baseUrl}/api/app-builder/config`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ themeSyncEnabled: false }),
      });
      assert.strictEqual(off.status, 200);
      const offBody = await off.json();
      assert.strictEqual(offBody.themeSyncEnabled, false, "flag must persist as strict boolean false");
      const offProf: any = buildAppProfile(getAppBuildConfig(), baseUrl);
      assert.strictEqual(offProf.Theme, undefined, "Theme section must be omitted when sync is disabled");
      assert.ok(offProf.Icon, "Icon section must remain independent of the theme toggle");

      // 3. /api/app/sync stops pushing the theme block while disabled
      const syncApp = express();
      syncApp.use(express.json());
      syncApp.use(createAppSyncRouter(() => TEST_TOKEN, () => TEST_ADMIN_TOKEN));
      const syncServer = http.createServer(syncApp);
      await new Promise<void>((r) => syncServer.listen(0, r));
      try {
        const syncRes = await fetch(`http://127.0.0.1:${(syncServer.address() as any).port}/api/app/sync`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-fleet-token": TEST_TOKEN },
          body: JSON.stringify({
            appInstanceId: "app_theme_gate",
            hostname: "HOST-THEME-GATE",
            username: "CORP\theme_gate",
            version: "2.2.0",
          }),
        });
        assert.strictEqual(syncRes.status, 200);
        const syncBody = await syncRes.json();
        assert.strictEqual(syncBody.ok, true);
        assert.strictEqual(syncBody.theme, undefined, "disabled sync must omit the theme block from /api/app/sync");
      } finally {
        await new Promise<void>((r) => syncServer.close(() => r()));
      }

      // 4. Toggle back on + string normalization ("false"/"true" from HTML forms)
      const strRes = await fetch(`${baseUrl}/api/app-builder/config`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ themeSyncEnabled: "false" }),
      });
      assert.strictEqual(strRes.status, 200);
      assert.strictEqual(getAppBuildConfig().themeSyncEnabled, false, 'string "false" must normalize to boolean false');
      const on = await fetch(`${baseUrl}/api/app-builder/config`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ themeSyncEnabled: true }),
      });
      assert.strictEqual(on.status, 200);
      const onProf: any = buildAppProfile(getAppBuildConfig(), baseUrl);
      assert.ok(onProf.Theme, "Theme section must return after re-enabling sync");
    });

    // 5. Extension builder router: the key passes the whitelist, strict boolean
    const bApp = express();
    bApp.use(express.json());
    bApp.use(createBuilderRouter(() => TEST_TOKEN, () => TEST_ADMIN_TOKEN));
    const bServer = http.createServer(bApp);
    await new Promise<void>((r) => bServer.listen(0, r));
    try {
      const post = await fetch(`http://127.0.0.1:${(bServer.address() as any).port}/api/builder/config`, {
        method: "POST",
        headers: { "x-admin-token": TEST_ADMIN_TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ themeSyncEnabled: "true" }),
      });
      assert.strictEqual(post.status, 200);
      assert.strictEqual(getBuildConfig().themeSyncEnabled, true, 'extension config must accept themeSyncEnabled and normalize "true"');
      const garbage = await fetch(`http://127.0.0.1:${(bServer.address() as any).port}/api/builder/config`, {
        method: "POST",
        headers: { "x-admin-token": TEST_ADMIN_TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ themeSyncEnabled: "banana" }),
      });
      assert.strictEqual(garbage.status, 200);
      assert.strictEqual(getBuildConfig().themeSyncEnabled, false, "non-boolean input must normalize to strict false, not pass through");
    } finally {
      await new Promise<void>((r) => bServer.close(() => r()));
    }
  } finally {
    saveAppBuildConfig({ ...prevAppCfg, themeSyncEnabled: true });
  }
});
