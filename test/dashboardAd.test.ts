import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { setupDashboardDom } from "./helpers/dashboardDom.js";
import { waitFor } from "./helpers/waitFor.js";

const DEFAULT_MOCK_RESPONSES = {
  "/api/ad/status": {
    enabled: true,
    ldapUrl: "ldaps://dc.corp.local:636",
    bindDn: "CN=pec-service,OU=ServiceAccounts,DC=corp,DC=local",
    searchBase: "DC=corp,DC=local",
    requiredGroupDn: "CN=ProxyFleetUsers,OU=Groups,DC=corp,DC=local",
    syncIntervalSec: 300,
    rejectUnknownUsers: false,
    tlsRejectUnauthorized: true,
    lastSyncAt: "2026-11-13T10:00:00.000Z",
    usersCount: 42,
    hasPassword: true,
  },
  "/api/ad/config": { ok: true },
  "/api/ad/test": { ok: true, message: "Connected successfully to DC" },
  "/api/ad/sync-now": { ok: true, usersCount: 42, syncedAt: "2026-11-13T10:00:00.000Z" },
  "/api/proxies": [
    {
      id: "proxy-corp-1",
      name: "Corporate Primary",
      host: "10.0.0.1",
      port: 10808,
      protocol: "socks5",
      isActive: true,
    },
  ],
  "/api/routing/profiles": [
    { id: "prof-default", name: "Default PAC", defaultPolicy: "direct" },
  ],
  "/api/instances": {
    online: 2,
    instances: [
      {
        instanceId: "inst-ad-user-01",
        username: "alice",
        domainUser: "CORP\\alice",
        ip: "10.0.1.50",
        version: "1.1.0",
        group: "HQ Users",
        appliedProfileName: "Default PAC",
        syncCount: 25,
        status: "ONLINE",
        tokenHash: "token-hash-alice",
        assignedProxyId: "proxy-corp-1",
      },
      {
        instanceId: "inst-legacy-02",
        username: "bob",
        domainUser: "",
        ip: "10.0.1.51",
        version: "1.0.0",
        group: "Branch",
        appliedProfileName: "Default PAC",
        syncCount: 8,
        status: "ONLINE",
        tokenHash: "token-hash-bob",
        assignedProxyId: "proxy-corp-1",
      },
    ],
  },
};

test("dashboardAd: initializes DOM with public/dashboard.min.js and exposes AD and fleet functions", () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: DEFAULT_MOCK_RESPONSES,
  });

  try {
    const { window, document } = env;

    // Verify script evaluation and global exposure
    assert.equal(typeof window.loadAdStatus, "function", "loadAdStatus must be exposed on window");
    assert.equal(typeof window.toggleAdFieldsState, "function", "toggleAdFieldsState must be exposed on window");
    assert.equal(typeof window.saveAdConfigAction, "function", "saveAdConfigAction must be exposed on window");
    assert.equal(typeof window.testAdConnectionAction, "function", "testAdConnectionAction must be exposed on window");
    assert.equal(typeof window.syncAdNowAction, "function", "syncAdNowAction must be exposed on window");
    assert.equal(typeof window.filterFleetTable, "function", "filterFleetTable must be exposed on window");
    assert.equal(typeof window.loadInstances, "function", "loadInstances must be exposed on window");

    // Verify key DOM elements exist
    assert.ok(document.getElementById("adConfigForm"), "#adConfigForm must exist in DOM");
    assert.ok(document.getElementById("badgeAdStatus"), "#badgeAdStatus must exist in DOM");
    assert.ok(document.getElementById("fleetTableBody"), "#fleetTableBody must exist in DOM");
    assert.ok(document.getElementById("fleetSearchInput"), "#fleetSearchInput must exist in DOM");
  } finally {
    env.teardown();
  }
});

test("dashboardAd: renders Active Directory settings form in GPO tab with populated values and badge", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: DEFAULT_MOCK_RESPONSES,
  });

  try {
    const { window, document } = env;

    // Load AD status into form
    await window.loadAdStatus();

    const enabledInput = document.getElementById("adEnabled") as HTMLInputElement;
    const urlInput = document.getElementById("adUrl") as HTMLInputElement;
    const bindDnInput = document.getElementById("adBindDn") as HTMLInputElement;
    const passwordInput = document.getElementById("adPassword") as HTMLInputElement;
    const baseDnInput = document.getElementById("adBaseDn") as HTMLInputElement;
    const groupDnInput = document.getElementById("adGroupDn") as HTMLInputElement;
    const intervalInput = document.getElementById("adInterval") as HTMLInputElement;
    const migrationSelect = document.getElementById("adMigrationMode") as HTMLSelectElement;
    const tlsRejectInput = document.getElementById("adTlsReject") as HTMLInputElement;
    const badgeStatus = document.getElementById("badgeAdStatus") as HTMLElement;
    const usersCountEl = document.getElementById("lblAdUsersCount") as HTMLElement;
    const lastSyncEl = document.getElementById("lblAdLastSync") as HTMLElement;

    assert.equal(enabledInput.checked, true, "#adEnabled should be checked");
    assert.equal(urlInput.value, "ldaps://dc.corp.local:636", "#adUrl should match mock");
    assert.equal(bindDnInput.value, "CN=pec-service,OU=ServiceAccounts,DC=corp,DC=local", "#adBindDn should match mock");
    assert.equal(baseDnInput.value, "DC=corp,DC=local", "#adBaseDn should match mock");
    assert.equal(groupDnInput.value, "CN=ProxyFleetUsers,OU=Groups,DC=corp,DC=local", "#adGroupDn should match mock");
    assert.equal(intervalInput.value, "300", "#adInterval should match mock sync interval");
    assert.equal(migrationSelect.value, "soft", "#adMigrationMode should reflect rejectUnknownUsers=false as soft");
    assert.equal(tlsRejectInput.checked, true, "#adTlsReject should be checked");

    // Status badge & telemetry counters
    assert.ok(
      badgeStatus.classList.contains("badge-online"),
      "Active status must use .badge-online CSS class"
    );
    assert.equal(usersCountEl.textContent?.trim(), "42", "Users in cache count should display 42");
    assert.notEqual(lastSyncEl.textContent?.trim(), "—", "Last sync date should be formatted and not default dash");

    // Password field should indicate saved password
    assert.ok(
      passwordInput.placeholder.includes("••••••••"),
      "Password placeholder must indicate stored credentials without exposing clear text"
    );
  } finally {
    env.teardown();
  }
});

test("dashboardAd: handles form interactivity and API actions (toggle, save, test, sync-now)", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: DEFAULT_MOCK_RESPONSES,
  });

  try {
    const { window, document, fetchCalls } = env;

    await window.loadAdStatus();

    // 1. Toggle container opacity
    const enabledInput = document.getElementById("adEnabled") as HTMLInputElement;
    const container = document.getElementById("adFieldsContainer") as HTMLElement;

    enabledInput.checked = false;
    window.toggleAdFieldsState();
    assert.equal(container.style.opacity, "0.6", "Disabled AD container must have opacity 0.6");

    enabledInput.checked = true;
    window.toggleAdFieldsState();
    assert.equal(container.style.opacity, "1", "Enabled AD container must have opacity 1");

    // 2. Test Connection Action
    await window.testAdConnectionAction();
    const testCall = fetchCalls.find((c) => c.url === "/api/ad/test");
    assert.ok(testCall, "testAdConnectionAction must trigger POST /api/ad/test");
    assert.equal(testCall?.method, "POST");
    const testPayload = JSON.parse(testCall?.body);
    assert.equal(testPayload.ldapUrl, "ldaps://dc.corp.local:636");
    assert.equal(testPayload.tlsRejectUnauthorized, true);

    // 3. Save Config Action
    await window.saveAdConfigAction();
    const saveCall = fetchCalls.find((c) => c.url === "/api/ad/config");
    assert.ok(saveCall, "saveAdConfigAction must trigger POST /api/ad/config");
    assert.equal(saveCall?.method, "POST");
    const savePayload = JSON.parse(saveCall?.body);
    assert.equal(savePayload.enabled, true);
    assert.equal(savePayload.rejectUnknownUsers, false);
    assert.equal(savePayload.syncIntervalSec, 300);

    // 4. Sync Now Action
    await window.syncAdNowAction();
    const syncCall = fetchCalls.find((c) => c.url === "/api/ad/sync-now");
    assert.ok(syncCall, "syncAdNowAction must trigger POST /api/ad/sync-now");
    assert.equal(syncCall?.method, "POST");
  } finally {
    env.teardown();
  }
});

test("dashboardAd: renders fleet table with domainUser badge for modern instances and legacy badge for older versions", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: DEFAULT_MOCK_RESPONSES,
  });

  try {
    const { window, document } = env;

    // Stop background timers to prevent race conditions in test environment
    if (typeof window.stopDashboardTimers === "function") {
      window.stopDashboardTimers();
    }
    // AUDIT-QA-P3: stopDashboardTimers() clears intervals synchronously —
    // no settle sleep needed.

    // Load fleet instances into DOM
    await window.loadInstances();
    // AUDIT-QA-P3: wait for the data rows (not the loading placeholder) to render.
    await waitFor(() => (document.getElementById("fleetTableBody")?.innerHTML || "").includes("inst-ad-user-01"), {
      label: "loadInstances to render fleet data rows",
    });

    const tbody = document.getElementById("fleetTableBody");
    assert.ok(tbody, "fleetTableBody must exist in DOM");

    const html = tbody.innerHTML;

    // Verify both instance IDs are present
    assert.ok(html.includes("inst-ad-user-01"), "inst-ad-user-01 row must be rendered");
    assert.ok(html.includes("inst-legacy-02"), "inst-legacy-02 row must be rendered");

    // Verify domain user badge with domain\username for inst-ad-user-01
    assert.ok(
      html.includes("badge-ad-user"),
      "Fleet table must render .badge-ad-user for instances with domainUser"
    );
    assert.ok(
      html.includes("CORP\\alice"),
      "Fleet table must display the exact DOMAIN\\user string"
    );

    // Verify legacy badge for inst-legacy-02
    assert.ok(
      html.includes("Legacy (без AD)"),
      "Fleet table must render 'Legacy (без AD)' badge for instances without domainUser"
    );
    assert.ok(
      html.includes("badge-warning"),
      "Legacy badge must use .badge-warning class"
    );
  } finally {
    env.teardown();
  }
});

test("dashboardAd: filters fleet table by domain user in search input", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: DEFAULT_MOCK_RESPONSES,
  });

  try {
    const { window, document } = env;

    // Stop background timers to prevent race conditions in test environment
    if (typeof window.stopDashboardTimers === "function") {
      window.stopDashboardTimers();
    }
    // AUDIT-QA-P3: stopDashboardTimers() clears intervals synchronously —
    // no settle sleep needed.

    await window.loadInstances();
    // AUDIT-QA-P3: wait for the data rows (not the loading placeholder) to render.
    await waitFor(() => (document.getElementById("fleetTableBody")?.innerHTML || "").includes("inst-ad-user-01"), {
      label: "loadInstances to render fleet data rows",
    });

    const searchInput = document.getElementById("fleetSearchInput") as HTMLInputElement;
    const tbody = document.getElementById("fleetTableBody") as HTMLElement;

    assert.ok(searchInput, "fleetSearchInput must exist");
    assert.ok(tbody, "fleetTableBody must exist");

    // 1. Search by domain username: "alice"
    searchInput.value = "alice";
    window.filterFleetTable();

    assert.ok(tbody.innerHTML.includes("inst-ad-user-01"), "Search for 'alice' must match inst-ad-user-01");
    assert.equal(
      tbody.innerHTML.includes("inst-legacy-02"),
      false,
      "Search for 'alice' must filter out inst-legacy-02"
    );

    // 2. Search by domain name prefix: "corp\\"
    searchInput.value = "corp\\";
    window.filterFleetTable();

    assert.ok(
      tbody.innerHTML.includes("inst-ad-user-01"),
      "Search for 'corp\\' must match domainUser CORP\\alice"
    );
    assert.equal(
      tbody.innerHTML.includes("inst-legacy-02"),
      false,
      "Search for 'corp\\' must filter out inst-legacy-02"
    );

    // 3. Search for legacy instance username: "bob"
    searchInput.value = "bob";
    window.filterFleetTable();

    assert.ok(tbody.innerHTML.includes("inst-legacy-02"), "Search for 'bob' must match inst-legacy-02");
    assert.equal(
      tbody.innerHTML.includes("inst-ad-user-01"),
      false,
      "Search for 'bob' must filter out inst-ad-user-01"
    );

    // 4. Search for non-existent domain user
    searchInput.value = "NONEXISTENT\\nobody";
    window.filterFleetTable();

    assert.equal(
      tbody.innerHTML.includes("inst-ad-user-01"),
      false,
      "Non-existent search must not match inst-ad-user-01"
    );
    assert.equal(
      tbody.innerHTML.includes("inst-legacy-02"),
      false,
      "Non-existent search must not match inst-legacy-02"
    );

    // 5. Reset search filter
    searchInput.value = "";
    window.filterFleetTable();

    assert.ok(tbody.innerHTML.includes("inst-ad-user-01"), "Reset filter must restore inst-ad-user-01");
    assert.ok(tbody.innerHTML.includes("inst-legacy-02"), "Reset filter must restore inst-legacy-02");
  } finally {
    env.teardown();
  }
});
