import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { renderPopupJs } from "../src/templates/popupJsTemplate.js";
import { renderPopupHtml } from "../src/templates/popupHtmlTemplate.js";
import { BACKGROUND_TEMPLATE } from "../src/templates/backgroundTemplate.js";

/**
 * THEME-SRC-FIX-3: the popup applies the server theme mode with the
 * dashboard-as-source priority. While the global sync toggle is ON
 * (payload.theme.source === "dashboard") the server mode wins over the
 * local popup toggle; with source === "constructor" (sync OFF) the local
 * toggle stays in charge and nothing is applied.
 *
 * Background contract: the sync response theme is persisted into
 * currentProxyState.serverTheme (palette/mode/source) and rides GET_STATUS
 * spreads; popup.js applyPopupState consumes it.
 */

function loadPopupInDom(): { dom: JSDOM; window: any } {
  const html = renderPopupHtml();
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:3000/popup.html" });
  const js = renderPopupJs();
  const ctx = dom.getInternalVMContext();
  assert.ok(ctx, "JSDOM internal VM context must exist with runScripts=outside-only");
  vm.runInContext(js, ctx);
  return { dom, window: dom.window as any };
}

test("FIX-3: applyPopupState applies the dashboard theme mode while source=dashboard", () => {
  const { dom, window } = loadPopupInDom();
  try {
    // Local preference is dark; the server says light (dashboard sync ON)
    window.document.body.setAttribute("data-theme", "dark");
    window.document.documentElement.setAttribute("data-theme", "dark");

    window.applyPopupState({
      online: true,
      enabled: true,
      serverTheme: { palette: "light", mode: "light", source: "dashboard" },
    });

    assert.equal(
      window.document.body.getAttribute("data-theme"),
      "light",
      "server theme (dashboard source) must override the local data-theme"
    );
    assert.equal(window.document.documentElement.getAttribute("data-theme"), "light");
    assert.equal(window.localStorage.getItem("pec_theme_mode"), "light", "applied mode is remembered as the popup preference");
  } finally {
    dom.window.close();
  }
});

test("FIX-3: source=constructor keeps the local toggle in charge (no regression)", () => {
  const { dom, window } = loadPopupInDom();
  try {
    window.document.body.setAttribute("data-theme", "dark");
    window.document.documentElement.setAttribute("data-theme", "dark");
    window.localStorage.setItem("pec_theme_mode", "dark");

    window.applyPopupState({
      online: true,
      enabled: true,
      serverTheme: { palette: "nord", mode: "light", source: "constructor" },
    });

    assert.equal(
      window.document.body.getAttribute("data-theme"),
      "dark",
      "constructor source (sync OFF) must NOT override the local data-theme"
    );

    // No serverTheme at all (older background or pre-feature build): same
    window.applyPopupState({ online: true, enabled: true });
    assert.equal(window.document.body.getAttribute("data-theme"), "dark", "absent serverTheme must not change the theme");
  } finally {
    dom.window.close();
  }
});

test("FIX-3: background template persists payload.theme into currentProxyState.serverTheme", () => {
  const src = BACKGROUND_TEMPLATE;
  assert.ok(
    src.includes("currentProxyState.serverTheme = {"),
    "background must persist the sync response theme (palette/mode/source)"
  );
  assert.ok(
    src.includes("payload.theme.source === \"dashboard\" ? \"dashboard\" : \"constructor\""),
    "the source marker must survive background normalization"
  );
  assert.ok(src.includes("serverTheme: null,"), "default state must carry the serverTheme slot");

  // Popup side: applyPopupState consumes serverTheme with the dashboard priority
  const popupSrc = renderPopupJs();
  assert.ok(
    popupSrc.includes('response.serverTheme.source === "dashboard"'),
    "popup must gate theme application on the dashboard source marker"
  );
  assert.ok(
    popupSrc.includes("applyTheme(response.serverTheme.mode)"),
    "popup must apply the server mode through the shared applyTheme path"
  );
  // Toggle contract documented (THEME-SRC-FIX-3 (b)): the next sync overrides the local choice
  assert.ok(
    popupSrc.includes("overrides this choice") || popupSrc.includes("перекроет выбор"),
    "the local toggle title must document the server-override contract"
  );
  // The synced extension copy matches the template
  // (EOL-tolerant: autocrlf checkouts on windows runners materialize CRLF on
  // disk while the canonical template ships LF - content equality is the
  // contract, same normalization as the popupTheme.js sync assert)
  const synced = fs.readFileSync(path.resolve("extension/popup.js"), "utf-8").replace(/\r\n/g, "\n");
  assert.equal(synced, popupSrc.replace(/\r\n/g, "\n"), "extension/popup.js must be the synced template copy (sync:templates)");
});
