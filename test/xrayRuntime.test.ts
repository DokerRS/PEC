import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  loadXrayRuntimeSettings,
  saveXrayRuntimeSettings,
  deriveProxySecret,
  normalizeRemnawaveUsername,
  parseVlessLink,
  buildXrayUserConfig,
  DEFAULT_XRAY_RUNTIME_SETTINGS,
} from "../src/xrayRuntime.js";
import { createXrayRuntimeRouter } from "../src/routes/xrayRuntimeRoutes.js";
import { getXrayRuntimeSettingsPath } from "../src/storage.js";
import { TEST_TOKEN, TEST_ADMIN_TOKEN } from "./helpers/setup.js";

/**
 * REMNA-PERUSER-XRAY-1: control-plane store, per-user credential derivation,
 * subscription link parsing, and per-user Xray config rendering.
 */

function resetStore() {
  fs.rmSync(getXrayRuntimeSettingsPath(), { force: true });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/xray-runtime", createXrayRuntimeRouter((req: any, res: any, next: any) => {
    const token = req.headers["x-admin-token"];
    if (token && token === TEST_ADMIN_TOKEN) return next();
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }));
  return app;
}

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = buildApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(base);
  } finally {
    if (typeof (server as any).closeAllConnections === "function") (server as any).closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("XR-1: settings default when store absent; save/load round-trip with sanitization", () => {
  resetStore();
  assert.deepEqual(loadXrayRuntimeSettings(), DEFAULT_XRAY_RUNTIME_SETTINGS);

  const saved = saveXrayRuntimeSettings({ enabled: true, version: "v24.11.11", listenPort: 12700 });
  assert.equal(saved.enabled, true);
  assert.equal(saved.version, "24.11.11", "leading v is stripped");
  assert.equal(saved.listenPort, 12700);
  assert.deepEqual(loadXrayRuntimeSettings(), { enabled: true, version: "24.11.11", listenPort: 12700 });

  // Garbage port falls back to default; non-boolean enabled stays false.
  const bad = saveXrayRuntimeSettings({ enabled: "yes" as unknown as boolean, listenPort: 99999 });
  assert.equal(bad.enabled, false);
  assert.equal(bad.listenPort, DEFAULT_XRAY_RUNTIME_SETTINGS.listenPort);
  resetStore();
});

test("XR-1: deriveProxySecret is deterministic per user and unique across users", () => {
  resetStore();
  const a1 = deriveProxySecret("ivanov");
  const a2 = deriveProxySecret("DOMAIN\\ivanov");
  const a3 = deriveProxySecret("ivanov@corp.local");
  assert.equal(a1, a2, "DOMAIN\\user maps to same secret");
  assert.equal(a1, a3, "UPN maps to same secret");
  assert.equal(a1.length, 22);
  assert.notEqual(a1, deriveProxySecret("petrov"));
  assert.throws(() => deriveProxySecret("  "));

  // Master secret persists in the store file and is stable across calls.
  const onDisk = JSON.parse(fs.readFileSync(getXrayRuntimeSettingsPath(), "utf-8"));
  assert.ok(typeof onDisk.masterSecret === "string" && onDisk.masterSecret.length >= 32);
  assert.equal(deriveProxySecret("ivanov"), a1);
  resetStore();
});

test("XR-1: normalizeRemnawaveUsername strips domain and UPN suffixes", () => {
  assert.equal(normalizeRemnawaveUsername("CORP\\ivanov"), "ivanov");
  assert.equal(normalizeRemnawaveUsername("ivanov@corp.local"), "ivanov");
  assert.equal(normalizeRemnawaveUsername("  ivanov  "), "ivanov");
  assert.equal(normalizeRemnawaveUsername("ivanov"), "ivanov");
  assert.equal(normalizeRemnawaveUsername(""), "");
});

test("XR-1: parseVlessLink accepts vless links and rejects everything else", () => {
  const link = "vless://11111111-2222-3333-4444-555555555555@edge1.corp:443?security=reality&pbk=PUBKEY&sid=ab&spx=%2F&fp=chrome&flow=xtls-rprx-vision&sni=site.example&type=tcp#Edge%201";
  const parsed = parseVlessLink(link);
  assert.ok(parsed);
  assert.equal(parsed!.uuid, "11111111-2222-3333-4444-555555555555");
  assert.equal(parsed!.host, "edge1.corp");
  assert.equal(parsed!.port, 443);
  assert.equal(parsed!.security, "reality");
  assert.equal(parsed!.publicKey, "PUBKEY");
  assert.equal(parsed!.flow, "xtls-rprx-vision");
  assert.equal(parsed!.name, "Edge 1");

  assert.equal(parseVlessLink("vmess://abc@host:443"), null);
  assert.equal(parseVlessLink("not a url"), null);
  assert.equal(parseVlessLink("vless://@host:443"), null);
  assert.equal(parseVlessLink(""), null);
});

test("XR-1: buildXrayUserConfig renders shared inbound, per-user account, and own outbounds", () => {
  const links = [
    "vless://aaaaaaaa-0000-0000-0000-000000000001@edge1.corp:443?security=reality&pbk=K1&fp=chrome&flow=xtls-rprx-vision#Edge%201",
    "vless://aaaaaaaa-0000-0000-0000-000000000002@edge2.corp:8443?security=tls&sni=edge2.corp#Edge%202",
    "ss://not-vless@edge3:8388",
  ];
  const { config, servers } = buildXrayUserConfig({
    username: "CORP\\ivanov",
    secret: "derived-secret",
    listenPort: 12080,
    subscription: { links },
  });

  assert.equal(servers.length, 2, "only vless links are usable");
  const inbounds = config.inbounds as any[];
  assert.equal(inbounds.length, 2);
  assert.equal(inbounds[0].protocol, "http");
  assert.equal(inbounds[0].listen, "127.0.0.1");
  assert.equal(inbounds[0].port, 12080);
  assert.equal(inbounds[0].settings.servers[0].user, "derived-secret");
  assert.equal(inbounds[0].settings.servers[0].email, "ivanov");
  assert.equal(inbounds[1].protocol, "socks");
  assert.equal(inbounds[1].port, 12081);

  const outbounds = config.outbounds as any[];
  assert.equal(outbounds.length, 4, "2 vless + direct + block");
  assert.equal(outbounds[0].tag, "remna_1");
  assert.equal(outbounds[0].settings.vnext[0].address, "edge1.corp");
  assert.equal(outbounds[0].streamSettings.security, "reality");
  assert.equal(outbounds[1].streamSettings.security, "tls");
  assert.equal(outbounds[1].settings.vnext[0].users[0].encryption, "none");

  const routing = config.routing as any;
  assert.deepEqual(routing.balancerInfo.selector, ["remna_1", "remna_2"]);
  assert.equal(routing.balancerInfo.fallbackTag, "remna_1");
  const userRule = routing.rules.find((r: any) => r.user);
  assert.deepEqual(userRule.user, ["ivanov"]);
  assert.equal(userRule.balancerTag, "remna_pool");
  assert.ok(routing.rules.some((r: any) => r.ip), "private IP bypass rule present");
});

test("XR-1: buildXrayUserConfig fails closed on empty subscription and bad port", () => {
  assert.throws(
    () => buildXrayUserConfig({ username: "ivanov", secret: "s", listenPort: 12080, subscription: { links: [] } }),
    /no usable VLESS/i
  );
  assert.throws(
    () =>
      buildXrayUserConfig({
        username: "ivanov",
        secret: "s",
        listenPort: 70000,
        subscription: { links: ["vless://u@h:443"] },
      }),
    /listenPort/i
  );
});

test("XR-1: /api/xray-runtime is admin-only and round-trips settings", async () => {
  resetStore();
  await withServer(async (base) => {
    const anon = await fetch(`${base}/api/xray-runtime`);
    assert.strictEqual(anon.status, 401, "anonymous read must be rejected");

    const fleet = await fetch(`${base}/api/xray-runtime`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fleet-token": TEST_TOKEN },
      body: JSON.stringify({ enabled: true }),
    });
    assert.strictEqual(fleet.status, 401, "fleet token must NOT have write access");

    const post = await fetch(`${base}/api/xray-runtime`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": TEST_ADMIN_TOKEN },
      body: JSON.stringify({ enabled: true, version: "24.11.11", listenPort: 12500 }),
    });
    assert.strictEqual(post.status, 200);
    const body = await post.json();
    assert.equal(body.ok, true);
    assert.equal(body.enabled, true);
    assert.equal(body.version, "24.11.11");
    assert.equal(body.listenPort, 12500);

    const get = await fetch(`${base}/api/xray-runtime`, { headers: { "x-admin-token": TEST_ADMIN_TOKEN } });
    assert.strictEqual(get.status, 200);
    const getBody = await get.json();
    assert.equal(getBody.enabled, true);
    assert.equal(getBody.listenPort, 12500);
    // The master secret must never leak through the admin API.
    assert.ok(!JSON.stringify(getBody).includes("masterSecret"));
  });
  resetStore();
});
