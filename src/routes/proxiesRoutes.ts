import { Router, Request, Response } from "express";
import {
  getAllProxies,
  getProxyById,
  createProxy,
  updateProxy,
  deleteProxy,
  setActiveProxy,
  probeProxyEgress,
  probeAllProxies,
} from "../proxies.js";
import { syncRemnawaveUser, getRemnawavePanel } from "../rotate.js";
import { recordAudit, getClientIp } from "../audit.js";
import { ProxyNode } from "../types.js";

function maskPassword<T extends { password?: string }>(node: T): T {
  return {
    ...node,
    password: node.password ? "********" : "",
  };
}

// AUDIT-SRV-P3 (promise coalescing): concurrent syncs for the same node used
// to be rejected with 409 while a Set flag was held - a double-click in the
// dashboard surfaced a spurious error. Callers now await the in-flight work
// and receive its result.
const activeSyncProxies = new Map<string, Promise<{ status: number; body: unknown }>>();

export function createProxiesRouter(): Router {
  const router = Router();

  // GET /api/proxies - list all proxies (passwords masked)
  router.get("/api/proxies", (_req: Request, res: Response) => {
    res.json(getAllProxies(true));
  });

  // POST /api/proxies - create manual or Remnawave proxy
  router.post("/api/proxies", async (req: Request, res: Response) => {
    try {
      const { type, tag, name, protocol, host, port, username, password, isActive } = req.body || {};

      if (type !== undefined && type !== "manual" && type !== "remnawave") {
        return res.status(400).json({ error: "Invalid proxy type: must be 'manual' or 'remnawave'" });
      }

      if (type === "remnawave") {
        // A Remnawave node is backed by a panel user, not an inbound tag.
        const remnawaveUsername = String(username || tag || "").trim();
        if (!remnawaveUsername) {
          return res.status(400).json({ error: "username is required for remnawave proxy" });
        }

        const panel = getRemnawavePanel();
        if (!panel) {
          return res.status(400).json({ error: "Remnawave panel is not configured" });
        }

        const syncResult = await syncRemnawaveUser({
          panelUrl: panel.panelUrl,
          apiToken: panel.apiToken,
          adminUser: panel.adminUser,
          adminPass: panel.adminPass,
          username: remnawaveUsername,
          insecureTls: panel.insecureTls,
        });

        if (!syncResult.ok) {
          return res.status(400).json({ error: syncResult.message || "Failed to sync user from Remnawave" });
        }

        let finalHost = host ? String(host).trim() : "";
        if (!finalHost) {
          try {
            finalHost = new URL(panel.panelUrl).hostname;
          } catch {
            finalHost = "127.0.0.1";
          }
        }

        const created = createProxy({
          tag: tag ? String(tag).trim() : remnawaveUsername,
          name: name ? String(name).trim() : remnawaveUsername,
          type: "remnawave",
          panelId: panel.id,
          remnawaveUsername: syncResult.username || remnawaveUsername,
          protocol: protocol === "http" || protocol === "https" ? protocol : "socks5",
          host: finalHost,
          port: port !== undefined && port !== null && port !== "" ? port : 443,
          username: syncResult.username,
          password: syncResult.password,
          isActive: isActive !== undefined ? Boolean(isActive) : undefined,
          lastSync: new Date().toISOString(),
          status: "OK",
        });

        recordAudit({
          ip: getClientIp(req),
          endpoint: "/api/proxies",
          status: 201,
          result: "PROXY_CREATED",
          details: `Created Remnawave proxy: ${created.tag} (${created.protocol}://${created.host}:${created.port})`,
        });

        return res.status(201).json(maskPassword(created));
      } else {
        // manual proxy
        if (!tag || !protocol || !host || port === undefined || port === null || port === "") {
          return res.status(400).json({ error: "tag, protocol, host, and port are required for manual proxy" });
        }

        const created = createProxy({
          tag: String(tag).trim(),
          name: name ? String(name).trim() : undefined,
          type: "manual",
          protocol,
          host: String(host).trim(),
          port,
          username: username !== undefined ? String(username) : undefined,
          password: password !== undefined ? String(password) : undefined,
          isActive: isActive !== undefined ? Boolean(isActive) : undefined,
        });

        recordAudit({
          ip: getClientIp(req),
          endpoint: "/api/proxies",
          status: 201,
          result: "PROXY_CREATED",
          details: `Created manual proxy: ${created.tag} (${created.protocol}://${created.host}:${created.port})`,
        });

        return res.status(201).json(maskPassword(created));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(400).json({ error: msg });
    }
  });

  // PUT /api/proxies/:id - update existing proxy
  router.put("/api/proxies/:id", (req: Request, res: Response) => {
    try {
      const updated = updateProxy(req.params.id, req.body);
      recordAudit({
        ip: getClientIp(req),
        endpoint: `/api/proxies/${req.params.id}`,
        status: 200,
        result: "PROXY_UPDATED",
        details: `Updated proxy: ${updated.tag} (${updated.id})`,
      });
      return res.json(maskPassword(updated));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Proxy not found")) {
        return res.status(404).json({ error: msg });
      }
      return res.status(400).json({ error: msg });
    }
  });

  // DELETE /api/proxies/:id - delete proxy
  router.delete("/api/proxies/:id", (req: Request, res: Response) => {
    const removed = deleteProxy(req.params.id);
    if (removed) {
      recordAudit({
        ip: getClientIp(req),
        endpoint: `/api/proxies/${req.params.id}`,
        status: 200,
        result: "PROXY_DELETED",
        details: `Deleted proxy: ${req.params.id}`,
      });
    }
    return res.json({ ok: true, removed });
  });

  // POST /api/proxies/:id/activate - activate proxy
  router.post("/api/proxies/:id/activate", (req: Request, res: Response) => {
    try {
      const activated = setActiveProxy(req.params.id);
      recordAudit({
        ip: getClientIp(req),
        endpoint: `/api/proxies/${req.params.id}/activate`,
        status: 200,
        result: "PROXY_ACTIVATED",
        details: `Activated proxy: ${activated.tag} (${activated.id})`,
      });
      return res.json({ ok: true, activeProxy: maskPassword(activated) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Proxy not found")) {
        return res.status(404).json({ error: msg });
      }
      return res.status(400).json({ error: msg });
    }
  });

  // POST /api/proxies/:id/sync - sync Remnawave proxy credentials
  router.post("/api/proxies/:id/sync", async (req: Request, res: Response) => {
    const proxyId = req.params.id;

    // AUDIT-SRV-P3: coalesce concurrent syncs for the same node instead of
    // rejecting the second caller - it waits and receives the same outcome.
    const inFlight = activeSyncProxies.get(proxyId);
    if (inFlight) {
      const settled = await inFlight.catch((err: unknown): { status: number; body: unknown } => ({
        status: 500,
        body: { ok: false, error: err instanceof Error ? err.message : String(err) },
      }));
      return res.status(settled.status).json(settled.body);
    }

    const work = (async (): Promise<{ status: number; body: unknown }> => {
      const proxy = getProxyById(proxyId);
      if (!proxy) {
        return { status: 404, body: { error: "Proxy not found" } };
      }
      if (proxy.type !== "remnawave") {
        return { status: 400, body: { error: "Only Remnawave proxy nodes can be synced" } };
      }

      const panel = getRemnawavePanel();
      if (!panel) {
        return { status: 400, body: { error: "Remnawave panel is not configured" } };
      }

      const targetUsername = proxy.remnawaveUsername || proxy.username;
      if (!targetUsername) {
        return { status: 400, body: { error: "Proxy node has no Remnawave username to sync" } };
      }

      const syncResult = await syncRemnawaveUser({
        panelUrl: panel.panelUrl,
        apiToken: panel.apiToken,
        adminUser: panel.adminUser,
        adminPass: panel.adminPass,
        username: targetUsername,
        insecureTls: panel.insecureTls,
      });

      if (!syncResult.ok) {
        updateProxy(proxy.id, {
          status: "ERROR",
          errorMessage: syncResult.message,
          lastSync: new Date().toISOString(),
        });
        return { status: 400, body: { ok: false, error: syncResult.message } };
      }

      const updates: Partial<ProxyNode> = {
        status: "OK",
        errorMessage: undefined,
        lastSync: new Date().toISOString(),
      };
      if (syncResult.password !== undefined) updates.password = syncResult.password;
      if (syncResult.username !== undefined) {
        updates.username = syncResult.username;
        updates.remnawaveUsername = syncResult.username;
      }

      const updated = updateProxy(proxy.id, updates);

      return {
        status: 200,
        body: {
          ok: true,
          proxy: maskPassword(updated),
          message: syncResult.message || "Proxy synchronized successfully",
        },
      };
    })();

    activeSyncProxies.set(proxyId, work);
    try {
      const settled = await work;
      return res.status(settled.status).json(settled.body);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ ok: false, error: msg });
    } finally {
      activeSyncProxies.delete(proxyId);
    }
  });

  // POST /api/proxies/check-all - probe all proxies
  router.post("/api/proxies/check-all", async (_req: Request, res: Response) => {
    try {
      const results = await probeAllProxies();
      return res.json({ ok: true, results });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  // POST /api/proxies/:id/check - probe single proxy egress & connectivity
  router.post("/api/proxies/:id/check", async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      const proxy = getProxyById(id);
      if (!proxy) {
        return res.status(404).json({ ok: false, error: "Proxy not found" });
      }
      const result = await probeProxyEgress(proxy);
      return res.json({ ok: true, result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ ok: false, error: msg });
    }
  });


  // POST /api/remnawave/user-lookup - read a Remnawave user's credentials
  router.post("/api/remnawave/user-lookup", async (req: Request, res: Response) => {
    try {
      const username = req.body?.username || req.body?.tag;
      if (!username || typeof username !== "string" || !username.trim()) {
        return res.status(400).json({ error: "username is required" });
      }

      const panel = getRemnawavePanel();
      if (!panel) {
        return res.status(400).json({ error: "Remnawave panel is not configured" });
      }

      const syncResult = await syncRemnawaveUser({
        panelUrl: panel.panelUrl,
        apiToken: panel.apiToken,
        adminUser: panel.adminUser,
        adminPass: panel.adminPass,
        username: username.trim(),
        insecureTls: panel.insecureTls,
      });

      if (!syncResult.ok) {
        return res.status(400).json({ ok: false, error: syncResult.message });
      }

      return res.json({
        ok: true,
        user: {
          username: syncResult.username || username.trim(),
          userId: syncResult.userId,
          shortUuid: syncResult.shortUuid,
          status: syncResult.status,
          subscriptionUrl: syncResult.subscriptionUrl,
          hasPassword: Boolean(syncResult.password),
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  return router;
}
