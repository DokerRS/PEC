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
import {
  APP_PALETTES,
  APP_THEME_PRESETS,
  setServerTheme,
  setServerThemeMode,
  setServerLayout,
  setThemeSyncEnabled,
  isThemeSyncEnabled,
  toggleSyncThemeWithApps,
  toggleCustomizationPopover,
  applyThemeSyncToConstructors,
} from "../src/client/dashboard/core/theme.js";
import { toast } from "../src/client/dashboard/core/notify.js";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:3000/dashboard" });
  const g = globalThis as any;
  g.window = dom.window;
  g.document = dom.window.document;
  try {
    g.localStorage = dom.window.localStorage;
  } catch {
    // A previous test may have redefined global localStorage as getter-only —
    // reinstall it as a writable value property instead of plain assignment.
    Object.defineProperty(g, "localStorage", {
      configurable: true,
      writable: true,
      value: dom.window.localStorage,
    });
  }
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

// ---------------------------------------------------------------------------
// THEME-QA-2d: theme-sync API units (setThemeSyncEnabled / toggleSyncThemeWithApps
// / isThemeSyncEnabled). THEME-WEB-1 made the flag E2E: it must persist locally
// and fire-and-forget POST {themeSyncEnabled} into both config endpoints.
// ---------------------------------------------------------------------------

type RecordedRequest = { url: string; init: any };

function installDomWithFetch(): { dom: JSDOM; requests: RecordedRequest[]; failFetch: () => void } {
  const dom = installDom();
  const requests: RecordedRequest[] = [];
  let failing = false;
  (globalThis as any).fetch = async (url: any, init: any) => {
    requests.push({ url: String(url), init });
    if (failing) throw new Error("network down");
    return { ok: true, status: 200, json: async () => ({}) } as any;
  };
  return {
    dom,
    requests,
    failFetch: () => {
      failing = true;
    },
  };
}

test("dashboardClientUnits: isThemeSyncEnabled defaults to true and parses stored flags strictly", () => {
  const dom = installDom();
  try {
    assert.equal(isThemeSyncEnabled(), true, "no stored value must default to true (THEME-WEB-1 default)");

    localStorage.setItem("pec_theme_sync_enabled", "true");
    assert.equal(isThemeSyncEnabled(), true, "stored 'true' must read back true");

    localStorage.setItem("pec_theme_sync_enabled", "false");
    assert.equal(isThemeSyncEnabled(), false, "stored 'false' must read back false");

    localStorage.setItem("pec_theme_sync_enabled", "garbage");
    assert.equal(isThemeSyncEnabled(), false, "anything but 'true' must be treated as disabled");
  } finally {
    dom.window.close();
  }
});

test("dashboardClientUnits: isThemeSyncEnabled falls back to true when localStorage throws", () => {
  const dom = installDom();
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage blocked");
      },
    });
    assert.equal(isThemeSyncEnabled(), true, "storage failure must degrade to the safe default (sync on)");
  } finally {
    // Remove the poisoned getter so later tests can reinstall a real storage.
    delete (globalThis as any).localStorage;
    dom.window.close();
  }
});

test("dashboardClientUnits: setThemeSyncEnabled persists locally and pushes the flag to both config endpoints", async () => {
  const { dom, requests } = installDomWithFetch();
  try {
    setThemeSyncEnabled(false);

    assert.equal(localStorage.getItem("pec_theme_sync_enabled"), "false", "the flag must persist as 'false'");
    assert.equal(isThemeSyncEnabled(), false);

    const pushes = requests.filter((r) => r.init?.method === "POST");
    const urls = pushes.map((r) => r.url);
    assert.ok(urls.some((u) => u.includes("/api/builder/config")), "must POST /api/builder/config (THEME-WEB-1)");
    assert.ok(urls.some((u) => u.includes("/api/app-builder/config")), "must POST /api/app-builder/config (THEME-WEB-1)");
    for (const p of pushes) {
      assert.deepEqual(JSON.parse(p.init.body), { themeSyncEnabled: false });
    }
  } finally {
    dom.window.close();
  }
});

test("dashboardClientUnits: theme-sync push failures never break the local toggle", async () => {
  const { dom, failFetch } = installDomWithFetch();
  failFetch();
  try {
    assert.doesNotThrow(() => setThemeSyncEnabled(true), "fire-and-forget push must swallow network errors");
    // The local flip happened synchronously before the async push settles.
    assert.equal(isThemeSyncEnabled(), true);
    await new Promise((r) => setTimeout(r, 20)); // let the rejection drain
    assert.equal(isThemeSyncEnabled(), true, "state must stay flipped after the failed push");
  } finally {
    dom.window.close();
  }
});

test("dashboardClientUnits: toggleSyncThemeWithApps coerces string checkbox values", () => {
  const dom = installDom();
  try {
    toggleSyncThemeWithApps("true");
    assert.equal(isThemeSyncEnabled(), true, "string 'true' (inline onchange contract) must enable sync");

    toggleSyncThemeWithApps("false");
    assert.equal(isThemeSyncEnabled(), false, "string 'false' must disable sync");

    toggleSyncThemeWithApps(true);
    assert.equal(isThemeSyncEnabled(), true, "boolean true must enable sync");

    toggleSyncThemeWithApps(false);
    assert.equal(isThemeSyncEnabled(), false, "boolean false must disable sync");
  } finally {
    dom.window.close();
  }
});

test("dashboardClientUnits: toggleCustomizationPopover toggles the popover and honors preventDefault", () => {
  const dom = installDom();
  try {
    const popover = document.createElement("div");
    popover.id = "popoverCustomization";
    document.body.appendChild(popover);

    let prevented = false;
    toggleCustomizationPopover({ preventDefault: () => { prevented = true; } } as any);
    assert.ok(prevented, "the wrapper must preventDefault the triggering event");
    assert.equal(popover.style.display, "block", "first call must open the popover");

    toggleCustomizationPopover();
    assert.equal(popover.style.display, "none", "second call must close the popover");
  } finally {
    dom.window.close();
  }
});

test("dashboardClientUnits: applyThemeSyncToConstructors forces the checkbox to the stored flag", () => {
  const dom = installDom();
  try {
    const chk = document.createElement("input") as HTMLInputElement;
    chk.id = "chkSyncThemeWithApps";
    chk.checked = true; // UI state contradicts storage
    document.body.appendChild(chk);

    localStorage.setItem("pec_theme_sync_enabled", "false");
    applyThemeSyncToConstructors();
    assert.equal(chk.checked, false, "checkbox must be forced to the disabled stored flag");

    localStorage.setItem("pec_theme_sync_enabled", "true");
    chk.checked = false;
    applyThemeSyncToConstructors();
    assert.equal(chk.checked, true, "checkbox must be forced back to the enabled stored flag");
  } finally {
    dom.window.close();
  }
});
