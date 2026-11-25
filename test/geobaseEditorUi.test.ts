import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { setupDashboardDom } from "./helpers/dashboardDom.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * GEO-BUILDER-UX-4: full-screen geobase editor (click-path).
 * ✎ on a file layer -> full-screen editor: manifest checkboxes, [▾] paged
 * previews, domain search with in-place list checkboxes, live dedup footer,
 * «Сменить файл» (selection reset + warning), snapshot rebind, save rebuilds
 * the layer in the constructor.
 */

const FILE_ID = "a".repeat(64);
const FILE_ID_2 = "b".repeat(64);

const TAG_TABLE: Record<string, string[]> = {
  VPN: ["t.me", "telegram.com", "vpn-gw.example", "shared.example"],
  TELEGRAM: ["t.me", "telegram.org"],
  "CATEGORY-AI-CHAT": ["shared.example"],
};

function unionCount(tags: string[]): number {
  const set = new Set<string>();
  for (const t of tags) for (const e of TAG_TABLE[t] || []) set.add(e);
  return set.size;
}

function makeManifest(fileId: string) {
  if (fileId === FILE_ID_2) {
    return {
      fileId,
      fileName: "fresh.dat",
      type: "geosite",
      lists: [{ tag: "FRESH", count: 2 }],
      totalEntries: 2,
    };
  }
  return {
    fileId,
    fileName: "geosite (2).dat",
    type: "geosite",
    lists: [
      { tag: "VPN", count: 4 },
      { tag: "TELEGRAM", count: 2 },
      { tag: "CATEGORY-AI-CHAT", count: 1 },
    ],
    totalEntries: 7,
  };
}

function makeEntries(fileId: string, tag: string, offset: number, limit: number) {
  const all = fileId === FILE_ID_2 ? ["fresh-a.example", "fresh-b.example"] : TAG_TABLE[tag] || [];
  // the editor requests limit=200; this fixture caps pages at 2 to exercise pagination
  const items = all.slice(offset, offset + 2);
  return { fileId, tag, total: all.length, offset, limit: items.length, items };
}

const PRESET = {
  id: "ux4:geo",
  name: "Geo Layers",
  description: "",
  source: "file",
  type: "domain",
  entries: ["t.me", "telegram.org", "old-a.example"],
  sources: [
    { kind: "file", fileId: FILE_ID, fileName: "geosite (2).dat", tags: ["TELEGRAM"], entries: ["t.me", "telegram.org"] },
    { kind: "file", name: "old-import.dat", tag: "RU", entries: ["old-a.example"] },
  ],
};

function resolveLayerResponse(init: any) {
  const body = typeof init?.body === "string" ? JSON.parse(init.body || "{}") : init?.body || {};
  const src = body.source || {};
  if (src.kind === "file") {
    if (src.fileId && (src.content === undefined || src.content === null)) {
      const tags: string[] = Array.isArray(src.tags) ? src.tags : [];
      // the server dedupes the materialized union — mirror that in the mock
      const entries = Array.from(new Set(tags.flatMap((t: string) => TAG_TABLE[t] || [])));
      return { ok: true, source: { kind: "file", fileId: src.fileId, fileName: "geosite (2).dat", tags, entries } };
    }
    return {
      ok: true,
      source: { kind: "file", name: src.name, fileId: FILE_ID_2, fileName: src.name, tags: [], entries: ["fresh-a.example", "fresh-b.example"] },
    };
  }
  return { ok: true, source: src };
}

const CUSTOM_RESPONSES = {
  "/api/routing/presets": [PRESET],
  "/api/routing/presets/ux4%3Ageo": PRESET,
  "/api/routing/presets/resolve-layer": resolveLayerResponse,
  [`/api/routing/geofiles/${FILE_ID}/manifest`]: makeManifest(FILE_ID),
  [`/api/routing/geofiles/${FILE_ID_2}/manifest`]: makeManifest(FILE_ID_2),
  [`/api/routing/geofiles/${FILE_ID}/union-count`]: (init: any) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body || "{}") : init?.body || {};
    return { fileId: FILE_ID, tags: body.tags || [], count: unionCount(body.tags || []) };
  },
  [`/api/routing/geofiles/${FILE_ID_2}/union-count`]: (init: any) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body || "{}") : init?.body || {};
    return { fileId: FILE_ID_2, tags: body.tags || [], count: unionCount(body.tags || []) };
  },
  [`/api/routing/geofiles/${FILE_ID}/search`]: (init: any, rawInput: any) => {
    const q = String(rawInput || "").split("q=")[1] || "";
    const query = decodeURIComponent(q).toLowerCase();
    if (query.includes("t.me")) {
      return {
        fileId: FILE_ID,
        lists: [],
        domains: [{ domain: "t.me", lists: ["VPN", "TELEGRAM"] }],
        totalDomainMatches: 1,
      };
    }
    if ("vpn".includes(query) && query) {
      return { fileId: FILE_ID, lists: [{ tag: "VPN", count: 4 }], domains: [], totalDomainMatches: 0 };
    }
    return { fileId: FILE_ID, lists: [], domains: [], totalDomainMatches: 0 };
  },
  [`/api/routing/geofiles/${FILE_ID}/lists/VPN/entries`]: (init: any, rawInput: any) => {
    const url = String(rawInput || "");
    const offset = parseInt(url.split("offset=")[1]?.split("&")[0] || "0", 10);
    return makeEntries(FILE_ID, "VPN", offset, 200);
  },
  [`/api/routing/geofiles/${FILE_ID}/lists/TELEGRAM/entries`]: (init: any, rawInput: any) => {
    const url = String(rawInput || "");
    const offset = parseInt(url.split("offset=")[1]?.split("&")[0] || "0", 10);
    return makeEntries(FILE_ID, "TELEGRAM", offset, 200);
  },
};

function click(win: any, el: Element): void {
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function openBuilderAndEditor(win: any, document: Document, layerIndex = 0): Promise<void> {
  await win.loadPresets();
  click(win, document.querySelector(`.btn-preset-menu[data-id="ux4:geo"]`));
  click(win, document.querySelector(`.pm-edit[data-id="ux4:geo"]`));
  await waitFor(() => document.getElementById("presetBuilderPage")?.style.display === "block", { label: "builder open" });
  click(win, document.querySelector(`.btn-layer-edit[data-index="${layerIndex}"]`));
  await waitFor(() => document.getElementById("geoEditorPage")?.style.display === "block", { label: "geobase editor open" });
  // the manifest loads asynchronously — wait for the list rows (snapshot
  // rebind mode renders no rows until a file is attached)
  if (layerIndex === 0) {
    await waitFor(() => document.querySelectorAll(".geo-editor-list-row").length === 3, { label: "manifest rows" });
  }
}

test("UX-4 (a): ✎ on a file layer opens the FULL-SCREEN geobase editor with the manifest of all lists", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document, fetchCalls } = env;
    await openBuilderAndEditor(window, document);

    assert.equal(document.getElementById("presetBuilderPage")!.style.display, "none", "constructor page hides");
    assert.equal(document.getElementById("branchExtView")!.style.display, "none");
    assert.match(document.getElementById("geoEditorTitle")!.textContent || "", /Редактор геобазы: geosite \(2\)\.dat/);
    assert.equal(document.getElementById("geoEditorTypeBadge")!.textContent, "GEOSITE");
    assert.ok(fetchCalls.some((c: any) => c.url.includes(`/api/routing/geofiles/${FILE_ID}/manifest`)), "manifest fetched");

    // all lists rendered as checkbox rows with counts
    const rows = document.querySelectorAll(".geo-editor-list-row");
    assert.equal(rows.length, 3, "three manifest rows");
    const vpnRow = document.querySelector('.geo-editor-list-row[data-tag="VPN"]')!;
    assert.match(vpnRow.querySelector(".geo-list-count")!.textContent || "", /^4/);
    // the layer's existing tags arrive pre-selected
    const telegramCheck = document.querySelector('.geo-list-check[data-tag="TELEGRAM"]') as HTMLInputElement;
    assert.equal(telegramCheck.checked, true, "layer tags arrive pre-selected");
    const selectionLine = document.getElementById("geoEditorSelectionCount")!.textContent || "";
    assert.match(selectionLine, /Выбрано списков: 1 \/ 3/);

    // live dedup footer: TELEGRAM alone -> 2 domains
    await waitFor(() => /Доменов попадёт в слой: 2 \(дедуп\)/.test(document.getElementById("geoEditorFooter")!.textContent || ""), {
      label: "footer dedup count",
    });
  } finally {
    env.teardown();
  }
});

test("UX-4 (b): toggling list checkboxes updates the live dedup footer (union, not sum)", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document } = env;
    await openBuilderAndEditor(window, document);
    await waitFor(() => /: 2 \(дедуп\)/.test(document.getElementById("geoEditorFooter")!.textContent || ""), {
      label: "initial footer",
    });

    // add VPN: union(TELEGRAM, VPN) = t.me, telegram.org, telegram.com, vpn-gw.example, shared.example = 5
    const vpnCheck = document.querySelector('.geo-list-check[data-tag="VPN"]') as HTMLInputElement;
    vpnCheck.checked = true;
    vpnCheck.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => /Доменов попадёт в слой: 5 \(дедуп\)/.test(document.getElementById("geoEditorFooter")!.textContent || ""), {
      label: "footer union after VPN",
    });
    assert.match(document.getElementById("geoEditorSelectionCount")!.textContent || "", /Выбрано списков: 2 \/ 3/);

    // uncheck again -> back to 2
    vpnCheck.checked = false;
    vpnCheck.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => /: 2 \(дедуп\)/.test(document.getElementById("geoEditorFooter")!.textContent || ""), {
      label: "footer union after uncheck",
    });
  } finally {
    env.teardown();
  }
});

test("UX-4 (c): [▾] expands a paged domain preview with «Показать ещё»", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document, fetchCalls } = env;
    await openBuilderAndEditor(window, document);

    click(window, document.querySelector('.geo-list-expand[data-tag="VPN"]')!);
    await waitFor(() => document.querySelectorAll('.geo-editor-entries[data-tag="VPN"] .geo-editor-entry').length === 2, {
      label: "first page of domains",
    });
    assert.ok(
      fetchCalls.some((c: any) => c.url.includes(`/lists/VPN/entries`)),
      "entries endpoint fetched"
    );

    const moreBtn = document.querySelector('.geo-list-more[data-tag="VPN"]')!;
    assert.match(moreBtn.textContent || "", /Показать ещё \(2\/4\)/);
    click(window, moreBtn);
    await waitFor(() => document.querySelectorAll('.geo-editor-entries[data-tag="VPN"] .geo-editor-entry').length === 4, {
      label: "second page appended",
    });
    assert.ok(!document.querySelector('.geo-list-more[data-tag="VPN"]'), "show-more hides when the list is exhausted");
  } finally {
    env.teardown();
  }
});

test("UX-4 (d): domain search shows WHERE a domain lives with in-place list checkboxes", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document, fetchCalls } = env;
    await openBuilderAndEditor(window, document);

    const search = document.getElementById("geoEditorSearch") as HTMLInputElement;
    search.value = "t.me";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));

    await waitFor(() => !!document.querySelector(".geo-editor-domain-results"), { label: "domain results block" });
    assert.ok(fetchCalls.some((c: any) => c.url.includes("/search")), "search endpoint fetched");
    const block = document.querySelector(".geo-editor-domain-results")!;
    assert.ok((block.textContent || "").includes("t.me"), "matched domain rendered");

    // VPN unchecked, TELEGRAM checked (pre-selected from the layer)
    const vpnBox = block.querySelector('.geo-domain-check[data-tag="VPN"]') as HTMLInputElement;
    const telegramBox = block.querySelector('.geo-domain-check[data-tag="TELEGRAM"]') as HTMLInputElement;
    assert.equal(vpnBox.checked, false);
    assert.equal(telegramBox.checked, true);

    // tick VPN right from the search result
    vpnBox.checked = true;
    vpnBox.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => /: 5 \(дедуп\)/.test(document.getElementById("geoEditorFooter")!.textContent || ""), {
      label: "footer after in-place tick",
    });

    // the main list row reflects the new selection
    const vpnRowCheck = document.querySelector('.geo-list-check[data-tag="VPN"]') as HTMLInputElement;
    assert.equal(vpnRowCheck.checked, true, "main list checkbox synced");
  } finally {
    env.teardown();
  }
});

test("UX-4 (e): «Сохранить слой» rebuilds the layer and returns to the constructor with an updated composition", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document, fetchCalls } = env;
    await openBuilderAndEditor(window, document);

    // select VPN alongside TELEGRAM
    const vpnCheck = document.querySelector('.geo-list-check[data-tag="VPN"]') as HTMLInputElement;
    vpnCheck.checked = true;
    vpnCheck.dispatchEvent(new window.Event("change", { bubbles: true }));

    click(window, document.querySelector(".btn-geo-editor-save")!);
    await waitFor(() => document.getElementById("presetBuilderPage")!.style.display === "block", {
      label: "back to constructor",
    });
    assert.equal(document.getElementById("geoEditorPage")!.style.display, "none");

    const resolveCalls = fetchCalls.filter((c: any) => c.url.includes("/resolve-layer") && c.method === "POST");
    const saveBody = JSON.parse(resolveCalls[resolveCalls.length - 1].body);
    assert.equal(saveBody.source.kind, "file");
    assert.equal(saveBody.source.fileId, FILE_ID);
    assert.deepEqual(saveBody.source.tags.sort(), ["TELEGRAM", "VPN"], "layer saved with the selected tags");

    // composition rebuilt with the VPN entries
    await waitFor(() => document.getElementById("builderEntriesBody")!.textContent!.includes("vpn-gw.example"), {
      label: "composition rebuilt",
    });
    const layerCard = document.querySelector('.builder-layer-row[data-index="0"]')!;
    assert.ok((layerCard.querySelector(".builder-layer-count")!.textContent || "").includes("доменов: 5"), "layer card count updated");
  } finally {
    env.teardown();
  }
});

test("UX-4 (f): «Сменить файл» loads the new manifest, resets the selection and warns", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document, fetchCalls } = env;
    await openBuilderAndEditor(window, document);
    await waitFor(() => document.querySelectorAll(".geo-editor-list-row").length === 3, { label: "initial manifest" });

    const file = new window.File(["new-geodata"], "fresh.dat", { type: "octet-stream" });
    const input = document.getElementById("geoEditorFileInput") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));

    // manifest of the NEW file
    await waitFor(() => document.querySelectorAll(".geo-editor-list-row").length === 1, { label: "new manifest rendered" });
    assert.ok(
      fetchCalls.some((c: any) => c.url.includes(`/api/routing/geofiles/${FILE_ID_2}/manifest`)),
      "new file manifest fetched"
    );
    // selection reset + warning
    assert.equal(document.querySelectorAll(".geo-list-check:checked").length, 0, "selection must be reset");
    assert.equal(document.getElementById("geoEditorWarning")!.style.display, "block");
    assert.match(document.getElementById("geoEditorWarning")!.textContent || "", /выбор списков сброшен/);
    assert.match(document.getElementById("geoEditorTitle")!.textContent || "", /fresh\.dat/);
  } finally {
    env.teardown();
  }
});

test("UX-4 (g): snapshot layer opens the editor in rebind mode; attaching a file unlocks the full editor", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document, fetchCalls } = env;
    await openBuilderAndEditor(window, document, 1);

    // rebind mode: upload prompt instead of the list body
    assert.equal(document.getElementById("geoEditorRebindBlock")!.style.display, "block");
    assert.equal(document.getElementById("geoEditorBody")!.style.display, "none");

    const file = new window.File(["revived"], "revived.dat", { type: "octet-stream" });
    const input = document.getElementById("geoEditorRebindInput") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));

    // full editor unlocked with the new manifest
    await waitFor(() => document.getElementById("geoEditorBody")!.style.display === "block", {
      label: "full editor after rebind",
    });
    assert.equal(document.getElementById("geoEditorRebindBlock")!.style.display, "none");
    assert.equal(document.querySelectorAll(".geo-editor-list-row").length, 1, "new file manifest rendered");
    assert.ok(
      fetchCalls.some((c: any) => c.url.includes(`/api/routing/geofiles/${FILE_ID_2}/manifest`)),
      "manifest of the attached file fetched"
    );
  } finally {
    env.teardown();
  }
});

test("UX-4 (h): back/cancel returns to the constructor without changing the layer", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document, fetchCalls } = env;
    await openBuilderAndEditor(window, document);

    // toggle VPN but do not save
    const vpnCheck = document.querySelector('.geo-list-check[data-tag="VPN"]') as HTMLInputElement;
    vpnCheck.checked = true;
    vpnCheck.dispatchEvent(new window.Event("change", { bubbles: true }));

    click(window, document.querySelector(".btn-geo-editor-back")!);
    await waitFor(() => document.getElementById("presetBuilderPage")!.style.display === "block", { label: "back to constructor" });

    const resolveAfter = fetchCalls.filter((c: any) => c.url.includes("/resolve-layer") && c.method === "POST").length;
    assert.equal(resolveAfter, 0, "cancel must not persist anything");

    // reopening shows the ORIGINAL selection (TELEGRAM only)
    click(window, document.querySelector('.btn-layer-edit[data-index="0"]')!);
    await waitFor(() => {
      const page = document.getElementById("geoEditorPage");
      const vpnBox = page?.querySelector('.geo-list-check[data-tag="VPN"]') as HTMLInputElement | null;
      return page?.style.display === "block" && !!vpnBox;
    }, { label: "editor reopened with manifest" });
    const vpnCheck2 = document.querySelector('.geo-list-check[data-tag="VPN"]') as HTMLInputElement;
    assert.equal(vpnCheck2.checked, false, "unsaved toggle must be discarded");
  } finally {
    env.teardown();
  }
});
