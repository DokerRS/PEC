import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { renderPopupHtml, POPUP_THEME_TEMPLATE } from "../src/extensionTemplates.js";

/**
 * AUDIT-EXT-1: a server-side DISABLE_PROXY (kill-switch / AD revocation) must
 * not be overridable from the local popup toggle. SET_ENABLED(true) stays
 * refused while pecProxyState.serverDisabled is set; the next successful
 * sync (payload.ok === true) lifts the gate.
 */
test("EXT-1: SET_ENABLED(true) is blocked while server kill-switch is active, lifted after successful sync", async () => {
  const bgPath = path.resolve("extension/background.js");
  const src = fs.readFileSync(bgPath, "utf-8");

  const storedState: Record<string, unknown> = {
    pecProxyState: { enabled: false, serverDisabled: true },
    pecEnabled: false,
  };
  const setCalls: Array<Record<string, unknown>> = [];

  let fetchMode: "fail" | "ok" = "fail";
  const okSyncPayload = { ok: true, serverTime: new Date().toISOString() };

  let messageListener: any = null;

  const mockChrome: any = {
    storage: {
      local: {
        get: (keys: string[], cb: (res: any) => void) => {
          const res: Record<string, unknown> = {};
          for (const k of keys) res[k] = storedState[k];
          cb(res);
        },
        set: (obj: Record<string, unknown>) => {
          setCalls.push(obj);
          Object.assign(storedState, obj);
        },
        remove: () => {},
      },
      session: { get: (_k: string[], cb: (res: any) => void) => cb({}), set: () => {} },
    },
    alarms: { get: async () => null, create: () => {}, onAlarm: { addListener: () => {} } },
    privacy: { network: { webRTCIPHandlingPolicy: { set: () => {} } } },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    proxy: { settings: { set: async () => {} } },
    tabs: { onActivated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, query: async () => [] },
    webRequest: {
      onAuthRequired: { addListener: () => {} },
      onCompleted: { addListener: () => {} },
      onErrorOccurred: { addListener: () => {} },
    },
    runtime: {
      getManifest: () => ({ version: "1.0.0" }),
      id: "test-ext-id",
      onMessage: { addListener: (fn: any) => { messageListener = fn; } },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
  };

  const mockFetch = async (input: any, _init?: any) => {
    const url = String(input);
    if (fetchMode === "fail") {
      return { ok: false, status: 503, statusText: "Service Unavailable", clone: () => mockFetchResult({}), json: async () => ({}) };
    }
    if (url.includes("/api/sync")) {
      return mockFetchResult(okSyncPayload);
    }
    if (url.includes("/creds")) {
      return mockFetchResult({ user: "corp-user", pass: "rotated-pass" });
    }
    return mockFetchResult({});
  };
  const mockFetchResult = (payload: unknown) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    clone: () => mockFetchResult(payload),
    json: async () => payload,
  });

  const sandbox = {
    chrome: mockChrome,
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Date,
    URL,
    URLSearchParams,
    fetch: mockFetch,
    AbortSignal,
    Map,
    Set,
    Promise,
    JSON,
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(src, context);
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert.ok(messageListener, "onMessage listener must be registered");

  const sendMessage = (msg: any): Promise<any> =>
    new Promise((resolve) => {
      messageListener(msg, {}, (resp: any) => resolve(resp));
    });

  // Phase 1: kill-switch active -> re-enable refused
  const status1 = await sendMessage({ action: "GET_STATUS" });
  assert.equal(status1.serverDisabled, true, "restored state must keep serverDisabled");

  setCalls.length = 0;
  const blocked = await sendMessage({ action: "SET_ENABLED", enabled: true });
  assert.equal(blocked.ok, false, "SET_ENABLED(true) must be refused during kill-switch");
  assert.match(blocked.error || "", /server policy/i, `error must explain the server policy block, got: ${blocked.error}`);
  assert.ok(
    !setCalls.some((c) => "pecEnabled" in c && c.pecEnabled === true),
    "blocked re-enable must not persist pecEnabled=true"
  );

  const status2 = await sendMessage({ action: "GET_STATUS" });
  assert.equal(status2.serverDisabled, true, "kill-switch flag must survive the blocked attempt");
  assert.equal(status2.enabled, false, "enabled must stay false");

  // Phase 2: successful sync lifts the gate
  fetchMode = "ok";
  const synced = await sendMessage({ action: "FORCE_SYNC" });
  assert.equal(synced.ok, true, `FORCE_SYNC must succeed with a healthy server mock, got: ${JSON.stringify(synced).slice(0, 120)}`);
  assert.equal(synced.serverDisabled, false, "successful sync (payload.ok=true) must clear serverDisabled");

  const enabledResp = await sendMessage({ action: "SET_ENABLED", enabled: true });
  assert.equal(enabledResp.ok, true, `re-enable must work after a successful sync, got: ${JSON.stringify(enabledResp).slice(0, 120)}`);
  assert.equal(enabledResp.enabled, true);
});

/**
 * AUDIT-EXT-2: MV3 CSP (script-src 'self') silently blocks inline scripts in
 * extension pages. The theme bootstrap must ship as an external file
 * (popupTheme.js) referenced from <head>, both in the renderer output and in
 * the synced extension/ sources.
 */
test("EXT-2: popup.html has no inline scripts and loads popupTheme.js externally (MV3 CSP)", () => {
  const html = renderPopupHtml();
  assert.ok(!/<script>\s/.test(html), "no inline <script> bodies are allowed under MV3 CSP");
  assert.ok(!/<script[^>]*>\s*[^<\s]/.test(html), "script tags must be reference-only (src), never inline");
  assert.ok(
    /<script\s+src="popupTheme\.js"><\/script>/.test(html),
    "popup.html must load the external theme bootstrap before first paint"
  );
  assert.ok(html.includes('data-theme="dark"'), "CSS dark-theme defaults must remain for pre-JS render");

  const syncedHtml = fs.readFileSync(path.resolve("extension/popup.html"), "utf-8");
  assert.ok(syncedHtml.includes('<script src="popupTheme.js"></script>'), "synced extension/popup.html must reference popupTheme.js");
  assert.ok(!/<script>\s/.test(syncedHtml), "synced extension/popup.html must not contain inline scripts");

  const themeFile = fs.readFileSync(path.resolve("extension/popupTheme.js"), "utf-8");
  assert.equal(themeFile, POPUP_THEME_TEMPLATE, "extension/popupTheme.js must be the synced template copy");
  assert.ok(themeFile.includes('localStorage.getItem("pec_theme_mode")'), "bootstrap must read the persisted theme");
  assert.ok(themeFile.includes('setAttribute("data-theme"'), "bootstrap must apply the theme attribute");
});

test("EXT-2: popupTheme.js applies the persisted theme before first paint", () => {
  const setOnRoot: Array<[string, string]> = [];
  const domListeners: Array<() => void> = [];
  const sandbox = {
    localStorage: { getItem: () => "light" },
    window: { matchMedia: () => ({ matches: false }) },
    document: {
      documentElement: { setAttribute: (k: string, v: string) => setOnRoot.push([k, v]) },
      body: null,
      addEventListener: (_t: string, fn: () => void) => domListeners.push(fn),
    },
  };
  vm.runInContext(POPUP_THEME_TEMPLATE, vm.createContext(sandbox));
  assert.deepEqual(setOnRoot, [["data-theme", "light"]], "root data-theme must be set synchronously");
  assert.ok(domListeners.length >= 1, "DOMContentLoaded fallback must be registered while body is absent");
});
