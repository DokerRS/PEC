import { Router, Request, Response } from "express";
import {
  testRemnawaveConnection,
  getAllRemnawavePanels,
  getRemnawavePanelById,
  saveRemnawavePanel,
  deleteRemnawavePanel,
  fetchRemnawaveUsers,
} from "../rotate.js";
import { createRateLimiter } from "../middleware/security.js";

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
      } = req.body || {};
      const saved = saveRemnawavePanel({
        id: req.params.id,
        name,
        panelUrl,
        apiToken,
        adminUser,
        adminPass,
        insecureTls,
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

  return router;
}
