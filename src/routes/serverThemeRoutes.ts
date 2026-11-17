import { Router, Request, Response, RequestHandler } from "express";
import { loadServerTheme, saveServerTheme } from "../serverTheme.js";

/**
 * THEME-SRC-1: admin-only endpoint for the dashboard appearance store.
 * The dashboard "Appearance" popover pushes {palette, mode, syncEnabled}
 * here (THEME-SRC-2); sync consumers read the store server-side
 * (THEME-SRC-3). The fleet token has NO access to this router.
 */
export function createServerThemeRouter(adminAuthMiddleware?: RequestHandler): Router {
  const router = Router();

  if (adminAuthMiddleware) {
    router.use(adminAuthMiddleware);
  }

  router.get(["/", "/api/server-theme"], (_req: Request, res: Response) => {
    const theme = loadServerTheme();
    if (!theme) {
      // Dashboard never pushed a theme: report defaults + absence flag
      return res.json({ ok: true, exists: false, palette: "cyber", mode: "dark", syncEnabled: true });
    }
    res.json({ ok: true, exists: true, ...theme });
  });

  router.post(["/", "/api/server-theme"], (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const saved = saveServerTheme({
        palette: body.palette,
        mode: body.mode,
        syncEnabled: body.syncEnabled,
      });
      res.json({ ok: true, ...saved });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  return router;
}
