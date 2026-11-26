import "./loadEnv.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns";
import { createRequire } from "node:module";
import type { Agent } from "undici";

const requireCompat = typeof require === "function" ? require : createRequire(path.resolve("package.json"));
import { RotationConfig, RotationHistoryItem, PanelRemnawaveConfig } from "./types.js";
import { writeJsonAtomic, readJsonStore, restrictSecretFilePermissions } from "./jsonStore.js";
import { getCredsStorePath, getRemnawavePanelsPath, getLegacy3xuiPanelsPath, getRotationConfigPath } from "./storage.js";
import { logger } from "./logger.js";
import { recordRotation } from "./metrics.js";
import type { RemnawaveConnection, RemnawaveSyncResult, RemnawaveUser } from "./remnawave.js";

export { getCredsStorePath, getRemnawavePanelsPath };

/**
 * The Remnawave client lives in remnawave.ts, which statically imports the
 * SSRF helpers exported here. Loading it through `import()` keeps the module
 * graph acyclic while still giving these call sites the real client.
 */
async function loadRemnawaveClient() {
  return import("./remnawave.js");
}

/**
 * Create the credentials store with a cryptographically random password if
 * it does not exist yet. Previously a hardcoded fallback password was baked
 * into two source locations.
 */
export function ensureCredsStore(storePath: string): { user: string; pass: string; updatedAt: string } {
  const creds = {
    user: "corp-user",
    pass: crypto.randomBytes(18).toString("base64url"),
    updatedAt: new Date().toISOString(),
  };
  atomicWriteCreds(storePath, creds);
  return creds;
}

export function readCurrentCreds(): { user: string; pass: string; updatedAt?: string } | null {
  const storePath = getCredsStorePath();
  try {
    if (fs.existsSync(storePath)) {
      const data = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      if (data && typeof data.user === "string" && typeof data.pass === "string") {
        return data;
      }
    } else {
      // Auto-heal missing creds store (random password, never a hardcoded one)
      const defaultCreds = ensureCredsStore(storePath);
      logger.info(`[rotate] Auto-healed missing creds store at ${storePath}`);
      return defaultCreds;
    }
  } catch (err) {
    logger.error("[rotate] Error reading creds store:", err);
  }
  return null;
}

/**
 * Async variant for request hot paths (/creds, /api/sync, /api/status):
 * fs.promises keeps the event loop free while the store is read from disk.
 * The sync version above stays for startup and cold-path callers.
 */
export async function readCurrentCredsAsync(): Promise<{ user: string; pass: string; updatedAt?: string } | null> {
  const storePath = getCredsStorePath();
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data.user === "string" && typeof data.pass === "string") {
      return data;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      // Auto-heal missing creds store (rare; the sync write is fine here)
      const defaultCreds = ensureCredsStore(storePath);
      logger.info(`[rotate] Auto-healed missing creds store at ${storePath}`);
      return defaultCreds;
    }
    logger.error("[rotate] Error reading creds store:", err);
  }
  return null;
}

export function atomicWriteCreds(filePath: string, creds: { user: string; pass: string; updatedAt?: string }) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const withTimestamp = {
    ...creds,
    updatedAt: creds.updatedAt || new Date().toISOString(),
  };

  const tempFile = path.join(dir, `${path.basename(filePath)}.tmp.${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(tempFile, JSON.stringify(withTimestamp, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tempFile, filePath);
}

/**
 * AUDIT-SRV-3: rotation local persistence with transient-failure retries.
 * Windows AV/indexer can hold the creds file (EPERM/EBUSY) for a moment вЂ”
 * failing the whole rotation over a retryable rename would desync the fleet
 * for no reason.
 */
export function atomicWriteCredsWithRetries(
  filePath: string,
  creds: { user: string; pass: string; updatedAt?: string },
  attempts = 3
): void {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      atomicWriteCreds(filePath, creds);
      return;
    } catch (err) {
      lastErr = err;
      logger.warn(`[rotate] Local creds store write attempt ${attempt}/${attempts} failed:`, err);
    }
  }
  throw lastErr;
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "0:0:0:0:0:0:0:1" ||
    hostname === "::" ||
    hostname === "0.0.0.0"
  ) {
    return true;
  }
  if (hostname.startsWith("127.")) {
    return true;
  }

  // Handle IPv4-mapped IPv6 (e.g. "::ffff:127.0.0.1" or Node's normalized "::ffff:7f00:1")
  let cleanHost = hostname;
  if (cleanHost.startsWith("::ffff:") || cleanHost.startsWith("0:0:0:0:0:ffff:")) {
    const rest = cleanHost.replace(/^(?:0:0:0:0:0:ffff:|::ffff:)/, "");
    if (rest.includes(":")) {
      const parts = rest.split(":");
      if (parts.length === 2) {
        const n1 = parseInt(parts[0], 16);
        const n2 = parseInt(parts[1], 16);
        if (!isNaN(n1) && !isNaN(n2)) {
          cleanHost = `${(n1 >> 8) & 0xff}.${n1 & 0xff}.${(n2 >> 8) & 0xff}.${n2 & 0xff}`;
        }
      }
    } else if (rest.includes(".")) {
      cleanHost = rest;
    }
  }

  // Unique local IPv6 (fc00::/7) or link-local IPv6 (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/i.test(cleanHost) || /^fe[89ab][0-9a-f]:/i.test(cleanHost)) {
    return true;
  }

  const match = cleanHost.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (match) {
    const o1 = parseInt(match[1], 10);
    const o2 = parseInt(match[2], 10);
    const o3 = parseInt(match[3], 10);
    const o4 = parseInt(match[4], 10);
    if (o1 <= 255 && o2 <= 255 && o3 <= 255 && o4 <= 255) {
      if (o1 === 10) return true;
      if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
      if (o1 === 192 && o2 === 168) return true;
      if (o1 === 127) return true;
      if (o1 === 0) return true;
      if (o1 === 169 && o2 === 254) return true;
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;
    }
  }
  return false;
}

export function validateSafeEndpointUrl(urlStr: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, error: "Only http:// or https:// protocol is permitted" };
    }
    // Node keeps IPv6 brackets in .hostname - strip them before matching.
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    // Block cloud metadata services and link-local addresses (SSRF guard)
    if (
      hostname === "169.254.169.254" ||
      hostname.startsWith("169.254.") ||
      hostname === "metadata.google.internal" ||
      hostname === "metadata.goog" ||
      hostname === "instance-data" ||
      // IPv6 forms of the same targets: AWS IMDSv1 endpoint and link-local
      hostname.startsWith("fd00:ec2:") ||
      hostname.startsWith("fe80:")
    ) {
      return { valid: false, error: "Access to cloud metadata endpoints is prohibited (SSRF prevention)" };
    }

    if (process.env.ALLOW_INTERNAL_PANEL !== "true" && isPrivateOrLoopbackHost(hostname)) {
      return {
        valid: false,
        error: "Access to loopback or private network endpoints is prohibited (SSRF prevention)",
      };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }
}

export interface EndpointValidationResult {
  valid: boolean;
  error?: string;
  /** DNS addresses verified during validation; consumed by SSRF TOCTOU pinning. */
  addresses?: Array<{ address: string; family: number }>;
}

/**
 * Asynchronous URL validation performing DNS IP resolution when ALLOW_INTERNAL_PANEL !== "true".
 * Blocks DNS rebinding attacks (e.g. *.nip.io resolving to 127.0.0.1 or RFC1918 addresses).
 * Returns the resolved addresses so callers can pin connections to them.
 */
export async function validateSafeEndpointUrlAsync(rawUrl: string): Promise<EndpointValidationResult> {
  const syncCheck = validateSafeEndpointUrl(rawUrl);
  if (!syncCheck.valid) return syncCheck;
  if (process.env.ALLOW_INTERNAL_PANEL === "true") return { valid: true };

  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const lookupResult = await dns.promises.lookup(hostname, { all: true });
    for (const addr of lookupResult) {
      if (isPrivateOrLoopbackHost(addr.address)) {
        return { valid: false, error: `Hostname resolves to private address ${addr.address} (SSRF prevention)` };
      }
    }
    return { valid: true, addresses: lookupResult };
  } catch (e: any) {
    return { valid: false, error: `DNS resolution failed: ${e?.message || e}` };
  }
}

let rotationInFlight = false;

export function isRotationInFlight(): boolean {
  return rotationInFlight;
}

export function setRotationInFlight(inFlight: boolean): void {
  rotationInFlight = inFlight;
}

/**
 * Panel fetches must never follow redirects: a 30x would silently send the
 * admin credentials (or an authorized request) to whatever target the panel
 * (or an attacker who controls it) points at. redirect:"manual" keeps the
 * 3xx response local; this helper turns it into a hard failure.
 */
function assertNoRedirect(res: Response, what: string): void {
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`${what}: panel returned redirect (${res.status}) - refused`);
  }
}

/**
 * Resolve whether TLS verification is skipped for a panel: an explicit
 * argument wins, then the stored panel entry, then the legacy global
 * `insecureSkipVerify` rotation setting.
 */
function resolveInsecureTls(panelUrl?: string, explicit?: boolean): boolean {
  if (explicit !== undefined) return Boolean(explicit);
  if (panelUrl) {
    try {
      const cleanUrl = panelUrl.replace(/\/+$/, "");
      const panelsFile = getRemnawavePanelsPath();
      const list = readJsonStore<PanelRemnawaveConfig[]>(panelsFile) || [];
      const p = list.find((item) => item.panelUrl.replace(/\/+$/, "") === cleanUrl);
      if (p && p.insecureTls !== undefined) {
        return Boolean(p.insecureTls);
      }
    } catch {}
  }
  try {
    const rotConfigFile = getRotationConfigPath();
    if (fs.existsSync(rotConfigFile)) {
      const rotData = JSON.parse(fs.readFileSync(rotConfigFile, "utf-8"));
      if (rotData && rotData.insecureSkipVerify !== undefined) {
        return Boolean(rotData.insecureSkipVerify);
      }
    }
  } catch {}
  return false;
}

let CachedUndiciAgent: any = null;

function loadUndiciAgent(): any {
  try {
    if (!CachedUndiciAgent) {
      // Lazy load to prevent crashes if undici package is not installed in runtime
      const undiciMod = requireCompat("undici");
      CachedUndiciAgent = undiciMod?.Agent || null;
    }
    return CachedUndiciAgent;
  } catch (e: any) {
    logger.warn("[rotate] Unable to load undici.Agent:", e?.message || e);
    return null;
  }
}

/**
 * Build an undici Agent carrying the handler-bridge shim required by Node's
 * global fetch (older fetch handler API vs. newer dispatch handler API).
 */
function buildBridgedAgent(connectOpts: { rejectUnauthorized?: boolean; lookup?: any }): Agent | undefined {
  const AgentCtor = loadUndiciAgent();
  if (!AgentCtor) return undefined;
  const agent = new AgentCtor({ connect: connectOpts }) as Agent;
  const origDispatch = (agent as any).dispatch.bind(agent);
  (agent as any).dispatch = function (opts: any, handler: any) {
    if (handler && typeof handler.onResponseStart !== "function") {
      const bridged = Object.create(handler);
      bridged.onRequestStart = () => {};
      bridged.onResponseError = (_ctrl: any, err: any) => handler.onError?.(err);
      bridged.onResponseStart = (_ctrl: any, status: number, headers: any, statusText: string) =>
        handler.onHeaders?.(status, headers, () => {}, statusText);
      bridged.onResponseData = (_ctrl: any, chunk: any) => handler.onData?.(chunk);
      bridged.onResponseEnd = (_ctrl: any, trailers: any) => handler.onComplete?.(trailers);
      return origDispatch(opts, bridged);
    }
    return origDispatch(opts, handler);
  };
  return agent;
}

function getFetchDispatcher(insecureTls?: boolean): Agent | undefined {
  if (!insecureTls) return undefined;
  return buildBridgedAgent({ rejectUnauthorized: false });
}

/**
 * SSRF TOCTOU pinning (AUDIT-SEC-2): validateSafeEndpointUrlAsync resolves and
 * vets the hostname, but a subsequent plain fetch() re-resolves DNS at connect
 * time вЂ” a rebinding attacker flips the record between check and use and the
 * authenticated panel request lands on 127.0.0.1 / RFC1918. The pinned lookup
 * freezes name resolution to the addresses that were actually verified.
 */
export function makePinnedLookup(hostname: string, pinned: Array<{ address: string; family: number }>) {
  const target = String(hostname || "").toLowerCase();
  return function pinnedLookup(hostnameArg: string, options: any, callback: any) {
    let cb = callback;
    let opts = options;
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    if (!pinned.length || String(hostnameArg || "").toLowerCase() !== target) {
      // Not the validated host (cannot happen inside panel flows) вЂ” normal DNS.
      return dns.lookup(hostnameArg, opts, cb);
    }
    const family = opts?.family ?? 0;
    const list = family === 4 || family === 6 ? pinned.filter((p) => p.family === family) : pinned;
    const serve = list.length ? list : pinned;
    if (opts?.all) {
      queueMicrotask(() => cb(null, serve.map((p) => ({ address: p.address, family: p.family }))));
    } else {
      queueMicrotask(() => cb(null, serve[0].address, serve[0].family));
    }
  };
}

export type SafeEndpointFetch = (url: string, init?: RequestInit) => Promise<globalThis.Response>;

export interface SsrfFetchPlan {
  valid: boolean;
  error?: string;
  /** fetch whose connections are pinned to the DNS-verified addresses */
  fetch: SafeEndpointFetch;
  /** Release dispatcher resources once the response body has been consumed */
  close(): void;
}

const ssrfDisabledFetch: SafeEndpointFetch = () => Promise.reject(new Error("SSRF validation failed"));

/**
 * Validate a remote URL and return a fetch function immune to DNS rebinding
 * between validation and connection. Degrades to the legacy plain-fetch
 * behavior only when undici is unavailable (preserves the pre-audit exposure
 * rather than breaking panel management outright).
 */
export async function createSsrfPinnedFetch(rawUrl: string, opts?: { insecureTls?: boolean }): Promise<SsrfFetchPlan> {
  const cleanUrl = String(rawUrl || "").trim().replace(/\/+$/, "");
  const isInsecure = resolveInsecureTls(cleanUrl, opts?.insecureTls);

  const syncCheck = validateSafeEndpointUrl(cleanUrl);
  if (!syncCheck.valid) {
    return { valid: false, error: syncCheck.error, fetch: ssrfDisabledFetch, close: () => {} };
  }

  if (process.env.ALLOW_INTERNAL_PANEL === "true") {
    // Operator explicitly allowed private endpoints: no DNS validation ran and
    // there is nothing to pin вЂ” keep the insecure-dispatcher semantics.
    const dispatcher = getFetchDispatcher(isInsecure);
    return {
      valid: true,
      fetch: (url, init) => fetch(url, { ...init, ...(dispatcher ? { dispatcher } : {}) }),
      close: () => {},
    };
  }

  const check = await validateSafeEndpointUrlAsync(cleanUrl);
  if (!check.valid) {
    return { valid: false, error: check.error, fetch: ssrfDisabledFetch, close: () => {} };
  }

  const addresses = check.addresses || [];
  let pinnedHost = "";
  try {
    pinnedHost = new URL(cleanUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    pinnedHost = "";
  }
  const dispatcher =
    addresses.length > 0 && pinnedHost
      ? buildBridgedAgent({ rejectUnauthorized: !isInsecure, lookup: makePinnedLookup(pinnedHost, addresses) })
      : undefined;

  if (!dispatcher) {
    const fallback = getFetchDispatcher(isInsecure);
    return {
      valid: true,
      fetch: (url, init) => fetch(url, { ...init, ...(fallback ? { dispatcher: fallback } : {}) }),
      close: () => {},
    };
  }

  logger.info(`[rotate] SSRF DNS pinning active: ${pinnedHost} -> ${addresses.map((a) => a.address).join(", ")}`);
  return {
    valid: true,
    fetch: (url, init) => fetch(url, { ...init, ...(dispatcher ? { dispatcher } : {}) }),
    close: () => {
      try {
        (dispatcher as any).close?.();
      } catch {}
    },
  };
}

// ==================== REMNAWAVE SYNC / ROTATION ====================

/**
 * Fetch a Remnawave user's credentials (and optionally rotate them) through
 * the panel API. Thin wrapper kept for call-site stability: the wire protocol
 * lives in remnawave.ts.
 */
export async function syncRemnawaveUser(params: {
  panelUrl: string;
  apiToken?: string;
  adminUser?: string;
  adminPass?: string;
  username: string;
  rotatePassword?: boolean;
  timeoutSec?: number;
  insecureTls?: boolean;
}): Promise<RemnawaveSyncResult> {
  const { syncRemnawaveUserByUsername } = await loadRemnawaveClient();
  return syncRemnawaveUserByUsername({
    panelUrl: params.panelUrl,
    apiToken: params.apiToken,
    adminUser: params.adminUser,
    adminPass: params.adminPass,
    username: params.username,
    rotatePassword: params.rotatePassword,
    timeoutSec: params.timeoutSec,
    insecureTls: resolveInsecureTls(params.panelUrl, params.insecureTls),
  });
}

/**
 * Connectivity probe for a panel: health + API access + target user lookup.
 * A reachable panel without the target user is still reported as `ok`
 * (the operator may register the user afterwards) but flags `userFound: false`.
 */
export async function testRemnawaveConnection(config: {
  panelUrl: string;
  apiToken?: string;
  adminUser?: string;
  adminPass?: string;
  targetUsername?: string;
  timeoutSec?: number;
  insecureTls?: boolean;
}): Promise<{ ok: boolean; message: string; userFound?: boolean; userId?: string }> {
  const { testRemnawaveConnection: probe } = await loadRemnawaveClient();
  return probe({
    panelUrl: config.panelUrl,
    apiToken: config.apiToken,
    adminUser: config.adminUser,
    adminPass: config.adminPass,
    targetUsername: config.targetUsername,
    timeoutSec: config.timeoutSec || 8,
    insecureTls: resolveInsecureTls(config.panelUrl, config.insecureTls),
  });
}

export async function executeRotation(customConfig?: Partial<RotationConfig>): Promise<RotationHistoryItem> {
  rotationInFlight = true;
  try {
    return await doExecuteRotation(customConfig);
  } finally {
    rotationInFlight = false;
  }
}

async function doExecuteRotation(customConfig?: Partial<RotationConfig>): Promise<RotationHistoryItem> {
  // REMNAWAVE_* is canonical; the legacy XUI_* names keep working so an
  // existing deployment's environment does not silently drop into
  // standalone mode on upgrade.
  let panel = customConfig?.panelUrl || process.env.REMNAWAVE_PANEL_URL || process.env.XUI_PANEL_URL;
  let panelApiToken = "";
  let panelUser = customConfig?.adminUser || process.env.REMNAWAVE_ADMIN_USER || process.env.XUI_ADMIN_USER;
  let panelPass = customConfig?.adminPass || process.env.REMNAWAVE_ADMIN_PASS || process.env.XUI_ADMIN_PASS;
  let targetUsername =
    customConfig?.targetUsername || process.env.REMNAWAVE_TARGET_USERNAME || process.env.XUI_INBOUND_REMARK || "pec-user";
  let targetProxyId: string | undefined = undefined;
  let activeProxy: any = undefined;

  try {
    const { getActiveProxy } = await import("./proxies.js");
    activeProxy = getActiveProxy();
    if (activeProxy && activeProxy.type === "remnawave") {
      targetProxyId = activeProxy.id;
      if (activeProxy.remnawaveUsername) targetUsername = activeProxy.remnawaveUsername;
      if (activeProxy.panelId) {
        const p = getRemnawavePanelById(activeProxy.panelId);
        if (p && (!panel || panel.includes("remnawave-host") || p.apiToken)) {
          panel = p.panelUrl;
          panelApiToken = p.apiToken || "";
          panelUser = p.adminUser;
          panelPass = p.adminPass;
        }
      }
    }
  } catch {}

  const timeoutMs = 10000;
  const credsStorePath = getCredsStorePath();

  // Multi-panel rotation: rotate only panels where rotationEnabled === true.
  const enabledPanels = getAllRemnawavePanels(false).filter((p) => p.rotationEnabled);
  if (enabledPanels.length > 0) {
    let primaryUser = "corp-user";
    let primaryPass = "";
    for (const p of enabledPanels) {
      const username = p.targetUsername || targetUsername || "pec-user";
      const syncResult = await syncRemnawaveUser({
        panelUrl: p.panelUrl,
        apiToken: p.apiToken,
        adminUser: p.adminUser,
        adminPass: p.adminPass,
        username,
        rotatePassword: true,
        timeoutSec: Math.floor(timeoutMs / 1000),
        insecureTls: p.insecureTls,
      });

      if (!syncResult.ok) {
        recordRotation("remnawave", "failure");
        throw new Error(`Remnawave rotation failed on panel '${p.name || p.id}': ${syncResult.message}`);
      }

      primaryUser = syncResult.username || username || primaryUser;
      primaryPass = syncResult.password!;

      try {
        const { getAllProxies, updateProxy } = await import("./proxies.js");
        const matchingProxy = getAllProxies(false).find(
          (px) => px.type === "remnawave" && (px.panelId === p.id || px.host === new URL(p.panelUrl).hostname)
        );
        if (matchingProxy) {
          updateProxy(matchingProxy.id, {
            password: primaryPass,
            username: primaryUser,
            lastSync: new Date().toISOString(),
          });
        }
      } catch (_) {}
    }

    atomicWriteCredsWithRetries(credsStorePath, { user: primaryUser, pass: primaryPass });
    recordRotation("remnawave", "success");
    return {
      id: crypto.randomBytes(4).toString("hex"),
      timestamp: new Date().toISOString(),
      source: "remnawave",
      user: primaryUser,
      success: true,
    };
  }

  // Single-panel mode: only when the panel is explicitly configured
  // (non-placeholder).
  const panelConfigured = Boolean(
    panel &&
      (panelApiToken || (panelUser && panelPass)) &&
      !panel.includes("remnawave-host") &&
      !panel.includes("3xui-host") &&
      panel.startsWith("http")
  );

  if (panelConfigured) {
    // SECURITY / OPERATIONS: no silent fallback. If the panel is configured,
    // a failed panel update must NOT write a new local password - that would
    // desynchronize every extension in the fleet (local store rotated, panel
    // user still on the old password) while history reported success.
    const panelUrl = panel as string;
    let failureReason = "";

    try {
      const syncResult = await syncRemnawaveUser({
        panelUrl,
        apiToken: panelApiToken,
        adminUser: panelUser as string,
        adminPass: panelPass as string,
        username: targetUsername,
        rotatePassword: true,
        timeoutSec: Math.floor(timeoutMs / 1000),
        insecureTls: customConfig?.insecureSkipVerify,
      });

      if (!syncResult.ok) {
        throw new Error(syncResult.message);
      }

      const username = syncResult.username || targetUsername || "corp-user";
      const newPassword = syncResult.password!;

      // AUDIT-SRV-3: the panel has ALREADY accepted the new password at this
      // point. Local failures below are a fleet DESYNC and must be reported
      // honestly вЂ” not as "credentials were NOT changed" (they were) and not
      // as a silent success either.
      let localDesync: string | undefined;
      try {
        atomicWriteCredsWithRetries(credsStorePath, { user: username, pass: newPassword });
      } catch (credsErr: unknown) {
        localDesync = `local creds store not updated after ${credsErr}`;
      }

      if (!localDesync) {
        try {
          const { getActiveProxy, updateProxy } = await import("./proxies.js");
          const activeProxy = getActiveProxy();
          const idToUpdate =
            targetProxyId || (activeProxy && activeProxy.type === "remnawave" ? activeProxy.id : undefined);
          if (idToUpdate) {
            updateProxy(idToUpdate, {
              password: newPassword,
              lastSync: new Date().toISOString(),
            });
          }
        } catch (proxyErr: unknown) {
          localDesync = `proxy registry not synced after ${proxyErr}`;
        }
      }

      if (localDesync) {
        recordRotation("remnawave", "failure");
        logger.error(
          `[rotate] Remnawave rotated the user password, but ${localDesync}. ` +
            `FLEET DESYNC: extensions will fail auth against the panel user '${username}'. Re-run the rotation or reconcile manually.`
        );
        return {
          id: crypto.randomBytes(4).toString("hex"),
          timestamp: new Date().toISOString(),
          source: "remnawave",
          user: username,
          success: false,
          error: `Remnawave password was rotated, but ${localDesync}. Fleet credentials are DESYNCED - re-run the rotation or reconcile manually.`,
        };
      }

      recordRotation("remnawave", "success");
      return {
        id: crypto.randomBytes(4).toString("hex"),
        timestamp: new Date().toISOString(),
        source: "remnawave",
        user: username,
        success: true,
      };
    } catch (err: unknown) {
      recordRotation("remnawave", "failure");
      failureReason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Remnawave rotation failed; credentials were NOT changed to avoid desynchronizing the fleet. Fix the panel connection, then retry. Original error: ${failureReason}`
      );
    }
  }

  // Standalone mode: panel intentionally not configured - rotate the local
  // store only. This is a deliberate deployment mode, not an error fallback.
  let currentUsername = "corp-user";
  try {
    const existing = readCurrentCreds();
    if (existing?.user) {
      currentUsername = existing.user;
    }
  } catch {}

  const newPassword = crypto.randomBytes(18).toString("base64url");
  atomicWriteCredsWithRetries(credsStorePath, { user: currentUsername, pass: newPassword });

  recordRotation("standalone", "success");
  return {
    id: crypto.randomBytes(4).toString("hex"),
    timestamp: new Date().toISOString(),
    source: "standalone-atomic",
    user: currentUsername,
    success: true,
  };
}

// ==================== REMNAWAVE MULTI-PANEL REGISTRY ====================

/**
 * One-time migration into data/panels_remnawave.json. Two legacy sources are
 * considered, in order:
 *  1. data/panels_3xui.json (multi-panel registry) - targetRemark becomes
 *     targetUsername; legacy login credentials are retained as a fallback
 *     until the operator replaces them with a Remnawave API token.
 *  2. rotation_config.json (single-panel deployment).
 * The legacy files are never deleted, so a rollback is still possible.
 */
function autoMigratePanelsIfNeeded(): void {
  const panelsFile = getRemnawavePanelsPath();
  if (fs.existsSync(panelsFile)) return;

  const panels: PanelRemnawaveConfig[] = [];
  const now = new Date().toISOString();

  try {
    const legacyFile = getLegacy3xuiPanelsPath();
    if (fs.existsSync(legacyFile)) {
      const legacy = readJsonStore<any[]>(legacyFile) || [];
      for (const p of legacy) {
        if (!p || typeof p.panelUrl !== "string" || !p.panelUrl.startsWith("http")) continue;
        panels.push({
          id: typeof p.id === "string" && p.id ? p.id : `panel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : "Imported panel",
          panelUrl: p.panelUrl.replace(/\/+$/, ""),
          apiToken: typeof p.apiToken === "string" ? p.apiToken : undefined,
          adminUser: typeof p.adminUser === "string" ? p.adminUser : "admin",
          adminPass: typeof p.adminPass === "string" ? p.adminPass : "",
          insecureTls: Boolean(p.insecureTls),
          rotationEnabled: Boolean(p.rotationEnabled),
          targetUsername: typeof p.targetRemark === "string" && p.targetRemark.trim()
            ? p.targetRemark.trim()
            : typeof p.targetUsername === "string"
              ? p.targetUsername.trim()
              : "",
          rotationIntervalMinutes:
            typeof p.rotationIntervalMinutes === "number" ? p.rotationIntervalMinutes : undefined,
          createdAt: typeof p.createdAt === "string" ? p.createdAt : now,
          updatedAt: now,
        });
      }
    }
  } catch (err) {
    logger.warn("[rotate] Auto-migration of legacy 3x-ui panel registry failed:", err);
  }

  if (panels.length === 0) {
    try {
      const rotConfigFile = getRotationConfigPath();
      if (fs.existsSync(rotConfigFile)) {
        const rotData = JSON.parse(fs.readFileSync(rotConfigFile, "utf-8"));
        if (
          rotData &&
          rotData.panelUrl &&
          typeof rotData.panelUrl === "string" &&
          rotData.panelUrl.startsWith("http") &&
          !rotData.panelUrl.includes("3xui-host") &&
          !rotData.panelUrl.includes("remnawave-host")
        ) {
          panels.push({
            id: "panel_default",
            name: "Primary Remnawave Panel",
            panelUrl: rotData.panelUrl.replace(/\/+$/, ""),
            apiToken: typeof rotData.apiToken === "string" ? rotData.apiToken : undefined,
            adminUser: rotData.adminUser || "admin",
            adminPass: rotData.adminPass || "",
            insecureTls: Boolean(rotData.insecureSkipVerify),
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    } catch (err) {
      logger.warn("[rotate] Auto-migration of legacy rotation config failed:", err);
    }
  }

  writeJsonAtomic(panelsFile, panels);
}

export function getAllRemnawavePanels(maskSecrets = false): PanelRemnawaveConfig[] {
  autoMigratePanelsIfNeeded();
  const list = readJsonStore<PanelRemnawaveConfig[]>(getRemnawavePanelsPath()) || [];
  return list.map((panel) => ({
    ...panel,
    apiToken: maskSecrets ? (panel.apiToken ? "••••••••" : "") : panel.apiToken,
    adminPass: maskSecrets ? (panel.adminPass ? "••••••••" : "") : panel.adminPass,
  }));
}

export function getRemnawavePanelById(id: string): PanelRemnawaveConfig | undefined {
  autoMigratePanelsIfNeeded();
  const list = readJsonStore<PanelRemnawaveConfig[]>(getRemnawavePanelsPath()) || [];
  const found = list.find((p) => p.id === id);
  return found ? { ...found } : undefined;
}

export function saveRemnawavePanel(
  panelData: Partial<PanelRemnawaveConfig> & { name: string; panelUrl: string }
): PanelRemnawaveConfig {
  const urlCheck = validateSafeEndpointUrl(panelData.panelUrl);
  if (!urlCheck.valid) {
    throw new Error(`SSRF Security Check Failed: ${urlCheck.error}`);
  }

  autoMigratePanelsIfNeeded();
  const panelsFile = getRemnawavePanelsPath();
  const list = readJsonStore<PanelRemnawaveConfig[]>(panelsFile) || [];
  const cleanUrl = panelData.panelUrl.trim().replace(/\/+$/, "");
  const isMaskedSecret = (value: string | undefined) =>
    value === "••••••••" || value === "вЂўвЂўвЂўвЂўвЂўвЂўвЂўвЂў" || value === "********";

  let savedPanel: PanelRemnawaveConfig;
  const now = new Date().toISOString();

  if (panelData.id) {
    const existingIndex = list.findIndex((p) => p.id === panelData.id);
    if (existingIndex !== -1) {
      const existing = list[existingIndex];
      const submittedToken = panelData.apiToken?.trim();
      const submittedPass = panelData.adminPass?.trim();

      savedPanel = {
        ...existing,
        name: panelData.name.trim(),
        panelUrl: cleanUrl,
        apiToken:
          submittedToken && !isMaskedSecret(submittedToken) ? submittedToken : existing.apiToken || "",
        adminUser: panelData.adminUser !== undefined ? panelData.adminUser.trim() : existing.adminUser,
        adminPass:
          submittedPass && !isMaskedSecret(submittedPass) ? submittedPass : existing.adminPass,
        insecureTls: panelData.insecureTls !== undefined ? panelData.insecureTls : existing.insecureTls,
        rotationEnabled:
          panelData.rotationEnabled !== undefined ? Boolean(panelData.rotationEnabled) : Boolean(existing.rotationEnabled),
        targetUsername:
          panelData.targetUsername !== undefined
            ? String(panelData.targetUsername).trim()
            : (existing.targetUsername || ""),
        rotationIntervalMinutes:
          typeof panelData.rotationIntervalMinutes === "number" ? panelData.rotationIntervalMinutes : existing.rotationIntervalMinutes,
        updatedAt: now,
      };
      list[existingIndex] = savedPanel;
    } else {
      savedPanel = {
        id: panelData.id,
        name: panelData.name.trim(),
        panelUrl: cleanUrl,
        apiToken: panelData.apiToken && !isMaskedSecret(panelData.apiToken) ? panelData.apiToken.trim() : "",
        adminUser: panelData.adminUser?.trim() || "",
        adminPass: panelData.adminPass && !isMaskedSecret(panelData.adminPass) ? panelData.adminPass : "",
        insecureTls: Boolean(panelData.insecureTls),
        rotationEnabled: Boolean(panelData.rotationEnabled),
        targetUsername: panelData.targetUsername ? String(panelData.targetUsername).trim() : "",
        rotationIntervalMinutes:
          typeof panelData.rotationIntervalMinutes === "number" ? panelData.rotationIntervalMinutes : undefined,
        createdAt: now,
        updatedAt: now,
      };
      list.push(savedPanel);
    }
  } else {
    const newId = `panel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    savedPanel = {
      id: newId,
      name: panelData.name.trim(),
      panelUrl: cleanUrl,
      apiToken: panelData.apiToken && !isMaskedSecret(panelData.apiToken) ? panelData.apiToken.trim() : "",
      adminUser: panelData.adminUser?.trim() || "",
      adminPass: panelData.adminPass && !isMaskedSecret(panelData.adminPass) ? panelData.adminPass : "",
      insecureTls: Boolean(panelData.insecureTls),
      rotationEnabled: Boolean(panelData.rotationEnabled),
      targetUsername: panelData.targetUsername ? String(panelData.targetUsername).trim() : "",
      rotationIntervalMinutes:
        typeof panelData.rotationIntervalMinutes === "number" ? panelData.rotationIntervalMinutes : undefined,
      createdAt: now,
      updatedAt: now,
    };
    list.push(savedPanel);
  }

  writeJsonAtomic(panelsFile, list);
  // AUDIT-SRV-P3: panel secrets live here - strip Windows ACE inheritance
  // so the store is not readable through inherited grants.
  restrictSecretFilePermissions(panelsFile);
  return savedPanel;
}

export function deleteRemnawavePanel(id: string): boolean {
  autoMigratePanelsIfNeeded();
  const panelsFile = getRemnawavePanelsPath();
  const list = readJsonStore<PanelRemnawaveConfig[]>(panelsFile) || [];
  const initialLength = list.length;
  const filtered = list.filter((p) => p.id !== id);
  if (filtered.length !== initialLength) {
    writeJsonAtomic(panelsFile, filtered);
    restrictSecretFilePermissions(panelsFile);
    return true;
  }
  return false;
}

/** User list for the dashboard picker (accepts a stored panel id or raw config). */
export async function fetchRemnawaveUsers(
  configOrId: RemnawaveConnection | string
): Promise<RemnawaveUser[]> {
  const { fetchRemnawaveUsers: listUsers } = await loadRemnawaveClient();
  return listUsers(configOrId as RemnawaveConnection, (id) => {
    const p = getRemnawavePanelById(id);
    if (!p) return undefined;
    return {
      panelUrl: p.panelUrl,
      apiToken: p.apiToken,
      adminUser: p.adminUser,
      adminPass: p.adminPass,
      insecureTls: p.insecureTls,
    };
  });
}
