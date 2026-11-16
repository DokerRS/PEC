import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import child_process from "node:child_process";

/**
 * fsync the temp file before rename so the atomic switch cannot publish a
 * buffer that is still sitting in the OS/page write-back cache when the
 * machine loses power (AUDIT-SRV-P3).
 */
function fsyncTempFile(tempFile: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempFile, "r+");
    fs.fsyncSync(fd);
  } catch {
    // fsync is a durability optimization: filesystems that reject it (some
    // network shares) must not lose the atomic write entirely.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * renameSync with Windows EPERM/EBUSY retries (AUDIT-SRV-P3). AV scanners
 * and search indexers can hold the destination for a moment; the old single
 * unlink+rename pass would lose the whole write. Back off briefly and retry.
 */
export function renameAtomicWithRetries(tempFile: string, filePath: string, maxAttempts = 5): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tempFile, filePath);
      return;
    } catch (err: any) {
      if (process.platform === "win32" && (err?.code === "EPERM" || err?.code === "EBUSY") && attempt < maxAttempts) {
        try { fs.unlinkSync(filePath); } catch {}
        // Synchronous short backoff; AV usually releases within milliseconds.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Atomic JSON persistence for all server state stores.
 *
 * A plain fs.writeFileSync leaves a truncated file on disk when the process
 * dies mid-write (SIGKILL, OOM, container restart). Reads are wrapped in
 * try/catch, so a torn store would silently reset to defaults - e.g. the
 * rotation schedule vanishing without any error. Writing to a temp file and
 * renaming (same directory, same filesystem) makes the switch atomic.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempFile = path.join(dir, `${path.basename(filePath)}.tmp.${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  fsyncTempFile(tempFile);
  renameAtomicWithRetries(tempFile, filePath);
}

/**
 * Atomic file persistence for raw buffers or strings (CRX, ZIP, XML, etc.).
 * Writes to a unique temp file in the same directory, then atomically renames.
 */
export function writeFileAtomic(
  filePath: string,
  data: Buffer | string,
  options?: { encoding?: BufferEncoding; mode?: number }
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempFile = path.join(dir, `${path.basename(filePath)}.tmp.${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(tempFile, data, options);
  fsyncTempFile(tempFile);
  renameAtomicWithRetries(tempFile, filePath);
}

/**
 * AUDIT-SRV-P3: POSIX mode bits are ignored on Windows - secret-bearing
 * stores (ad_config.json, panels_3xui.json) inherited Everyone:Read through
 * directory ACE inheritance. Strip inheritance and grant access to the
 * current user only. No-op on POSIX (0o600 already applies).
 */
export function restrictSecretFilePermissions(filePath: string): void {
  if (process.platform !== "win32") return;
  if (!fs.existsSync(filePath)) return;
  try {
    const user = process.env.USERNAME || process.env.USERDOMAIN || "";
    if (!user) return;
    child_process.execFileSync(
      "icacls",
      [filePath, "/inheritance:r", "/grant:r", `${user}:F`],
      { windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (err: any) {
    console.warn(`[store] Could not restrict Windows ACL on ${path.basename(filePath)}: ${err?.message || err}`);
  }
}

/**
 * Read a JSON store; on a parse/read failure preserve the broken file next
 * to itself as <name>.corrupt-<timestamp> (for post-mortem) and return null
 * so the caller falls back to defaults. A missing file is not an error.
 */
export function readJsonStore<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (err) {
    console.error(`[store] Unreadable JSON store at ${filePath}:`, err);
    try {
      const corruptPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(filePath, corruptPath);
      console.error(`[store] Broken store preserved as ${corruptPath}`);
    } catch {
      // best-effort only - the file may not exist at all
    }
    return null;
  }
}
