import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { executeRotation, atomicWriteCreds, getCredsStorePath } from "../src/rotate.js";
import { getRemnawavePanelsPath } from "../src/storage.js";

/**
 * Standalone mode = no panel configured. The panel registry is created by
 * auto-migration as soon as a real panelUrl is saved anywhere, so tests that
 * exercise the local atomic rotation path must reset it explicitly.
 */
function resetToStandaloneMode(): void {
  updateRotationConfig({
    panelUrl: "https://remnawave-host:3000/basepath", // placeholder = not configured
    enabled: false,
  });
  fs.rmSync(getRemnawavePanelsPath(), { force: true });
}

/**
 * The rotation history file must be seeded BEFORE the scheduler module loads
 * its state (it reads the store once at import time), so the scheduler is
 * imported dynamically after the seed is written.
 */
const HISTORY_PATH = process.env.ROTATION_HISTORY_PATH!;

// 55 entries in the store format produced by unshift(): newest first.
const seeded = Array.from({ length: 55 }, (_, i) => ({
  id: `hist_seed_${i}`,
  timestamp: new Date(Date.now() - (55 - i) * 60_000).toISOString(),
  source: "manual",
  user: "corp-user",
  success: true,
})).reverse(); // hist_seed_54 (newest) first, hist_seed_0 (oldest) last
fs.writeFileSync(HISTORY_PATH, JSON.stringify(seeded, null, 2));

const { updateRotationConfig, getRotationConfig, getRotationConfigPublic, getRotationHistory, runManualRotation } =
  await import("../src/scheduler.js");

test("rotation config: interval validation rejects NaN, zero, negatives and garbage", () => {
  assert.throws(() => updateRotationConfig({ intervalMinutes: 0 }), /intervalMinutes/);
  assert.throws(() => updateRotationConfig({ intervalMinutes: NaN }), /intervalMinutes/);
  assert.throws(() => updateRotationConfig({ intervalMinutes: "abc" as unknown as number }), /intervalMinutes/);
  assert.throws(() => updateRotationConfig({ intervalMinutes: -5 }), /intervalMinutes/);
  assert.throws(() => updateRotationConfig({ intervalMinutes: 1.5 }), /intervalMinutes/);
  // >2^31-1 ms (~24.8 days) would make Node clamp setInterval to 1 ms - a
  // hot loop hammering the panel; the cap must reject it
  assert.throws(() => updateRotationConfig({ intervalMinutes: 144000 }), /intervalMinutes/);
  // valid value passes and persists
  updateRotationConfig({ intervalMinutes: 90, enabled: false });
  assert.strictEqual(getRotationConfig().intervalMinutes, 90);
});

test("rotation config: admin pass is masked in the public view and preserved on empty save", () => {
  updateRotationConfig({ adminPass: "super-secret-remnawave-pass", enabled: false });

  const pub = getRotationConfigPublic();
  assert.strictEqual(pub.adminPass, "********");
  assert.ok(!JSON.stringify(pub).includes("super-secret-remnawave-pass"), "public config must not leak the password");

  // saving with an empty password keeps the stored one
  updateRotationConfig({ adminPass: "", enabled: false });
  assert.strictEqual(getRotationConfig().adminPass, "super-secret-remnawave-pass");

  // saving the mask itself is rejected (would corrupt the credential)
  assert.throws(() => updateRotationConfig({ adminPass: "********" }), /masked/i);
});

test("rotation config: panelUrl is SSRF-validated on save", () => {
  assert.throws(() => updateRotationConfig({ panelUrl: "http://169.254.169.254/", enabled: false }), /panelUrl|SSRF/i);
  assert.throws(() => updateRotationConfig({ panelUrl: "file:///etc/passwd", enabled: false }), /panelUrl/i);
  updateRotationConfig({ panelUrl: "https://panel.corp.example:2053/xui", enabled: false });
  assert.strictEqual(getRotationConfig().panelUrl, "https://panel.corp.example:2053/xui");
});

test("executeRotation: rotation is refused once a Remnawave panel is configured", async () => {
  // REMNA migration: credential rotation was removed. With a panel configured
  // (registry or a non-placeholder panelUrl), executeRotation must refuse
  // instead of touching the panel or the local creds store.
  atomicWriteCreds(getCredsStorePath(), { user: "corp-user", pass: "known-password-before-rotation" });
  const before = JSON.parse(fs.readFileSync(getCredsStorePath(), "utf-8"));

  updateRotationConfig({
    panelUrl: "http://127.0.0.1:9/", // port 9 (discard) - nothing listens
    adminUser: "admin",
    adminPass: "panel-pass",
    targetUsername: "corp-user",
    enabled: false,
  });

  await assert.rejects(
    () => executeRotation(getRotationConfig()),
    /rotation is disabled/i,
    "rotation must be refused while a Remnawave panel is configured"
  );

  const after = JSON.parse(fs.readFileSync(getCredsStorePath(), "utf-8"));
  assert.strictEqual(after.pass, before.pass, "local credentials must remain untouched");
});

test("rotation history: capped at 50, newest first, both in memory and on disk", async () => {
  // The seed had 55 entries: loading must already cap at 50 (oldest evicted)
  const loaded = getRotationHistory();
  assert.strictEqual(loaded.length, 50, "an oversized history store must be capped on load");
  assert.strictEqual(loaded[0].id, "hist_seed_54", "newest seeded entry must come first");
  assert.strictEqual(loaded[49].id, "hist_seed_5", "the 6 oldest seeded entries must be evicted on load");

  // One more rotation keeps the cap and lands on top (standalone mode:
  // placeholder panel = no panel configured, local atomic rotation runs).
  resetToStandaloneMode();
  await runManualRotation();

  const history = getRotationHistory();
  assert.strictEqual(history.length, 50, "history must stay capped at 50 entries after a push");
  assert.strictEqual(history[0].success, true, "the fresh standalone rotation must be the newest entry");
  assert.strictEqual(history[1].id, "hist_seed_54", "the previous newest entry shifts to second place");

  // Strict newest-first ordering
  for (let i = 1; i < history.length; i++) {
    const prev = new Date(history[i - 1].timestamp).getTime();
    const cur = new Date(history[i].timestamp).getTime();
    assert.ok(prev >= cur, `history must be ordered newest-first (index ${i - 1} -> ${i})`);
  }

  // The persisted file is capped to the same 50 entries
  const onDisk = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8")) as Array<{ id: string }>;
  assert.strictEqual(onDisk.length, 50, "the history store on disk must be capped to 50 entries");
  assert.ok(!onDisk.some((h) => h.id === "hist_seed_0"), "the oldest seeded entry must have been evicted from disk");
});

test("runManualRotation: concurrent calls are serialized by the in-flight lock", async () => {
  // Standalone mode (placeholder panel): rotation succeeds locally, so the
  // two concurrent callers must resolve with the SAME coalesced promise and
  // the history must grow by exactly one entry.
  resetToStandaloneMode();

  const historyBefore = getRotationHistory();
  const [a, b] = await Promise.all([runManualRotation(), runManualRotation()]);

  assert.strictEqual(a.success, true);
  assert.strictEqual(b.success, true);
  assert.strictEqual(a.id, b.id, "concurrent rotations must be collapsed into a single attempt");
  const historyAfter = getRotationHistory();
  assert.strictEqual(historyAfter.length, historyBefore.length, "history stays capped at 50 entries");
  assert.strictEqual(historyAfter[0].id, a.id, "the coalesced run must land on top of the history exactly once");
  assert.strictEqual(historyAfter.filter((h) => h.id === a.id).length, 1, "no duplicate entries for one run");

  // The in-flight slot is freed afterwards: a fresh call starts a new run.
  const c = await runManualRotation();
  assert.notStrictEqual(c.id, a.id, "the lock must release after completion");
});

test("SSRF: validateSafeEndpointUrl rejects IPv6 metadata and link-local targets", async () => {
  const { validateSafeEndpointUrl } = await import("../src/rotate.js");
  for (const bad of ["http://[fd00:ec2::254]/", "http://[fe80::1]/", "http://[FE80::a]/"]) {
    const check = validateSafeEndpointUrl(bad);
    assert.strictEqual(check.valid, false, `${bad} must be rejected`);
    assert.match(check.error || "", /SSRF|metadata/i);
  }
  // Legitimate colocated targets stay allowed (loopback, private v4)
  assert.strictEqual(validateSafeEndpointUrl("http://127.0.0.1:2053/xui").valid, true);
  assert.strictEqual(validateSafeEndpointUrl("http://10.0.0.5:2053/xui").valid, true);
});

test("SSRF: a Remnawave panel redirect is refused, not followed", async () => {
  const { testRemnawaveConnection } = await import("../src/rotate.js");
  const { withHttpServer } = await import("./helpers/http-server.js");

  const { url, close } = await withHttpServer((_req, res) => {
    res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
  });

  try {
    const result = await testRemnawaveConnection({
      panelUrl: url,
      adminUser: "admin",
      adminPass: "pass",
      timeoutSec: 3,
    });
    assert.strictEqual(result.ok, false, "a redirecting panel must not be treated as connected");
    assert.match(result.message, /redirect/i);
  } finally {
    await close();
  }
});