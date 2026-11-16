import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * AUDIT-QA-P3: unit tests for the modular dashboard client sources
 * (src/client/dashboard/core/*) — previously these modules were only covered
 * indirectly through the esbuild bundle (public/dashboard.min.js).
 */
import { I18N } from "../src/client/dashboard/core/i18n.js";
import { state } from "../src/client/dashboard/core/state.js";
import { esc, extractError } from "../src/client/dashboard/core/api.js";
import { APP_PALETTES, APP_THEME_PRESETS, setServerTheme, setServerThemeMode, setServerLayout } from "../src/client/dashboard/core/theme.js";
import { toast } from "../src/client/dashboard/core/notify.js";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:3000/dashboard" });
  const g = globalThis as any;
  g.window = dom.window;
  g.document = dom.window.document;
  g.localStorage = dom.window.localStorage;
  return dom;
}

test("dashboardClientUnits: i18n dictionaries keep EN/RU key parity without empty values", () => {
  const enKeys = Object.keys(I18N.en).sort();
  const ruKeys = Object.keys(I18N.ru).sort();
  assert.deepEqual(enKeys, ruKeys, "EN and RU dictionaries must have identical key sets");
  assert.ok(enKeys.length > 300, `dictionary must remain comprehensive (got ${enKeys.length} keys)`);

  for (const lang of ["en", "ru"]) {
    for (const [key, value] of Object.entries(I18N[lang])) {
      assert.equal(typeof value, "string", `${lang}.${key} must be a string`);
      assert.ok((value as string).length > 0, `${lang}.${key} must not be empty`);
    }
  }
});

test("dashboardClientUnits: initial state shape is safe defaults", () => {
  assert.equal(state.currentLang, "ru");
  assert.equal(state.globalKillSwitch, false);
  assert.equal(state.isDashboardAuthenticated, false);
  assert.deepEqual(state.currentProxiesList, []);
  assert.deepEqual(state.allProfiles, []);
});

test("dashboardClientUnits: esc() escapes all HTML-significant characters", () => {
  assert.equal(esc(`<a href="x" class='y'>&\``), "&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;&amp;&#96;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
});

test("dashboardClientUnits: extractError honors precedence data.error > message > detail > HTTP > default", () => {
  const res500 = { status: 500 } as Response;
  assert.equal(extractError(res500, { error: "boom" }), "boom");
  assert.equal(extractError(res500, { message: "msg" }), "msg");
  assert.equal(extractError(res500, { detail: "det" }), "det");
  assert.equal(extractError(res500, undefined, "fallback"), "fallback (500)");
  assert.equal(extractError(res500, undefined, undefined), "HTTP Error (500)");
  assert.equal(extractError(undefined, undefined, "fallback"), "fallback");
  assert.equal(extractError(undefined, undefined, undefined), "Request failed");
});

test("dashboardClientUnits: APP_THEME_PRESETS map onto defined APP_PALETTES entries", () => {
  for (const [preset, def] of Object.entries(APP_THEME_PRESETS)) {
    assert.ok(
      APP_PALETTES[def.palette],
      `preset ${preset} references palette ${def.palette} which must exist in APP_PALETTES`
    );
  }
});

test("dashboardClientUnits: server theme/layout setters update body attributes and persist to localStorage", () => {
  const dom = installDom();
  try {
    setServerTheme("obsidian");
    assert.equal(document.body.getAttribute("data-theme"), "obsidian");
    assert.equal(localStorage.getItem("pec_server_theme"), "obsidian");

    setServerThemeMode("light");
    assert.equal(document.body.getAttribute("data-theme-mode"), "light");
    assert.equal(localStorage.getItem("pec_server_theme_mode"), "light");

    // Invalid mode falls back to dark instead of writing garbage
    setServerThemeMode("banana");
    assert.equal(document.body.getAttribute("data-theme-mode"), "dark");

    setServerLayout("terminal");
    assert.equal(document.body.getAttribute("data-layout"), "terminal");
    assert.equal(localStorage.getItem("pec_server_layout"), "terminal");
  } finally {
    dom.window.close();
  }
});

test("dashboardClientUnits: toast() appends the message into #toastHost", () => {
  const dom = installDom();
  try {
    const host = document.createElement("div");
    host.id = "toastHost";
    document.body.appendChild(host);

    toast("Версия активирована", "success");

    assert.ok(host.children.length > 0, "toast must append a child element to #toastHost");
    assert.ok(host.textContent?.includes("Версия активирована"), "toast text must contain the message");
  } finally {
    dom.window.close();
  }
});
