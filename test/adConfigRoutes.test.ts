import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import app from "../server.js";
import { adSyncService } from "../src/adSync.js";
import {
  clearInstances,
  _clearPersistentMetaForTesting,
  getInstanceMeta,
} from "../src/instances.js";
import { TEST_ADMIN_TOKEN, TEST_TOKEN } from "./helpers/setup.js";

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    if (typeof (server as any).closeAllConnections === "function") {
      (server as any).closeAllConnections();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("adConfigRoutes: enforces admin authentication on all /api/ad/* endpoints", async () => {
  await withServer(async (base) => {
    const endpoints = [
      { method: "GET", path: "/api/ad/status" },
      { method: "POST", path: "/api/ad/config", body: JSON.stringify({ enabled: false }) },
      { method: "POST", path: "/api/ad/test", body: JSON.stringify({ ldapUrl: "ldaps://127.0.0.1:636" }) },
      { method: "POST", path: "/api/ad/sync-now", body: "{}" },
    ];

    for (const ep of endpoints) {
      // 1. Without credentials -> 401 Unauthorized
      const unauthRes = await fetch(`${base}${ep.path}`, {
        method: ep.method,
        headers: { "Content-Type": "application/json" },
        body: ep.method === "POST" ? ep.body : undefined,
      });
      assert.equal(
        unauthRes.status,
        401,
        `Expected 401 for unauthenticated ${ep.method} ${ep.path}, got ${unauthRes.status}`
      );

      // 2. With invalid token -> 401 Unauthorized
      const badTokenRes = await fetch(`${base}${ep.path}`, {
        method: ep.method,
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": "wrong-token-forbidden",
        },
        body: ep.method === "POST" ? ep.body : undefined,
      });
      assert.equal(
        badTokenRes.status,
        401,
        `Expected 401 for bad admin token on ${ep.method} ${ep.path}, got ${badTokenRes.status}`
      );
    }

    // 3. With valid ADMIN_TOKEN -> allows request through to endpoint (expect 200 on GET /api/ad/status)
    const authRes = await fetch(`${base}/api/ad/status`, {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    });
    assert.equal(
      authRes.status,
      200,
      `Expected 200 for authenticated GET /api/ad/status, got ${authRes.status}`
    );
  });
});

test("adConfigRoutes: GET /api/ad/status returns configuration and never exposes bindPassword", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ad/status`, {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    });
    assert.equal(res.status, 200, `GET /api/ad/status must return HTTP 200, got: ${res.status}`);

    const data = (await res.json()) as any;

    // Check required status fields
    assert.equal(typeof data.enabled, "boolean", "enabled must be a boolean");
    assert.equal(typeof data.ldapUrl, "string", "ldapUrl must be a string");
    assert.equal(typeof data.searchBase, "string", "searchBase must be a string");
    assert.equal(typeof data.requiredGroupDn, "string", "requiredGroupDn must be a string");
    assert.equal(typeof data.syncIntervalSec, "number", "syncIntervalSec must be a number");
    assert.equal(typeof data.rejectUnknownUsers, "boolean", "rejectUnknownUsers must be a boolean");
    assert.equal(typeof data.tlsRejectUnauthorized, "boolean", "tlsRejectUnauthorized must be a boolean");
    assert.equal(typeof data.usersCount, "number", "usersCount must be a number");
    // AD-UX-2: honest counters — unique sAMAccountName users vs identifiers
    assert.equal(typeof data.uniqueUsersCount, "number", "uniqueUsersCount must be a number");
    assert.ok(data.uniqueUsersCount <= data.usersCount, "uniqueUsersCount must never exceed the identifier count");
    assert.equal(typeof data.hasPassword, "boolean", "hasPassword flag must be returned");

    // Critical invariant: plaintext password must NEVER be exposed
    assert.equal(data.bindPassword, undefined, "bindPassword field must NEVER be returned in status response");
    assert.ok(
      !JSON.stringify(data).includes("bindPassword"),
      "Response JSON must not contain bindPassword key"
    );
  });
});

test("adConfigRoutes: POST /api/ad/config saves settings to data/ad_config.json and updates adSyncService", async () => {
  await withServer(async (base) => {
    const newConfigPayload = {
      enabled: true,
      ldapUrl: "ldaps://dc-primary.corp.internal:636",
      bindDn: "CN=pec-admin,OU=Services,DC=corp,DC=internal",
      bindPassword: "SuperSecretLdapPassword123!",
      searchBase: "OU=Users,DC=corp,DC=internal",
      requiredGroupDn: "CN=ProxyFleetAccess,OU=Groups,DC=corp,DC=internal",
      syncIntervalSec: 180,
      rejectUnknownUsers: true,
      tlsRejectUnauthorized: true,
    };

    const res = await fetch(`${base}/api/ad/config`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": TEST_ADMIN_TOKEN,
      },
      body: JSON.stringify(newConfigPayload),
    });

    assert.equal(res.status, 200, `POST /api/ad/config must return HTTP 200, got: ${res.status}`);
    const data = (await res.json()) as any;
    assert.equal(data.ok, true, "Response must report ok: true");

    // Verify in-memory service was updated
    const liveConfig = adSyncService.getConfig();
    assert.equal(liveConfig.enabled, true);
    assert.equal(liveConfig.ldapUrl, "ldaps://dc-primary.corp.internal:636");
    assert.equal(liveConfig.bindDn, "CN=pec-admin,OU=Services,DC=corp,DC=internal");
    assert.equal(liveConfig.bindPassword, "SuperSecretLdapPassword123!");
    assert.equal(liveConfig.searchBase, "OU=Users,DC=corp,DC=internal");
    assert.equal(liveConfig.requiredGroupDn, "CN=ProxyFleetAccess,OU=Groups,DC=corp,DC=internal");
    assert.equal(liveConfig.syncIntervalSec, 180);
    assert.equal(liveConfig.rejectUnknownUsers, true);
    assert.equal(liveConfig.tlsRejectUnauthorized, true);

    // Verify persistence to data/ad_config.json on disk
    const dataDir = process.env.DATA_DIR || path.resolve("data");
    const configPath = path.join(dataDir, "ad_config.json");
    assert.ok(fs.existsSync(configPath), `data/ad_config.json must exist at ${configPath}`);

    const savedOnDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(savedOnDisk.ldapUrl, "ldaps://dc-primary.corp.internal:636");
    assert.equal(savedOnDisk.syncIntervalSec, 180);
    assert.equal(savedOnDisk.enabled, true);
  });
});

test("adConfigRoutes: POST /api/ad/test checks connection to Domain Controller and returns result", async () => {
  await withServer(async (base) => {
    // Test with unreachable port to verify structured error handling
    const unreachablePayload = {
      ldapUrl: "ldaps://127.0.0.1:19999",
      bindDn: "CN=admin,DC=corp",
      bindPassword: "invalid-pass",
      tlsRejectUnauthorized: false,
    };

    const res = await fetch(`${base}/api/ad/test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": TEST_ADMIN_TOKEN,
      },
      body: JSON.stringify(unreachablePayload),
    });

    assert.equal(res.status, 200, `POST /api/ad/test must return HTTP 200 with test diagnostics, got: ${res.status}`);
    const data = (await res.json()) as any;
    assert.equal(data.ok, false, "Connection to unreachable port must report ok: false");
    assert.ok(data.error || data.message, "Must return diagnostic error message");
  });
});

test("adConfigRoutes: POST /api/ad/sync-now triggers immediate synchronization", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/ad/sync-now`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": TEST_ADMIN_TOKEN,
      },
      body: JSON.stringify({}),
    });

    assert.equal(res.status, 200, `POST /api/ad/sync-now must return HTTP 200, got: ${res.status}`);
    const data = (await res.json()) as any;
    assert.equal(data.ok, true, "sync-now must report ok: true");
    assert.equal(typeof data.usersCount, "number", "Must return usersCount");
    assert.equal(typeof data.uniqueUsersCount, "number", "Must return uniqueUsersCount (AD-UX-2)");
    assert.ok(data.syncedAt, "Must return syncedAt timestamp");
  });
});

test("adConfigRoutes: fleet soft migration permits legacy instances when rejectUnknownUsers=false and flags them as legacy", async (t) => {
  const initialAdConfig = adSyncService.getConfig();

  t.after(() => {
    adSyncService.updateConfig(initialAdConfig);
    clearInstances();
    _clearPersistentMetaForTesting();
  });

  await withServer(async (base) => {
    // 1. Soft migration mode: AD_ENABLED=true, but rejectUnknownUsers=false
    adSyncService.updateConfig({
      enabled: true,
      rejectUnknownUsers: false,
    });
    adSyncService.setMockAllowedUsers(["corp.user1"]);

    // An older extension instance (v1.0.0) without domainUser syncing
    const resLegacy = await fetch(`${base}/api/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ext-Token": TEST_TOKEN,
      },
      body: JSON.stringify({
        instanceId: "inst-legacy-unmigrated-01",
        version: "1.0.0",
        // Notice: domainUser is intentionally omitted (legacy client)
      }),
    });

    assert.equal(resLegacy.status, 200, "Legacy instance must be permitted when rejectUnknownUsers=false");
    const dataLegacy = (await resLegacy.json()) as any;
    assert.equal(dataLegacy.ok, true);
    assert.ok(dataLegacy.creds, "Legacy instance must receive credentials/proxy configuration");

    // Invariant: Instance must be marked as legacy in persistent metadata
    const metaLegacy = getInstanceMeta("inst-legacy-unmigrated-01");
    assert.ok(metaLegacy, "Instance metadata must exist");
    assert.equal(
      Boolean((metaLegacy as any)?.legacy || (metaLegacy as any)?.isLegacy),
      true,
      "Instance without domainUser must be marked as legacy in metadata during soft migration"
    );

    // 2. Strict enforcement mode: rejectUnknownUsers=true
    adSyncService.updateConfig({
      enabled: true,
      rejectUnknownUsers: true,
    });

    // Another legacy instance without domainUser attempting sync under strict policy
    const resBlocked = await fetch(`${base}/api/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ext-Token": TEST_TOKEN,
      },
      body: JSON.stringify({
        instanceId: "inst-legacy-blocked-02",
        version: "1.0.0",
        // domainUser is missing
      }),
    });

    assert.equal(resBlocked.status, 403, "Legacy instance must be blocked with HTTP 403 when rejectUnknownUsers=true");
    const dataBlocked = (await resBlocked.json()) as any;
    assert.equal(dataBlocked.ok, false);
    assert.equal(dataBlocked.action, "DISABLE_PROXY");
  });
});
