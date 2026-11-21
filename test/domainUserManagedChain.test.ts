import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { generateGpoConfig } from "../src/packager.js";
import { registerHeartbeat, getActiveInstances, clearInstances } from "../src/instances.js";
import { getAppBuildConfig } from "../src/appPackager.js";

/**
 * EXT-DOMAINUSER-1: end-to-end domainUser identity chain.
 *
 * Chain contract: chrome.storage.managed (GPO/GPP) -> background
 * getManagedConfig() -> POST /api/sync body.domainUser. While the GPP
 * domainUser key is absent the machine stays Legacy; the first sync that
 * carries it clears isLegacy automatically (anti-spoofing invariant:
 * changing the identity on a live binding = 403 — asserted too).
 */

function loadBackgroundWithManaged(managedValues: Record<string, string>, captured: { syncBody: any | null }) {
  const src = fs.readFileSync(path.resolve("extension/background.js"), "utf-8");
  const syncRequests: Array<{ url: string; body: any }> = [];

  const sandbox: any = {
    chrome: {
      storage: {
        managed: {
          get: (_keys?: unknown, cb?: (v: unknown) => void) => {
            if (typeof cb === "function") cb(managedValues);
            return Promise.resolve(managedValues);
          },
        },
        local: {
          get: (_keys?: unknown, cb?: (v: unknown) => void) => {
            const res = {};
            if (typeof cb === "function") cb(res);
            return Promise.resolve(res);
          },
          set: (_obj: any, cb?: () => void) => {
            if (typeof cb === "function") cb();
            return Promise.resolve();
          },
        },
        session: {
          get: (_keys?: unknown, cb?: (v: unknown) => void) => {
            const res = {};
            if (typeof cb === "function") cb(res);
            return Promise.resolve(res);
          },
          set: (_obj: any, cb?: () => void) => {
            if (typeof cb === "function") cb();
            return Promise.resolve();
          },
        },
      },
      runtime: {
        id: "du-test-ext-id",
        getManifest: () => ({ version: "1.0.0" }),
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        onMessage: { addListener: () => {} },
        requestUpdateCheck: (cb?: (s: string) => void) => {
          if (cb) cb("no_update");
          return Promise.resolve(["no_update"]);
        },
      },
      alarms: {
        create: () => {},
        get: (_n: any, cb?: any) => {
          if (cb) cb(null);
          return Promise.resolve(null);
        },
        clear: () => {},
        onAlarm: { addListener: () => {} },
      },
      proxy: {
        settings: {
          set: (_cfg: any, cb?: any) => {
            if (cb) cb();
            return Promise.resolve();
          },
          get: (_cfg: any, cb?: any) => {
            if (cb) cb({ levelOfControl: "controlled_by_this_extension", value: { mode: "pac_script" } });
            return Promise.resolve({});
          },
        },
        onChange: { addListener: () => {} },
      },
      privacy: {
        network: {
          webRTCIPHandlingPolicy: {
            set: (_cfg: any, cb?: any) => {
              if (cb) cb();
              return Promise.resolve();
            },
          },
        },
      },
      action: {
        setBadgeText: () => {},
        setBadgeBackgroundColor: () => {},
        setBadgeTextColor: () => {},
      },
      webRequest: {
        onAuthRequired: { addListener: () => {} },
        onCompleted: { addListener: () => {} },
        onErrorOccurred: { addListener: () => {} },
      },
    },
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    setTimeout: (fn: Function, ms: number) => setTimeout(fn, ms),
    clearTimeout,
    setInterval: (fn: Function, ms: number) => setInterval(fn, ms),
    clearInterval,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    Promise,
    AbortSignal,
    URL,
    Map,
    Set,
    JSON,
    Math,
    fetch: (async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("/api/sync")) {
        captured.syncBody = JSON.parse(init.body);
        syncRequests.push({ url: u, body: captured.syncBody });
        registerHeartbeat({
          instanceId: captured.syncBody.instanceId,
          domainUser: captured.syncBody.domainUser,
          ip: "127.0.0.1",
          version: captured.syncBody.version || "1.0.0",
        });
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: async () => ({ ok: true, activeProxyId: "x" }) }),
          json: async () => ({ ok: true, activeProxyId: "x" }),
          headers: { get: () => null },
        };
      }
      return { ok: false, status: 404, clone: () => ({ json: async () => ({}) }), json: async () => ({}), headers: { get: () => null } };
    }) as any,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: "background.js" });
  return { ctx, sandbox, syncRequests };
}

test("DOMAINUSER-1 (a): managed domainUser rides the /api/sync payload (storage -> payload chain)", async () => {
  clearInstances();
  const captured: { syncBody: any | null } = { syncBody: null };
  const { syncRequests } = loadBackgroundWithManaged(
    {
      extToken: "test-admin-token",
      syncUrl: "http://127.0.0.1:3000/api/sync",
      credsUrl: "http://127.0.0.1:3000/creds",
      domainUser: "CORP\\j.doe",
    },
    captured
  );
  // Let the boot sync fire and settle
  for (let i = 0; i < 20; i++) {
    if (captured.syncBody) break;
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.ok(syncRequests.length >= 1, "boot sync must fire");
  assert.equal(
    captured.syncBody.domainUser,
    "CORP\\j.doe",
    "managed storage domainUser must ride the /api/sync payload verbatim"
  );

  // Server-side acceptance: the instance leaves Legacy on the first domainUser
  const inst = getActiveInstances().find((i) => i.instanceId === captured.syncBody.instanceId);
  assert.ok(inst, "instance registered by the sync handler in this test run is tracked locally");
  assert.equal(inst.isLegacy, false, "first domainUser must clear the Legacy flag");
  assert.equal(inst.domainUser, "CORP\\j.doe");
});

test("DOMAINUSER-1 (d): machine WITHOUT GPP domainUser stays Legacy; first domainUser clears it; identity switch = 403-class rejection", async () => {
  clearInstances();

  // 1. Machine with no domainUser in managed storage: registers as Legacy
  const reg = registerHeartbeat({
    instanceId: "inst_du_legacy",
    ip: "127.0.0.1",
    version: "1.3.0",
  });
  assert.equal(reg.isLegacy, true, "no domainUser -> machine stays Legacy");

  // 2. The first domainUser arrival clears Legacy automatically (verified invariant)
  const reg2 = registerHeartbeat({
    instanceId: "inst_du_legacy",
    ip: "127.0.0.1",
    version: "1.3.0",
    domainUser: "CORP\\j.doe",
  });
  assert.equal(reg2.isLegacy, false, "first domainUser must clear the Legacy flag");
  assert.equal(reg2.domainUser, "CORP\\j.doe");

  // 3. Anti-spoofing invariant: a different identity on a live binding is rejected
  clearInstances();
  const first = registerHeartbeat({ instanceId: "inst_du_bind", ip: "127.0.0.1", version: "1.3.0", domainUser: "CORP\\alice" });
  assert.equal(first.isLegacy, false);
  assert.equal(getActiveInstances().find((i) => i.instanceId === "inst_du_bind")!.domainUser, "CORP\\alice");
  const attempt = registerHeartbeat({ instanceId: "inst_du_bind", ip: "127.0.0.1", version: "1.3.0", domainUser: "CORP\\mallory" });
  assert.equal(attempt.domainUser, "CORP\\alice", "spoofed identity must NOT overwrite the live binding");
  void getAppBuildConfig;
});

test("DOMAINUSER-1 (b): generated GPO .reg policies configure managed storage domainUser to %USERDOMAIN%\\%USERNAME%", () => {
  const gpo = generateGpoConfig(
    "testextid0000000000000000000000000000000000",
    "https://pec.corp.local",
    "tok",
    { targetGroup: "SEC-Proxy-Users" }
  );

  assert.ok(
    gpo.regContentUser.includes('"domainUser"="%USERDOMAIN%\\\\%USERNAME%"'),
    "regContentUser must include domainUser set to %USERDOMAIN%\\%USERNAME%"
  );
  assert.ok(
    gpo.regContentMachine.includes('"domainUser"="%USERDOMAIN%\\\\%USERNAME%"'),
    "regContentMachine must include domainUser set to %USERDOMAIN%\\%USERNAME%"
  );
});
