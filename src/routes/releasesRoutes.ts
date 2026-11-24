import { Router, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getReleasesDir } from "../storage.js";
import {
  getAllReleases,
  getActiveRelease,
  setActiveRelease,
  deleteRelease,
} from "../releases.js";
import { createRateLimiter, createTokenAuthMiddleware, timingSafeEqualString } from "../middleware/security.js";

export const releaseHashCache = new Map<string, string>();
const inFlightHashes = new Map<string, Promise<string>>();

export async function computeFileSha256(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const stat = await fs.promises.stat(resolved);
  const cacheKey = `${resolved}:${stat.mtimeMs}:${stat.size}`;
  const cached = releaseHashCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const inFlight = inFlightHashes.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const hashPromise = (async () => {
    try {
      const hash = await new Promise<string>((resolve, reject) => {
        const stream = fs.createReadStream(resolved);
        const hasher = crypto.createHash("sha256");
        stream.on("data", (chunk) => hasher.update(chunk));
        stream.on("end", () => resolve(hasher.digest("hex")));
        stream.on("error", (err) => {
          try {
            stream.destroy();
          } catch {}
          reject(err);
        });
      });
      if (releaseHashCache.size >= 200) {
        const oldestKey = releaseHashCache.keys().next().value;
        if (oldestKey) releaseHashCache.delete(oldestKey);
      }
      releaseHashCache.set(cacheKey, hash);
      return hash;
    } finally {
      inFlightHashes.delete(cacheKey);
    }
  })();

  inFlightHashes.set(cacheKey, hashPromise);
  return hashPromise;
}

export function createReleasesRouter(
  getAdminToken?: () => string,
  cookieAuth?: (req: Request) => boolean,
  getFleetToken?: () => string
): Router {
  const router = Router();

  const limiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests: 120,
    message: "Too many release manager requests.",
  });
  router.use("/api/releases", limiter);

  const adminAuthMiddleware = getAdminToken
    ? createTokenAuthMiddleware(getAdminToken, "x-admin-token", cookieAuth)
    : (_req: Request, _res: Response, next: () => void) => next();

  const getHeaderString = (val: string | string[] | undefined): string => {
    if (Array.isArray(val)) return (val[0] || "").split(",")[0].trim();
    if (typeof val === "string") return val.split(",")[0].trim();
    return "";
  };

  const downloadAuthMiddleware = (req: Request, res: Response, next: () => void) => {
    if (cookieAuth && cookieAuth(req)) {
      return next();
    }
    const adminToken = getAdminToken ? getAdminToken() : (process.env.ADMIN_TOKEN || "");
    const headerAdmin = getHeaderString(req.headers["x-admin-token"]);
    if (adminToken && headerAdmin && timingSafeEqualString(headerAdmin, adminToken)) {
      return next();
    }
    const rawType = String(req.params.type || "").toLowerCase();
    // Allow X-Fleet-Token only for extension downloads. Desktop app and MSI packages require admin credentials.
    if (rawType === "extension") {
      const fleetToken = getFleetToken ? getFleetToken() : (process.env.EXT_SHARED_TOKEN || process.env.FLEET_TOKEN || "");
      const headerFleet = getHeaderString(req.headers["x-fleet-token"] || req.headers["x-ext-token"]);
      if (fleetToken && headerFleet && timingSafeEqualString(headerFleet, fleetToken)) {
        return next();
      }
    }
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  };

  const VERSION_REGEX = /^[0-9]+(\.[0-9]+){1,3}(-[a-zA-Z0-9.-]+)?$/;

  router.get("/api/releases", adminAuthMiddleware, (_req: Request, res: Response) => {
    const store = getAllReleases();
    res.json({
      ok: true,
      activeExtensionVersion: store.activeExtensionVersion,
      activeAppVersion: store.activeAppVersion,
      releases: store.releases,
    });
  });

  // REL-OBS-1: observability of the extension update channel — kills the
  // "built != published != installed" confusion by reporting the LIVE facts
  // from /updates/updates.xml + the CRX bytes on disk, cross-checked against
  // the recorded release metadata (data/releases_meta.json).
  router.get("/api/releases/update-channel", adminAuthMiddleware, (_req: Request, res: Response) => {
    const updatesDir = path.resolve(process.env.PEC_UPDATES_DIR || "./dist/updates");
    const xmlPath = path.join(updatesDir, "updates.xml");
    const crxPath = path.join(updatesDir, "extension.crx");
    const crxPathAlt = path.join(updatesDir, "pec-extension.crx");

    const crxFinal = fs.existsSync(crxPath) ? crxPath : fs.existsSync(crxPathAlt) ? crxPathAlt : null;
    const xmlExists = fs.existsSync(xmlPath);
    if (!xmlExists || !crxFinal) {
      return res.json({
        ok: true,
        exists: false,
        reason: !xmlExists ? "updates.xml not found in the updates directory" : "extension.crx not found in the updates directory",
      });
    }

    // Parse the live gupdate manifest: version + codebase the browsers actually see.
    // Anchored to <updatecheck ...> so the XML declaration's version='1.0'
    // never matches first.
    let extensionVersion = "";
    let codebase = "";
    try {
      const xml = fs.readFileSync(xmlPath, "utf-8");
      extensionVersion = xml.match(/updatecheck[^>]*\bversion=['"]([^'"]+)['"]/)?.[1] || "";
      codebase = xml.match(/updatecheck[^>]*\bcodebase=['"]([^'"]+)['"]/)?.[1] || "";
    } catch {}

    const crxBuffer = fs.readFileSync(crxFinal);
    const crxSha256 = crypto.createHash("sha256").update(crxBuffer).digest("hex");
    const crxSize = crxBuffer.length;
    const publishedAt = fs.statSync(xmlPath).mtime.toISOString();

    // Cross-check against the recorded release (built artifact), when present.
    const recorded = getActiveRelease("extension");
    const matchesRecorded = recorded ? recorded.sha256 === crxSha256 : null;

    const envPublicBase = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
    const updatesXmlUrl = "/updates/updates.xml";
    const updatesXmlAbsUrl = (envPublicBase || codebase.replace(/\/updates\/extension\.crx$/, "") || "") + updatesXmlUrl;

    res.json({
      ok: true,
      exists: true,
      channel: {
        extensionVersion,
        crxSha256,
        crxSize,
        publishedAt,
        updatesXmlUrl,
        updatesXmlAbsUrl,
        codebase,
        crxUrl: updatesXmlAbsUrl.replace(/updates\.xml$/, "extension.crx"),
        matchesRecorded,
      },
      recorded: recorded
        ? { version: recorded.version, sha256: recorded.sha256, builtAt: recorded.builtAt }
        : null,
    });
  });

  router.post("/api/releases/set-active", adminAuthMiddleware, (req: Request, res: Response) => {
    try {
      const { type, version } = req.body || {};
      if (type !== "extension" && type !== "app") {
        return res.status(400).json({ ok: false, error: "Invalid type: must be 'extension' or 'app'" });
      }
      if (!version || typeof version !== "string" || !VERSION_REGEX.test(version.trim())) {
        return res.status(400).json({ ok: false, error: "Invalid version format" });
      }

      const result = setActiveRelease(type, version.trim());
      res.json({
        ok: true,
        activeVersion: result.activeVersion,
        isForwardRollback: result.isForwardRollback,
        rollbackFrom: result.rollbackFrom,
        message: result.isForwardRollback
          ? `Forward-rollback to v${result.activeVersion} (from v${result.rollbackFrom}) successfully released`
          : `Active ${type} version switched to ${result.activeVersion}`,
      });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err.message || "Failed to set active release" });
    }
  });

  router.delete("/api/releases/:type/:version", adminAuthMiddleware, (req: Request, res: Response) => {
    try {
      const { type, version } = req.params;
      if (type !== "extension" && type !== "app") {
        return res.status(400).json({ ok: false, error: "Invalid type: must be 'extension' or 'app'" });
      }
      if (!version || !VERSION_REGEX.test(version.trim())) {
        return res.status(400).json({ ok: false, error: "Invalid version format" });
      }

      const removed = deleteRelease(type, version.trim());
      if (!removed) {
        return res.status(404).json({ ok: false, error: "Release not found" });
      }
      res.json({ ok: true, removed: true });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err.message || "Failed to delete release" });
    }
  });

  router.get("/api/releases/download/:type/:version", downloadAuthMiddleware, async (req: Request, res: Response) => {
    try {
      const rawType = String(req.params.type || "").toLowerCase();
      const version = String(req.params.version || "").trim();
      if (rawType !== "extension" && rawType !== "app" && rawType !== "msi") {
        return res.status(400).json({ ok: false, error: "Invalid type: must be 'extension', 'app', or 'msi'" });
      }
      if (!version || !VERSION_REGEX.test(version)) {
        return res.status(400).json({ ok: false, error: "Invalid version format" });
      }

      const releasesBaseDir = path.resolve(getReleasesDir());
      const isInsideDir = (targetPath: string, parentDir: string): boolean => {
        const resolvedTarget = path.resolve(targetPath);
        const resolvedParent = path.resolve(parentDir);
        const targetCased = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
        const parentCased = process.platform === "win32" ? resolvedParent.toLowerCase() : resolvedParent;
        return targetCased.startsWith(parentCased + path.sep);
      };

      if (rawType === "msi") {
        const msiCandidates = [
          path.join(getReleasesDir(), "apps", version, `PEC-App-${version}.msi`),
          path.join(getReleasesDir(), "apps", version, "PEC-App.msi"),
        ];
        const msiPath = msiCandidates.find((p) => fs.existsSync(p));
        if (!msiPath) {
          return res.status(404).json({ ok: false, error: "MSI release file not found" });
        }
        const resolvedMsi = path.resolve(msiPath);
        if (!isInsideDir(resolvedMsi, releasesBaseDir)) {
          return res.status(403).json({ ok: false, error: "Access denied" });
        }
        return res.download(resolvedMsi, `PEC-App-${version}.msi`);
      }
      const type = rawType as "extension" | "app";
      const store = getAllReleases();
      const release = store.releases.find((r) => r.type === type && r.version === version);
      if (!release) {
        return res.status(404).json({ ok: false, error: "Release not found" });
      }

      if (!fs.existsSync(release.filePath)) {
        return res.status(404).json({ ok: false, error: "Release file not found on disk" });
      }

      const resolvedFile = path.resolve(release.filePath);
      if (!isInsideDir(resolvedFile, releasesBaseDir)) {
        return res.status(403).json({ ok: false, error: "Access denied" });
      }

      // Check SHA-256 integrity of release file on download (M-3)
      if (release.sha256 && /^[0-9a-fA-F]{64}$/.test(release.sha256)) {
        const actualHash = await computeFileSha256(resolvedFile);
        if (actualHash.toLowerCase() !== release.sha256.toLowerCase()) {
          return res.status(500).json({ ok: false, error: "Integrity check failed: release file SHA-256 mismatch" });
        }
      }

      const rawFilename = release.fileName || path.basename(release.filePath);
      const filename = path.basename(rawFilename).replace(/[\r\n"]/g, "");
      res.download(resolvedFile, filename, (err) => {
        if (err && !res.headersSent) {
          console.error("[releases] Download transfer error:", err);
          res.status(500).json({ ok: false, error: "Internal server error" });
        }
      });
    } catch (err: any) {
      console.error("[releases] Download error:", err);
      res.status(500).json({ ok: false, error: "Internal server error" });
    }
  });

  return router;
}
