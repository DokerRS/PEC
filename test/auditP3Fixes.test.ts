import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import child_process from "node:child_process";
import express from "express";
import { TEST_TMP_DIR } from "./helpers/setup.js";
import {
  writeJsonAtomic,
  writeFileAtomic,
  renameAtomicWithRetries,
  restrictSecretFilePermissions,
} from "../src/jsonStore.js";
import { recordRateLimitBlock, resetMetricsForTest, getMetricsSnapshot } from "../src/metrics.js";
import { sanitizeSingleLine } from "../src/logger.js";
import { decryptPassword, getConfigPath } from "../src/codeSigner.js";
import { isWithinPresetEntryLimit, MAX_ROUTING_PRESET_ENTRIES } from "../src/routing.js";
import { createRoutingRouter } from "../src/routes/routingRoutes.js";
import { createProxiesRouter } from "../src/routes/proxiesRoutes.js";
import { createProxy, deleteProxy } from "../src/proxies.js";
import type { AddressInfo } from "node:net";

/**
 * AUDIT-SRV-P3 regression pack: fsync+rename retries, config-store loud
 * degradation, 5xx masking, metrics label sanitization, timer re-arm after
 * manual rotation, sync promise coalescing, preset entry cap, log-forging
 * sanitization, PAC host:port escaping, legacy-seed migration, Windows ACL.
 */

test("P3/jsonStore: writeJsonAtomic fsyncs the temp file before rename", () => {
  const fsyncCalls: number[] = [];
  const origFsync = fs.fsyncSync;
  (fs as any).fsyncSync = (fd: number) => {
    fsyncCalls.push(fd);
    return origFsync.call(fs, fd);
  };
  try {
    const target = path.join(TEST_TMP_DIR, "p3-fsync", "state.json");
    writeJsonAtomic(target, { a: 1 });
    assert.ok(fsyncCalls.length >= 1, "fsync must be issued before publishing the rename");
    writeFileAtomic(path.join(TEST_TMP_DIR, "p3-fsync", "blob.bin"), Buffer.from("x"));
    assert.ok(fsyncCalls.length >= 2, "writeFileAtomic must fsync as well");
    assert.strictEqual(JSON.parse(fs.readFileSync(target, "utf-8")).a, 1);
  } finally {
    (fs as any).fsyncSync = origFsync;
  }
});

test("P3/jsonStore: renameAtomicWithRetries retries transient EPERM/EBUSY on Windows", { skip: process.platform !== "win32" }, () => {
  const dir = path.join(TEST_TMP_DIR, "p3-rename-retry");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "src.tmp");
  const dst = path.join(dir, "dst.json");
  fs.writeFileSync(tmp, "payload");

  const origRename = fs.renameSync;
  let attempts = 0;
  (fs as any).renameSync = function brokenRename(a: string, b: string) {
    attempts++;
    if (attempts < 3 && process.platform === "win32") {
      const e: NodeJS.ErrnoException = new Error("simulated busy file");
      e.code = "EBUSY";
      throw e;
    }
    return origRename.call(fs, a, b);
  };
  try {
    renameAtomicWithRetries(tmp, dst, 5);
    assert.strictEqual(fs.readFileSync(dst, "utf-8"), "payload", "retry loop must eventually publish the file");
    assert.ok(attempts >= 3, `expected retries, saw ${attempts} attempt(s)`);
  } finally {
    (fs as any).renameSync = origRename;
  }
});

test("P3/metrics: recordRateLimitBlock sanitizes control characters in labels", () => {
  resetMetricsForTest();
  recordRateLimitBlock("first\nsecond\tline");
  const rendered = JSON.stringify(getMetricsSnapshot());
  assert.ok(!rendered.includes("first\\nsecond"), "forged newline must be collapsed in metric labels");
  assert.ok(rendered.includes("first second"), `control chars must become spaces, got: ${rendered.slice(0, 300)}`);
  resetMetricsForTest();
});

test("P3/logger: sanitizeSingleLine strips control characters from client-supplied identifiers", () => {
  assert.strictEqual(sanitizeSingleLine("user\nATTACKER admin=true"), "user ATTACKER admin=true");
  assert.strictEqual(sanitizeSingleLine("host\r\nINJECTED"), "host INJECTED");
  assert.strictEqual(sanitizeSingleLine("clean"), "clean");
  assert.strictEqual(sanitizeSingleLine(undefined), "");
  assert.ok(!sanitizeSingleLine("a\tb\x00c").includes("\t"));
});

test("P3/server: globalApiErrorHandler masks 5xx internals but keeps 4xx/413 messages", async () => {
  const { globalApiErrorHandler } = (await import("../server.js")) as any;
  const calls: Array<{ status: number; body: any }> = [];
  const fakeRes: any = {
    headersSent: false,
    status(code: number) {
      calls.push({ status: code, body: undefined });
      return this;
    },
    json(body: any) {
      calls[calls.length - 1].body = body;
      return this;
    },
  };
  const fakeReq: any = { method: "POST", url: "/api/sync", path: "/api/sync" };

  globalApiErrorHandler(Object.assign(new Error("ECONNREFUSED 10.0.0.5:636 (ldap bind)"), { status: 500 }), fakeReq, fakeRes, () => {});
  assert.equal(calls[0].status, 500);
  assert.equal(calls[0].body.error, "Internal Server Error", "5xx must not mirror internal error text");
  assert.ok(!JSON.stringify(calls[0].body).includes("ECONNREFUSED"));

  globalApiErrorHandler(Object.assign(new Error("Explicit bad request detail"), { status: 400 }), fakeReq, fakeRes, () => {});
  assert.equal(calls[1].body.error, "Explicit bad request detail", "4xx messages stay actionable");

  globalApiErrorHandler(Object.assign(new Error("request entity too large"), { type: "entity.too.large", limit: 1024 * 1024 }), fakeReq, fakeRes, () => {});
  assert.match(calls[2].body.error, /Payload Too Large/i);
});

test("P3/scheduler: manual rotation re-arms the timer (no drift) and rotates standalone creds", async () => {
  const { runManualRotation, updateRotationConfig, getRotationConfig, stopScheduler } = await import("../src/scheduler.js");

  const captured: string[] = [];
  const origLog = console.log;
  const origInfo = console.info;
  console.log = (...a: unknown[]) => captured.push(a.map(String).join(" "));
  console.info = (...a: unknown[]) => captured.push(a.map(String).join(" "));

  updateRotationConfig({ enabled: true, intervalMinutes: 1440, panelUrl: "https://3xui-host:2053/basepath", adminPass: "" });
  try {
    const result = await runManualRotation();
    assert.equal(result.success, true, `standalone rotation must succeed, got error: ${result.error}`);
    const rearmLogs = captured.filter((line) => /Rotation timer armed/i.test(line));
    assert.ok(rearmLogs.length >= 1, "manual rotation must re-arm the interval timer (AUDIT-SRV-P3 drift fix)");
    assert.ok(getRotationConfig().nextRotationAt, "nextRotationAt must be set after rotation");
  } finally {
    console.log = origLog;
    console.info = origInfo;
    stopScheduler();
  }
});

test("P3/routing: preset entry cap is enforced (helper + POST /api/routing/presets)", async () => {
  assert.ok(isWithinPresetEntryLimit(1));
  assert.ok(isWithinPresetEntryLimit(MAX_ROUTING_PRESET_ENTRIES));
  assert.ok(!isWithinPresetEntryLimit(MAX_ROUTING_PRESET_ENTRIES + 1));
  assert.ok(!isWithinPresetEntryLimit(0));

  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.use(createRoutingRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const tooBig = Array.from({ length: MAX_ROUTING_PRESET_ENTRIES + 5 }, (_, i) => `d${i}.e.com`);
    const res = await fetch(`${base}/api/routing/presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": process.env.ADMIN_TOKEN! },
      body: JSON.stringify({ id: "preset_too_big", name: "Too Big", entries: tooBig }),
    });
    assert.equal(res.status, 400, "oversized preset must be rejected at import");
    const body = await res.json();
    assert.match(body.error, /entry limit/);
  } finally {
    if (typeof (server as any).closeAllConnections === "function") (server as any).closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("P3/proxiesRoutes: concurrent Remnawave user syncs are coalesced, not 409-rejected", async () => {
  const { saveRemnawavePanel, deleteRemnawavePanel } = await import("../src/rotate.js");
  const panel = saveRemnawavePanel({
    name: "Coalesce Panel",
    panelUrl: "http://remnawave.mock.test:3000",
    adminUser: "admin",
    adminPass: "pass",
    targetUsername: "coalesce-user",
  });
  const node = createProxy({
    name: "Coalesce Node",
    type: "remnawave",
    remnawaveUsername: "coalesce-user",
    protocol: "socks5",
    host: "10.70.0.1",
    port: 1080,
    tag: "coalesce-user",
    panelId: panel.id,
  });

  let panelHits = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:") || url.includes("//localhost")) {
      return realFetch(input, init);
    }
    const jsonHeaders = { "content-type": "application/json" };
    if (url.endsWith("/api/auth/login")) {
      return new Response(JSON.stringify({ response: { accessToken: "test-token" } }), {
        status: 201,
        headers: jsonHeaders,
      });
    }
    if (url.includes("/api/users/by-username/coalesce-user")) {
      panelHits++;
      await new Promise((r) => setTimeout(r, 200));
      return new Response(
        JSON.stringify({ response: { id: 11, username: "coalesce-user", trojanPassword: "p1" } }),
        { status: 200, headers: jsonHeaders }
      );
    }
    return new Response("{}", { status: 404 });
  }) as any;

  const app = express();
  app.use(express.json());
  app.use(createProxiesRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const [a, b] = await Promise.all([
      fetch(`${base}/api/proxies/${node.id}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Token": process.env.ADMIN_TOKEN! },
        body: JSON.stringify({ rotatePassword: false }),
      }),
      fetch(`${base}/api/proxies/${node.id}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Token": process.env.ADMIN_TOKEN! },
        body: JSON.stringify({ rotatePassword: false }),
      }),
    ]);
    const bodyA = await a.json();
    assert.equal(a.status, 200, `first sync must succeed: ${a.status} ${JSON.stringify(bodyA).slice(0, 200)}`);
    const bodyB = await b.json();
    assert.equal(b.status, 200, `concurrent second sync must be coalesced, not 409: ${b.status} ${JSON.stringify(bodyB).slice(0, 200)}`);
    assert.equal(bodyA.ok, true, "coalesced caller must receive the shared success result");
    assert.equal(panelHits, 1, "panel must be contacted exactly once despite two concurrent callers");
  } finally {
    globalThis.fetch = realFetch;
    if (typeof (server as any).closeAllConnections === "function") (server as any).closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    deleteProxy(node.id);
    deleteRemnawavePanel(panel.id);
  }
});

test("P3/background: PAC proxy host is sanitized against PAC injection (synced copy)", () => {
  const src = fs.readFileSync(path.resolve("extension/background.js"), "utf-8");
  assert.ok(
    src.includes('replace(/[^a-zA-Z0-9.:\\-\\[\\]]/g, "")'),
    "background.js must sanitize the PAC host with the exact safe-character allowlist"
  );
  // Behavioral check of the exact pattern shipped in the template
  const pattern = /[^a-zA-Z0-9.:\-\[\]]/g;
  assert.strictEqual('1.2.3.4"; alert(1); "'.replace(pattern, ""), "1.2.3.4alert1");
  assert.strictEqual("proxy.corp.local".replace(pattern, ""), "proxy.corp.local");
  assert.strictEqual("[2001:db8::1]".replace(pattern, ""), "[2001:db8::1]");
});

test("P3/codeSigner: legacy-seed decrypt migrates the ciphertext to the current master key", () => {
  const prevKey = process.env.CODE_SIGN_MASTER_KEY;
  const prevAdmin = process.env.ADMIN_TOKEN;
  const certsDir = path.join(TEST_TMP_DIR, "p3-codesign");
  fs.mkdirSync(certsDir, { recursive: true });
  process.env.CODE_SIGN_DIR = certsDir;
  delete process.env.CODE_SIGN_MASTER_KEY;
  process.env.ADMIN_TOKEN = "legacy-admin-token";

  try {
    // Simulate a config encrypted by the OLD legacy seed key (ADMIN_TOKEN-derived)
    const legacyKey = crypto.createHash("sha256").update("legacy-admin-token").digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", legacyKey, iv);
    let enc = cipher.update("S3cretPfxPass", "utf8", "base64");
    enc += cipher.final("base64");
    const tag = cipher.getAuthTag().toString("base64");

    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({ encryptedPassword: enc, iv: iv.toString("base64"), tag }, null, 2)
    );

    const decrypted = decryptPassword({ encryptedPassword: enc, iv: iv.toString("base64"), tag } as any);
    assert.equal(decrypted, "S3cretPfxPass", "legacy decrypt path must still work");

    // AUDIT-SRV-P3: the migration must have re-encrypted with the current key
    const migratedRaw = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    assert.notEqual(migratedRaw.encryptedPassword, enc, "stored ciphertext must have been rotated");
    const reDecrypted = decryptPassword(migratedRaw as any);
    assert.equal(reDecrypted, "S3cretPfxPass", "migrated ciphertext must decrypt via the primary path");
  } finally {
    if (prevKey !== undefined) process.env.CODE_SIGN_MASTER_KEY = prevKey;
    else delete process.env.CODE_SIGN_MASTER_KEY;
    process.env.ADMIN_TOKEN = prevAdmin;
    delete process.env.CODE_SIGN_DIR;
  }
});

test("P3/jsonStore: restrictSecretFilePermissions strips Windows ACE inheritance on win32 only", () => {
  const target = path.join(TEST_TMP_DIR, "p3-acl", "secret.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "{}");

  const calls: Array<{ file: string; args: string[] }> = [];
  const origExec = child_process.execFileSync;
  (child_process as any).execFileSync = (file: string, args: string[]) => {
    calls.push({ file, args });
    return Buffer.from("");
  };
  try {
    restrictSecretFilePermissions(target);
    if (process.platform === "win32") {
      const icacls = calls.find((c) => c.file === "icacls");
      assert.ok(icacls, "win32 must invoke icacls");
      assert.ok(icacls.args.includes("/inheritance:r"), "inheritance must be stripped");
      assert.ok(icacls.args.some((a) => a.includes(":F")), "current user must retain full control");
    } else {
      assert.equal(calls.filter((c) => c.file === "icacls").length, 0, "non-win32 must not invoke icacls");
    }
  } finally {
    (child_process as any).execFileSync = origExec;
  }
});
