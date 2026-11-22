import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { registerPreviewThemeListener, notifyPreviewThemeChanged } from "../src/client/dashboard/core/state.js";
import { setServerTheme, setServerThemeMode, isThemeSyncEnabled } from "../src/client/dashboard/core/theme.js";

/**
 * THEME-APP-PREVIEW-1 (layer 2): the locked App Studio inputs show the
 * RESOLVED panel surfaces while sync is ON (preview == artifact), and the
 * saved constructor values return without loss when sync is turned OFF.
 *
 * User case: panel = cyber (#38bdf8), constructor config themeColor =
 * #c084fc (Dark Obsidian era) -> the locked inputs and the App preview show
 * #38bdf8, not purple; OFF -> #c084fc returns from the saved config.
 */

let installed: { dom: JSDOM; g: any; prev: any } | null = null;
let studioMod: typeof import("../src/client/dashboard/tabs/studio.js") | null = null;

async function installStudioDom(): Promise<void> {
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
    '<div id="appPreviewWindow"></div>' +
    '<input type="color" id="appThemeColor" />' +
    '<input type="color" id="appThemeBackground" />' +
    '<input type="color" id="appThemeCard" />' +
    "</body></html>",
    { url: "http://localhost:3000/dashboard" }
  );
  const g = globalThis as any;
  const prev = { window: g.window, document: g.document, ls: Object.getOwnPropertyDescriptor(g, "localStorage") };
  g.window = dom.window;
  g.document = dom.window.document;
  try {
    Object.defineProperty(g, "localStorage", { configurable: true, value: dom.window.localStorage });
  } catch {}
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) }) as any;

  studioMod = await import("../src/client/dashboard/tabs/studio.js");
  installed = { dom, g, prev };
}

async function teardown(): Promise<void> {
  if (!installed) return;
  const { dom, g, prev } = installed;
  await new Promise((r) => setImmediate(() => setImmediate(r)));
  if (prev.ls) Object.defineProperty(g, "localStorage", prev.ls);
  else delete g.localStorage;
  g.document = prev.document;
  g.window = prev.window;
  dom.window.close();
  installed = null;
  studioMod = null;
}

function seedAppInputs(color: string, bg: string, card: string): void {
  const set = (id: string, v: string) => {
    const el = globalThis.document.getElementById(id);
    if (el) (el as HTMLInputElement).value = v;
  };
  set("appThemeColor", color);
  set("appThemeBackground", bg);
  set("appThemeCard", card);
}

function readAppInputs(): { color: string; bg: string; card: string } {
  const get = (id: string) => ((globalThis.document.getElementById(id) as HTMLInputElement) || { value: "" }).value;
  return { color: get("appThemeColor"), bg: get("appThemeBackground"), card: get("appThemeCard") };
}

function seedServerTheme(palette: string, mode: string, syncEnabled: boolean): void {
  globalThis.document.body.setAttribute("data-theme", palette);
  globalThis.document.body.setAttribute("data-theme-mode", mode);
  window.localStorage.setItem("pec_theme_sync_enabled", syncEnabled ? "true" : "false");
  // state.currentLang default is fine; publish via the registry like theme.ts does
  notifyPanelViaThemeApi(palette, mode);
}

function notifyPanelViaThemeApi(palette: string, mode: string): void {
  setServerTheme(palette);
  setServerThemeMode(mode);
}

test("PREVIEW-2 (d): sync ON + config #c084fc + panel cyber -> inputs and preview resolve to #38bdf8", async () => {
  await installStudioDom();
  try {
    // Constructor config is Dark Obsidian era
    seedAppInputs("#c084fc", "#0d1117", "#161b22");
    seedServerTheme("cyber", "dark", true); // sync ON, panel cyber
    // Simulate the registry notify like a panel change does
    notifyPreviewThemeChanged();

    const inputs = readAppInputs();
    assert.equal(inputs.color, "#38bdf8", "locked accent input must show the resolved panel accent");
    assert.equal(inputs.bg, "#0b1120", "locked bg input must show the resolved panel bg");
    assert.equal(inputs.card, "#131d36", "locked card input must show the resolved panel card");
  } finally {
    await teardown();
  }
});

test("PREVIEW-2: light panel mode resolves light surfaces over the constructor config", async () => {
  await installStudioDom();
  try {
    seedAppInputs("#c084fc", "#0d1117", "#161b22");
    seedServerTheme("light", "light", true);
    notifyPreviewThemeChanged();

    const inputs = readAppInputs();
    assert.equal(inputs.color, "#2563eb", "light palette accent");
    assert.equal(inputs.bg, "#f1f5f9", "light palette bg");
    assert.equal(inputs.card, "#ffffff", "light palette card");
  } finally {
    await teardown();
  }
});

test("PREVIEW-2 (d): sync OFF restores the saved constructor values without loss", async () => {
  await installStudioDom();
  try {
    // Constructor config holds the Dark Obsidian era values
    const g = globalThis as any;
    g.fetch = async (url: any) => {
      const u = String(url);
      if (u.includes("/api/app-builder/config")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            presetStyle: "dark-obsidian",
            themeColor: "#c084fc",
            themeBackground: "#0d1117",
            themeCard: "#161b22",
          }),
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({}) } as any;
    };

    // Boot path: ON + panel cyber — loadAppStudioConfig fills the constructor
    // values, then applyResolvedPanelThemeToAppInputs resolves the panel layer.
    seedServerTheme("cyber", "dark", true);
    await studioMod!.loadAppStudioConfig();
    const onInputs = readAppInputs();
    assert.equal(onInputs.color, "#38bdf8", "ON shows the panel accent after the config load");

    // OFF: notify fires applyResolvedPanelThemeToAppInputs -> saved values return
    seedServerTheme("cyber", "dark", false);
    assert.equal(isThemeSyncEnabled(), false);
    notifyPreviewThemeChanged();
    const inputs = readAppInputs();
    assert.equal(inputs.color, "#c084fc", "OFF restores the saved constructor accent");
    assert.equal(inputs.bg, "#0d1117", "OFF restores the saved constructor bg");
    assert.equal(inputs.card, "#161b22", "OFF restores the saved constructor card");
  } finally {
    await teardown();
  }
});

test("PREVIEW-2: panel switch re-resolves the inputs (cyber -> emerald)", async () => {
  await installStudioDom();
  try {
    seedAppInputs("#c084fc", "#0d1117", "#161b22");
    seedServerTheme("cyber", "dark", true);
    notifyPreviewThemeChanged();
    assert.equal(readAppInputs().color, "#38bdf8");

    setServerTheme("emerald"); // panel switch
    notifyPreviewThemeChanged();
    const inputs = readAppInputs();
    assert.equal(inputs.color, "#34d399", "emerald accent resolved");
    assert.equal(inputs.bg, "#06130d", "emerald bg resolved");
    assert.equal(inputs.card, "#0b1f16", "emerald card resolved");
  } finally {
    await teardown();
  }
});


test("PREVIEW-2 (e): saving the form while ON keeps the constructor theme in the config (no panel bleed)", async () => {
  await installStudioDom();
  try {
    const savedConfigs: Array<any> = [];
    const g = globalThis as any;
    g.fetch = async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("/api/app-builder/config") && init?.method === "POST") {
        savedConfigs.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      }
      if (u.includes("/api/app-builder/config")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            presetStyle: "dark-obsidian",
            themeColor: "#c084fc",
            themeBackground: "#0d1117",
            themeCard: "#161b22",
          }),
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({}) } as any;
    };

    seedServerTheme("cyber", "dark", true);
    await studioMod!.loadAppStudioConfig(); // inputs resolved to #38bdf8

    // User hits Save while the form is locked+resolved
    await studioMod!.saveAppStudioConfigAction(true);

    assert.ok(savedConfigs.length >= 1, "save must POST the config");
    const sent = savedConfigs[savedConfigs.length - 1];
    assert.equal(sent.themeColor, "#c084fc", "constructor accent must be persisted, not the panel one");
    assert.equal(sent.themeBackground, "#0d1117", "constructor bg must be persisted");
    assert.equal(sent.themeCard, "#161b22", "constructor card must be persisted");
    assert.equal(sent.presetStyle, "dark-obsidian", "constructor preset must be persisted");

    // OFF then restores the saved constructor theme in the inputs
    seedServerTheme("cyber", "dark", false);
    notifyPreviewThemeChanged();
    const inputs = readAppInputs();
    assert.equal(inputs.color, "#c084fc", "OFF restore uses the persisted constructor accent");
  } finally {
    await teardown();
  }
});
