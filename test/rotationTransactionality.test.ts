import "./helpers/setup.js";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { TEST_TMP_DIR } from "./helpers/setup.js";

/**
 * AUDIT-SRV-3 (rotation transactionality): once Remnawave accepts the
 * credential revocation, local persistence failures are a FLEET DESYNC. The
 * rotation result must say so honestly (success=false + desync diagnostics),
 * never a silent success and never the misleading "credentials were NOT
 * changed" message from the pre-panel phase.
 */

function panelFetchMock(recorded: string[]): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  let user = {
    id: 7,
    username: "corp-user",
    shortUuid: "stable-subscription-id",
    trojanPassword: "old-pass",
  };
  return async (input: any, init?: any) => {
    const url = String(input);
    recorded.push(`${init?.method || "GET"} ${url}`);
    const jsonHeaders = { "content-type": "application/json" };
    if (url.endsWith("/api/auth/login")) {
      return new Response(JSON.stringify({ response: { accessToken: "test-token" } }), {
        status: 201,
        headers: jsonHeaders,
      });
    }
    if (url.includes("/api/users/by-username/corp-user")) {
      return new Response(JSON.stringify({ response: user }), { status: 200, headers: jsonHeaders });
    }
    if (url.endsWith("/api/users/7/actions/revoke")) {
      user = { ...user, trojanPassword: "new-pass" };
      return new Response(JSON.stringify({ response: user }), { status: 200, headers: jsonHeaders });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };
}

test("SRV-3: Remnawave rotated but local creds write failed -> honest DESYNC failure, not silent success", async () => {
  const realFetch = globalThis.fetch;
  const recorded: string[] = [];
  globalThis.fetch = panelFetchMock(recorded) as any;

  // Break the local store: a DIRECTORY sitting at the creds file path makes
  // the atomic rename fail (EISDIR/EPERM on Windows) on every retry.
  const brokenDir = path.join(TEST_TMP_DIR, "srv3-broken-store");
  const brokenStore = path.join(brokenDir, "current_creds.json");
  fs.mkdirSync(brokenStore, { recursive: true });
  const origStore = process.env.CREDS_STORE;
  process.env.CREDS_STORE = brokenStore;

  try {
    const { executeRotation } = await import("../src/rotate.js");
    const result = await executeRotation({
      panelUrl: "http://panel-srv.test:8081",
      adminUser: "admin",
      adminPass: "panel-secret",
      targetUsername: "corp-user",
    });

    assert.ok(recorded.some((c) => c.includes("/api/users/7/actions/revoke")), "credential revoke must have been issued");
    assert.equal(result.success, false, "a local desync must NOT be reported as success");
    assert.ok(/DESYNC/i.test(result.error || ""), `error must name the desync, got: ${result.error}`);
    assert.ok(
      /Remnawave password was rotated/i.test(result.error || ""),
      `error must state Remnawave DID rotate the credential, got: ${result.error}`
    );
    assert.ok(
      /local creds store not updated/i.test(result.error || ""),
      `error must point at the failed local stage, got: ${result.error}`
    );
  } finally {
    globalThis.fetch = realFetch;
    if (origStore !== undefined) process.env.CREDS_STORE = origStore;
    fs.rmSync(brokenDir, { recursive: true, force: true });
  }
});

test("SRV-3: atomicWriteCredsWithRetries retries transient failures before giving up", async () => {
  const { atomicWriteCredsWithRetries } = await import("../src/rotate.js");

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  const brokenDir = path.join(TEST_TMP_DIR, "srv3-retry-store");
  const brokenStore = path.join(brokenDir, "current_creds.json");
  fs.mkdirSync(brokenStore, { recursive: true });

  try {
    assert.throws(
      () => atomicWriteCredsWithRetries(brokenStore, { user: "u", pass: "p" }, 3),
      "exhausted retries must throw so the caller can report the desync"
    );
    const retryWarnings = warnings.filter((w) => /creds store write attempt \d\/3 failed/i.test(w));
    assert.equal(retryWarnings.length, 3, `expected exactly 3 retry warnings, got ${retryWarnings.length}`);
  } finally {
    console.warn = origWarn;
    fs.rmSync(brokenDir, { recursive: true, force: true });
  }
});

test("SRV-3: fully successful Remnawave rotation still returns success=true", async () => {
  const realFetch = globalThis.fetch;
  const recorded: string[] = [];
  globalThis.fetch = panelFetchMock(recorded) as any;

  const okStore = path.join(TEST_TMP_DIR, "srv3-ok-store", "current_creds.json");
  fs.mkdirSync(path.dirname(okStore), { recursive: true });
  const origStore = process.env.CREDS_STORE;
  process.env.CREDS_STORE = okStore;

  try {
    const { executeRotation, readCurrentCreds } = await import("../src/rotate.js");
    const result = await executeRotation({
      panelUrl: "http://panel-srv.test:8081",
      adminUser: "admin",
      adminPass: "panel-secret",
      targetUsername: "corp-user",
    });

    assert.equal(result.success, true, `happy path must stay success, got error: ${result.error}`);
    const stored = readCurrentCreds();
    assert.ok(stored?.pass && stored.pass !== "old-pass", "local store must hold the rotated password");
  } finally {
    globalThis.fetch = realFetch;
    if (origStore !== undefined) process.env.CREDS_STORE = origStore;
    fs.rmSync(path.dirname(okStore), { recursive: true, force: true });
  }
});
