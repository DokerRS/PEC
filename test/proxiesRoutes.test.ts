import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert";
import express from "express";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import { createProxiesRouter } from "../src/routes/proxiesRoutes.js";
import { getProxiesStorePath } from "../src/storage.js";
import { createProxy, getAllProxies } from "../src/proxies.js";
import { saveRemnawavePanel, deleteRemnawavePanel, getRemnawavePanel } from "../src/rotate.js";
import { getAuditLogs } from "../src/audit.js";
import { withHttpServer } from "./helpers/http-server.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createProxiesRouter());
  return app;
}

let sharedBase = "";
let serverInstance: any = null;

async function getSharedBase(): Promise<string> {
  if (!sharedBase) {
    const app = buildApp();
    serverInstance = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => serverInstance.once("listening", () => resolve()));
    const port = (serverInstance.address() as AddressInfo).port;
    sharedBase = `http://127.0.0.1:${port}`;
  }
  return sharedBase;
}

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const base = await getSharedBase();
  return await fn(base);
}

test.after(() => {
  if (serverInstance) {
    serverInstance.close();
  }
});

function resetProxiesStore() {
  const storePath = getProxiesStorePath();
  if (fs.existsSync(storePath)) {
    fs.unlinkSync(storePath);
  }
}

test("GET /api/proxies: returns empty list initially or all proxies with masked passwords", async () => {
  resetProxiesStore();
  await withServer(async (base) => {
    const res1 = await fetch(`${base}/api/proxies`);
    assert.strictEqual(res1.status, 200);
    const body1 = await res1.json();
    assert.deepStrictEqual(body1, []);

    // Create a proxy with password directly
    createProxy({
      tag: "test-p1",
      name: "Proxy 1",
      type: "manual",
      protocol: "socks5",
      host: "10.0.0.1",
      port: 1080,
      username: "user1",
      password: "secretpassword123",
    });

    const res2 = await fetch(`${base}/api/proxies`);
    assert.strictEqual(res2.status, 200);
    const body2 = await res2.json();
    assert.strictEqual(body2.length, 1);
    assert.strictEqual(body2[0].tag, "test-p1");
    assert.strictEqual(body2[0].password, "********");
  });
});

test("POST /api/proxies (manual): validation and creation", async () => {
  resetProxiesStore();
  await withServer(async (base) => {
    // Missing required fields
    const resBad = await fetch(`${base}/api/proxies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "manual", host: "1.2.3.4" }),
    });
    assert.strictEqual(resBad.status, 400);

    // Invalid type
    const resBadType = await fetch(`${base}/api/proxies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "unknown-type", tag: "t1" }),
    });
    assert.strictEqual(resBadType.status, 400);

    // Invalid port
    const resBadPort = await fetch(`${base}/api/proxies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "manual",
        tag: "p-bad-port",
        protocol: "socks5",
        host: "1.2.3.4",
        port: 99999,
      }),
    });
    assert.strictEqual(resBadPort.status, 400);

    // Valid manual proxy
    const resGood = await fetch(`${base}/api/proxies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "manual",
        tag: "manual-node-1",
        name: "Manual Node 1",
        protocol: "socks5",
        host: "192.168.1.50",
        port: 10808,
        username: "myuser",
        password: "mypassword",
      }),
    });
    assert.strictEqual(resGood.status, 201);
    const created = await resGood.json();
    assert.ok(created.id);
    assert.strictEqual(created.tag, "manual-node-1");
    assert.strictEqual(created.name, "Manual Node 1");
    assert.strictEqual(created.protocol, "socks5");
    assert.strictEqual(created.host, "192.168.1.50");
    assert.strictEqual(created.port, 10808);
    assert.strictEqual(created.password, "********");
    assert.strictEqual(created.isActive, true, "First proxy must be active");

    // Verify audit log
    const auditLogs = getAuditLogs();
    const createdAudit = auditLogs.find((a) => a.result === "PROXY_CREATED");
    assert.ok(createdAudit, "Audit log must contain PROXY_CREATED");
    assert.strictEqual(createdAudit.status, 201);
  });
});

test("PUT /api/proxies/:id: validation, 404 and updating", async () => {
  resetProxiesStore();
  const node = createProxy({
    tag: "p-to-update",
    protocol: "http",
    host: "1.2.3.4",
    port: 8080,
    password: "oldpassword",
  });

  await withServer(async (base) => {
    // 404 for unknown id
    const res404 = await fetch(`${base}/api/proxies/non-existent-id`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    assert.strictEqual(res404.status, 404);

    // 400 for invalid port
    const res400 = await fetch(`${base}/api/proxies/${node.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: -1 }),
    });
    assert.strictEqual(res400.status, 400);

    // 200 for valid update
    const res200 = await fetch(`${base}/api/proxies/${node.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Name", port: 8081 }),
    });
    assert.strictEqual(res200.status, 200);
    const updated = await res200.json();
    assert.strictEqual(updated.id, node.id);
    assert.strictEqual(updated.name, "Updated Name");
    assert.strictEqual(updated.port, 8081);
    assert.strictEqual(updated.password, "********");

    // Verify audit log
    const auditLogs = getAuditLogs();
    const updatedAudit = auditLogs.find((a) => a.result === "PROXY_UPDATED");
    assert.ok(updatedAudit, "Audit log must contain PROXY_UPDATED");
  });
});

test("POST /api/proxies/:id/activate: activates target proxy", async () => {
  resetProxiesStore();
  const node1 = createProxy({
    tag: "node-1",
    protocol: "socks5",
    host: "1.1.1.1",
    port: 1080,
    password: "pass1",
  });
  const node2 = createProxy({
    tag: "node-2",
    protocol: "http",
    host: "2.2.2.2",
    port: 8080,
    password: "pass2",
  });

  await withServer(async (base) => {
    // 404 for missing proxy
    const res404 = await fetch(`${base}/api/proxies/unknown-id/activate`, {
      method: "POST",
    });
    assert.strictEqual(res404.status, 404);

    // Activate node 2
    const res200 = await fetch(`${base}/api/proxies/${node2.id}/activate`, {
      method: "POST",
    });
    assert.strictEqual(res200.status, 200);
    const body = await res200.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.activeProxy.id, node2.id);
    assert.strictEqual(body.activeProxy.isActive, true);
    assert.strictEqual(body.activeProxy.password, "********");

    // Verify audit log
    const auditLogs = getAuditLogs();
    const activatedAudit = auditLogs.find((a) => a.result === "PROXY_ACTIVATED");
    assert.ok(activatedAudit, "Audit log must contain PROXY_ACTIVATED");
  });
});

test("DELETE /api/proxies/:id: deletes proxy", async () => {
  resetProxiesStore();
  const node = createProxy({
    tag: "node-to-delete",
    protocol: "socks5",
    host: "3.3.3.3",
    port: 1080,
  });

  await withServer(async (base) => {
    // Delete existing
    const res = await fetch(`${base}/api/proxies/${node.id}`, {
      method: "DELETE",
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.removed, true);

    // Delete non-existent
    const res2 = await fetch(`${base}/api/proxies/${node.id}`, {
      method: "DELETE",
    });
    assert.strictEqual(res2.status, 200);
    const body2 = await res2.json();
    assert.strictEqual(body2.ok, true);
    assert.strictEqual(body2.removed, false);

    // Verify audit log
    const auditLogs = getAuditLogs();
    const deletedAudit = auditLogs.find((a) => a.result === "PROXY_DELETED");
    assert.ok(deletedAudit, "Audit log must contain PROXY_DELETED");
  });
});

test("POST /api/proxies (Remnawave): user creation and validation", async () => {
  resetProxiesStore();
  await withServer(async (base) => {
    const noUsername = await fetch(`${base}/api/proxies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "remnawave" }),
    });
    assert.strictEqual(noUsername.status, 400);

    // No panel configured: creation must be refused.
    for (let p = getRemnawavePanel(); p; p = getRemnawavePanel()) deleteRemnawavePanel(p.id);
    const noPanel = await fetch(`${base}/api/proxies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "remnawave", username: "pec-user" }),
    });
    assert.strictEqual(noPanel.status, 400);

    const mockPanel = await withHttpServer((req, res) => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url === "/api/auth/login") {
        req.resume();
        req.on("end", () => json(201, { response: { accessToken: "test-token" } }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/users/by-username/pec-user") {
        json(200, { response: { id: 21, username: "pec-user", trojanPassword: "user-pass" } });
        return;
      }
      json(404, { statusCode: 404, message: "Not found" });
    });

    let registeredPanel: { id: string } | null = null;
    try {
      registeredPanel = saveRemnawavePanel({ name: "mock-panel", panelUrl: mockPanel.url, adminUser: "admin", adminPass: "admin" });
      const createdRes = await fetch(`${base}/api/proxies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "remnawave", username: "pec-user" }),
      });
      assert.strictEqual(createdRes.status, 201);
      const created = await createdRes.json();
      assert.strictEqual(created.type, "remnawave");
      assert.strictEqual(created.remnawaveUsername, "pec-user");
      assert.strictEqual(created.password, "********");
      assert.strictEqual(created.host, "127.0.0.1");
    } finally {
      await mockPanel.close();
      if (registeredPanel) deleteRemnawavePanel(registeredPanel.id);
    }
  });
});

test("POST /api/proxies/:id/sync: syncs Remnawave user credentials", async () => {
  resetProxiesStore();
  const manualProxy = createProxy({ tag: "manual-node", protocol: "socks5", host: "1.1.1.1", port: 1080 });

  await withServer(async (base) => {
    const missing = await fetch(`${base}/api/proxies/unknown-id/sync`, { method: "POST" });
    assert.strictEqual(missing.status, 404);
    const manual = await fetch(`${base}/api/proxies/${manualProxy.id}/sync`, { method: "POST" });
    assert.strictEqual(manual.status, 400);

    let password = "old-pass";
    const mockPanel = await withHttpServer((req, res) => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url === "/api/auth/login") {
        req.resume();
        req.on("end", () => json(201, { response: { accessToken: "test-token" } }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/users/by-username/pec-user") {
        json(200, { response: { id: 22, username: "pec-user", trojanPassword: password } });
        return;
      }
      if (req.method === "POST" && req.url === "/api/users/22/actions/revoke") {
        req.resume();
        req.on("end", () => {
          password = "new-pass";
          json(200, { response: { id: 22, username: "pec-user", trojanPassword: password } });
        });
        return;
      }
      json(404, { statusCode: 404, message: "Not found" });
    });

    const remnawaveProxy = createProxy({
      tag: "pec-user",
      type: "remnawave",
      remnawaveUsername: "pec-user",
      protocol: "socks5",
      host: "127.0.0.1",
      port: 443,
    });

    let registeredPanel: { id: string } | null = null;
    try {
      registeredPanel = saveRemnawavePanel({ name: "mock-panel", panelUrl: mockPanel.url, adminUser: "admin", adminPass: "admin" });
      const response = await fetch(`${base}/api/proxies/${remnawaveProxy.id}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotatePassword: true }),
      });
      assert.strictEqual(response.status, 200);
      const data = await response.json();
      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.proxy.password, "********");
      assert.ok(data.proxy.lastSync);
      assert.strictEqual(password, "old-pass", "sync is read-only and must never rotate the panel credential");
    } finally {
      await mockPanel.close();
      if (registeredPanel) deleteRemnawavePanel(registeredPanel.id);
    }
  });
});

test("POST /api/remnawave/user-lookup: reads credentials without rotating them", async () => {
  await withServer(async (base) => {
    const missingUsername = await fetch(`${base}/api/remnawave/user-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(missingUsername.status, 400);

    let revokes = 0;
    const mockPanel = await withHttpServer((req, res) => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url === "/api/auth/login") {
        req.resume();
        req.on("end", () => json(201, { response: { accessToken: "test-token" } }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/users/by-username/lookup-user") {
        json(200, { response: { id: 23, username: "lookup-user", ssPassword: "ss-secret" } });
        return;
      }
      if (req.url?.includes("/actions/revoke")) revokes++;
      json(404, { statusCode: 404, message: "Not found" });
    });

    let registeredPanel: { id: string } | null = null;
    try {
      registeredPanel = saveRemnawavePanel({ name: "mock-panel", panelUrl: mockPanel.url, adminUser: "admin", adminPass: "admin" });
      const response = await fetch(`${base}/api/remnawave/user-lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "lookup-user" }),
      });
      assert.strictEqual(response.status, 200);
      const data = await response.json();
      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.user.username, "lookup-user");
      assert.strictEqual(data.user.hasPassword, true);
      assert.strictEqual(revokes, 0);
    } finally {
      await mockPanel.close();
      if (registeredPanel) deleteRemnawavePanel(registeredPanel.id);
    }
  });
});