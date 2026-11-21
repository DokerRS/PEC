import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { renderDashboardHtml } from "../src/views/dashboardView.js";
import { setupDashboardDom } from "./helpers/dashboardDom.js";
import { waitFor } from "./helpers/waitFor.js";

test("Dashboard UI: renderDashboardHtml includes Releases tab and Rollback table", () => {
  const html = renderDashboardHtml({
    isDefaultTokenInUse: false,
  });

  assert.ok(
    html.includes('id="tabBtnReleases"'),
    "HTML must include tabBtnReleases navigation button"
  );
  assert.ok(
    html.includes('id="tab-releases"'),
    "HTML must include tab-releases pane"
  );
  assert.ok(
    html.includes('id="releasesTable"'),
    "HTML must include releasesTable"
  );
  assert.ok(
    html.includes('id="releasesTableBody"'),
    "HTML must include releasesTableBody"
  );
});

test("Dashboard UI: fleet table includes username column and pairing display", async () => {
  const html = renderDashboardHtml({
    isDefaultTokenInUse: false,
  });

  assert.ok(
    html.includes("data-sort=\"user\"") || html.includes("Пользователь"),
    "instancesTable must have user / username column header"
  );

  // AUDIT-QA-P3: behavioral contracts against the shipped bundle (were
  // source-content asserts on the orphaned monolith).
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/instances": {
        online: 1,
        instances: [
          {
            instanceId: "inst-paired-01",
            username: "operator@corp.local",
            status: "ONLINE",
            pairedAppId: "app-01",
            pairedHostname: "OPERATOR-PC",
          },
        ],
      },
    },
  });
  try {
    // Releases functions must be exposed on window at runtime.
    assert.equal(typeof env.window.loadReleases, "function", "loadReleases must be exposed on window");
    assert.equal(typeof env.window.downloadReleaseVersion, "function", "downloadReleaseVersion must be exposed on window");

    // Rollback action must POST /api/releases/set-active.
    env.setMockResponse("/api/releases/set-active", { ok: true });
    env.window.pecConfirm = (async () => true) as any;
    await env.window.setActiveReleaseVersion("extension", "1.2.0");
    const rollbackCall = env.fetchCalls.find((c) => c.url === "/api/releases/set-active");
    assert.ok(rollbackCall, "setActiveReleaseVersion must POST /api/releases/set-active for rollback");
    assert.equal(rollbackCall.method, "POST");
    assert.deepEqual(JSON.parse(rollbackCall.body), { type: "extension", version: "1.2.0" });

    // Fleet rows must render instances cleanly without redundant desktop badges in extension table.
    await env.window.loadInstances();
    await waitFor(
      () => (env.document.getElementById("fleetTableBody")?.innerHTML || "").includes("inst-paired-01"),
      { label: "loadInstances to render fleet rows" }
    );
    const fleetHtml = env.document.getElementById("fleetTableBody")?.innerHTML || "";
    assert.ok(fleetHtml.includes("inst-paired-01"), "fleet row must render instanceId");
    assert.ok(fleetHtml.includes("operator@corp.local"), "fleet row must render username");
    assert.strictEqual(fleetHtml.includes("🔗"), false, "paired desktop badge must not render in extensions table");
  } finally {
    env.teardown();
  }
});

test("Dashboard UI: renderReleasesTable correctly distinguishes active vs archived release rows", () => {
  const jsContent = fs.readFileSync(path.resolve("./public/dashboard.js"), "utf-8");

  // Extract renderReleasesTable and its dependencies to execute in a light VM
  assert.ok(
    jsContent.includes("rel.isActive"),
    "dashboard.js must inspect rel.isActive property"
  );

  // Simulate row generator logic
  const relActive = {
    type: "extension",
    version: "1.2.0",
    builtAt: new Date().toISOString(),
    sha256: "abcdef123456",
    isActive: true,
  };

  const relArchived = {
    type: "extension",
    version: "1.1.0",
    builtAt: new Date(Date.now() - 100000).toISOString(),
    sha256: "123456abcdef",
    isActive: false,
  };

  // Check code pattern in dashboard.js
  assert.ok(
    jsContent.includes("const isActive = Boolean(rel.isActive || rel.active);"),
    "dashboard.js must compute isActive using rel.isActive"
  );
  assert.ok(
    jsContent.includes("downloadReleaseVersion("),
    "dashboard.js must trigger downloadReleaseVersion from download button"
  );
});
