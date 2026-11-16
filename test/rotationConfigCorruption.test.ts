import "./helpers/setup.js";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * AUDIT-SRV-P3: a torn rotation_config.json must degrade loudly (with
 * .corrupt-<timestamp> preservation) instead of silently resetting the
 * rotation schedule. scheduler.ts resolves its store path and reads it at
 * import time, so this file seeds the broken payload BEFORE the first
 * dynamic import and must not statically import anything that transitively
 * pulls src/scheduler.js (routes do).
 */
test("scheduler: torn rotation_config.json degrades loudly with .corrupt preservation", async () => {
  const cfgPath = process.env.ROTATION_CONFIG_PATH!;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  const torn = '{"enabled": tru';
  fs.writeFileSync(cfgPath, torn, "utf-8");

  const captured: string[] = [];
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = (...a: unknown[]) => captured.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => captured.push(a.map(String).join(" "));

  try {
    const mod = await import("../src/scheduler.js");

    const cfg = mod.getRotationConfig();
    assert.equal(cfg.enabled, true, "defaults must apply (enabled)");
    assert.equal(cfg.inboundRemark, "squid-in", "defaults must apply (remark)");
    assert.equal(cfg.intervalMinutes, parseInt(process.env.ROTATION_INTERVAL_MIN || "1440", 10), "default interval must apply");

    const loud = captured.find((line) => /rotation_config\.json is unreadable/i.test(line));
    assert.ok(loud, `expected loud degradation warning, got: ${captured.join(" | ") || "(none)"}`);

    const preserved = fs
      .readdirSync(path.dirname(cfgPath))
      .find((f) => f.startsWith(path.basename(cfgPath)) && f.includes(".corrupt-"));
    assert.ok(preserved, "torn rotation_config.json must be preserved for post-mortem");
    assert.strictEqual(fs.readFileSync(path.join(path.dirname(cfgPath), preserved), "utf-8"), torn);
  } finally {
    console.error = origErr;
    console.warn = origWarn;
  }
});
