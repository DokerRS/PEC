import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  testRemnawaveConnection,
  syncRemnawaveUser,
  getAllRemnawavePanels,
  saveRemnawavePanel,
  deleteRemnawavePanel,
} from "../src/rotate.js";
import { withHttpServer } from "./helpers/http-server.js";

function fakeRemnawavePanel(user: Record<string, unknown> | null, revokedUser?: Record<string, unknown>) {
  const seen: string[] = [];
  let revokeBody: unknown;

  const handler = (req: any, res: any) => {
    const url = req.url || "";
    seen.push(`${req.method} ${url}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "POST" && url === "/api/auth/login") {
      req.resume();
      req.on("end", () => json(201, { response: { accessToken: "test-access-token" } }));
      return;
    }
    if (req.method === "GET" && url === "/api/system/health") {
      json(200, { response: { status: "ok" } });
      return;
    }
    if (!String(req.headers.authorization || "").startsWith("Bearer ")) {
      json(401, { message: "Unauthorized" });
      return;
    }
    const byUsername = /^\/api\/users\/by-username\/(.+)$/.exec(url);
    if (req.method === "GET" && byUsername) {
      if (!user || decodeURIComponent(byUsername[1]) !== user.username) {
        json(404, { statusCode: 404, message: "User not found" });
        return;
      }
      json(200, { response: user });
      return;
    }
    if (req.method === "GET" && url === "/api/users?limit=1&page=1") {
      json(200, { response: { users: user ? [user] : [], total: user ? 1 : 0 } });
      return;
    }
    if (req.method === "POST" && /^\/api\/users\/[^/]+\/actions\/revoke$/.test(url)) {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk));
      req.on("end", () => {
        revokeBody = JSON.parse(raw);
        json(200, { response: revokedUser || user });
      });
      return;
    }
    json(404, { statusCode: 404, message: "Not found" });
  };

  return { handler, seen, getRevokeBody: () => revokeBody };
}

test("Remnawave connection test authenticates and finds the configured username", async () => {
  const panel = fakeRemnawavePanel({
    id: 10,
    username: "pec-user",
    status: "ACTIVE",
    trojanPassword: "old-secret",
  });
  const { url, close } = await withHttpServer(panel.handler);

  try {
    const result = await testRemnawaveConnection({
      panelUrl: url,
      adminUser: "admin",
      adminPass: "pass",
      targetUsername: "pec-user",
      insecureTls: true,
      timeoutSec: 3,
    });
    assert.equal(result.ok, true);
    assert.equal(result.userFound, true);
    assert.equal(result.userId, 10);
    assert.ok(panel.seen.includes("POST /api/auth/login"));
  } finally {
    await close();
  }
});

test("Remnawave connection test distinguishes a missing user from a failed connection", async () => {
  const panel = fakeRemnawavePanel(null);
  const { url, close } = await withHttpServer(panel.handler);

  try {
    const result = await testRemnawaveConnection({
      panelUrl: url,
      adminUser: "admin",
      adminPass: "pass",
      targetUsername: "missing-user",
      timeoutSec: 3,
    });
    assert.equal(result.ok, true);
    assert.equal(result.userFound, false);
    assert.match(result.message, /not found/i);
  } finally {
    await close();
  }
});

test("Remnawave rotation revokes only passwords and reads back the new credential", async () => {
  const panel = fakeRemnawavePanel(
    {
      id: 25,
      username: "pec-user",
      status: "ACTIVE",
      shortUuid: "stable-subscription-id",
      trojanPassword: "old-password",
    },
    {
      id: 25,
      username: "pec-user",
      status: "ACTIVE",
      shortUuid: "stable-subscription-id",
      trojanPassword: "new-password",
    }
  );
  const { url, close } = await withHttpServer(panel.handler);

  try {
    const result = await syncRemnawaveUser({
      panelUrl: url,
      adminUser: "admin",
      adminPass: "pass",
      username: "pec-user",
      rotatePassword: true,
      timeoutSec: 3,
    });
    assert.equal(result.ok, true);
    assert.equal(result.rotated, true);
    assert.equal(result.password, "new-password");
    assert.equal(result.shortUuid, "stable-subscription-id");
    assert.deepEqual(panel.getRevokeBody(), { revokeOnlyPasswords: true });
  } finally {
    await close();
  }
});

test("Remnawave credential lookup is read-only and supports Shadowsocks credentials", async () => {
  const panel = fakeRemnawavePanel({
    id: 30,
    username: "pec-user",
    status: "ACTIVE",
    ssPassword: "ss-secret",
  });
  const { url, close } = await withHttpServer(panel.handler);

  try {
    const result = await syncRemnawaveUser({
      panelUrl: url,
      adminUser: "admin",
      adminPass: "pass",
      username: "pec-user",
      timeoutSec: 3,
    });
    assert.equal(result.ok, true);
    assert.equal(result.rotated, false);
    assert.equal(result.password, "ss-secret");
    assert.ok(!panel.seen.some((request) => request.includes("/actions/revoke")));
  } finally {
    await close();
  }
});

test("Remnawave registry supports password masking, updates, and deletion", () => {
  const saved = saveRemnawavePanel({
    name: "test-panel",
    panelUrl: "https://remnawave.test.local:3000",
    adminUser: "admin",
    adminPass: "secret",
    targetUsername: "pec-user",
    rotationEnabled: true,
  });

  try {
    assert.ok(saved.id);
    assert.equal(getAllRemnawavePanels(true).find((panel) => panel.id === saved.id)?.adminPass, "••••••••");
    const updated = saveRemnawavePanel({
      ...saved,
      name: "updated-panel",
      adminPass: "********",
    });
    assert.equal(updated.name, "updated-panel");
    assert.equal(updated.adminPass, "secret");
    assert.equal(updated.targetUsername, "pec-user");
  } finally {
    deleteRemnawavePanel(saved.id);
  }

  assert.ok(!getAllRemnawavePanels().some((panel) => panel.id === saved.id));
});
