import crypto from "node:crypto";
import { readJsonStore, writeJsonAtomic, restrictSecretFilePermissions } from "./jsonStore.js";
import { getXrayRuntimeSettingsPath } from "./storage.js";
import { logger } from "./logger.js";
import type { RemnawaveSubscription } from "./remnawave.js";

/**
 * REMNA-PERUSER-XRAY-1: server-side control plane for the per-user local
 * Xray runtime. The PEC server never runs Xray and never stores subscription
 * pools: it pins the core version the fleet must run, holds the HMAC master
 * secret that derives deterministic per-user localhost proxy credentials, and
 * renders the per-user Xray JSON config (one shared HTTP inbound with one
 * account per user + user->outbound routing rules) that the PEC-App service
 * writes and hot-reloads on the client machine.
 */

export interface XrayRuntimeSettings {
  /** Master switch: when false no xray block is delivered to clients. */
  enabled: boolean;
  /** Xray-core version the fleet must run, e.g. "24.11.11". Empty = client default. */
  version: string;
  /** Shared localhost listener port (HTTP proxy). SOCKS5 uses port + 1. */
  listenPort: number;
}

export const DEFAULT_XRAY_RUNTIME_SETTINGS: XrayRuntimeSettings = {
  enabled: false,
  version: "",
  listenPort: 12080,
};

function sanitizeSettings(raw: unknown): XrayRuntimeSettings {
  const obj = (raw && typeof raw === "object" && !Array.isArray(raw)) ? (raw as Record<string, unknown>) : {};
  const port = Number(obj.listenPort);
  return {
    enabled: obj.enabled === true,
    version: typeof obj.version === "string" ? obj.version.trim().replace(/^v+/, "") : "",
    listenPort: Number.isInteger(port) && port >= 1 && port <= 65534 ? port : DEFAULT_XRAY_RUNTIME_SETTINGS.listenPort,
  };
}

/** Returns the persisted settings, or the defaults when the store is absent. */
export function loadXrayRuntimeSettings(): XrayRuntimeSettings {
  const stored = readJsonStore<unknown>(getXrayRuntimeSettingsPath());
  if (!stored) return { ...DEFAULT_XRAY_RUNTIME_SETTINGS };
  return sanitizeSettings(stored);
}

export function saveXrayRuntimeSettings(updates: Partial<XrayRuntimeSettings>): XrayRuntimeSettings {
  const current = loadXrayRuntimeSettings();
  const merged = sanitizeSettings({
    enabled: updates.enabled === undefined ? current.enabled : updates.enabled === true,
    version: updates.version === undefined ? current.version : String(updates.version),
    listenPort: updates.listenPort === undefined ? current.listenPort : updates.listenPort,
  });
  const path = getXrayRuntimeSettingsPath();
  // Preserve the HMAC master secret across settings updates (rewriting the
  // file without it would silently invalidate every delivered client credential).
  const existing = readJsonStore<{ masterSecret?: unknown }>(path);
  const payload: Record<string, unknown> = { ...merged };
  if (existing && typeof existing.masterSecret === "string" && existing.masterSecret.length >= 32) {
    payload.masterSecret = existing.masterSecret;
  }
  writeJsonAtomic(path, payload);
  restrictSecretFilePermissions(path);
  logger.info(`[xrayRuntime] Runtime settings updated: enabled=${merged.enabled}, version=${merged.version || "(client default)"}, port=${merged.listenPort}`);
  return merged;
}

/**
 * HMAC master secret for per-user proxy credentials. Generated once and kept
 * in the same restricted store file; rotation of this secret invalidates all
 * delivered client credentials (they are re-fetched on the next sync).
 */
function getOrCreateMasterSecret(): string {
  const path = getXrayRuntimeSettingsPath();
  const stored = readJsonStore<{ masterSecret?: unknown }>(path);
  if (stored && typeof stored.masterSecret === "string" && stored.masterSecret.length >= 32) {
    return stored.masterSecret;
  }
  const masterSecret = crypto.randomBytes(32).toString("base64url");
  const settings = loadXrayRuntimeSettings();
  writeJsonAtomic(path, { ...settings, masterSecret });
  restrictSecretFilePermissions(path);
  logger.info("[xrayRuntime] Generated per-user proxy credential master secret");
  return masterSecret;
}

/**
 * Deterministic per-user localhost proxy password: the same AD user always
 * maps to the same credential on every machine, and nothing user-specific is
 * ever persisted server-side.
 */
export function deriveProxySecret(username: string): string {
  const clean = normalizeRemnawaveUsername(username);
  if (!clean) throw new Error("Username is required to derive the proxy secret");
  return crypto
    .createHmac("sha256", getOrCreateMasterSecret())
    .update(`pec-xray-v1:${clean.toLowerCase()}`)
    .digest("base64url")
    .slice(0, 22);
}

/**
 * AD identity ("DOMAIN\\user", "user@corp.local", "user") -> Remnawave
 * username / proxy account name. Agreed mapping: bare sAMAccountName.
 */
export function normalizeRemnawaveUsername(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  const withoutDomain = value.includes("\\") ? value.slice(value.lastIndexOf("\\") + 1) : value;
  const withoutUpn = withoutDomain.includes("@") ? withoutDomain.slice(0, withoutDomain.indexOf("@")) : withoutDomain;
  return withoutUpn;
}

// ----------------- Xray config rendering -----------------

export interface ParsedVlessServer {
  uuid: string;
  host: string;
  port: number;
  name: string;
  flow: string;
  security: string;
  sni: string;
  publicKey: string;
  shortId: string;
  spiderX: string;
  fingerprint: string;
  network: string;
}

/** Parse one vless:// subscription link. Returns null for anything unparseable. */
export function parseVlessLink(link: string): ParsedVlessServer | null {
  let url: URL;
  try {
    url = new URL(String(link || "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "vless:") return null;
  const uuid = decodeURIComponent(url.username || "");
  const host = decodeURIComponent(url.hostname || "");
  const port = Number(url.port);
  if (!uuid || !host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const q = url.searchParams;
  return {
    uuid,
    host,
    port,
    name: decodeURIComponent(url.hash || "").replace(/^#/, "") || `${host}:${port}`,
    flow: q.get("flow") || "",
    security: q.get("security") || "none",
    sni: q.get("sni") || q.get("peer") || "",
    publicKey: q.get("pbk") || "",
    shortId: q.get("sid") || "",
    spiderX: q.get("spx") || "",
    fingerprint: q.get("fp") || "",
    network: q.get("type") || "tcp",
  };
}

function buildVlessOutbound(tag: string, server: ParsedVlessServer): Record<string, unknown> {
  const streamSettings: Record<string, unknown> = { network: server.network, security: server.security };
  if (server.security === "reality") {
    streamSettings.realitySettings = {
      serverName: server.sni || undefined,
      publicKey: server.publicKey || undefined,
      fingerprint: server.fingerprint || "chrome",
      shortId: server.shortId || undefined,
      spiderX: server.spiderX || undefined,
    };
  } else if (server.security === "tls" || server.security === "xtls") {
    streamSettings.tlsSettings = { serverName: server.sni || undefined, insecure: false };
  }
  return {
    tag,
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: server.host,
          port: server.port,
          users: [
            {
              id: server.uuid,
              encryption: "none",
              ...(server.flow ? { flow: server.flow } : {}),
            },
          ],
        },
      ],
    },
    streamSettings,
  };
}

export interface XrayUserConfigResult {
  /** Full xray JSON config for this user's local runtime. */
  config: Record<string, unknown>;
  /** Parsed servers the config routes to (names only reach logs/UI, links never persist). */
  servers: Array<{ name: string; host: string; port: number }>;
}

/**
 * Render the per-user Xray config: one shared HTTP inbound on 127.0.0.1 with
 * a single account (the user's derived secret) plus a SOCKS5 companion on
 * port+1, one VLESS outbound per subscription link, and routing rules that
 * pin this user's traffic to their own outbounds (first server by default,
 * remaining servers as same-user failover targets via a tag balancer).
 */
export function buildXrayUserConfig(params: {
  username: string;
  secret: string;
  listenPort: number;
  subscription: Pick<RemnawaveSubscription, "links">;
}): XrayUserConfigResult {
  const user = normalizeRemnawaveUsername(params.username);
  if (!user) throw new Error("Username is required to build the Xray config");
  if (!params.secret) throw new Error("Proxy secret is required to build the Xray config");
  const port = Number(params.listenPort);
  if (!Number.isInteger(port) || port < 1 || port > 65534) {
    throw new Error("listenPort must be between 1 and 65534");
  }

  const servers: ParsedVlessServer[] = [];
  for (const link of params.subscription.links || []) {
    const parsed = parseVlessLink(link);
    if (parsed) servers.push(parsed);
  }
  if (servers.length === 0) {
    throw new Error("Subscription contains no usable VLESS servers");
  }

  const outbounds: Array<Record<string, unknown>> = [];
  const rules: Array<Record<string, unknown>> = [];
  const tags: string[] = [];
  servers.forEach((server, i) => {
    const tag = `remna_${i + 1}`;
    tags.push(tag);
    outbounds.push(buildVlessOutbound(tag, server));
  });

  // All of this user's traffic goes through their own subscription servers.
  // The first server is the primary target; the balancer fails over across
  // the remaining tags of the same user only.
  rules.push({ type: "field", user: [user], balancerTag: "remna_pool" });

  const config: Record<string, unknown> = {
    log: { loglevel: "warning" },
    inbounds: [
      {
        port,
        listen: "127.0.0.1",
        protocol: "http",
        settings: {
          servers: [{ level: 0, user: params.secret, pass: params.secret, email: user }],
        },
        sniffing: { enabled: true, destOverride: ["http", "tls"] },
      },
      {
        port: port + 1,
        listen: "127.0.0.1",
        protocol: "socks",
        settings: {
          auth: "password",
          accounts: [{ user: params.secret, pass: params.secret }],
        },
      },
    ],
    outbounds: [
      ...outbounds,
      // Direct fallback keeps LAN/corporate hosts reachable even when the
      // panel subscription is temporarily unreachable.
      { tag: "direct", protocol: "freedom", settings: {} },
      { tag: "block", protocol: "blackhole", settings: {} },
    ],
    routing: {
      domainStrategy: "AsIs",
      rules: [
        // Private networks bypass the tunnel (terminal servers, printers, AD).
        { type: "field", network: "tcp,udp", ip: ["private"], outboundTag: "direct" },
        ...rules,
      ],
      balancerInfo: { selector: tags, fallbackTag: tags[0] },
    },
  };

  return {
    config,
    servers: servers.map((s) => ({ name: s.name, host: s.host, port: s.port })),
  };
}
