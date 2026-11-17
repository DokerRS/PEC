import "./loadEnv.js";
import fs from "node:fs";
import { Client } from "ldapts";
import { writeJsonAtomic, restrictSecretFilePermissions } from "./jsonStore.js";
import { getAdCachePath, getAdConfigPath } from "./storage.js";
import { logger } from "./logger.js";

export interface AdSyncConfig {
  enabled: boolean;
  ldapUrl: string;
  bindDn: string;
  bindPassword: string;
  searchBase: string;
  requiredGroupDn: string;
  syncIntervalSec: number;
  rejectUnknownUsers: boolean;
  tlsRejectUnauthorized: boolean;
}

export interface AdCacheData {
  updatedAt: string;
  groupDn: string;
  count: number;
  allowedUsers: string[];
}

export function escapeLdapFilter(str: string): string {
  return str
    .replace(/\\/g, "\\5c")
    .replace(/\*/g, "\\2a")
    .replace(/\(/g, "\\28")
    .replace(/\)/g, "\\29")
    .replace(/\0/g, "\\00");
}

/**
 * AUDIT-SRV-2: clamp the AD sync interval to [5..86400] seconds. An
 * unclamped 0/negative value reaching setInterval would spin a hot LDAP
 * loop against the domain controller; the upper bound keeps a mistyped
 * value from silently disabling sync for more than a day. Garbage input
 * falls back to the 300s default.
 */
export const AD_SYNC_INTERVAL_MIN_SEC = 5;
export const AD_SYNC_INTERVAL_MAX_SEC = 86400;
export const AD_SYNC_INTERVAL_DEFAULT_SEC = 300;

export function clampSyncIntervalSec(value: unknown): number {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return AD_SYNC_INTERVAL_DEFAULT_SEC;
  }
  return Math.min(AD_SYNC_INTERVAL_MAX_SEC, Math.max(AD_SYNC_INTERVAL_MIN_SEC, Math.floor(parsed)));
}

export function loadAdConfig(): AdSyncConfig {
  const envConfig: AdSyncConfig = {
    enabled: process.env.AD_ENABLED === "true",
    ldapUrl: process.env.AD_LDAP_URL || "ldaps://127.0.0.1:636",
    bindDn: process.env.AD_BIND_DN || "",
    bindPassword: process.env.AD_BIND_PASSWORD || "",
    searchBase: process.env.AD_SEARCH_BASE || "",
    requiredGroupDn: process.env.AD_REQUIRED_GROUP_DN || "",
    syncIntervalSec: clampSyncIntervalSec(process.env.AD_SYNC_INTERVAL_SEC || AD_SYNC_INTERVAL_DEFAULT_SEC),
    rejectUnknownUsers: process.env.AD_REJECT_UNKNOWN_USERS === "true",
    tlsRejectUnauthorized: process.env.AD_TLS_REJECT_UNAUTHORIZED !== "false",
  };

  try {
    const configPath = getAdConfigPath();
    if (fs.existsSync(configPath)) {
      const rawDisk = fs.readFileSync(configPath, "utf-8");
      const diskConfig = JSON.parse(rawDisk);
      if (diskConfig && typeof diskConfig === "object") {
        return {
          ...envConfig,
          ...diskConfig,
          // AUDIT-SRV-2: disk config is operator-editable and historically
          // unvalidated — clamp before it can reach setInterval.
          syncIntervalSec: clampSyncIntervalSec(
            diskConfig.syncIntervalSec !== undefined ? diskConfig.syncIntervalSec : envConfig.syncIntervalSec
          ),
        };
      }
    }
  } catch (err) {
    logger.warn("[adSync] Failed to read ad_config.json from disk:", err);
  }

  return envConfig;
}

export class AdSyncService {
  private config: AdSyncConfig;
  private timer: NodeJS.Timeout | null = null;
  private allowedUsersSet = new Set<string>();
  private lastSyncAt?: string;
  private lastSyncError?: string;
  private isSyncing = false;

  constructor(cfg?: Partial<AdSyncConfig>) {
    this.config = {
      ...loadAdConfig(),
      ...cfg,
    };
    this.loadCacheFromDisk();
  }

  public getConfig(): AdSyncConfig {
    return { ...this.config };
  }

  public updateConfig(updates: Partial<AdSyncConfig>): void {
    this.config = {
      ...this.config,
      ...updates,
      ...(updates.syncIntervalSec !== undefined
        ? { syncIntervalSec: clampSyncIntervalSec(updates.syncIntervalSec) }
        : {}),
    };
  }

  public saveConfig(newConfig: Partial<AdSyncConfig>): void {
    const merged: AdSyncConfig = {
      ...this.config,
      ...newConfig,
    };
    if (newConfig.bindPassword === undefined || newConfig.bindPassword === "") {
      merged.bindPassword = this.config.bindPassword;
    }
    // AUDIT-SRV-2: POST /api/ad/config forwards the raw request body here;
    // clamp before persisting so a crafted 0 cannot hot-loop the scheduler.
    merged.syncIntervalSec = clampSyncIntervalSec(merged.syncIntervalSec);
    writeJsonAtomic(getAdConfigPath(), merged);
    // AUDIT-SRV-P3: bindPassword is stored here - strip Windows ACE inheritance
    // so the file is not readable through inherited Everyone/group grants.
    restrictSecretFilePermissions(getAdConfigPath());
    this.updateConfig(merged);
    if (this.timer) {
      this.startPeriodicSync();
    }
  }

  /**
   * AD-TLS-OPT-1: build ldapts Client options. tlsOptions must be attached
   * ONLY for ldaps:// URLs: ldapts 9.2.0 (locked in package-lock) aborts
   * plain ldap:// connections with ECONNRESET before the LDAP dialogue when
   * tlsOptions are present — reproduced on production via three-variant
   * bisection. See observations.md [runtime].
   */
  public buildClientOptions(url: string, tlsRejectUnauthorized: boolean, timeoutMs: number) {
    const options: {
      url: string;
      timeout: number;
      connectTimeout: number;
      tlsOptions?: { rejectUnauthorized: boolean };
    } = {
      url,
      timeout: timeoutMs,
      connectTimeout: timeoutMs,
    };
    if (String(url || "").trim().toLowerCase().startsWith("ldaps://")) {
      options.tlsOptions = { rejectUnauthorized: tlsRejectUnauthorized };
    }
    return options;
  }

  public async testConnection(testCfg?: Partial<AdSyncConfig>): Promise<{ ok: boolean; message?: string; error?: string }> {
    const targetUrl = testCfg?.ldapUrl || this.config.ldapUrl;
    const targetBindDn = testCfg?.bindDn !== undefined ? testCfg.bindDn : this.config.bindDn;
    const targetBindPassword = testCfg?.bindPassword !== undefined && testCfg.bindPassword !== "" ? testCfg.bindPassword : this.config.bindPassword;
    const tlsRejectUnauthorized = testCfg?.tlsRejectUnauthorized !== undefined ? testCfg.tlsRejectUnauthorized : this.config.tlsRejectUnauthorized;

    let client: Client | null = null;
    try {
      // AD-TLS-OPT-1: tlsOptions only for ldaps:// (ldap:// + tlsOptions = ECONNRESET)
      client = new Client(this.buildClientOptions(targetUrl, tlsRejectUnauthorized, 5000));

      if (targetBindDn) {
        await client.bind(targetBindDn, targetBindPassword);
      } else {
        await client.bind("", "");
      }

      return { ok: true, message: "Connected successfully" };
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    } finally {
      if (client) {
        try {
          await client.unbind();
        } catch {}
      }
    }
  }

  private loadCacheFromDisk(): void {
    try {
      const cachePath = getAdCachePath();
      if (fs.existsSync(cachePath)) {
        const raw = fs.readFileSync(cachePath, "utf-8");
        const data: AdCacheData = JSON.parse(raw);
        if (Array.isArray(data.allowedUsers)) {
          for (const u of data.allowedUsers) {
            if (typeof u === "string") {
              this.allowedUsersSet.add(u.trim().toLowerCase());
            }
          }
          this.lastSyncAt = data.updatedAt;
          logger.info(`[adSync] Loaded ${this.allowedUsersSet.size} allowed users from cache: ${cachePath}`);
        }
      }
    } catch (err) {
      logger.warn("[adSync] Failed to read initial cache from disk:", err);
    }
  }

  public async sync(): Promise<{ success: boolean; count: number; error?: string }> {
    if (!this.config.enabled) {
      return { success: true, count: this.allowedUsersSet.size };
    }

    if (this.isSyncing) {
      return { success: true, count: this.allowedUsersSet.size };
    }

    this.isSyncing = true;
    if (!this.config.tlsRejectUnauthorized) {
      logger.warn(
        "[SECURITY WARNING] Active Directory LDAPS certificate validation is disabled (AD_TLS_REJECT_UNAUTHORIZED=false). This allows man-in-the-middle attacks!"
      );
    }
    let client: Client | null = null;
    try {
      // AD-TLS-OPT-1: tlsOptions only for ldaps:// (ldap:// + tlsOptions = ECONNRESET)
      client = new Client(this.buildClientOptions(this.config.ldapUrl, this.config.tlsRejectUnauthorized, 10000));

      await client.bind(this.config.bindDn, this.config.bindPassword);

      let filter = "(&(objectCategory=person)(objectClass=user))";
      if (this.config.requiredGroupDn && this.config.requiredGroupDn.trim()) {
        const groupDn = this.config.requiredGroupDn.trim();
        filter = `(&(objectCategory=person)(objectClass=user)(memberOf:1.2.840.113556.1.4.1941:=${escapeLdapFilter(groupDn)}))`;
      }

      const searchResults = await client.search(this.config.searchBase || "", {
        scope: "sub",
        filter,
        attributes: [
          "sAMAccountName",
          "userPrincipalName",
          "userAccountControl",
          "mail",
          "displayName",
        ],
      });

      const newSet = new Set<string>();
      const userList: string[] = [];

      for (const entry of searchResults.searchEntries) {
        // userAccountControl check: ACCOUNTDISABLE = 2 (0x0002)
        const uacRaw = (entry as any).userAccountControl;
        const uac = typeof uacRaw === "number" ? uacRaw : parseInt(String(uacRaw || "0"), 10);
        if ((uac & 2) !== 0) {
          // Account is disabled in AD, skip
          continue;
        }

        const sam = (entry as any).sAMAccountName;
        const upn = (entry as any).userPrincipalName;
        const mail = (entry as any).mail;

        if (sam && typeof sam === "string") {
          const cleanSam = sam.trim().toLowerCase();
          newSet.add(cleanSam);
          userList.push(cleanSam);
        }

        if (upn && typeof upn === "string") {
          const cleanUpn = upn.trim().toLowerCase();
          newSet.add(cleanUpn);
          if (!userList.includes(cleanUpn)) {
            userList.push(cleanUpn);
          }
        }

        if (mail && typeof mail === "string") {
          const cleanMail = mail.trim().toLowerCase();
          newSet.add(cleanMail);
        }
      }

      this.allowedUsersSet = newSet;
      this.lastSyncAt = new Date().toISOString();
      this.lastSyncError = undefined;

      const cacheData: AdCacheData = {
        updatedAt: this.lastSyncAt,
        groupDn: this.config.requiredGroupDn,
        count: this.allowedUsersSet.size,
        allowedUsers: userList,
      };

      try {
        writeJsonAtomic(getAdCachePath(), cacheData);
      } catch (e) {
        logger.warn("[adSync] Could not write ad_cache.json atomically:", e);
      }

      logger.info(`[adSync] AD sync complete: ${this.allowedUsersSet.size} active users allowed.`);
      return { success: true, count: this.allowedUsersSet.size };
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastSyncError = msg;
      logger.error("[adSync] Active Directory sync failure (keeping previous cache active):", msg);
      // Fault tolerance: do NOT wipe out existing cache upon DC failure
      return { success: false, count: this.allowedUsersSet.size, error: msg };
    } finally {
      if (client) {
        try {
          await client.unbind();
        } catch {}
      }
      this.isSyncing = false;
    }
  }

  public isUserAllowed(user?: string | null): boolean {
    if (!this.config.enabled) {
      return true;
    }

    if (!user || typeof user !== "string" || user.trim() === "") {
      return !this.config.rejectUnknownUsers;
    }

    const clean = user.trim().toLowerCase();

    // 1. Direct match (e.g. sAMAccountName, full UPN, email)
    if (this.allowedUsersSet.has(clean)) {
      return true;
    }

    // 2. DOMAIN\username format -> match username
    if (clean.includes("\\")) {
      const parts = clean.split("\\");
      const nameOnly = parts[parts.length - 1];
      if (this.allowedUsersSet.has(nameOnly)) {
        return true;
      }
    }

    // 3. username@domain format -> match username
    if (clean.includes("@")) {
      const nameOnly = clean.split("@")[0];
      if (this.allowedUsersSet.has(nameOnly)) {
        return true;
      }
    }

    return false;
  }

  public startPeriodicSync(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (!this.config.enabled) {
      logger.info("[adSync] Active Directory sync is disabled (AD_ENABLED != true).");
      return;
    }

    if (!this.config.tlsRejectUnauthorized) {
      logger.warn(
        "[SECURITY WARNING] Active Directory LDAPS certificate validation is disabled (AD_TLS_REJECT_UNAUTHORIZED=false). This allows man-in-the-middle attacks!"
      );
    }
    logger.info(
      `[adSync] Starting periodic AD sync (interval=${this.config.syncIntervalSec}s, url=${this.config.ldapUrl})`
    );

    // Initial background trigger
    this.sync().catch((err) => {
      logger.warn("[adSync] Initial sync error:", err);
    });

    const intervalMs = this.config.syncIntervalSec * 1000;
    this.timer = setInterval(() => {
      this.sync().catch((err) => {
        logger.error("[adSync] Periodic sync error:", err);
      });
    }, intervalMs);

    this.timer.unref?.();
  }

  public stopPeriodicSync(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("[adSync] Stopped periodic AD sync.");
    }
  }

  public getAllowedUsersCount(): number {
    return this.allowedUsersSet.size;
  }

  public getLastSyncInfo() {
    return {
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      usersCount: this.allowedUsersSet.size,
      enabled: this.config.enabled,
    };
  }

  public setMockAllowedUsers(users: string[]): void {
    this.allowedUsersSet = new Set(users.map((u) => u.trim().toLowerCase()));
  }
}

export const adSyncService = new AdSyncService();

export function isDomainUserAllowed(user?: string | null): boolean {
  return adSyncService.isUserAllowed(user);
}

export function startAdSync(): void {
  adSyncService.startPeriodicSync();
}

export function stopAdSync(): void {
  adSyncService.stopPeriodicSync();
}

export function triggerAdSync(): Promise<{ success: boolean; count: number; error?: string }> {
  return adSyncService.sync();
}
