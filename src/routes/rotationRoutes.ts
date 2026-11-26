import { Router, Request, Response } from "express";
import {
  getRotationConfig,
  getRotationConfigPublic,
  getRotationHistory,
  updateRotationConfig,
  runManualRotation,
} from "../scheduler.js";
import {
  testRemnawaveConnection,
  getAllRemnawavePanels,
  getRemnawavePanelById,
  saveRemnawavePanel,
  deleteRemnawavePanel,
  fetchRemnawaveUsers,
} from "../rotate.js";
import { recordAudit, getClientIp } from "../audit.js";
import { createRateLimiter } from "../middleware/security.js";

/**
 * Normalizes and preserves rotAdminPass / adminPass when updating rotation/proxy config:
 * If rotAdminPass is an empty string ("") or undefined in the request body,
 * the existing rotAdminPass / adminPass from current storage is preserved instead of wiped out.
 */
export function preservePasswordOnConfigUpdate(
  body: any,
  currentStorage: { adminPass?: string; rotAdminPass?: string } = getRotationConfig()
): any {
  const currentPass = currentStorage.rotAdminPass || currentStorage.adminPass || "";
  const sanitized = { ...body };

  if ("rotAdminPass" in sanitized) {
    if (sanitized.rotAdminPass === "" || sanitized.rotAdminPass === undefined) {
      sanitized.rotAdminPass = currentPass;
      sanitized.adminPass = currentPass;
    } else {
      sanitized.adminPass = sanitized.rotAdminPass;
    }
  } else if ("adminPass" in sanitized) {
    if (sanitized.adminPass === "" || sanitized.adminPass === undefined) {
      sanitized.adminPass = currentPass;
      sanitized.rotAdminPass = currentPass;
    } else {
      sanitized.rotAdminPass = sanitized.adminPass;
    }
  }

  return sanitized;
}

export function updateRotationConfigWithPreservation(body: any) {
  const sanitized = preservePasswordOnConfigUpdate(body);
  return updateRotationConfig(sanitized);
}

export function createRotationRouter(): Router {
  const router = Router();

  const testLimiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests: 15,
    message: "Rate limit exceeded for Remnawave connection test.",
  });

  // ----------------- REMNAWAVE PANELS REGISTRY -----------------

  router.get("/api/remnawave/panels", (_req: Request, res: Response) => {
    try {
      const panels = getAllRemnawavePanels(true);
      res.json(panels);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/api/remnawave/panels", (req: Request, res: Response) => {
    try {
      const {
        name,
        panelUrl,
        apiToken,
        adminUser,
        adminPass,
        insecureTls,
        rotationEnabled,
        targetUsername,
        rotationIntervalMinutes,
      } = req.body || {};
      const hasApiToken = typeof apiToken === "string" && apiToken.trim().length > 0;
      const hasLegacyCredentials =
        typeof adminUser === "string" &&
        adminUser.trim().length > 0 &&
        typeof adminPass === "string" &&
        adminPass.trim().length > 0;
      if (!name || !panelUrl || (!hasApiToken && !hasLegacyCredentials)) {
        return res.status(400).json({ error: "Missing required fields: name, panelUrl, apiToken" });
      }
      const saved = saveRemnawavePanel({
        name,
        panelUrl,
        apiToken,
        adminUser,
        adminPass,
        insecureTls,
        rotationEnabled,
        targetUsername,
        rotationIntervalMinutes,
      });
      res.json({
        ...saved,
        apiToken: saved.apiToken ? "••••••••" : "",
        adminPass: saved.adminPass ? "••••••••" : "",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.put("/api/remnawave/panels/:id", (req: Request, res: Response) => {
    try {
      const {
        name,
        panelUrl,
        apiToken,
        adminUser,
        adminPass,
        insecureTls,
        rotationEnabled,
        targetUsername,
        rotationIntervalMinutes,
      } = req.body || {};
      const saved = saveRemnawavePanel({
        id: req.params.id,
        name,
        panelUrl,
        apiToken,
        adminUser,
        adminPass,
        insecureTls,
        rotationEnabled,
        targetUsername,
        rotationIntervalMinutes,
      });
      res.json({
        ...saved,
        apiToken: saved.apiToken ? "••••••••" : "",
        adminPass: saved.adminPass ? "••••••••" : "",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.delete("/api/remnawave/panels/:id", (req: Request, res: Response) => {
    try {
      const ok = deleteRemnawavePanel(req.params.id);
      res.json({ ok });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/api/remnawave/panels/:id/test", testLimiter, async (req: Request, res: Response) => {
    try {
      const panel = getRemnawavePanelById(req.params.id);
      if (!panel) return res.status(404).json({ ok: false, message: "Panel not found" });
      const result = await testRemnawaveConnection({
        panelUrl: panel.panelUrl,
        apiToken: panel.apiToken,
        adminUser: panel.adminUser,
        adminPass: panel.adminPass,
        targetUsername: panel.targetUsername,
        timeoutSec: 8,
      });
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  router.get("/api/remnawave/panels/:id/users", async (req: Request, res: Response) => {
    try {
      const users = await fetchRemnawaveUsers(req.params.id);
      res.json(users);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/api/rotation/config", (_req: Request, res: Response) => {
    const pub = getRotationConfigPublic();
    res.json({
      config: {
        ...pub,
        rotAdminPass: pub.adminPass,
      },
      history: getRotationHistory().slice(0, 10),
    });
  });

  router.post("/api/rotation/config", (req: Request, res: Response) => {
    try {
      const updated = updateRotationConfigWithPreservation(req.body);
      // never echo the real admin password back to the client
      const masked = updated.adminPass ? "********" : "";
      res.json({ ...updated, adminPass: masked, rotAdminPass: masked });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.post("/api/rotation/rotate-now", async (req: Request, res: Response) => {
    try {
      const result = await runManualRotation();
      recordAudit({
        ip: getClientIp(req),
        endpoint: "/api/rotation/rotate-now",
        status: 200,
        result: "ROTATED",
        details: `Source: ${result.source}, User: ${result.user}`,
      });
      res.json({ ok: true, result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  router.post("/api/remnawave/test", testLimiter, async (req: Request, res: Response) => {
    try {
      const current = getRotationConfig();
      const testConfig = {
        panelUrl: req.body?.panelUrl || current.panelUrl,
        apiToken: req.body?.apiToken || "",
        adminUser: req.body?.adminUser || current.adminUser,
        adminPass:
          req.body?.adminPass !== undefined && req.body.adminPass !== ""
            ? req.body.adminPass
            : current.adminPass,
        targetUsername: req.body?.targetUsername || current.targetUsername,
        timeoutSec: 7,
      };
      const result = await testRemnawaveConnection(testConfig);
      res.json(result);
    } catch (err: unknown) {
      // Express 4 does not catch async rejections - without this handler an
      // unexpected failure inside the tester would crash the whole process.
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  return router;
}
