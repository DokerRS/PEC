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

test("Remnawave panel registry supports CRUD and password masking", () => {
  const panel = saveRemnawavePanel({
    name: "Frankfurt Node",
    panelUrl: "https://remnawave-ffm.corp:3000/path",
    adminUser: "ffm_admin",
    adminPass: "secretpass123",
    insecureTls: true,
    targetUsername: "pec-user"
  });

  assert.ok(panel.id, "panel must have generated id");
  assert.equal(panel.name, "Frankfurt Node");

  const fetched = getRemnawavePanelById(panel.id);
  assert.ok(fetched);
  assert.equal(fetched.adminUser, "ffm_admin");
  assert.equal(fetched.adminPass, "secretpass123");

  const list = getAllRemnawavePanels(true); // with mask
  const listed = list.find((p) => p.id === panel.id);
  assert.ok(listed);
  assert.equal(listed.adminPass, "••••••••");

  // Updating without changing password preserves existing password
  const updated = saveRemnawavePanel({
    id: panel.id,
    name: "Frankfurt Node Renamed",
    panelUrl: "https://remnawave-ffm.corp:3000/path",
    adminUser: "ffm_admin",
    adminPass: ""
  });
  assert.equal(updated.name, "Frankfurt Node Renamed");
  const fetchedUpdated = getRemnawavePanelById(panel.id);
  assert.ok(fetchedUpdated);
  assert.equal(fetchedUpdated.adminPass, "secretpass123");

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
        adminUser: "berlin_admin",
        adminPass: "supersecretberlin",
        insecureTls: true,
        targetUsername: "pec-user"
      })
    });
    assert.equal(createRes.status, 200);
    const createdData = await createRes.json();
    assert.ok(createdData.id);
    assert.equal(createdData.name, "Berlin Node");
    assert.equal(createdData.adminPass, "••••••••");
    createdId = createdData.id;

    // 2. List panels (must be masked)
    const listRes = await fetch(`${base}/api/remnawave/panels`);
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    const found = list.find((p: any) => p.id === createdId);
    assert.ok(found);
    assert.equal(found.adminPass, "••••••••");

    // 3. Update panel
    const updateRes = await fetch(`${base}/api/remnawave/panels/${createdId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Berlin Node Updated",
        panelUrl: "https://remnawave-berlin.corp:3000/path",
        adminUser: "berlin_admin",
        adminPass: "" // Keep existing
      })
    });
    assert.equal(updateRes.status, 200);

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

  // 2. Panel selector in Add from Remnawave modal
  assert.ok(html.includes('id="addRemnawavePanelSelect"'), "dashboardView must contain a panel selector in the Remnawave user modal");

  // 3. Rotation widget
  assert.ok(html.includes('id="widgetRotationStatus"') || html.includes('id="rotHistoryList"'), "dashboardView must render rotation status or history list");
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
    isActive: true,
  });

  try {
    // When executeRotation runs without customConfig.panelUrl,
    // it must look up panel via px.panelId and attempt rotation against http://127.0.0.1:59999
    // (failing loudly with connection error rather than silently doing standalone local rotation)
    await assert.rejects(
      () => executeRotation({}),
      /Remnawave rotation failed/i,
      "executeRotation must attempt connection to resolved panel instead of standalone rotation"
    );
  } finally {
    deleteRemnawavePanel(panel.id);
    deleteProxy(px.id);
  }
});

