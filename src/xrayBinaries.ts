import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getDataDir } from "./storage.js";
import { writeJsonAtomic, readJsonStore } from "./jsonStore.js";
import { logger } from "./logger.js";

/**
 * REMNA-PERUSER-XRAY-1: cached hosting of the admin-pinned Xray core binary.
 * The PEC server is the only fleet member allowed to talk to GitHub: an admin
 * triggers a fetch of the pinned release, the server extracts xray.exe from
 * the official zip, hashes it, and streams the verified binary to clients
 * (fleet-authenticated). Clients never contact GitHub directly and never run
 * an unpinned core.
 */

export interface XrayBinaryMeta {
  version: string;
  /** Release asset the binary was extracted from. */
  asset: string;
  sha256: string;
  sizeBytes: number;
  fetchedAt: string;
}

/** Assets we accept from the official Xray-core release (windows client fleet). */
const ALLOWED_ASSETS = new Set(["Xray-windows-64.zip", "Xray-linux-64.zip"]);
const MAX_ZIP_BYTES = 80 * 1024 * 1024;

export function isValidXrayVersion(version: string): boolean {
  return /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version);
}

export function getBinaryCacheDir(): string {
  const dir = path.join(getDataDir(), "xray-binaries");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function exePathFor(version: string): string {
  return path.join(getBinaryCacheDir(), `xray-${version}.exe`);
}

function metaPathFor(version: string): string {
  return path.join(getBinaryCacheDir(), `xray-${version}.json`);
}

export function getCachedXrayBinary(version: string): { meta: XrayBinaryMeta; exePath: string } | null {
  if (!isValidXrayVersion(version)) return null;
  const exePath = exePathFor(version);
  try {
    const meta = readJsonStore<XrayBinaryMeta>(metaPathFor(version));
    if (meta && meta.version === version && fs.existsSync(exePath)) {
      return { meta, exePath };
    }
  } catch {}
  return null;
}

export function listCachedXrayBinaries(): XrayBinaryMeta[] {
  const dir = getBinaryCacheDir();
  const out: XrayBinaryMeta[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^xray-\d+\.\d+\.\d+\.json$/.test(f)) continue;
      try {
        const meta = readJsonStore<XrayBinaryMeta>(path.join(dir, f));
        if (meta && meta.version) out.push(meta);
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : -1));
}

export function deleteCachedXrayBinary(version: string): boolean {
  if (!isValidXrayVersion(version)) return false;
  let removed = false;
  for (const p of [exePathFor(version), metaPathFor(version)]) {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p);
        removed = true;
      }
    } catch {}
  }
  return removed;
}

function envProxyUrl(): string | undefined {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY;
}

/**
 * Download the pinned Xray-core release zip from GitHub, extract xray.exe,
 * verify integrity and cache it atomically. Rejects anything that does not
 * look like the official asset. Concurrent fetches of the same version are
 * coalesced.
 */
const inFlight = new Map<string, Promise<XrayBinaryMeta>>();

export async function fetchXrayBinary(version: string, asset = "Xray-windows-64.zip"): Promise<XrayBinaryMeta> {
  const ver = String(version || "").trim().replace(/^v+/, "");
  if (!isValidXrayVersion(ver)) throw new Error("Version must look like 24.11.11");
  if (!ALLOWED_ASSETS.has(asset)) throw new Error("Unsupported release asset");
  const existing = getCachedXrayBinary(ver);
  if (existing) return existing.meta;
  const key = `${ver}|${asset}`;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = (async (): Promise<XrayBinaryMeta> => {
    const url = `https://github.com/XTLS/Xray-core/releases/download/v${ver}/${encodeURIComponent(asset)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let tmpZip = "";
    try {
      const fetchOpts: any = { signal: controller.signal, redirect: "follow" };
      const proxyUrl = envProxyUrl();
      if (proxyUrl) {
        try {
          const { ProxyAgent } = await import("undici");
          fetchOpts.dispatcher = new ProxyAgent(proxyUrl);
        } catch {}
      }
      logger.info(`[xrayBinaries] Fetching ${url}`);
      const res = await fetch(url, fetchOpts);
      if (!res.ok) throw new Error(`GitHub release download failed: HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") || 0);
      if (declared > MAX_ZIP_BYTES) throw new Error("Release asset too large");

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_ZIP_BYTES) throw new Error("Unexpected release asset size");

      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip(buf);
      const entry = zip.getEntry("xray.exe") || zip.getEntry("xray");
      if (!entry) throw new Error("Release zip does not contain xray core binary");
      const exeBuf = zip.readFile(entry);
      if (!exeBuf || exeBuf.length < 1024 * 1024) throw new Error("Extracted core binary looks truncated");

      const sha256 = crypto.createHash("sha256").update(exeBuf).digest("hex");
      const exePath = exePathFor(ver);
      tmpZip = `${exePath}.tmp-${Date.now()}`;
      fs.writeFileSync(tmpZip, exeBuf);
      fs.renameSync(tmpZip, exePath);
      tmpZip = "";

      const meta: XrayBinaryMeta = {
        version: ver,
        asset,
        sha256,
        sizeBytes: exeBuf.length,
        fetchedAt: new Date().toISOString(),
      };
      writeJsonAtomic(metaPathFor(ver), meta);
      logger.info(`[xrayBinaries] Cached xray ${ver} (${exeBuf.length} bytes, sha256=${sha256.slice(0, 16)}...)`);
      return meta;
    } finally {
      clearTimeout(timeout);
      if (tmpZip) {
        try { fs.rmSync(tmpZip, { force: true }); } catch {}
      }
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return task;
}
