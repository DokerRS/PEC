import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import express from "express";
import { getAppVersion } from "../src/version.js";
import { renderDashboardHtml } from "../src/views/dashboardView.js";
import { initDashboardCredentials, resetDashboardCredentialsForTest } from "../src/auth.js";
import { createSystemRouter } from "../src/routes/systemRoutes.js";
import { TEST_TOKEN } from "./helpers/setup.js";

test("B2: getAppVersion returns package.json version and renders in dashboard badge", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
  const version = getAppVersion();
  assert.equal(version, pkg.version);

  const html = renderDashboardHtml();
  assert.ok(html.includes(`data-server-version="${pkg.version}"`), "badge must contain data-server-version attribute");
  assert.ok(html.includes(`>v${pkg.version}</span>`), "badge must render formatted version string");
  assert.ok(!html.includes(">v1.3.0</span>"), "hardcoded v1.3.0 must not be present");
});

test("B3: update check repo defaults to vlv-code/PEC and honors UPDATE_CHECK_REPO env", async () => {
  // AUDIT-QA-P3: behavioral — exercised through GET /api/github/releases and its
  // `repo` echo instead of reading route source text. The echo is present on
  // every outcome (200 / 400 / 404 / 502), so the precedence chain is verified
  // offline without depending on GitHub availability.
  const app = express();
  app.use(
    createSystemRouter({
      port: 3000,
      getFleetToken: () => TEST_TOKEN,
      defaultFleetToken: "default-token",
      adminTokenConfigured: true,
      credsStorePath: "/tmp/creds.json",
    })
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  const origEnv = process.env.UPDATE_CHECK_REPO;
  try {
    // 1. Env override wins when no query param is given.
    process.env.UPDATE_CHECK_REPO = "env-probe/env-probe";
    const resEnv = await fetch(`${baseUrl}/api/github/releases`);
    const bodyEnv = (await resEnv.json()) as any;
    assert.equal(bodyEnv.repo, "env-probe/env-probe", "UPDATE_CHECK_REPO env must override the default repo");

    // 2. Query param takes precedence over env.
    const resQuery = await fetch(`${baseUrl}/api/github/releases?repo=query-probe/query-probe`);
    const bodyQuery = (await resQuery.json()) as any;
    assert.equal(bodyQuery.repo, "query-probe/query-probe", "?repo= query param must take precedence over env");

    // 3. Default is vlv-code/PEC when neither is set (stale repo is gone).
    delete process.env.UPDATE_CHECK_REPO;
    const resDefault = await fetch(`${baseUrl}/api/github/releases`);
    const bodyDefault = (await resDefault.json()) as any;
    assert.equal(bodyDefault.repo, "vlv-code/PEC", "default update-check repo must be vlv-code/PEC");
    assert.notEqual(bodyDefault.repo, "balukabalukasa/pec-proxy-corp", "stale repo must never be used");
  } finally {
    if (origEnv === undefined) delete process.env.UPDATE_CHECK_REPO;
    else process.env.UPDATE_CHECK_REPO = origEnv;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("B1: initDashboardCredentials prints bootstrap credentials banner on fallback creation", () => {
  const origLog = console.log;
  let loggedOutput = "";
  console.log = (...args: any[]) => {
    loggedOutput += args.join(" ") + "\n";
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pec-b1-test-"));
  const authPath = path.join(tempDir, "dashboard_auth.json");
  const origAuthPath = process.env.DASHBOARD_AUTH_PATH;
  const origAdminPass = process.env.ADMIN_PASSWORD;

  try {
    process.env.DASHBOARD_AUTH_PATH = authPath;
    delete process.env.ADMIN_PASSWORD;
    resetDashboardCredentialsForTest();

    const res = initDashboardCredentials({ username: "admin", autoCreate: true });
    assert.equal(res.usingFallbackPassword, true);
    assert.equal(res.setupRequired, false);

    assert.ok(loggedOutput.includes("Dashboard bootstrap credentials (shown ONCE)"), "must print bootstrap banner");
    assert.ok(loggedOutput.includes("Login:    admin"), "banner must show admin username");
    assert.ok(fs.existsSync(authPath), "auth file must be written to disk");

    // Second call with existing store should NOT print banner
    loggedOutput = "";
    const secondRes = initDashboardCredentials({ username: "admin" });
    assert.equal(secondRes.usingFallbackPassword, false);
    assert.ok(!loggedOutput.includes("Dashboard bootstrap credentials (shown ONCE)"), "second run must not re-print");
  } finally {
    console.log = origLog;
    if (origAuthPath !== undefined) process.env.DASHBOARD_AUTH_PATH = origAuthPath;
    else delete process.env.DASHBOARD_AUTH_PATH;
    if (origAdminPass !== undefined) process.env.ADMIN_PASSWORD = origAdminPass;
    else delete process.env.ADMIN_PASSWORD;
    resetDashboardCredentialsForTest();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});
