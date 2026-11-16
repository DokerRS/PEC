import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

/**
 * Shared vm sandbox for behavioral tests against the shipped dashboard bundle
 * (public/dashboard.min.js). Complements helpers/dashboardDom.ts (JSDOM stand):
 * this variant provides lightweight mock elements plus deterministic
 * instrumentation of setTimeout, so debounced-save contracts (onConfigChangeLive
 * schedules saveBuilderConfigOnly after 500ms) can be asserted without real
 * timers or sleeps (AUDIT-QA-1 / AUDIT-QA-P3).
 */

const DASHBOARD_BUNDLE_PATH = path.resolve("public/dashboard.min.js");

export interface PendingTimer {
  id: number;
  fn: () => void;
  delay: number;
}

export interface DashboardVmEnv {
  ctx: any;
  /** Auto-creating mock element registry (same pattern as dashboardAppStudio suites). */
  getEl: (id: string) => any;
  /** Timers currently scheduled inside the sandbox (setTimeout recorder). */
  pendingTimers: () => PendingTimer[];
  /** Flush all pending timers immediately (run debounced callbacks now). */
  flushTimers: () => void;
  /** Dispatch a synthetic window event to listeners registered by the bundle. */
  emitWindowEvent: (type: string, event: any) => void;
  fetchCalls: Array<{ url: string; method?: string; body?: any }>;
}

export function createDashboardVmEnv(
  fetchHandler: (url: string, opts?: any) => Promise<any> = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    blob: async () => ({}),
  })
): DashboardVmEnv {
  const dashboardJs = fs.readFileSync(DASHBOARD_BUNDLE_PATH, "utf-8");

  const elements: Record<string, any> = {};
  const getEl = (id: string) => {
    if (!elements[id]) {
      const classSet = new Set<string>();
      const customStyles: Record<string, string> = { display: "block" };
      elements[id] = {
        id,
        value: "",
        textContent: "",
        innerHTML: "",
        checked: false,
        disabled: false,
        files: [],
        style: new Proxy(customStyles, {
          get(target, prop: string) {
            if (prop === "setProperty") {
              return (k: string, v: string) => {
                target[k] = v;
              };
            }
            return target[prop];
          },
          set(target, prop: string, val: string) {
            target[prop] = val;
            return true;
          },
        }),
        classList: {
          classes: classSet,
          add: (c: string) => classSet.add(c),
          remove: (c: string) => classSet.delete(c),
          toggle: (c: string, force?: boolean) => {
            if (force === true) classSet.add(c);
            else if (force === false) classSet.delete(c);
            else if (classSet.has(c)) classSet.delete(c);
            else classSet.add(c);
          },
          contains: (c: string) => classSet.has(c),
        },
        children: [] as any[],
        appendChild(child: any) {
          this.children.push(child);
        },
        removeChild(child: any) {
          this.children = this.children.filter((x: any) => x !== child);
        },
        remove() {},
        addEventListener() {},
        removeEventListener() {},
        setAttribute(k: string, v: any) {
          (this as any)[k] = v;
        },
        getAttribute(k: string) {
          return (this as any)[k] ?? null;
        },
        focus() {},
        click() {},
      };
    }
    return elements[id];
  };

  const fetchCalls: Array<{ url: string; method?: string; body?: any }> = [];
  const timers = new Map<number, PendingTimer>();
  const windowListeners: Array<{ type: string; fn: (e: any) => void }> = [];
  let timerSeq = 1;

  const sandbox: any = {
    window: {
      addEventListener: (type: string, fn: (e: any) => void) => {
        windowListeners.push({ type, fn });
      },
      removeEventListener: () => {},
      location: { href: "http://localhost:3000", origin: "http://localhost:3000" },
    },
    // index.ts boot reads localStorage at module top-level
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    document: {
      getElementById: getEl,
      querySelector: (sel: string) => {
        if (sel.startsWith("#")) return getEl(sel.slice(1));
        return getEl("mock_" + sel);
      },
      querySelectorAll: () => [],
      createElement: (tag: string) => {
        const el = getEl("created_" + Math.random().toString(36).slice(2, 8));
        el.tagName = tag.toUpperCase();
        return el;
      },
      body: getEl("body"),
      activeElement: null,
      addEventListener: () => {},
    },
    fetch: async (url: string, opts?: any) => {
      fetchCalls.push({ url, method: opts?.method, body: opts?.body });
      return fetchHandler(url, opts);
    },
    URL: {
      createObjectURL: () => "blob:mock-url",
      revokeObjectURL: () => {},
    },
    setTimeout: (fn: () => void, delay = 0) => {
      const id = timerSeq++;
      timers.set(id, { id, fn, delay });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    setInterval: () => 1,
    clearInterval: () => {},
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
      info: () => {},
    },
    Date: global.Date,
    Math: global.Math,
    JSON: global.JSON,
    Array: global.Array,
    Object: global.Object,
    String: global.String,
    Number: global.Number,
    Boolean: global.Boolean,
    RegExp: global.RegExp,
    Promise: global.Promise,
  };

  sandbox.window.document = sandbox.document;
  sandbox.window.fetch = sandbox.fetch;
  sandbox.global = sandbox.window;
  sandbox.self = sandbox.window;

  // studio.ts bridges currentLang via Object.defineProperty(window, ...) — in a
  // real browser window IS the global object; in this vm sandbox it is not, so
  // bare `currentLang` reads must delegate to the window property.
  Object.defineProperty(sandbox, "currentLang", {
    configurable: true,
    get() {
      return sandbox.window.currentLang;
    },
    set(v: string) {
      sandbox.window.currentLang = v;
    },
  });

  const ctx = vm.createContext(sandbox);
  vm.runInContext(dashboardJs, ctx);

  return {
    ctx,
    getEl,
    pendingTimers: () => Array.from(timers.values()),
    flushTimers: () => {
      const pending = Array.from(timers.values());
      timers.clear();
      for (const t of pending) t.fn();
    },
    emitWindowEvent: (type: string, event: any) => {
      for (const l of windowListeners.filter((x) => x.type === type)) l.fn(event);
    },
    fetchCalls,
  };
}
