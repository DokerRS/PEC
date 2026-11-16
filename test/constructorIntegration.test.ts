import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildExtensionFiles, saveBuildConfig, getBuildConfig, generateExtensionFiles, parseDataUrlBuffer } from "../src/packager.js";
import { ExtensionBuildConfig } from "../src/types.js";
import { renderDashboardHtml } from "../src/views/dashboardView.js";
import { createDashboardVmEnv } from "./helpers/dashboardVm.js";

test("packager accepts uiLayout, colorPalette, and defaultThemeMode and renders into popup", async () => {
  const cfg: ExtensionBuildConfig = {
    name: "Corporate Proxy",
    shortName: "CorpProxy",
    version: "1.4.0",
    serverUrl: "https://pec.example.corp",
    token: "fleet-secret-123",
    uiLayout: "terminal",
    colorPalette: "emerald",
    defaultThemeMode: "light",
  };

  const files = await buildExtensionFiles(cfg);
  const popupHtml = files["popup.html"];
  assert.ok(popupHtml);
  assert.ok(popupHtml.includes('data-palette="emerald"'));
  assert.ok(popupHtml.includes('data-layout="terminal"'));
  assert.ok(popupHtml.includes('data-theme="light"'));
});

test("packager falls back to default layout, palette, and theme mode when omitted", async () => {
  const cfg: ExtensionBuildConfig = {
    name: "Default Config Proxy",
    shortName: "DefProxy",
    version: "1.4.0",
  };

  const files = await buildExtensionFiles(cfg);
  const popupHtml = files["popup.html"];
  assert.ok(popupHtml);
  assert.ok(popupHtml.includes('data-palette="cyber"'));
  assert.ok(popupHtml.includes('data-layout="console"'));
  assert.ok(popupHtml.includes('data-theme="dark"'));
});

test("packager supports all 5 color palettes and both layouts", async () => {
  const palettes = ["cyber", "obsidian", "nord", "emerald", "light"] as const;
  const layouts = ["console", "terminal"] as const;

  for (const pal of palettes) {
    for (const lay of layouts) {
      const files = await buildExtensionFiles({
        name: `Test ${pal} ${lay}`,
        shortName: "Test",
        version: "1.0.0",
        colorPalette: pal,
        uiLayout: lay,
        defaultThemeMode: "dark",
      });
      const html = files["popup.html"];
      assert.ok(html.includes(`data-palette="${pal}"`));
      assert.ok(html.includes(`data-layout="${lay}"`));
    }
  }
});

test("saveBuildConfig round-trips uiLayout, colorPalette, and defaultThemeMode", () => {
  saveBuildConfig({
    uiLayout: "terminal",
    colorPalette: "nord",
    defaultThemeMode: "light",
  });

  const updated = getBuildConfig();
  assert.equal(updated.uiLayout, "terminal");
  assert.equal(updated.colorPalette, "nord");
  assert.equal(updated.defaultThemeMode, "light");
});

test("dashboard.css configures .popup-frame-box with flexible fit-content width and smooth transitions", () => {
  const css = fs.readFileSync(path.resolve(process.cwd(), "public/dashboard.css"), "utf-8");
  assert.match(css, /\.popup-frame-box\s*\{[^}]*width:\s*fit-content/);
  assert.match(css, /\.popup-frame-box\s*\{[^}]*max-width:\s*100%/);
  assert.match(css, /\.popup-frame-box\s*\{[^}]*transition:\s*width\s+0\.2s\s+ease,\s*height\s+0\.2s\s+ease/);
  assert.match(css, /\.popup-frame-box\s+iframe\s*\{[^}]*width:\s*380px/);
  assert.match(css, /\.popup-frame-box\s+iframe\s*\{[^}]*height:\s*580px/);
});

test("dashboard.min.js mockScript includes full chrome.storage.local mock with get/set", () => {
  const js = fs.readFileSync(path.resolve(process.cwd(), "public/dashboard.min.js"), "utf-8");
  assert.ok(js.includes("storage: {") || js.includes("storage:{"));
  assert.ok(js.includes("__simStorage"));
  assert.ok(js.includes("pecUserRules"));
});

test("dashboard.min.js mockScript includes chrome.tabs mock", () => {
  const js = fs.readFileSync(path.resolve(process.cwd(), "public/dashboard.min.js"), "utf-8");
  assert.ok(js.includes("tabs: {") || js.includes("tabs:{"));
  assert.ok(js.includes("query: function"));
});

test("dashboard.min.js mockScript supports SET_ENABLED, SAVE_USER_RULES, and GET_USER_RULES with action and type", () => {
  const js = fs.readFileSync(path.resolve(process.cwd(), "public/dashboard.min.js"), "utf-8");
  assert.ok(js.includes("SET_ENABLED"));
  assert.ok(js.includes("SAVE_USER_RULES"));
  assert.ok(js.includes("GET_USER_RULES"));
  assert.ok(js.includes("BYPASS_TOGGLE"));
  assert.ok(js.includes("GET_LOGS"));
});

test("dashboard.min.js handles PREVIEW_RESIZE with both width and height", () => {
  // AUDIT-QA-1: behavioral contract. The preview iframe measures itself
  // (__postPreviewSize must ship in the bundle) and the parent clamps both
  // dimensions on the PREVIEW_RESIZE message (studio.ts message listener).
  const js = fs.readFileSync(path.resolve(process.cwd(), "public/dashboard.min.js"), "utf-8");
  assert.ok(js.includes("__postPreviewSize"), "iframe size reporter must ship in the bundle");
  assert.ok(js.includes("PREVIEW_RESIZE"), "PREVIEW_RESIZE protocol must ship in the bundle");

  const { getEl, emitWindowEvent } = createDashboardVmEnv();
  const pf = getEl("previewFrame");
  const frameWindow = {};
  pf.contentWindow = frameWindow;

  // Oversized content clamps to the maximum band.
  emitWindowEvent("message", {
    source: frameWindow,
    data: { type: "PREVIEW_RESIZE", width: 2000, height: 5000 },
  });
  assert.equal(pf.style.width, "600px", "width must clamp to 600px max");
  assert.equal(pf.style.height, "850px", "height must clamp to 850px max");
  assert.equal(pf.style.overflow, "hidden");

  // Tiny content clamps to the minimum band.
  emitWindowEvent("message", {
    source: frameWindow,
    data: { type: "PREVIEW_RESIZE", width: 100, height: 50 },
  });
  assert.equal(pf.style.width, "380px", "width must clamp to 380px min");
  assert.equal(pf.style.height, "180px", "height must clamp to 180px min");

  // Messages from a foreign source must be ignored (sandbox isolation).
  emitWindowEvent("message", {
    source: {},
    data: { type: "PREVIEW_RESIZE", width: 111, height: 222 },
  });
  assert.equal(pf.style.width, "380px", "foreign source messages must not resize the frame");
  assert.equal(pf.style.height, "180px", "foreign source messages must not resize the frame");
});

test("Extension Studio provides popup and stealth modes without kiosk", () => {
  const html = renderDashboardHtml({});
  assert.match(html, /Обычный режим/);
  assert.match(html, /Скрытый агент/);
  assert.doesNotMatch(html, /Режим киоска/i);
  assert.doesNotMatch(html, /Kiosk \/ Restricted/i);
});

test("generateExtensionFiles always generates popup.html and popup.js in memory even in stealth mode", () => {
  const files = generateExtensionFiles({
    name: "Test Ext",
    shortName: "Test",
    version: "1.0.0",
    serverUrl: "https://proxy.example.com",
    uiMode: "stealth"
  });

  assert.ok(files, "generateExtensionFiles returns an object with files");
  assert.ok(files["popup.html"], "popup.html is present in memory for preview");
  assert.ok(files["popup.js"], "popup.js is present in memory for preview");
});

test("generateExtensionFiles omits action from manifest in stealth mode", () => {
  const files = generateExtensionFiles({
    name: "Stealth Ext",
    shortName: "Stealth",
    version: "1.0.0",
    uiMode: "stealth"
  });
  const manifest = JSON.parse(files["manifest.json"] as string);
  assert.equal(manifest.action, undefined, "manifest.action must be omitted in stealth mode");
});

test("generateExtensionFiles generates icon files from customIconDataUrl or emoji", () => {
  const sampleDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const filesWithCustom = generateExtensionFiles({
    name: "Custom Icon Ext",
    shortName: "Custom",
    version: "1.0.0",
    customIconDataUrl: sampleDataUrl,
  });

  assert.ok(filesWithCustom["icon16.png"], "icon16.png is generated");
  assert.ok(filesWithCustom["icon48.png"], "icon48.png is generated");
  assert.ok(filesWithCustom["icon128.png"], "icon128.png is generated");
  assert.ok(filesWithCustom["icon.png"], "icon.png is generated");
});

test("parseDataUrlBuffer returns null for empty, blank, or invalid base64 data URLs", () => {
  assert.equal(parseDataUrlBuffer(""), null);
  assert.equal(parseDataUrlBuffer(undefined), null);
  assert.equal(parseDataUrlBuffer("data:image/png;base64,"), null);
  assert.equal(parseDataUrlBuffer("not-a-data-url"), null);
});

test("generateExtensionFiles escapes customIconDataUrl in SVG preview to prevent attribute injection", () => {
  const maliciousDataUrl = 'data:image/png;base64,abc" onmouseover="alert(1)"';
  const files = generateExtensionFiles({
    name: "Injection Test",
    shortName: "Inject",
    version: "1.0.0",
    customIconDataUrl: maliciousDataUrl,
  });

  const svg = files["icon.svg"] as string;
  assert.ok(svg.includes("&quot;"), "quotes must be escaped in SVG href");
  assert.doesNotMatch(svg, /href="[^"]*"[^>]*onmouseover/);
});

test("dashboard.min.js applyUiModePreset saves by default and suppresses save on initial load (triggerSave=false)", () => {
  // AUDIT-QA-1: behavioral contract (was a source-shape regex on the orphaned
  // monolith). Default triggerSave=true schedules the 500ms debounced save via
  // onConfigChangeLive; triggerSave=false (initial load path) must not.
  const { ctx, getEl, pendingTimers } = createDashboardVmEnv();

  // Initial load path: explicit triggerSave=false — no extraneous save.
  ctx.window.applyUiModePreset("stealth", false);
  assert.equal(getEl("bldUiMode").value, "stealth");
  assert.equal(getEl("bldPresetBadge").textContent, "Stealth Agent");
  assert.ok(getEl("chip-stealth").classList.contains("active"), "stealth chip must be highlighted");
  assert.ok(!getEl("chip-popup").classList.contains("active"), "popup chip must be dimmed");
  assert.equal(
    pendingTimers().filter((t) => t.delay === 500).length,
    0,
    "triggerSave=false must not schedule the debounced config save"
  );

  // Default: triggerSave=true — debounced save is scheduled.
  ctx.window.applyUiModePreset("popup");
  assert.equal(getEl("bldPresetBadge").textContent, "Self-Service Pro");
  assert.ok(getEl("chip-popup").classList.contains("active"), "popup chip must be highlighted");
  assert.ok(!getEl("chip-stealth").classList.contains("active"), "stealth chip must be dimmed");
  assert.equal(
    pendingTimers().filter((t) => t.delay === 500).length,
    1,
    "default applyUiModePreset must schedule the 500ms debounced config save"
  );
});



