import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { setupDashboardDom } from "./helpers/dashboardDom.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * GEO-PRESET-UX-2 CARD-MENU: per-card «⋮» dropdown replacing the inline
 * ✏️/🗑/🔄 buttons.
 *
 * CLICK-PATH + POPOVER-CLOSE discipline: every interaction dispatches real
 * events (click / keydown) on the actual buttons; open/outside/Escape/switch
 * dismiss paths are covered behaviorally (observations @ 2026-11-17 checklist
 * — static bundle greps do not prove listener liveness).
 */

const BUILTIN_PRESET = {
  id: "builtin:ai",
  name: "AI & LLM Services (builtin)",
  description: "Builtin AI domains",
  source: "builtin",
  type: "domain",
  entries: ["openai.com", "chatgpt.com"],
  sources: [{ kind: "geo-tag", ref: "builtin:ai", entries: ["openai.com", "chatgpt.com"] }],
};

const REMOTE_PRESET = {
  id: "remote:ads",
  name: "Ads Blocklist",
  description: "Remote ads list",
  source: "remote",
  sourceUrl: "https://example.com/ads.txt",
  type: "domain",
  entries: ["ads.example.com"],
  sources: [{ kind: "url", url: "https://example.com/ads.txt", entries: ["ads.example.com"] }],
};

const FILE_PRESET = {
  id: "file:local",
  name: "Local File List",
  description: "Imported from file",
  source: "file",
  type: "domain",
  entries: ["file-entry.example"],
  sources: [{ kind: "file", name: "local.txt", entries: ["file-entry.example"] }],
};

function click(win: any, el: Element): void {
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
}

function menuOfCard(document: Document, id: string): HTMLElement | null {
  const btn = document.querySelector(`.btn-preset-menu[data-id="${id}"]`);
  if (!btn) return null;
  const card = btn.closest(".preset-card");
  return card ? (card.querySelector(".preset-card-menu") as HTMLElement | null) : null;
}

/**
 * Open a card's menu and return the FRESHLY queried menu element.
 * DOM references must never be held across actions: any async chain that
 * ends in loadPresets() (refresh/delete/duplicate/save) re-renders the
 * container, so a previously captured menu node goes detached.
 */
function openCardMenu(win: any, document: Document, id: string): HTMLElement {
  const btn = document.querySelector(`.btn-preset-menu[data-id="${id}"]`);
  assert.ok(btn, `⋮ button for ${id} must be attached`);
  click(win, btn);
  const card = btn!.closest(".preset-card");
  const menu = card ? (card.querySelector(".preset-card-menu") as HTMLElement | null) : null;
  assert.ok(menu && menu.style.display === "flex", `menu for ${id} must open`);
  return menu!;
}

function menuCardItem(document: Document, id: string, cls: string): HTMLElement {
  const item = document.querySelector(`.${cls}[data-id="${id}"]`) as HTMLElement | null;
  assert.ok(item && item.isConnected, `.${cls} for ${id} must be attached`);
  return item!;
}

async function loadCards(win: any, document: Document): Promise<void> {
  await win.loadPresets();
  assert.equal(document.querySelectorAll(".preset-card").length >= 1, true, "preset cards must render");
}

test("CARD-MENU (a): ⋮ click opens the menu; clicking outside closes it; menu stays inside its card (absolute)", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [BUILTIN_PRESET, REMOTE_PRESET, FILE_PRESET],
    },
  });
  try {
    const { window, document } = env;
    await loadCards(window, document);

    // no inline action buttons on cards anymore; every card has exactly one ⋮
    const html = document.getElementById("presetsContainer")!.innerHTML;
    assert.ok(!html.includes("btn-preset-open"), "inline ✏️ must be gone");
    assert.ok(!html.includes("btn-delete-preset"), "inline 🗑 must be gone");
    assert.ok(!html.includes("btn-refresh-preset"), "inline 🔄 must be gone");
    assert.ok(!html.includes("btn-inspect-geobase"), "🔍 must stay removed");
    assert.equal(document.querySelectorAll(".btn-preset-menu").length, 3, "one ⋮ per card");
    // quick-add row + badge untouched
    assert.ok(html.includes("btn-add-preset-rule"), "quick-add row must stay");

    const menu = menuOfCard(document, REMOTE_PRESET.id)!;
    assert.ok(menu, "card must embed a menu");
    assert.equal(menu.style.display, "none", "menu starts closed");
    // absolute positioning inside the card, above other cards
    assert.equal(menu.style.position, "absolute");
    assert.ok(parseInt(menu.style.zIndex, 10) >= 100, "menu z-index must exceed the card grid");

    const menuBtn = document.querySelector(`.btn-preset-menu[data-id="${REMOTE_PRESET.id}"]`)!;
    assert.equal(menuBtn.getAttribute("aria-haspopup"), "menu");
    click(window, menuBtn);
    assert.equal(menu.style.display, "flex", "⋮ click must open the menu");
    assert.equal(
      document.querySelector(`.btn-preset-menu[data-id="${REMOTE_PRESET.id}"]`)!.getAttribute("aria-expanded"),
      "true"
    );

    // outside click closes it
    click(window, document.body);
    assert.equal(menu.style.display, "none", "outside click must close the menu");
    assert.equal(
      document.querySelector(`.btn-preset-menu[data-id="${REMOTE_PRESET.id}"]`)!.getAttribute("aria-expanded"),
      "false"
    );

    // ⋮ toggles its own menu closed as well
    click(window, menuBtn);
    assert.equal(menu.style.display, "flex");
    click(window, menuBtn);
    assert.equal(menu.style.display, "none", "second ⋮ click toggles the menu closed");
  } finally {
    env.teardown();
  }
});

test("CARD-MENU (b): Escape closes the open menu", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [REMOTE_PRESET],
    },
  });
  try {
    const { window, document } = env;
    await loadCards(window, document);

    const menu = menuOfCard(document, REMOTE_PRESET.id)!;
    click(window, document.querySelector(`.btn-preset-menu[data-id="${REMOTE_PRESET.id}"]`)!);
    assert.equal(menu.style.display, "flex");

    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(menu.style.display, "none", "Escape must close the menu");
  } finally {
    env.teardown();
  }
});

test("CARD-MENU (c): opening a second ⋮ closes the first menu (single-open invariant)", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [BUILTIN_PRESET, REMOTE_PRESET],
    },
  });
  try {
    const { window, document } = env;
    await loadCards(window, document);

    const menuA = menuOfCard(document, BUILTIN_PRESET.id)!;
    const menuB = menuOfCard(document, REMOTE_PRESET.id)!;

    click(window, document.querySelector(`.btn-preset-menu[data-id="${BUILTIN_PRESET.id}"]`)!);
    assert.equal(menuA.style.display, "flex");

    click(window, document.querySelector(`.btn-preset-menu[data-id="${REMOTE_PRESET.id}"]`)!);
    assert.equal(menuA.style.display, "none", "first menu must close");
    assert.equal(menuB.style.display, "flex", "second menu must open");
  } finally {
    env.teardown();
  }
});

test("CARD-MENU (d): custom/remote menu = Edit · Refresh · Export · Delete(red); non-remote has no Refresh; items fire their actions and close the menu", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": (init: any) =>
        init?.method === "POST" && (init?.body || "").includes('"id":"remote:ads"')
          ? { ok: true, preset: REMOTE_PRESET }
          : [BUILTIN_PRESET, REMOTE_PRESET, FILE_PRESET],
      "/api/routing/presets/remote%3Aads": REMOTE_PRESET,
      "/api/routing/presets/remote%3Aads/export": {
        format: "pec-preset",
        version: 1,
        preset: { id: REMOTE_PRESET.id, name: REMOTE_PRESET.name, sources: REMOTE_PRESET.sources },
      },
      "/api/routing/presets/remote%3Aads/refresh": { ok: true, preset: REMOTE_PRESET },
    },
  });
  try {
    const { window, document, fetchCalls } = env;
    (window as any).pecConfirm = async () => true;
    await loadCards(window, document);

    // non-remote (file) preset has no Refresh
    const fileMenu = openCardMenu(window, document, FILE_PRESET.id);
    assert.ok(fileMenu.querySelector(".pm-edit"), "file preset menu has Edit");
    assert.ok(!fileMenu.querySelector(".pm-refresh"), "non-remote menu must NOT have Refresh");
    assert.ok(fileMenu.querySelector(".pm-export"));
    assert.ok(fileMenu.querySelector(".pm-delete"));
    assert.ok(!fileMenu.querySelector(".pm-duplicate"), "custom preset menu has no Duplicate");
    click(window, document.body);

    // remote menu matrix
    const remoteMenu = openCardMenu(window, document, REMOTE_PRESET.id);
    const delBtn = remoteMenu.querySelector(".pm-delete") as HTMLElement;
    assert.ok(delBtn, "remote menu has Delete");
    assert.match(delBtn.getAttribute("style") || "", /danger|#ef4444/, "Delete must be red");
    assert.ok(remoteMenu.querySelector(".pm-refresh"), "remote menu has Refresh");
    assert.ok(remoteMenu.querySelector(".pm-edit"));
    assert.ok(remoteMenu.querySelector(".pm-export"));

    // Refresh item -> POST /refresh AND closes the menu
    click(window, menuCardItem(document, REMOTE_PRESET.id, "pm-refresh"));
    await waitFor(() => fetchCalls.some((c: any) => c.method === "POST" && c.url.includes("/refresh")), {
      label: "refresh POST",
    });
    assert.equal(menuOfCard(document, REMOTE_PRESET.id)!.style.display, "none", "menu must close after selecting an item");

    // Export item -> GET /export (refresh re-rendered the cards: re-query)
    openCardMenu(window, document, REMOTE_PRESET.id);
    click(window, menuCardItem(document, REMOTE_PRESET.id, "pm-export"));
    await waitFor(() => fetchCalls.some((c: any) => c.url.includes("/export")), { label: "export GET" });
    assert.equal(menuOfCard(document, REMOTE_PRESET.id)!.style.display, "none");

    // Delete item -> confirm + DELETE
    openCardMenu(window, document, REMOTE_PRESET.id);
    click(window, menuCardItem(document, REMOTE_PRESET.id, "pm-delete"));
    await waitFor(() => fetchCalls.some((c: any) => c.method === "DELETE"), { label: "delete DELETE" });
    assert.equal(menuOfCard(document, REMOTE_PRESET.id)!.style.display, "none");
    const delCall = fetchCalls.find((c: any) => c.method === "DELETE");
    assert.equal(delCall.url, "/api/routing/presets/remote%3Aads");

    // Edit item -> constructor sub-page opens
    openCardMenu(window, document, REMOTE_PRESET.id);
    click(window, menuCardItem(document, REMOTE_PRESET.id, "pm-edit"));
    await waitFor(() => document.getElementById("presetBuilderPage")?.style.display === "block", {
      label: "constructor opened via menu",
      timeoutMs: 6000,
    });
    assert.equal((document.getElementById("builderNameInput") as HTMLInputElement).value, REMOTE_PRESET.name);
    window.closePresetBuilder();
  } finally {
    env.teardown();
  }
});

test("CARD-MENU (e): builtin menu = View layers · Duplicate only; no Edit/Delete/Refresh; items work", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [BUILTIN_PRESET, REMOTE_PRESET],
      "/api/routing/presets/builtin%3Aai": BUILTIN_PRESET,
      "/api/routing/presets/import-preset": {
        ok: true,
        preset: { id: "preset:copy-1", name: "AI copy", sources: BUILTIN_PRESET.sources, entries: BUILTIN_PRESET.entries, entriesCount: 2 },
      },
    },
  });
  try {
    const { window, document, fetchCalls } = env;
    await loadCards(window, document);

    const builtinMenu = openCardMenu(window, document, BUILTIN_PRESET.id);
    assert.ok(builtinMenu.querySelector(".pm-view"), "builtin menu has View layers");
    assert.ok(builtinMenu.querySelector(".pm-duplicate"), "builtin menu has Duplicate");
    assert.ok(!builtinMenu.querySelector(".pm-edit"), "builtin menu must NOT have Edit");
    assert.ok(!builtinMenu.querySelector(".pm-delete"), "builtin menu must NOT have Delete");
    assert.ok(!builtinMenu.querySelector(".pm-refresh"), "builtin menu must NOT have Refresh");
    assert.ok(!builtinMenu.querySelector(".pm-export"), "builtin menu has no Export (read-only sharing out of scope)");

    // View layers -> read-only constructor
    click(window, menuCardItem(document, BUILTIN_PRESET.id, "pm-view"));
    await waitFor(() => document.getElementById("presetBuilderPage")?.style.display === "block", {
      label: "read-only constructor via menu",
    });
    assert.equal((document.getElementById("builderNameInput") as HTMLInputElement).readOnly, true);
    assert.equal(menuOfCard(document, BUILTIN_PRESET.id)!.style.display, "none", "menu closed after item selection");
    window.closePresetBuilder();

    // Duplicate -> POST import-preset with copied sources (fresh query: the
    // constructor open/close cycle must not leave stale menu references)
    openCardMenu(window, document, BUILTIN_PRESET.id);
    click(window, menuCardItem(document, BUILTIN_PRESET.id, "pm-duplicate"));
    await waitFor(() => fetchCalls.some((c: any) => c.url.includes("/api/routing/presets/import-preset")), {
      label: "duplicate POST",
      timeoutMs: 6000,
    });
    const dupCall = fetchCalls.find((c: any) => c.url.includes("/api/routing/presets/import-preset"));
    assert.equal(dupCall.method, "POST");
    assert.match(JSON.parse(dupCall.body).preset.name, /копия|copy/);
    assert.equal(menuOfCard(document, BUILTIN_PRESET.id)!.style.display, "none");
  } finally {
    env.teardown();
  }
});
