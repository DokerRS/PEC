import { Router, Request, Response } from "express";
import type { RequestHandler } from "express";
import { loadXrayRuntimeSettings, saveXrayRuntimeSettings } from "../xrayRuntime.js";

/**
 * REMNA-PERUSER-XRAY-1: admin-only control of the per-user Xray runtime
 * (core version pin, shared localhost port, master switch). Mounted WITH the
 * /api/xray-runtime prefix so the router-wide admin auth never intercepts
 * unrelated application routes.
 */
export function createXrayRuntimeRouter(adminAuthMiddleware?: RequestHandler): Router {
  const router = Router();

  if (adminAuthMiddleware) {
    router.use(adminAuthMiddleware);
  }

  router.get(["/", "/xray-runtime"], (_req: Request, res: Response) => {
    res.json({ ok: true, ...loadXrayRuntimeSettings() });
  });

  router.post(["/", "/xray-runtime"], (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const saved = saveXrayRuntimeSettings({
        enabled: body.enabled,
        version: body.version,
        listenPort: body.listenPort,
      });
      res.json({ ok: true, ...saved });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ ok: false, error: msg });
    }
  });

  return router;
}
