import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { registerPreviewThemeListener, notifyPreviewThemeChanged } from "../src/client/dashboard/core/state.js";
import { setServerTheme, setServerThemeMode, isThemeSyncEnabled } from "../src/client/dashboard/core/theme.js";

/**
 * THEME-APP-PREVIEW-1: panel palette/mode changes MUST reach the App Studio
 * live preview (UPDATE_STUDIO_THEME postMessage) — previously
 * updateLivePreviewThemeAndLayout() fired only from the locked studio
 * editors, so a panel palette switch never poked the preview at all.
 */

let installed: { dom: JSDOM; g: any; prev: any } | null = null;
let studioMod: typeof import("../src/client/dashboard/tabs/studio.js") | null = null;

async function installStudioDom(): Promise<{ posted: Array<any> }> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:3000/dashboard" });
  const g = globalThis as any;
  const prev = { window: g.window, document: g.document, ls: Object.getOwnPropertyDescriptor(g, "localStorage") };
  g.window = dom.window;
  g.document = dom.window.document;
  try {
    Object.defineProperty(g, "localStorage", { configurable: true, value: dom.window.localStorage });
  } catch {}

  // Simulated preview frame: captures the postMessage payloads
  const posted: Array<any> = [];
  const iframe: any = { contentWindow: { postMessage: (msg: any) => posted.push(msg) } };
  const origGet = dom.window.document.getElementById.bind(dom.window.document);
  dom.window.document.getElementById = (id: string) => (id === "previewFrame" ? iframe : origGet(id));
  g.document.getElementById = (id: string) => (id === "previewFrame" ? iframe : origGet(id));

  // Fire-and-forget appearance push (THEME-SRC-2) must resolve instantly
  // instead of racing the teardown.
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) }) as any;

  // studio.ts needs DOM at import time — dynamic import AFTER the DOM install
  studioMod = await import("../src/client/dashboard/tabs/studio.js");
  installed = { dom, g, prev };
  return { posted };
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

test("PREVIEW-1: panel palette change (setServerTheme) posts UPDATE_STUDIO_THEME with the panel palette", async () => {
  const { posted } = await installStudioDom();
  try {
    // Sync ON + panel cyber; subscribe the studio preview to the registry
    window.localStorage.setItem("pec_theme_sync_enabled", "true");
    assert.equal(isThemeSyncEnabled(), true);
    registerPreviewThemeListener(() => studioMod!.updateLivePreviewThemeAndLayout());

    setServerTheme("cyber");

    const themeMsgs = posted.filter((m) => m.type === "UPDATE_STUDIO_THEME");
    assert.ok(themeMsgs.length >= 1, "panel change must post UPDATE_STUDIO_THEME (was: zero postMessages)");
    assert.equal(themeMsgs[themeMsgs.length - 1].palette, "cyber", "postMessage palette must be the panel palette");
  } finally {
    await teardown();
  }
});

test("PREVIEW-1: panel palette switch re-posts with the NEW palette; mode rides too", async () => {
  const { posted } = await installStudioDom();
  try {
    window.localStorage.setItem("pec_theme_sync_enabled", "true");
    registerPreviewThemeListener(() => studioMod!.updateLivePreviewThemeAndLayout());

    setServerTheme("nord");
    assert.ok(posted.some((m) => m.type === "UPDATE_STUDIO_THEME" && m.palette === "nord"), "nord change must post");

    setServerTheme("emerald"); // panel switch -> repeated postMessage
    assert.ok(posted.some((m) => m.type === "UPDATE_STUDIO_THEME" && m.palette === "emerald"), "the NEW panel palette must be re-posted");

    setServerThemeMode("light");
    assert.ok(posted.some((m) => m.type === "UPDATE_STUDIO_THEME" && m.themeMode === "light"), "panel mode change must ride the postMessage too");
  } finally {
    await teardown();
  }
});

test("PREVIEW-1: sync OFF — constructor palette path does not regress", async () => {
  const { posted } = await installStudioDom();
  try {
    window.localStorage.setItem("pec_theme_sync_enabled", "false");
    assert.equal(isThemeSyncEnabled(), false);
    registerPreviewThemeListener(() => studioMod!.updateLivePreviewThemeAndLayout());

    setServerTheme("nord"); // panel change with sync OFF

    const msgs = posted.filter((m) => m.type === "UPDATE_STUDIO_THEME");
    assert.ok(msgs.length >= 1, "postMessage still fires (the studio palette view must exist)");
    assert.equal(msgs[msgs.length - 1].palette, "cyber", "sync OFF must NOT push the panel palette (constructor fallback)");
    assert.notEqual(msgs[msgs.length - 1].palette, "nord", "panel palette must not leak while sync is OFF");
  } finally {
    await teardown();
  }
});

test("PREVIEW-1: registry contract — duplicate subscribe keeps one entry, subscriber throw is swallowed", () => {
  let calls = 0;
  const fn = () => { calls++; };
  registerPreviewThemeListener(fn);
  registerPreviewThemeListener(fn); // duplicate must not double-register
  notifyPreviewThemeChanged();
  assert.equal(calls, 1, "duplicate subscribe must keep exactly one entry (one call per notify)");

  const throwing = () => { throw new Error("boom"); };
  registerPreviewThemeListener(throwing);
  assert.doesNotThrow(() => notifyPreviewThemeChanged(), "a throwing subscriber must be swallowed");
  assert.equal(calls, 2, "other subscribers still receive the notify after a throwing one");

  // Teardown-safe: unsubscribe-like cleanup by re-notify after window close
  // is covered implicitly by the studio subscriber swallowing in prior tests.
});
