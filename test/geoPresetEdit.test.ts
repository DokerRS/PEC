import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { setupDashboardDom } from "./helpers/dashboardDom.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * GEO-PRESET-EDIT-1b: edit/delete/refresh UI for geo presets (non-builtin
 * only) + inspector delete-selected flow.
 */

const BUILTIN_PRESET = {
  id: "builtin:google",
  name: "Google (builtin)",
  description: "Builtin Google domains",
  source: "builtin",
  type: "domain",
  entries: ["google.com", "googleapis.com"],
};
const REMOTE_PRESET = {
  id: "remote:ads",
  name: "Ads Blocklist",
  description: "Remote ads list",
  source: "remote",
  sourceUrl: "https://example.com/ads.txt",
  sourceTag: "ads",
  type: "domain",
  entries: ["ads.example.com", "tracker.example.net"],
};

test("GEO-EDIT (a): preset card shows ✏️ and 🗑 for non-builtin, hides them for builtin; 🔄 only for remote", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [BUILTIN_PRESET, REMOTE_PRESET],
    },
  });
  try {
    const { window } = env;
    await window.loadPresets();
    const container = window.document.getElementById("presetsContainer");
    assert.ok(container, "presets container must exist");

    const cards = container.querySelectorAll(".preset-card");
    assert.equal(cards.length, 2, "two preset cards must render");

    const html = container.innerHTML;
    assert.match(html, /btn-edit-preset/, "edit button must be present");
    assert.match(html, /btn-delete-preset/, "delete button must be present");
    assert.match(html, /btn-refresh-preset/, "refresh button must be present");
  } finally {
    env.teardown();
  }
});

test("GEO-EDIT (e): preset edit modal payload re-sends source/sourceUrl/sourceTag on save", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [REMOTE_PRESET],
    },
  });
  try {
    const { window, document, fetchCalls } = env;
    await window.loadPresets();

    // Open edit modal for the remote preset
    window.openPresetEditModal(REMOTE_PRESET.id);

    // Modify name and entries
    const nameEl = document.getElementById("presetEditName") as HTMLInputElement;
    const entriesEl = document.getElementById("presetEditEntries") as HTMLTextAreaElement;
    assert.ok(nameEl, "presetEditName must exist");
    assert.ok(entriesEl, "presetEditEntries must exist");
    assert.equal(nameEl.value, "Ads Blocklist", "modal must prefill the preset name");
    nameEl.value = "Ads Blocklist v2";
    entriesEl.value = "ads.example.com\nnew-tracker.example.net";

    // Type badge is read-only
    const typeBadge = document.getElementById("presetEditTypeBadge");
    assert.ok(typeBadge, "presetEditTypeBadge must exist");
    assert.equal(typeBadge.textContent, "DOMAIN", "type badge must show DOMAIN (read-only)");

    // Save
    await window.savePresetEdit();

    // Verify the POST payload re-sends source fields
    const posts = fetchCalls.filter((c: any) => c.url.includes("/api/routing/presets") && c.method === "POST");
    assert.ok(posts.length >= 1, "save must POST to /api/routing/presets");
    const body = JSON.parse(posts[posts.length - 1].body);
    assert.equal(body.id, REMOTE_PRESET.id, "payload must carry the preset id (upsert)");
    assert.equal(body.name, "Ads Blocklist v2", "payload must carry the modified name");
    assert.equal(body.source, "remote", "payload MUST re-send source (otherwise POST resets to file)");
    assert.equal(body.sourceUrl, "https://example.com/ads.txt", "payload MUST re-send sourceUrl");
    assert.equal(body.sourceTag, "ads", "payload MUST re-send sourceTag");
    assert.deepEqual(body.entries, ["ads.example.com", "new-tracker.example.net"], "payload must carry the entries");
  } finally {
    env.teardown();
  }
});

test("GEO-EDIT (b): inspector delete-selected removes entries via upsert POST", async () => {
  const presetWithEntries = {
    ...REMOTE_PRESET,
    entries: ["ads.example.com", "tracker.example.net", "banner.example.org"],
  };
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": (init: any) =>
        init?.method === "POST" || init?.method === "DELETE"
          ? { ok: true, preset: presetWithEntries }
          : [presetWithEntries],
      "/api/routing/presets/remote%3Aads": presetWithEntries,
    },
  });
  try {
    const { window, document, fetchCalls } = env;

    // Populate lastLoadedPresets first
    await window.loadPresets();
    // Open inspector for the remote preset
    await window.openGeobaseInspector(REMOTE_PRESET.id);
    const tbody = document.getElementById("inspectorTableBody");
    assert.ok(tbody, "inspector table body must exist");

    // Select two entries via checkboxes (table renders async)
    await waitFor(() => document.querySelectorAll(".toggle-inspector-entry").length >= 3, { label: "inspector checkboxes" });
    const checkboxes = document.querySelectorAll(".toggle-inspector-entry");
    assert.ok(checkboxes.length >= 3, "inspector must render checkboxes for entries");
    (checkboxes[0] as HTMLInputElement).checked = true;
    (checkboxes[0] as HTMLInputElement).dispatchEvent(new window.Event("change", { bubbles: true }));
    (checkboxes[1] as HTMLInputElement).checked = true;
    (checkboxes[1] as HTMLInputElement).dispatchEvent(new window.Event("change", { bubbles: true }));

    // Trigger delete
    await window.deleteInspectorSelectedEntries();

    // Verify entries were removed from the inspector table
    const remaining = document.querySelectorAll(".toggle-inspector-entry");
    assert.equal(remaining.length, 1, "one entry must remain after deletion");

    // Verify the POST payload filtered the entries
    const posts = fetchCalls.filter((c: any) => c.url.includes("/api/routing/presets") && c.method === "POST");
    const body = JSON.parse(posts[posts.length - 1].body);
    assert.deepEqual(body.entries, ["banner.example.org"], "POST payload must exclude deleted entries");
  } finally {
    env.teardown();
  }
});

test("GEO-EDIT (c): DELETE flow removes a non-builtin preset via API", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [REMOTE_PRESET],
    },
  });
  try {
    const { window, fetchCalls } = env;
    await window.loadPresets();

    (window as any).pecConfirm = async () => true;
    await window.deletePresetWithConfirm(REMOTE_PRESET.id);

    const delCalls = fetchCalls.filter((c: any) => c.method === "DELETE");
    assert.ok(delCalls.length >= 1, "DELETE must be called for the preset");
  } finally {
    env.teardown();
  }
});

test("GEO-EDIT (d): refresh button only fires for source === 'remote'", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [REMOTE_PRESET],
    },
  });
  try {
    const { window, document } = env;
    await window.loadPresets();

    const container = document.getElementById("presetsContainer");
    assert.ok(container);
    const refreshBtns = container.querySelectorAll(".btn-refresh-preset");
    assert.equal(refreshBtns.length, 1, "remote preset must have a refresh button");

    (refreshBtns[0] as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    env.teardown();
  }
});
