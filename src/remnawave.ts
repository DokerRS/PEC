/**
 * Remnawave panel API client (https://docs.rw/api/).
 *
 * Every request goes through the SSRF-pinned fetch produced by
 * `createSsrfPinnedFetch`, so panel endpoints are protected by the same
 * DNS-rebinding / metadata-service guards the rest of the fleet uses.
 *
 * Auth model: use a configured API token as `Authorization: Bearer <token>`.
 * Legacy panel configurations without an API token still use
 * POST /api/auth/login and re-acquire the JWT once after a 401.
 */

import { createSsrfPinnedFetch, type SafeEndpointFetch } from "./rotate.js";
import { logger } from "./logger.js";

export interface RemnawaveConnection {
  panelUrl: string;
  apiToken?: string;
  adminUser?: string;
  adminPass?: string;
  timeoutSec?: number;
  insecureTls?: boolean;
}

export interface RemnawaveUser {
  id?: number | string;
  shortUuid?: string;
  username?: string;
  status?: string;
  trojanPassword?: string;
  vlessUuid?: string;
  ssPassword?: string;
  subscriptionUrl?: string;
  expireAt?: string;
  trafficLimitBytes?: number;
  trafficLimitStrategy?: string;
  description?: string;
  tag?: string;
  activeInternalSquads?: Array<{ uuid?: string; name?: string }>;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface RemnawaveSubscription {
  isFound: boolean;
  user: {
    username: string;
    isActive: boolean;
    userStatus: string;
    shortUuid: string;
  };
  links: string[];
  ssConfLinks: Record<string, string>;
  subscriptionUrl: string;
}

export interface RemnawaveNode {
  uuid?: string;
  name?: string;
  address?: string;
  port?: number;
  isConnected?: boolean;
  isDisabled?: boolean;
  countryCode?: string;
  tags?: string[];
  usersOnline?: number | null;
  [key: string]: unknown;
}

export interface RemnawaveSyncResult {
  ok: boolean;
  message: string;
  userId?: number | string;
  username?: string;
  password?: string;
  shortUuid?: string;
  subscriptionUrl?: string;
  status?: string;
}

/** Strip trailing slashes so `${base}/api/...` is always well-formed. */
function normalizeBase(panelUrl: string): string {
  return String(panelUrl || "").trim().replace(/\/+$/, "");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pull the human-readable reason out of a Remnawave error envelope
 * (`{statusCode, message, error}`) so failures are actionable.
 */
async function describeError(res: Response, what: string): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    const msg = Array.isArray(body?.message) ? body.message.join(", ") : body?.message;
    detail = String(msg || body?.error || "").slice(0, 200);
  } catch {
    /* non-JSON error body */
  }
  return detail ? `${what}: HTTP ${res.status} (${detail})` : `${what}: HTTP ${res.status}`;
}

/**
 * Panel fetches must never follow redirects: a 3xx would silently forward the
 * Bearer token to whatever target the panel (or an attacker who controls it)
 * points at. `redirect: "manual"` keeps the response local; this turns it
 * into a hard failure.
 */
function assertNoRedirect(res: Response, what: string): void {
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`${what}: panel returned redirect (${res.status}) - refused`);
  }
}

/**
 * A single panel connection. The SSRF plan (DNS pinning + optional insecure
 * dispatcher) is created per operation and closed when the body is consumed,
 * so a long-lived client must not cache the plan - only the access token.
 */
export class RemnawaveClient {
  private accessToken: string | null = null;

  constructor(private readonly conn: RemnawaveConnection) {}

  get base(): string {
    return normalizeBase(this.conn.panelUrl);
  }

  private get timeoutMs(): number {
    return (this.conn.timeoutSec || 10) * 1000;
  }

  /**
   * POST /api/auth/login. Remnawave answers 201 with
   * `{response: {accessToken}}`.
   */
  async login(panelFetch: SafeEndpointFetch): Promise<string> {
    if (!this.conn.adminUser || !this.conn.adminPass) {
      throw new Error("Remnawave API token is required when legacy login credentials are not configured");
    }
    const res = await panelFetch(`${this.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: this.conn.adminUser, password: this.conn.adminPass }),
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    assertNoRedirect(res, "auth/login");
    if (!res.ok) {
      throw new Error(`Remnawave login failed: ${await describeError(res, "auth/login")}`);
    }
    const data = (await res.json().catch(() => null)) as { response?: { accessToken?: string } } | null;
    const token = data?.response?.accessToken;
    if (!token || typeof token !== "string") {
      throw new Error("Remnawave login failed: response did not contain an access token");
    }
    this.accessToken = token;
    return token;
  }

  /**
   * Legacy JWT credentials are transparently refreshed once after a 401.
   * API-token requests are sent as-is. Returns the unwrapped `response` payload.
   */
  async request<T>(panelFetch: SafeEndpointFetch, method: string, apiPath: string, body?: unknown): Promise<T> {
    const doCall = async (token: string): Promise<Response> => {
      const res = await panelFetch(`${this.base}${apiPath}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${token}`,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      assertNoRedirect(res, apiPath);
      return res;
    };

    const apiToken = this.conn.apiToken?.trim();
    let token = this.accessToken || apiToken || null;
    if (!token) token = await this.login(panelFetch);

    let res = await doCall(token);
    if (res.status === 401 && !apiToken) {
      logger.info(`[remnawave] Access token rejected by ${this.base}, re-authenticating.`);
      token = await this.login(panelFetch);
      res = await doCall(token);
    }
    if (!res.ok) {
      throw new Error(`Remnawave request failed: ${await describeError(res, `${method} ${apiPath}`)}`);
    }

    // 204 (and empty bodies) carry no envelope.
    const text = await res.text();
    if (!text) return undefined as unknown as T;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Remnawave request failed: ${method} ${apiPath} returned a non-JSON body`);
    }
    if (parsed && typeof parsed === "object" && "response" in (parsed as Record<string, unknown>)) {
      return (parsed as { response: T }).response;
    }
    return parsed as T;
  }

  /** Open a pinned fetch, run `fn`, and always release the dispatcher. */
  private async withPinnedFetch<T>(fn: (panelFetch: SafeEndpointFetch) => Promise<T>): Promise<T> {
    const ssrf = await createSsrfPinnedFetch(this.conn.panelUrl, { insecureTls: this.conn.insecureTls });
    if (!ssrf.valid) {
      ssrf.close();
      throw new Error(`SSRF Security Check Failed: ${ssrf.error}`);
    }
    try {
      return await fn(ssrf.fetch);
    } finally {
      ssrf.close();
    }
  }

  /** GET /api/system/health - authenticated liveness probe (required by OpenAPI). */
  async getHealth(): Promise<{ status?: string; isDbConnected?: boolean; isRedisConnected?: boolean }> {
    return this.withPinnedFetch(async (panelFetch) => {
      const health = await this.request<{
        status?: string;
        isDbConnected?: boolean;
        isRedisConnected?: boolean;
      }>(panelFetch, "GET", "/api/system/health");
      return health || {};
    });
  }

  /**
   * GET /api/users/by-username/{username} -> UserResponseDto.
   * Returns null when the user does not exist (404).
   */
  async getUserByUsername(username: string): Promise<RemnawaveUser | null> {
    const clean = String(username || "").trim();
    if (!clean) throw new Error("Remnawave username is required");
    return this.withPinnedFetch(async (panelFetch) => {
      try {
        return await this.request<RemnawaveUser>(
          panelFetch,
          "GET",
          `/api/users/by-username/${encodeURIComponent(clean)}`
        );
      } catch (err) {
        if (errorMessage(err).includes("HTTP 404")) return null;
        throw err;
      }
    });
  }

  /** GET /api/subscriptions/by-username/{username}; returns this user's links only. */
  async getSubscriptionByUsername(username: string): Promise<RemnawaveSubscription | null> {
    const clean = String(username || "").trim();
    if (!clean) throw new Error("Remnawave username is required");

    return this.withPinnedFetch(async (panelFetch) => {
      let subscription: RemnawaveSubscription;
      try {
        subscription = await this.request<RemnawaveSubscription>(
          panelFetch,
          "GET",
          `/api/subscriptions/by-username/${encodeURIComponent(clean)}`
        );
      } catch (err) {
        if (errorMessage(err).includes("HTTP 404")) return null;
        throw err;
      }

      if (!subscription || typeof subscription !== "object" || typeof subscription.isFound !== "boolean") {
        throw new Error("Remnawave subscription response is malformed");
      }
      if (!subscription.isFound) return null;
      if (
        !subscription.user ||
        typeof subscription.user.username !== "string" ||
        !Array.isArray(subscription.links) ||
        typeof subscription.subscriptionUrl !== "string"
      ) {
        throw new Error("Remnawave subscription response is missing required fields");
      }

      return {
        ...subscription,
        links: subscription.links.filter((link): link is string => typeof link === "string" && link.trim().length > 0),
        ssConfLinks:
          subscription.ssConfLinks && typeof subscription.ssConfLinks === "object"
            ? subscription.ssConfLinks
            : {},
      };
    });
  }

  /** GET /api/users?limit=&page= -> {users,total}. */
  async listUsers(limit = 50, page = 1): Promise<{ users: RemnawaveUser[]; total: number }> {
    return this.withPinnedFetch(async (panelFetch) => {
      const res = await this.request<{ users?: RemnawaveUser[]; total?: number }>(
        panelFetch,
        "GET",
        `/api/users?limit=${limit}&page=${page}`
      );
      return { users: res?.users || [], total: Number(res?.total || 0) };
    });
  }

  /** GET /api/nodes -> node list (used by the dashboard node picker). */
  async listNodes(): Promise<RemnawaveNode[]> {
    return this.withPinnedFetch(async (panelFetch) => {
      const res = await this.request<{ nodes?: RemnawaveNode[] } | RemnawaveNode[]>(panelFetch, "GET", "/api/nodes");
      return Array.isArray(res) ? res : res?.nodes || [];
    });
  }

  /** Read one user's credentials without changing anything. */
  async fetchUserByUsername(username: string): Promise<RemnawaveSyncResult> {
    const user = await this.getUserByUsername(username);
    if (!user) {
      return { ok: false, message: `Remnawave user '${username}' not found` };
    }
    const password = user.trojanPassword || user.ssPassword;
    if (!password) {
      return {
        ok: false,
        message: `Remnawave user '${username}' has no readable credential (trojanPassword/ssPassword missing)`,
      };
    }
    return {
      ok: true,
      message: "User fetched successfully",
      userId: user.id,
      username: user.username || username,
      password,
      shortUuid: user.shortUuid,
      subscriptionUrl: user.subscriptionUrl,
      status: user.status,
    };
  }
}

/**
 * Open a connection, optionally verify reachability, and read one user's
 * credentials without changing the user in Remnawave.
 */
export async function syncRemnawaveUserByUsername(params: {
  panelUrl: string;
  apiToken?: string;
  adminUser?: string;
  adminPass?: string;
  username: string;
  timeoutSec?: number;
  insecureTls?: boolean;
}): Promise<RemnawaveSyncResult> {
  const client = new RemnawaveClient({
    panelUrl: params.panelUrl,
    apiToken: params.apiToken,
    adminUser: params.adminUser,
    adminPass: params.adminPass,
    timeoutSec: params.timeoutSec,
    insecureTls: params.insecureTls,
  });

  try {
    return await client.fetchUserByUsername(params.username);
  } catch (err: unknown) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * Connectivity probe: health endpoint + API access + user lookup.
 * `userFound: false` is still a successful connection - the operator may have
 * configured the panel before creating the rotation user.
 */
export async function testRemnawaveConnection(config: RemnawaveConnection & {
  targetUsername?: string;
}): Promise<{ ok: boolean; message: string; userFound?: boolean; userId?: string }> {
  const client = new RemnawaveClient(config);
  try {
    const health = await client.getHealth();
    const target = String(config.targetUsername || "").trim();
    if (!target) {
      return {
        ok: true,
        message: `Connected successfully to Remnawave (status: ${health.status || "ok"}). No target user configured.`,
      };
    }

    const user = await client.getUserByUsername(target);
    if (!user) {
      const { total } = await client.listUsers(1, 1);
      return {
        ok: true,
        userFound: false,
        message: `Connected successfully, but Remnawave user '${target}' was not found (panel reports ${total} users).`,
      };
    }

    return {
      ok: true,
      userFound: true,
      userId: String(user.id),
      message: `Connected successfully to Remnawave! Found user "${user.username || target}" (id: ${user.id}, status: ${user.status || "ACTIVE"}).`,
    };
  } catch (err: unknown) {
    return { ok: false, message: `Connection failed: ${errorMessage(err)}` };
  }
}

/** List users for the dashboard picker (accepts a stored panel id or raw config). */
export async function fetchRemnawaveUsers(
  configOrId: RemnawaveConnection | string,
  resolvePanelById: (id: string) => RemnawaveConnection | undefined,
  limit = 100
): Promise<RemnawaveUser[]> {
  let targetConfig: RemnawaveConnection;
  if (typeof configOrId === "string") {
    const p = resolvePanelById(configOrId);
    if (!p) throw new Error(`Remnawave panel with ID '${configOrId}' not found`);
    targetConfig = { ...p, timeoutSec: 10 };
  } else {
    targetConfig = configOrId;
  }

  const client = new RemnawaveClient(targetConfig);
  const { users } = await client.listUsers(limit, 1);
  return users;
}
