import fs from "node:fs";
import crypto from "node:crypto";
import { Router, Request, Response } from "express";
import { getClientIp, recordAudit } from "../audit.js";
import { createRateLimiter, timingSafeEqualString } from "../middleware/security.js";
import {
  registerDesktopHeartbeat,
  getActiveDesktopInstances,
  getProxyConfig,
  setDesktopInstanceProxy,
  deleteDesktopInstance,
  getInstanceMeta,
  enrollInstanceToken,
  acquireInstanceMutex,
  revokeInstanceToken,
  unrevokeInstanceToken,
} from "../instances.js";
import { isDomainUserAllowed, adSyncService } from "../adSync.js";
import { getActiveProxy, getProxyById, getAllProxies } from "../proxies.js";
import { ProxyNode } from "../types.js";
import { getActiveRelease } from "../releases.js";
import { resolveProfileForInstance, expandRuleDomains, getProfileById } from "../routing.js";
import { getBuildConfig as getExtensionBuildConfig } from "../packager.js";
import { sanitizeSingleLine, logger } from "../logger.js";
import { DEFAULT_APP_VERSION, getAppBuildConfig, isDarkHexColor, isLightHexColor } from "../appPackager.js";
import { resolveFleetTheme, resolveThemeSyncEnabled } from "../serverTheme.js";
import {
  buildXraySyncBlock,
  normalizeRemnawaveUsername,
  type XraySyncBlock,
} from "../xrayRuntime.js";
import { isNewerVersion } from "../utils/semver.js";
import { getAppBuildInfoPath } from "../storage.js";

export function createAppSyncRouter(
  getFleetToken: () => string,
  getAdminToken?: () => string,
  cookieAuth?: (req: Request) => boolean
): Router {
  const router = Router();

  const limiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests: 120,
    message: "Too many desktop app sync requests.",
  });

  router.post("/api/app/sync", limiter, async (req: Request, res: Response) => {
    const getHeaderString = (val: string | string[] | undefined): string => {
      if (Array.isArray(val)) return typeof val[0] === "string" ? val[0].trim() : "";
      return typeof val === "string" ? val.trim() : "";
    };

    const rawAppInstanceId = (req.body?.appInstanceId || getHeaderString(req.headers["x-instance-id"]) || "") as string;
    const cleanAppId = typeof rawAppInstanceId === "string" ? rawAppInstanceId.trim() : "";

    const releaseLock = cleanAppId ? await acquireInstanceMutex(cleanAppId) : () => {};
    try {
      const rawInstanceToken = getHeaderString(req.headers["x-instance-token"]);
      const rawFleetToken = getHeaderString(req.headers["x-fleet-token"] || req.headers["x-ext-token"]);
      const rawAdminToken = getHeaderString(req.headers["x-admin-token"]);

      const fleetExpected = getFleetToken();
      const adminExpected = getAdminToken?.();

      let authenticated = false;
      let shouldEnroll = false;

      if (rawAdminToken && adminExpected && timingSafeEqualString(rawAdminToken, adminExpected)) {
        authenticated = true;
      } else if (cleanAppId) {
        const meta = getInstanceMeta(cleanAppId);
        if (meta?.revoked) {
          const boundUser = meta.domainUser || meta.username;
          const presentedUser = typeof req.body?.username === "string" ? req.body.username.trim() : "";
          const canAutoRecover = Boolean(
            meta.revokedReason !== "manual" &&
            rawFleetToken && fleetExpected && timingSafeEqualString(rawFleetToken, fleetExpected) &&
            boundUser && presentedUser && boundUser.toLowerCase() === presentedUser.toLowerCase() &&
            adSyncService.getConfig().enabled &&
            isDomainUserAllowed(boundUser)
          );

          if (canAutoRecover) {
            authenticated = true;
            shouldEnroll = true;
          } else {
            return res.status(401).json({ ok: false, error: "Unauthorized: Instance revoked" });
          }
        } else if (meta?.tokenHash) {
          if (!rawInstanceToken) {
            return res.status(401).json({
              ok: false,
              error: "Unauthorized: Instance already enrolled, X-Instance-Token required",
            });
          }
          const incomingHash = crypto.createHash("sha256").update(rawInstanceToken).digest("hex");
          if (timingSafeEqualString(incomingHash, meta.tokenHash)) {
            authenticated = true;
          } else {
            return res.status(401).json({ ok: false, error: "Unauthorized: Invalid instance token" });
          }
        } else {
          if (rawFleetToken && fleetExpected && timingSafeEqualString(rawFleetToken, fleetExpected)) {
            authenticated = true;
            shouldEnroll = true;
          }
        }
      } else {
        if (rawFleetToken && fleetExpected && timingSafeEqualString(rawFleetToken, fleetExpected)) {
          authenticated = true;
        }
      }

      if (!authenticated) {
        return res.status(401).json({ ok: false, error: "Unauthorized: Invalid fleet token" });
      }

      const {
        appInstanceId,
        hostname,
        username,
        version,
        os,
        clientType,
        pairedExtension,
      } = req.body || {};

      const effectiveAppId = appInstanceId || cleanAppId;
      if (!effectiveAppId || typeof effectiveAppId !== "string" || !effectiveAppId.trim()) {
        return res.status(400).json({ ok: false, error: "appInstanceId is required and must be non-empty" });
      }

      const clientIp = getClientIp(req);
      const existingMeta = cleanAppId ? getInstanceMeta(cleanAppId) : undefined;
      const cleanUsername = typeof username === "string" ? username.trim() : "";

      // Anti-spoofing check for desktop client:
      // Bind appInstanceId to the first registered username/domainUser.
      // Any attempt to switch username on an existing instance without admin reset is rejected.
      const boundUser = existingMeta?.domainUser || existingMeta?.username;
      if (cleanAppId && boundUser && cleanUsername && boundUser.toLowerCase() !== cleanUsername.toLowerCase()) {
        recordAudit({
          ip: clientIp,
          endpoint: "/api/app/sync",
          status: 403,
          result: "REJECTED_TOKEN",
          details: `Desktop username spoofing attempt: instance '${cleanAppId}' bound to '${boundUser}' but presented '${cleanUsername}'`,
        });
        return res.status(403).json({
          ok: false,
          error: "Forbidden: Username mismatch: instance is bound to a different domain user",
          action: "DISABLE_PROXY",
        });
      }

      // Active Directory membership check for desktop app (Kill-Switch)
      const adConfig = adSyncService.getConfig();
      if (adConfig.enabled) {
        const effectiveUser = cleanUsername || boundUser;
        if (!effectiveUser) {
          if (adConfig.rejectUnknownUsers) {
            if (cleanAppId) {
              revokeInstanceToken(cleanAppId, "ad_killswitch");
            }
            return res.status(403).json({
              ok: false,
              error: "Forbidden: AD identity required",
              action: "DISABLE_PROXY",
            });
          }
        } else if (!isDomainUserAllowed(effectiveUser)) {
          if (cleanAppId) {
            revokeInstanceToken(cleanAppId, "ad_killswitch");
          }
          return res.status(403).json({
            ok: false,
            error: "Forbidden: Access revoked by Active Directory",
            action: "DISABLE_PROXY",
          });
        } else {
          // User is authorized in Active Directory!
          // If desktop instance was previously revoked (and not manually locked by admin), auto-recover it
          if (cleanAppId && existingMeta?.revoked && existingMeta.revokedReason !== "manual") {
            unrevokeInstanceToken(cleanAppId);
            recordAudit({
              ip: clientIp,
              endpoint: "/api/app/sync",
              status: 200,
              result: "CONFIG_UPDATED",
              details: `Desktop access restored by Active Directory for user: ${effectiveUser}`,
            });
          }
        }
      }

      if (pairedExtension !== undefined && pairedExtension !== null) {
        if (typeof pairedExtension !== "object" || Array.isArray(pairedExtension)) {
          return res.status(400).json({ ok: false, error: "pairedExtension must be an object" });
        }
        if (pairedExtension.instanceId !== undefined) {
          if (typeof pairedExtension.instanceId !== "string" || !pairedExtension.instanceId.trim()) {
            return res.status(400).json({ ok: false, error: "pairedExtension.instanceId must be a non-empty string" });
          }
        }
      }

      const desktopRecord = registerDesktopHeartbeat({
        appInstanceId: cleanAppId,
        hostname: hostname || "unknown-host",
        username: username || "unknown-user",
        version: version || "1.0.0",
        os,
        clientType,
        ip: clientIp,
        pairedExtension,
      });

      let issuedInstanceToken: string | undefined;
      if (shouldEnroll && cleanAppId) {
        issuedInstanceToken = crypto.randomBytes(24).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(issuedInstanceToken).digest("hex");
        const enrolled = enrollInstanceToken(cleanAppId, tokenHash);
        if (!enrolled) {
          return res.status(409).json({ ok: false, error: "Conflict: Instance already enrolled" });
        }
      }

      // Check allowUserProxySwitch from getExtensionBuildConfig()
      const bldCfg = getExtensionBuildConfig();
      const allowUserSwitch = bldCfg.allowUserProxySwitch !== false;

      // If client requests a specific proxy assignment (e.g. user chose active proxy in UI)
      const reqSelectedId = req.body?.selectedProxyId ? String(req.body.selectedProxyId).trim() : "";
      const reqSelectedHost = req.body?.selectedProxyHost ? String(req.body.selectedProxyHost).trim() : "";
      const reqSelectedPort = req.body?.selectedProxyPort ? Number(req.body.selectedProxyPort) : 0;

      if (allowUserSwitch) {
        if (reqSelectedId === "default" || (req.body && req.body.selectedProxyId === "")) {
          setDesktopInstanceProxy(cleanAppId, null);
        } else if (reqSelectedId) {
          const found = getProxyById(reqSelectedId);
          if (found && (found as any).enabled !== false) {
            setDesktopInstanceProxy(cleanAppId, found.id);
          }
        } else if (reqSelectedHost && reqSelectedPort > 0) {
          const match = getAllProxies().find(
            (p) => p.host.toLowerCase() === reqSelectedHost.toLowerCase() && Number(p.port) === reqSelectedPort && (p as any).enabled !== false
          );
          if (match) {
            setDesktopInstanceProxy(cleanAppId, match.id);
          }
        }
      }

      // Determine active proxy for this desktop instance
      let effectiveNode: ProxyNode | undefined;
      const appMeta = getInstanceMeta(cleanAppId);
      const effectivePairedExtId = desktopRecord.pairedExtension?.instanceId;
      if (appMeta?.assignedProxyId) {
        effectiveNode = getProxyById(appMeta.assignedProxyId);
      } else if (effectivePairedExtId) {
        const extMeta = getInstanceMeta(effectivePairedExtId);
        if (extMeta?.assignedProxyId) {
          effectiveNode = getProxyById(extMeta.assignedProxyId);
        }
      }
      if (effectiveNode && (effectiveNode as any).enabled === false) {
        effectiveNode = undefined;
      }
      if (!effectiveNode) {
        effectiveNode = getActiveProxy();
      }

      const proxyConfig = getProxyConfig();
      const proxyPayload = effectiveNode
        ? {
            id: effectiveNode.id,
            name: effectiveNode.name || `${effectiveNode.host}:${effectiveNode.port}`,
            protocol: effectiveNode.protocol,
            host: effectiveNode.host,
            port: effectiveNode.port,
            user: effectiveNode.username || "",
            pass: effectiveNode.password || "",
          }
        : {
            id: "default",
            name: "Default Node",
            protocol: proxyConfig.protocol || "http",
            host: proxyConfig.host || "10.0.0.1",
            port: proxyConfig.port || 10809,
            user: "",
            pass: "",
          };

      const allProxiesList = getAllProxies(false).filter((p) => p.host && p.port && (p as any).enabled !== false);
      // Two-token isolation (AUDIT-SEC-1): a fleet-level app sync must never
      // receive credentials for nodes it is not assigned to. Credentials travel
      // only with the assigned activeProxy above; node switching is performed
      // server-side (selectedProxyId) and the next sync returns fresh credentials.
      const availableProxies = allProxiesList.map((p) => ({
        id: p.id,
        name: p.name || `${p.host}:${p.port}`,
        protocol: p.protocol || "socks5",
        host: p.host,
        port: p.port,
      }));

      const activeRelease = getActiveRelease("app");
      const clientVersion = String(version || "").trim();
      const latestVersion = activeRelease?.version || DEFAULT_APP_VERSION;
      let hasUpdate = Boolean(activeRelease && isNewerVersion(activeRelease.version, clientVersion));

      let activeReleaseInfo: any = { ...(activeRelease || {}) };
      try {
        const infoPath = getAppBuildInfoPath();
        if (fs.existsSync(infoPath)) {
          const buildInfo = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
          if (!activeRelease || buildInfo?.version === activeRelease?.version) {
            activeReleaseInfo = {
              embeddedVersion: buildInfo.embeddedVersion,
              binariesStale: buildInfo.binariesStale,
              ...activeReleaseInfo,
            };
            if (activeReleaseInfo.binariesStale === undefined && buildInfo.binariesStale !== undefined) {
              activeReleaseInfo.binariesStale = buildInfo.binariesStale;
            }
            if (!activeReleaseInfo.embeddedVersion && buildInfo.embeddedVersion) {
              activeReleaseInfo.embeddedVersion = buildInfo.embeddedVersion;
            }
          }
        }
      } catch {}

      if (hasUpdate && activeReleaseInfo?.binariesStale && activeReleaseInfo?.embeddedVersion && activeReleaseInfo.embeddedVersion === clientVersion) {
        hasUpdate = false;
        console.warn(
          `[APP-SYNC] Suppressed infinite update loop for client ${clientVersion}: active release ${latestVersion} has stale binaries with matching embeddedVersion ${activeReleaseInfo.embeddedVersion}`
        );
      }

      const downloadUrl = activeRelease
        ? `/api/releases/download/app/${encodeURIComponent(activeRelease.version)}`
        : `/api/releases/download/app/${encodeURIComponent(latestVersion)}`;

      // AUDIT-SRV-P3: username/hostname are client-supplied - sanitize before
      // logging so they cannot forge extra log lines.
      logger.info(
        `[APP-SYNC] Client '${sanitizeSingleLine(username || "unknown")}' on '${sanitizeSingleLine(hostname || "unknown")}' (v${version || "?"}, IP: ${clientIp}) sync OK` +
          (effectivePairedExtId ? ` [Paired: ${sanitizeSingleLine(effectivePairedExtId)} / ${sanitizeSingleLine(desktopRecord.pairedExtension?.browser || "?")}]` : "") +
          (hasUpdate ? ` [Update -> v${latestVersion}]` : "")
      );

      const targetProfileId = effectivePairedExtId || cleanAppId;
      const assignedProfile = resolveProfileForInstance(targetProfileId);
      const appBldCfg = getAppBuildConfig();
      const serverRules: Array<{
        id: string;
        process: string;
        hosts: string;
        ports: string;
        domains: string;
        protocol: string;
        action: string;
        enabled: boolean;
        isCorporate?: boolean;
      }> = [];

      // 1. Process rules configured in App Builder / Desktop Constructor
      if (Array.isArray(appBldCfg.processRules)) {
        for (const pr of appBldCfg.processRules) {
          serverRules.push({
            id: pr.id || `proc_rule_${serverRules.length + 1}`,
            process: pr.processName || "*",
            hosts: pr.targetHosts || "*",
            ports: pr.targetPorts || "*",
            domains: pr.targetDomains || "*",
            protocol: (pr.protocol || "BOTH").toUpperCase(),
            action: (pr.action || "PROXY").toUpperCase(),
            enabled: true,
            isCorporate: true,
          });
        }
      }

      // 2. Extension routing rules are strictly optional for desktop clients (default: false).
      // Only include if explicitly enabled in app configuration.
      const shouldIncludeExtRules = Boolean(
        appBldCfg.includeExtensionRules && (appBldCfg.inheritRoutingProfileId || assignedProfile)
      );
      if (shouldIncludeExtRules) {
        const extProfile = appBldCfg.inheritRoutingProfileId
          ? getProfileById(appBldCfg.inheritRoutingProfileId) || assignedProfile
          : assignedProfile;

        if (extProfile && Array.isArray(extProfile.rules)) {
          for (let i = 0; i < extProfile.rules.length; i++) {
            const r = extProfile.rules[i];
            if (!r.enabled) continue;
            if (
              Array.isArray(appBldCfg.inheritRuleIds) &&
              appBldCfg.inheritRuleIds.length > 0 &&
              !appBldCfg.inheritRuleIds.includes(r.id)
            ) {
              continue;
            }
            const expanded = expandRuleDomains(r);
            serverRules.push({
              id: r.id?.startsWith("ext_rule_") ? r.id : `ext_rule_${r.id || i + 1}`,
              process: "*",
              hosts: "*",
              ports: "*",
              domains: expanded.join("; ") || "*",
              protocol: "BOTH",
              action: r.action === "block" ? "BLOCK" : (r.action === "direct" ? "DIRECT" : "PROXY"),
              enabled: true,
              isCorporate: true,
            });
          }
        }
      }

      // THEME-SRC-3 (dashboard-as-source, replaces the THEME-WEB-1 gate):
      // global sync ON -> the PANEL theme is delivered (palette mapped to the
      // app presetStyle + mode; hex surfaces from the canonical registry);
      // OFF or a missing global store -> constructor themes (classic chain
      // below); the legacy per-config themeSyncEnabled flag is the fallback
      // when no global store exists (migration without breaking installs).
      const fleetTheme = resolveFleetTheme();
      const themeSyncOn = resolveThemeSyncEnabled(appBldCfg.themeSyncEnabled);
      const useDashboardTheme = themeSyncOn && Boolean(fleetTheme);

      const effectivePreset = useDashboardTheme
        ? fleetTheme!.style
        : assignedProfile?.colorPalette || appBldCfg.presetStyle || "cyber-blue";
      const effectiveMode = useDashboardTheme
        ? fleetTheme!.mode
        : assignedProfile?.defaultThemeMode || appBldCfg.defaultThemeMode || "dark";
      const isLightMode = effectiveMode === "light";
      let syncBg = useDashboardTheme
        ? fleetTheme!.background
        : assignedProfile?.themeBackground || appBldCfg.themeBackground || (isLightMode ? "#f1f5f9" : "#0b1120");
      let syncCard = useDashboardTheme
        ? fleetTheme!.card
        : assignedProfile?.themeCard || appBldCfg.themeCard || (isLightMode ? "#ffffff" : "#131d36");
      const syncPrimary = useDashboardTheme
        ? fleetTheme!.primary
        : assignedProfile?.themeColor || appBldCfg.themeColor || (isLightMode ? "#2563eb" : "#38bdf8");
      if (isLightMode) {
        // THEME-WEB-3: luminance replaces the leaky ^#2[0-4] prefix regex
        if (isDarkHexColor(syncBg)) {
          syncBg = effectivePreset === "dark-obsidian" ? "#faf5ff" : (effectivePreset === "emerald-secops" ? "#f0fdf4" : "#f1f5f9");
        }
        if (isDarkHexColor(syncCard)) {
          syncCard = "#ffffff";
        }
      } else {
        if (isLightHexColor(syncBg)) {
          syncBg = "#0b1120";
        }
        if (isLightHexColor(syncCard)) {
          syncCard = "#131d36";
        }
      }

      // REMNA-PERUSER-XRAY-1: per-user local Xray runtime block. Delivered
      // only when the admin enabled it AND the user passed AD authorization
      // (fail-closed: without AD enabled or without a resolved username the
      // client gets no xray block and keeps the legacy remote-proxy flow).
      // The subscription is fetched live from Remnawave and never persisted.
      let xrayBlock: XraySyncBlock | undefined;
      const xrayUser = normalizeRemnawaveUsername(cleanUsername || boundUser || "");
      if (xrayUser && adConfig.enabled && isDomainUserAllowed(xrayUser)) {
        const block = await buildXraySyncBlock({ username: xrayUser, includeConfig: true });
        if (block.enabled) {
          xrayBlock = block;
        } else if (block.reason) {
          // Runtime enabled but delivery failed: surface the reason so the
          // client can show why the local tunnel is unavailable.
          xrayBlock = { enabled: false, reason: block.reason };
        }
      }

      const theme = {
        preset: effectivePreset,
        layout: assignedProfile?.uiLayout || appBldCfg.uiLayout || "console",
        mode: effectiveMode,
        primary: syncPrimary,
        background: syncBg,
        card: syncCard,
        // THEME-SRC-FIX-3: the source marker drives popup theme priority —
        // "dashboard" wins over the local toggle, "constructor" does not.
        source: useDashboardTheme ? ("dashboard" as const) : ("constructor" as const),
      };

      // Constructor themes are always delivered now: the THEME-WEB-1
      // neutral semantics (omit while disabled) is replaced by the global
      // dashboard-as-source switch above.
      const themeBlock = theme;

      res.json({
        ok: true,
        ...(issuedInstanceToken ? { instanceToken: issuedInstanceToken } : {}),
        allowUserProxySwitch: allowUserSwitch,
        syncIntervalMinutes: appBldCfg.syncIntervalMinutes || 15,
        activeProxy: proxyPayload,
        availableProxies,
        serverRules,
        ...(xrayBlock ? { xrayRuntime: xrayBlock } : {}),
        ...(themeBlock ? { theme: themeBlock } : {}),
        update: {
          hasUpdate,
          latestVersion,
          mandatory: false,
          downloadUrl,
          sha256: activeRelease?.sha256 || "",
        },
      });
    } catch (err: any) {
      if (err?.message === "Invalid instanceId" || err?.message === "Forbidden instanceId") {
        return res.status(400).json({ ok: false, error: err.message });
      }
      console.error("[appSync] Error processing app sync:", err);
      res.status(500).json({ ok: false, error: "Internal server error" });
    } finally {
      releaseLock();
    }
  });

  router.get("/api/app/instances", (req: Request, res: Response) => {
    try {
      const rawAdminToken = (req.headers["x-admin-token"] || "") as string;
      const adminExpected = getAdminToken?.();
      const tokenOk = Boolean(rawAdminToken && adminExpected && timingSafeEqualString(rawAdminToken, adminExpected));
      const cookieOk = Boolean(cookieAuth && cookieAuth(req));

      if (!tokenOk && !cookieOk) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }

      res.json({
        ok: true,
        instances: getActiveDesktopInstances(),
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message || "Failed to get app instances" });
    }
  });

  router.post("/api/app/instances/:id/assign-proxy", (req: Request, res: Response) => {
    try {
      const rawAdminToken = (req.headers["x-admin-token"] || "") as string;
      const adminExpected = getAdminToken?.();
      const tokenOk = Boolean(rawAdminToken && adminExpected && timingSafeEqualString(rawAdminToken, adminExpected));
      const cookieOk = Boolean(cookieAuth && cookieAuth(req));

      if (!tokenOk && !cookieOk) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }

      const instanceId = req.params.id;
      const { proxyId } = req.body || {};
      const cleanProxyId = typeof proxyId === "string" ? proxyId.trim() : null;

      if (cleanProxyId && cleanProxyId !== "default") {
        const node = getProxyById(cleanProxyId);
        if (!node) {
          return res.status(404).json({ ok: false, error: "Proxy node not found" });
        }
      }

      const effectiveAssigned = cleanProxyId === "default" ? null : cleanProxyId;
      setDesktopInstanceProxy(instanceId, effectiveAssigned);
      res.json({ ok: true, appInstanceId: instanceId, assignedProxyId: effectiveAssigned });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message || "Failed to assign proxy" });
    }
  });

  router.delete("/api/app/instances/:id", (req: Request, res: Response) => {
    try {
      const rawAdminToken = (req.headers["x-admin-token"] || "") as string;
      const adminExpected = getAdminToken?.();
      const tokenOk = Boolean(rawAdminToken && adminExpected && timingSafeEqualString(rawAdminToken, adminExpected));
      const cookieOk = Boolean(cookieAuth && cookieAuth(req));

      if (!tokenOk && !cookieOk) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }

      const instanceId = req.params.id;
      deleteDesktopInstance(instanceId);
      res.json({ ok: true, appInstanceId: instanceId });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message || "Failed to delete desktop instance" });
    }
  });

  return router;
}
