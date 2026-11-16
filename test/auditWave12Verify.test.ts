import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * AUDIT-VERIFY-QA: anti-regression coverage for wave 1-2 fixes that are not
 * already closed by their own feature suites.
 *
 * Coverage map (fix -> closing test):
 * - AUDIT-SEC-1 -> test/appSync.test.ts (D7: availableProxies без user/pass)
 * - AUDIT-SEC-2 -> test/ssrfPinnedFetch.test.ts (SSRF TOCTOU pinning)
 * - AUDIT-SEC-3 -> test/codeSignerSecurity.test.ts + test/codeSignerArgs.test.ts
 * - AUDIT-SRV-1 -> test/instancesMetaCorruption.test.ts (.corrupt-<ts> контракт)
 * - AUDIT-SRV-2 -> test/adSync.test.ts (clampSyncIntervalSec 5..86400)
 * - AUDIT-SRV-3 -> test/rotationTransactionality.test.ts
 * - AUDIT-EXT-1/2 -> test/extensionAuditFixes.test.ts (kill-switch gate, CSP)
 * - AUDIT-INFRA-1..3 -> ревизия + Redocly lint + test/openapi.test.ts
 * - AUDIT-NAT-1/2 -> test/appPackager.test.ts (Audit H-1 WinVerifyTrust) —
 *   C-side части фиксов утрачены рабочим деревом 2026-11-16 (см. Handoff в
 *   .agents/project_knowledge/tasks.md); TS-наблюдаемая часть (update_core.h)
 *   сохранена как untracked-файл.
 * - AUDIT-INFRA-4 -> этот файл (CI: build:ui до npm test + drift-гейт).
 */

const CI_PATH = path.resolve(".github/workflows/ci.yml");

test("AUDIT-INFRA-4: ci.yml builds dashboard bundle before tests and gates template drift", () => {
  const ci = fs.readFileSync(CI_PATH, "utf-8");

  const buildMatch = ci.indexOf("npm run build:ui");
  const testMatch = ci.indexOf("npm test");
  assert.ok(buildMatch !== -1, "ci.yml must run npm run build:ui");
  assert.ok(testMatch !== -1, "ci.yml must run npm test");
  assert.ok(
    buildMatch < testMatch,
    "build:ui must run before npm test — the JSDOM test stand evaluates public/dashboard.min.js"
  );

  // Drift gate: a stale committed bundle must fail CI (same pattern as
  // template-drift-check).
  const gateIdx = ci.indexOf("public/dashboard.min.js");
  assert.ok(gateIdx !== -1, "ci.yml must reference public/dashboard.min.js in a drift gate");
  const gateWindow = ci.slice(Math.max(0, gateIdx - 300), gateIdx + 100);
  assert.ok(
    gateWindow.includes("git diff"),
    "drift gate must verify the bundle via git diff (rebuilt artifact must be committed)"
  );
});
