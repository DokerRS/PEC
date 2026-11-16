import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_TEMPLATE } from "../src/extensionTemplates.js";
import { createDashboardVmEnv } from "./helpers/dashboardVm.js";

test("dashboardReviewFixes: highlightStyleChip is exposed on window and applies the mapped studio palette", () => {
  // AUDIT-QA-1: behavioral contract against the shipped bundle (was a source-
  // shape assert on the orphaned monolith). highlightStyleChip must map a style
  // key to a palette via setStudioPalette: palette chip highlight + brand color.
  const { ctx, getEl } = createDashboardVmEnv();

  assert.equal(typeof ctx.window.highlightStyleChip, "function", "highlightStyleChip must be exposed on window");

  ctx.window.highlightStyleChip("nord");
  assert.ok(getEl("chip-palette-nord").classList.contains("active"), "nord palette chip must be highlighted");
  assert.ok(!getEl("chip-palette-cyber").classList.contains("active"), "cyber chip must be dimmed");
  assert.equal(getEl("bldThemeColor").value, "#88c0d0", "brand color must follow the nord palette");

  ctx.window.highlightStyleChip("emerald-sentinel");
  assert.ok(getEl("chip-palette-emerald").classList.contains("active"), "emerald palette chip must be highlighted");
  assert.equal(getEl("bldThemeColor").value, "#34d399", "brand color must follow the emerald palette");
});

test("dashboardReviewFixes: setCustomIconDataUrl defaults triggerSave to false and displays saved icons", async () => {
  const ICON_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  // Part 1: direct call with default triggerSave=false — preview visible, no save.
  const { ctx, getEl, pendingTimers } = createDashboardVmEnv();
  ctx.window.setCustomIconDataUrl(ICON_URL, true);
  assert.equal(getEl("customIconPreviewImg").src, ICON_URL, "preview img must show the uploaded icon");
  assert.equal(getEl("customIconPreviewBox").style.display, "inline-flex", "preview box must be visible");
  assert.equal(
    pendingTimers().filter((t) => t.delay === 500).length,
    0,
    "default triggerSave=false must not schedule the debounced save"
  );

  // Explicit triggerSave=true does schedule the debounced save.
  ctx.window.setCustomIconDataUrl(ICON_URL, true, true);
  assert.equal(
    pendingTimers().filter((t) => t.delay === 500).length,
    1,
    "explicit triggerSave=true must schedule the debounced save"
  );

  // Clearing the icon hides the preview and resets the file input.
  getEl("iconFileInput").value = "C:\\fake\\icon.png";
  ctx.window.setCustomIconDataUrl("", false);
  assert.equal(getEl("customIconPreviewBox").style.display, "none", "preview box must hide on clear");
  assert.equal(getEl("customIconPreviewImg").src, "", "preview img must reset on clear");
  assert.equal(getEl("iconFileInput").value, "", "file input must reset on clear");

  // Part 2: loadBuilderConfig shows the saved icon (isUploaded=true) without saving.
  const env2 = createDashboardVmEnv(async (url: string) => {
    if (url === "/api/builder/config") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: "Corp", version: "1.0.0", customIconDataUrl: ICON_URL }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });

  await env2.ctx.window.loadBuilderConfig();
  assert.equal(env2.getEl("customIconPreviewImg").src, ICON_URL, "saved custom icon must render after loadBuilderConfig");
  assert.equal(env2.getEl("customIconPreviewBox").style.display, "inline-flex", "saved icon preview box must be visible");
  assert.equal(
    env2.pendingTimers().filter((t) => t.delay === 500).length,
    0,
    "loadBuilderConfig must not schedule a save for the saved custom icon"
  );
});

test("dashboardReviewFixes: applyPacScript caches downloaded PAC in chrome.storage.local", () => {
  const bgJs = fs.readFileSync(path.join(process.cwd(), "extension/background.js"), "utf-8");
  assert.ok(
    bgJs.includes("chrome.storage.local.set({ pecBasePac: text })"),
    "background.js must persist pecBasePac to chrome.storage.local"
  );
  assert.ok(
    BACKGROUND_TEMPLATE.includes("chrome.storage.local.set({ pecBasePac: text })"),
    "BACKGROUND_TEMPLATE must persist pecBasePac to chrome.storage.local"
  );
});
