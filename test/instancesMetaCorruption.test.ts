import "./helpers/setup.js";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert";

/**
 * AUDIT-SRV-1: a torn instances_meta.json used to silently reset to defaults,
 * which resurrects revoked instances (revoked flags / token hashes lost) with
 * no trace. The module load must instead:
 *   1. preserve the broken original as <name>.corrupt-<timestamp> for post-mortem,
 *   2. emit a loud security warning about the lost revoked flags,
 *   3. still load (fail-open to defaults, but loudly).
 *
 * instances.ts resolves its store path and reads the file at import time, so
 * this file seeds the broken payload BEFORE the first dynamic import and must
 * not statically import anything that transitively pulls src/instances.js.
 */
test("instances.ts: corrupted instances_meta.json is preserved and triggers a loud security warning", async () => {
  const metaPath = process.env.INSTANCES_META_PATH!;
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  const brokenPayload = '{ "inst_revoked_1": { "revoked": tru';
  fs.writeFileSync(metaPath, brokenPayload, "utf-8");

  const captured: string[] = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };

  try {
    const mod = await import("../src/instances.js");

    // 3. module still loads — server must boot, not crash, on a broken store
    assert.strictEqual(typeof mod.getInstanceMeta, "function");
    assert.strictEqual(mod.getInstanceMeta("inst_revoked_1"), undefined, "unreadable meta resets to empty registry");

    // 1. broken original preserved for post-mortem
    const dir = path.dirname(metaPath);
    const preserved = fs
      .readdirSync(dir)
      .find((f) => f.startsWith(path.basename(metaPath)) && f.includes(".corrupt-"));
    assert.ok(preserved, "broken instances_meta.json must be preserved as .corrupt-<timestamp>");
    assert.strictEqual(
      fs.readFileSync(path.join(dir, preserved), "utf-8"),
      brokenPayload,
      "preserved copy must match the torn content"
    );

    // 2. the security regression is reported loudly
    const loud = captured.find((line) => /SECURITY REGRESSION/i.test(line) && /instances_meta/i.test(line));
    assert.ok(loud, `expected loud security warning about lost revoked flags, got: ${captured.join(" | ") || "(none)"}`);
  } finally {
    console.error = origError;
    console.warn = origWarn;
  }
});
