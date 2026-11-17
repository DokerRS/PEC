import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { getAppBuildConfig, saveAppBuildConfig, buildAppProfile, computeHexLuminance, isDarkHexColor, isLightHexColor } from "../src/appPackager.js";
import { createAppSyncRouter } from "../src/routes/appSyncRoutes.js";
import { TEST_TOKEN, TEST_ADMIN_TOKEN } from "./helpers/setup.js";

/**
 * THEME-WEB-3: the "^#0../^#1../^#2[0-4].." prefix heuristics let dark cards
 * in the #25-#FF range (nord #2e3440, amber #261805, slate #2a2a3a) leak onto
 * light builds as unreadable dark-on-light cards. Both clamp sites now use
 * the perceptual luminance formula from the ImGui theme reference
 * (pec_imgui_theme.h:99): dark = lum < 100, light = lum > 175.
 */

test("THEME-WEB-3: computeHexLuminance matches the ImGui weighted formula", () => {
  assert.strictEqual(computeHexLuminance("#0b1120"), 11 * 0.299 + 17 * 0.587 + 32 * 0.114);
  assert.strictEqual(computeHexLuminance("#FFFFFF"), 255 * 0.299 + 255 * 0.587 + 255 * 0.114);
  assert.ok(Math.abs(computeHexLuminance("#AfAfAf")! - 175) < 1e-9, "hex parsing is case-insensitive");
  assert.strictEqual(computeHexLuminance(undefined), null);
  assert.strictEqual(computeHexLuminance(null), null);
  assert.strictEqual(computeHexLuminance(""), null);
  assert.strictEqual(computeHexLuminance("red"), null);
  assert.strictEqual(computeHexLuminance("#12345"), null, "5-digit hex is not a color");
  assert.strictEqual(computeHexLuminance("#12345g"), null);
});

test("THEME-WEB-3: dark/light predicate thresholds cover the #25-#FF leak range", () => {
  // Dark range: everything the old ^#2[0-4] regex missed
  for (const hex of ["#0b1120", "#1e293b", "#261805", "#2a2a3a", "#2e3440", "#252525", "#343a46", "#4b5563"]) {
    assert.ok(isDarkHexColor(hex), `${hex} (lum=${computeHexLuminance(hex)!.toFixed(1)}) must be classified dark`);
  }
  // Boundary: lum == 100 is not dark, lum == 175 is not light
  assert.strictEqual(isDarkHexColor("#6b7280"), false, "mid-gray (lum 113.5) must stay untouched");
  assert.strictEqual(isDarkHexColor("#afafaf"), false, "lum 175 is not dark");
  assert.strictEqual(isLightHexColor("#afafaf"), false, "lum 175 is not light (strict > 175)");
  assert.strictEqual(isLightHexColor("#b0b0b0"), true, "lum 176.1 crosses the light threshold");
  assert.strictEqual(isDarkHexColor("#646464"), false, "lum exactly 100 is not dark (strict < 100)");
  // Light range
  for (const hex of ["#f1f5f9", "#e2e8f0", "#faf5ff", "#fef3c7", "#ffffff"]) {
    assert.ok(isLightHexColor(hex), `${hex} (lum=${computeHexLuminance(hex)!.toFixed(1)}) must be classified light`);
  }
});

test("THEME-WEB-3: buildAppProfile clamps the full dark-matrix in light mode", () => {
  const darkCards = ["#0b1120", "#1e293b", "#261805", "#2a2a3a", "#2e3440", "#4b5563"];
  for (const hex of darkCards) {
    const cfg = {
      ...getAppBuildConfig(),
      presetStyle: "cyber-blue" as const,
      defaultThemeMode: "light" as const,
      themeBackground: hex,
      themeCard: hex,
    };
    const prof: any = buildAppProfile(cfg, "http://127.0.0.1:3000");
    assert.equal(prof.Theme.background, "#f1f5f9", `${hex} background must clamp to the light default`);
    assert.equal(prof.Theme.card, "#ffffff", `${hex} card must clamp to white`);
  }

  // Light colors in light mode pass through untouched
  const lightCfg = {
    ...getAppBuildConfig(),
    presetStyle: "cyber-blue" as const,
    defaultThemeMode: "light" as const,
    themeBackground: "#f1f5f9",
    themeCard: "#ffffff",
  };
  const lightProf: any = buildAppProfile(lightCfg, "http://127.0.0.1:3000");
  assert.equal(lightProf.Theme.background, "#f1f5f9");
  assert.equal(lightProf.Theme.card, "#ffffff");
});

test("THEME-WEB-3: buildAppProfile clamps light colors in dark mode", () => {
  const lightColors = ["#f1f5f9", "#e2e8f0", "#fef3c7", "#ffffff"];
  for (const hex of lightColors) {
    const cfg = {
      ...getAppBuildConfig(),
      presetStyle: "cyber-blue" as const,
      defaultThemeMode: "dark" as const,
      themeBackground: hex,
      themeCard: hex,
    };
    const prof: any = buildAppProfile(cfg, "http://127.0.0.1:3000");
    assert.equal(prof.Theme.background, "#0b1120", `${hex} background must clamp to the dark default`);
    assert.equal(prof.Theme.card, "#131d36", `${hex} card must clamp to the dark card`);
  }

  // Dark colors in dark mode pass through untouched
  const darkCfg = {
    ...getAppBuildConfig(),
    presetStyle: "cyber-blue" as const,
    defaultThemeMode: "dark" as const,
    themeBackground: "#0b1120",
    themeCard: "#131d36",
  };
  const prof: any = buildAppProfile(darkCfg, "http://127.0.0.1:3000");
  assert.equal(prof.Theme.background, "#0b1120");
  assert.equal(prof.Theme.card, "#131d36");
});

test("THEME-WEB-3: /api/app/sync applies the same luminance clamp to the pushed theme", async () => {
  const prevCfg = getAppBuildConfig();
  try {
    saveAppBuildConfig({
      presetStyle: "cyber-blue",
      defaultThemeMode: "light",
      themeBackground: "#f1f5f9",
      themeCard: "#2e3440", // nord dark card: previously leaked through ^#2[0-4]
    });

    const app = express();
    app.use(express.json());
    app.use(createAppSyncRouter(() => TEST_TOKEN, () => TEST_ADMIN_TOKEN));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/app/sync`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-fleet-token": TEST_TOKEN },
        body: JSON.stringify({
          appInstanceId: "app_theme_lum",
          hostname: "HOST-LUM",
          username: "CORP\\lum",
          version: "2.2.0",
        }),
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.equal(body.theme.card, "#ffffff", "nord dark card must clamp to white in the sync theme push");
      assert.equal(body.theme.background, "#f1f5f9", "light background must pass through");
    } finally {
      if (typeof (server as any).closeAllConnections === "function") (server as any).closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  } finally {
    saveAppBuildConfig({ ...prevCfg, themeSyncEnabled: true });
  }
});
