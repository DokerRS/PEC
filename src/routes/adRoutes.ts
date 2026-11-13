import { Router, Request, Response, RequestHandler } from "express";
import { adSyncService } from "../adSync.js";
import { logger } from "../logger.js";

export function createAdRouter(adminAuthMiddleware?: RequestHandler): Router {
  const router = Router();

  if (adminAuthMiddleware) {
    router.use(adminAuthMiddleware);
  }

  // GET /api/ad/status
  router.get(["/", "/status", "/api/ad/status"], (_req: Request, res: Response) => {
    try {
      const cfg = adSyncService.getConfig();
      const lastSync = adSyncService.getLastSyncInfo();

      res.json({
        enabled: Boolean(cfg.enabled),
        ldapUrl: String(cfg.ldapUrl || ""),
        bindDn: String(cfg.bindDn || ""),
        searchBase: String(cfg.searchBase || ""),
        requiredGroupDn: String(cfg.requiredGroupDn || ""),
        syncIntervalSec: Number(cfg.syncIntervalSec) || 300,
        rejectUnknownUsers: Boolean(cfg.rejectUnknownUsers),
        tlsRejectUnauthorized: Boolean(cfg.tlsRejectUnauthorized),
        usersCount: adSyncService.getAllowedUsersCount(),
        hasPassword: Boolean(cfg.bindPassword && cfg.bindPassword.length > 0),
        lastSyncAt: lastSync.lastSyncAt,
        lastSyncError: lastSync.lastSyncError,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("[adRoutes] Error retrieving AD status:", msg);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // POST /api/ad/config
  router.post(["/config", "/api/ad/config"], (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      adSyncService.saveConfig(body);
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("[adRoutes] Error updating AD configuration:", msg);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // POST /api/ad/test
  router.post(["/test", "/api/ad/test"], async (req: Request, res: Response) => {
    try {
      const result = await adSyncService.testConnection(req.body);
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("[adRoutes] Error testing AD connection:", msg);
      res.json({ ok: false, error: msg });
    }
  });

  // POST /api/ad/sync-now
  router.post(["/sync-now", "/api/ad/sync-now"], async (_req: Request, res: Response) => {
    try {
      const result = await adSyncService.sync();
      res.json({
        ok: true,
        usersCount: result.count,
        syncedAt: new Date().toISOString(),
        ...(result.error ? { warning: result.error } : {}),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("[adRoutes] Error triggering AD sync:", msg);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  return router;
}
