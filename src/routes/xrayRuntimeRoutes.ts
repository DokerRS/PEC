import fs from "node:fs";
import { Router, Request, Response } from "express";
import type { RequestHandler } from "express";
import { loadXrayRuntimeSettings, saveXrayRuntimeSettings } from "../xrayRuntime.js";
import {
  fetchXrayBinary,
  getCachedXrayBinary,
  listCachedXrayBinaries,
  deleteCachedXrayBinary,
  isValidXrayVersion,
} from "../xrayBinaries.js";
import { timingSafeEqualString, createRateLimiter } from "../middleware/security.js";
import { logger } from "../logger.js";

/**
 * REMNA-PERUSER-XRAY-1: admin-only control of the per-user Xray runtime
 * (core version pin, shared localhost port, master switch) plus the pinned
 * core binary cache. Mounted WITH the /api/xray-runtime prefix so the
 * router-wide admin auth never intercepts unrelated application routes.
 *
 * The binary download endpoint is mounted BEFORE the admin middleware and
 * authenticates with the low-privilege fleet token instead: PEC-App machines
 * pull the pinned xray.exe from here (they never contact GitHub directly).
 */
export function createXrayRuntimeRouter(adminAuthMiddleware?: RequestHandler, getFleetToken?: () => string): Router {
  const router = Router();

  const downloadLimiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests: 10,
    message: "Too many core download requests.",
  });

  // Fleet-authenticated pinned core download (registered before admin auth).
  router.get("/binaries/:version/download", downloadLimiter, (req: Request, res: Response) => {
    try {
      const fleetToken = getFleetToken?.();
      const header = req.headers["x-fleet-token"] || req.headers["x-ext-token"];
      const presented = Array.isArray(header) ? header[0] : header;
      if (!fleetToken || !presented || !timingSafeEqualString(String(presented), fleetToken)) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
      const version = String(req.params.version || "");
      if (!isValidXrayVersion(version)) {
        return res.status(400).json({ ok: false, error: "Invalid version" });
      }
      const cached = getCachedXrayBinary(version);
      if (!cached) {
        return res.status(404).json({ ok: false, error: "Core version not cached on server" });
      }
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(cached.meta.sizeBytes));
      res.setHeader("X-Sha256", cached.meta.sha256);
      res.setHeader("Cache-Control", "private, max-age=3600");
      fs.createReadStream(cached.exePath).on("error", (err) => {
        logger.warn(`[xray-runtime] Binary stream failed for ${version}: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ ok: false, error: "Read failed" });
        else res.destroy();
      }).pipe(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.status(500).json({ ok: false, error: msg });
    }
  });

  if (adminAuthMiddleware) {
    router.use(adminAuthMiddleware);
  }

  router.get(["/", "/xray-runtime"], (_req: Request, res: Response) => {
    res.json({ ok: true, ...loadXrayRuntimeSettings(), binaries: listCachedXrayBinaries() });
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

  // Admin: cache the pinned core binary on the server (fetched from GitHub).
  router.post("/binaries/fetch", async (req: Request, res: Response) => {
    try {
      const version = String(req.body?.version || "").trim();
      const asset = String(req.body?.asset || "Xray-windows-64.zip").trim();
      const meta = await fetchXrayBinary(version, asset);
      res.json({ ok: true, binary: meta });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ ok: false, error: msg });
    }
  });

  router.delete("/binaries/:version", (req: Request, res: Response) => {
    const removed = deleteCachedXrayBinary(String(req.params.version || ""));
    res.json({ ok: true, removed });
  });

  return router;
}
