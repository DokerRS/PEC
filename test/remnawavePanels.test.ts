import "./helpers/setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import http from "node:http";
import {
  getAllRemnawavePanels,
  saveRemnawavePanel,
  getRemnawavePanelById,
  deleteRemnawavePanel
} from "../src/rotate.js";
import { createRotationRouter } from "../src/routes/rotationRoutes.js";
import { renderDashboardHtml } from "../src/views/dashboardView.js";

test("Remnawave panel registry supports CRUD and API-token masking", () => {
  const panel = saveRemnawavePanel({
    name: "Frankfurt Node",
    panelUrl: "https://remnawave-ffm.corp:3000/path",
    apiToken: "secret-api-token",
    insecureTls: true,
    targetUsername: "pec-user"
  });

  assert.ok(panel.id, "panel must have generated id");
  assert.equal(panel.name, "Frankfurt Node");

  const fetched = getRemnawavePanelById(panel.id);
  assert.ok(fetched);
  assert.equal(fetched.apiToken, "secret-api-token");

  const list = getAllRemnawavePanels(true);
  const listed = list.find((p) => p.id === panel.id);
  assert.ok(listed);
  assert.equal(listed.apiToken, "••••••••");

  // Updating without a replacement token preserves the existing token.
  const updated = saveRemnawavePanel({
    id: panel.id,
    name: "Frankfurt Node Renamed",
    panelUrl: "https://remnawave-ffm.corp:3000/path",
    apiToken: ""
  });
  assert.equal(updated.name, "Frankfurt Node Renamed");
  const fetchedUpdated = getRemnawavePanelById(panel.id);
  assert.ok(fetchedUpdated);
  assert.equal(fetchedUpdated.apiToken, "secret-api-token");

  // Clean up
  deleteRemnawavePanel(panel.id);
  assert.equal(getRemnawavePanelById(panel.id), undefined);
});

test("Remnawave panels HTTP endpoints provide REST CRUD", async () => {
  const app = express();
  app.use(express.json());
  app.use(createRotationRouter());

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  let createdId = "";
  try {
    // 1. Create panel
    const createRes = await fetch(`${base}/api/remnawave/panels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Berlin Node",
        panelUrl: "https://remnawave-berlin.corp:3000/path",
        apiToken: "supersecretberlin",
        insecureTls: true,
        targetUsername: "pec-user"
      })
    });
    assert.equal(createRes.status, 200);
    const createdData = await createRes.json();
    assert.ok(createdData.id);
    assert.equal(createdData.name, "Berlin Node");
    assert.equal(createdData.apiToken, "••••••••");
    assert.ok(!JSON.stringify(createdData).includes("supersecretberlin"));
    createdId = createdData.id;

    // 2. List panels (must be masked)
    const listRes = await fetch(`${base}/api/remnawave/panels`);
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    const found = list.find((p: any) => p.id === createdId);
    assert.ok(found);
    assert.equal(found.apiToken, "••••••••");

    // 3. Update panel
    const updateRes = await fetch(`${base}/api/remnawave/panels/${createdId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Berlin Node Updated",
        panelUrl: "https://remnawave-berlin.corp:3000/path",
        apiToken: "" // Keep existing
      })
    });
    assert.equal(updateRes.status, 200);
    const updatedData = await updateRes.json();
    assert.equal(updatedData.apiToken, "••••••••");

    // 4. Delete panel
    const delRes = await fetch(`${base}/api/remnawave/panels/${createdId}`, {
      method: "DELETE"
    });
    assert.equal(delRes.status, 200);
  } finally {
    if (createdId) deleteRemnawavePanel(createdId);
    server.close();
  }
});

test("dashboard UI: renders Remnawave panels registry, panel selector, and rotation widget", () => {
  const html = renderDashboardHtml({});

  // 1. Panels table & Add Panel button
  assert.ok(html.includes('id="panelsRemnawaveTable"') || html.includes('id="panelsRemnawaveBody"'), "dashboardView must contain Remnawave panels table");
  assert.ok(html.includes('id="btnOpenAddRemnawavePanel"'), "dashboardView must have button to add a Remnawave panel");
  assert.ok(html.includes('id="modalRemnawavePanel"'), "dashboardView must contain the Remnawave panel modal");
  assert.ok(html.includes('id="panelApiToken"'), "panel modal must accept a Remnawave API token");
  assert.ok(!html.includes('id="panelUser"') && !html.includes('id="panelPass"'), "panel modal must not ask for admin login credentials");

  // 2. Panel selector in Add from Remnawave modal
  assert.ok(html.includes('id="addRemnawavePanelSelect"'), "dashboardView must contain a panel selector in the Remnawave user modal");

  // 3. Rotation widget was removed; per-user Xray runtime card replaced it
  assert.ok(!html.includes('id="widgetRotationStatus"') && !html.includes('id="rotHistoryList"'), "rotation widget must be removed");
  assert.ok(html.includes('id="xrayRuntimeEnabled"') && html.includes('id="btnSaveXrayRuntime"'), "dashboardView must render the Xray runtime card");
});

test("executeRotation resolves target panel credentials from panels registry via activeProxy.panelId", async () => {
  const { executeRotation } = await import("../src/rotate.js");
  const { saveProxy, deleteProxy } = await import("../src/proxies.js");

  const panel = saveRemnawavePanel({
    name: "Registry Node",
    panelUrl: "http://127.0.0.1:59999",
    adminUser: "reg_admin",
    adminPass: "reg_pass",
  });

  const px = saveProxy({
    tag: "inbound-tag-test",
    type: "remnawave",
    remnawaveUsername: "pec-user",
    panelId: panel.id,
    protocol: "http",
    host: "127.0.0.1",
    port: 8080,
    isActive: true,
  });

  try {
    // Rotation was removed: with a panel configured, executeRotation must fail loudly
    // instead of silently doing standalone local rotation.
    await assert.rejects(
      () => executeRotation({}),
      /rotation is disabled/i,
      "executeRotation must refuse to rotate when a Remnawave panel is configured"
    );
  } finally {
    deleteRemnawavePanel(panel.id);
    deleteProxy(px.id);
  }
});

