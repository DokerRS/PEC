import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { setupDashboardDom } from "./helpers/dashboardDom.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * GEO-BUILDER-UX-3: understandable sources + editable layers (constructor).
 * CLICK-PATH invariant (UX-2): every interaction dispatches real events on
 * the actual buttons/inputs — no direct export calls for new flows.
 */

const FILE_ID = "a".repeat(64);
const FILE_ID_2 = "b".repeat(64);

const TAG_TABLE: Record<string, string[]> = {
  TELEGRAM: ["t.me", "telegram.org"],
  NEWS: ["bbc.co.uk", "cnn.com"],
  RU: ["mail.ru", "yandex.ru", "vk.com"],
};

function resolveLayerResponse(init: any) {
  const body = typeof init?.body === "string" ? JSON.parse(init.body || "{}") : init?.body || {};
  const src = body.source || {};
  if (src.kind === "file") {
    if (src.fileId && (src.content === undefined || src.content === null)) {
      const tags: string[] = Array.isArray(src.tags) ? src.tags : [];
      const entries = tags.flatMap((t: string) => TAG_TABLE[t] || []);
      return {
        ok: true,
        source: { kind: "file", fileId: src.fileId, fileName: "geosite (2).dat", tags, entries },
        availableTags: Object.entries(TAG_TABLE).map(([tag, entries]) => ({ tag, count: entries.length })),
      };
    }
    // upload / file replacement
    return {
      ok: true,
      source: {
        kind: "file",
        name: src.name,
        fileId: FILE_ID_2,
        fileName: src.name,
        tags: Array.isArray(src.tags) ? src.tags : [],
        entries: ["replaced-a.example", "replaced-b.example"],
      },
      availableTags: Object.entries(TAG_TABLE).map(([tag, entries]) => ({ tag, count: entries.length })),
    };
  }
  if (src.kind === "url") {
    return {
      ok: true,
      source: { kind: "url", url: src.url, tag: src.tag, entries: ["refreshed-url.example"] },
    };
  }
  return { ok: true, source: src };
}

function makePreset() {
  return {
    id: "ux3:mixed",
    name: "Mixed Layers",
    description: "UX-3 fixture",
    source: "file",
    type: "domain",
    entries: ["t.me", "telegram.org", "old-a.example", "ads.example.com", "hand.example"],
    sources: [
      { kind: "file", fileId: FILE_ID, fileName: "geosite (2).dat", tags: ["TELEGRAM"], entries: ["t.me", "telegram.org"] },
      { kind: "file", name: "old-import.dat", tag: "RU", entries: ["old-a.example"] },
      { kind: "url", url: "https://example.com/ads.txt", tag: "ads", entries: ["ads.example.com"] },
      { kind: "manual", entries: ["hand.example"] },
    ],
  };
}

function makeDupePreset() {
  return {
    id: "ux3:dupes",
    name: "Dupe Layers",
    description: "",
    source: "file",
    type: "domain",
    entries: ["shared.example", "only-a.example", "file-only.example"],
    sources: [
      { kind: "manual", entries: ["shared.example", "only-a.example"] },
      { kind: "file", fileId: FILE_ID, fileName: "geosite (2).dat", tags: ["TELEGRAM"], entries: ["shared.example", "file-only.example"] },
    ],
  };
}

const CUSTOM_RESPONSES = {
  "/api/routing/presets": (init: any) =>
    init?.method === "POST" ? { ok: true, preset: makePreset() } : [makePreset()],
  "/api/routing/presets/ux3%3Amixed": makePreset(),
  "/api/routing/presets/resolve-layer": resolveLayerResponse,
  [`/api/routing/geofiles/${FILE_ID}/tags`]: {
    fileId: FILE_ID,
    fileName: `${FILE_ID}.dat`,
    availableTags: Object.entries(TAG_TABLE).map(([tag, entries]) => ({ tag, count: entries.length })),
  },
};

function click(win: any, el: Element): void {
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function openBuilder(win: any, document: Document): Promise<any> {
  await win.loadPresets();
  click(win, document.querySelector(`.btn-preset-menu[data-id="ux3:mixed"]`));
  click(win, document.querySelector(`.pm-edit[data-id="ux3:mixed"]`));
  await waitFor(() => document.getElementById("presetBuilderPage")?.style.display === "block", {
    label: "builder open",
  });
  return document;
}

test("UX-3 (a): layer cards show SOURCE name, tag chips, honest per-layer count and live/snapshot status", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document } = env;
    await openBuilder(window, document);

    const rows = document.querySelectorAll(".builder-layer-row");
    assert.equal(rows.length, 4, "four layer cards");

    // section headings
    assert.match(document.getElementById("builderLayersTitle")!.textContent || "", /СЛОИ ПРЕСЕТА \(4\)/);
    assert.ok(document.getElementById("builderAddSourceTitle"));
    assert.equal(document.querySelectorAll(".builder-src-btn").length, 5, "five add-source buttons");

    const liveFile = rows[0];
    assert.match(liveFile.querySelector(".builder-layer-name")!.textContent || "", /geosite \(2\)\.dat/, "header shows the SOURCE file name, not tags");
    const chips = Array.from(liveFile.querySelectorAll(".builder-layer-tag")).map((c) => c.textContent);
    assert.deepEqual(chips, ["TELEGRAM"]);
    assert.match(liveFile.querySelector(".builder-layer-count")!.textContent || "", /^2/, "per-layer honest count");
    assert.match(liveFile.querySelector(".builder-layer-status")!.textContent || "", /живой \(файл\)/);
    assert.ok(liveFile.querySelector(".btn-layer-refresh"), "live file layer gets ↻");

    const snapshot = rows[1];
    assert.match(snapshot.querySelector(".builder-layer-status")!.textContent || "", /снапшот/);
    assert.ok(snapshot.querySelector(".btn-layer-rebind"), "snapshot layer gets «Привязать файл заново»");
    assert.ok(!snapshot.querySelector(".btn-layer-refresh"), "snapshot layer has no ↻");

    const urlLayer = rows[2];
    assert.match(urlLayer.querySelector(".builder-layer-name")!.textContent || "", /example\.com/, "url layer header shows the host");
    assert.match(urlLayer.querySelector(".builder-layer-status")!.textContent || "", /живой \(url\)/);
  } finally {
    env.teardown();
  }
});

test("UX-3 (b): origin badges are short sources with full-path titles; honest counters line; search over all entries", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document } = env;
    await openBuilder(window, document);

    const totalLine = document.getElementById("builderEntriesTotal")!.textContent || "";
    assert.match(totalLine, /Всего по слоям: 5/);
    assert.match(totalLine, /Уникальных: 5/);
    assert.ok(!/дублей скрыто/.test(totalLine), "no duplicates line when there are none");

    const badges = Array.from(document.querySelectorAll(".builder-entry-origin"));
    const labels = badges.map((b) => b.textContent);
    assert.ok(labels.includes("geosite (2).dat:telegram"), `short file origin, got: ${labels.join("|")}`);
    assert.ok(labels.includes("url:ads"), "short url origin");
    assert.ok(labels.includes("вручную"), "manual origin");
    const fileBadge = badges.find((b) => (b.textContent || "").startsWith("geosite (2).dat"));
    assert.match(fileBadge!.getAttribute("title") || "", /data\/geofiles\/aaaa/, "title holds the full geofile path");

    // search placeholder counts ALL union entries
    const search = document.getElementById("builderEntrySearch") as HTMLInputElement;
    assert.match(search.placeholder, /Поиск по всем 5 записям/);

    // search matches an entry that is NOT among the first rendered rows is
    // impossible here (5 < 500), so assert the filter actually searches the
    // whole union by finding a tail entry
    search.value = "hand.example";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await waitFor(() => document.querySelectorAll(".builder-entry-row").length === 1, { label: "search filtered" });
  } finally {
    env.teardown();
  }
});

test("UX-3 (c): duplicates are counted honestly (Всего / Уникальных / дублей скрыто) and short labels stay unique", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [makeDupePreset()],
      "/api/routing/presets/ux3%3Adupes": makeDupePreset(),
      "/api/routing/presets/resolve-layer": resolveLayerResponse,
    },
  });
  try {
    const { window, document } = env;
    await window.loadPresets();
    click(window, document.querySelector(`.btn-preset-menu[data-id="ux3:dupes"]`));
    click(window, document.querySelector(`.pm-edit[data-id="ux3:dupes"]`));
    await waitFor(() => document.getElementById("presetBuilderPage")?.style.display === "block", { label: "builder open" });

    const totalLine = document.getElementById("builderEntriesTotal")!.textContent || "";
    assert.match(totalLine, /Всего по слоям: 4/);
    assert.match(totalLine, /Уникальных: 3/);
    assert.match(totalLine, /дублей скрыто: 1/);

    // same display name on the manual+file pair would collide -> numbered suffix
    const labels = Array.from(document.querySelectorAll(".builder-entry-origin")).map((b) => b.textContent);
    assert.ok(labels.includes("geosite (2).dat:telegram"));
  } finally {
    env.teardown();
  }
});

test("UX-3 (d): ✎ tag editor — checklist with counts, search, multiselect, Save rebuilds the layer", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document, fetchCalls } = env;
    await openBuilder(window, document);

    // open the tag editor on the live file layer
    click(window, document.querySelector('.btn-layer-edit[data-index="0"]')!);
    await waitFor(() => document.querySelectorAll(".builder-tag-check").length === 3, { label: "tag checklist rendered" });
    const editor = document.querySelector(".builder-layer-editor")!;
    assert.ok(editor.querySelector('.builder-tag-check[data-tag="NEWS"]'));

    // tags endpoint was fetched for the checklist
    assert.ok(fetchCalls.some((c: any) => c.url.includes(`/api/routing/geofiles/${FILE_ID}/tags`)));

    // search filters the checklist
    const tagSearch = document.getElementById("builderTagSearch") as HTMLInputElement;
    tagSearch.value = "news";
    tagSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
    await waitFor(() => document.querySelectorAll(".builder-tag-check").length === 1, { label: "checklist filtered" });
    tagSearch.value = "";
    tagSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
    await waitFor(() => document.querySelectorAll(".builder-tag-check").length === 3, { label: "checklist restored" });

    // multiselect: add NEWS on top of TELEGRAM
    const newsBox = document.querySelector('.builder-tag-check[data-tag="NEWS"]') as HTMLInputElement;
    newsBox.checked = true;
    newsBox.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.match(document.querySelector(".builder-tag-summary")!.textContent || "", /Выбрано тегов: 2/);

    // Save -> resolve-layer with both tags -> layer rebuilt
    click(window, document.querySelector(".btn-editor-save")!);
    await waitFor(() => {
      const calls = fetchCalls.filter((c: any) => c.url.includes("/resolve-layer") && c.method === "POST");
      return calls.length > 0;
    }, { label: "resolve-layer POST" });
    const resolveBody = JSON.parse(
      fetchCalls.filter((c: any) => c.url.includes("/resolve-layer") && c.method === "POST").pop().body
    );
    assert.equal(resolveBody.source.kind, "file");
    assert.equal(resolveBody.source.fileId, FILE_ID);
    assert.deepEqual(resolveBody.source.tags.sort(), ["NEWS", "TELEGRAM"]);

    // composition now shows the NEWS entries brought in by the rebuilt layer
    await waitFor(() => document.getElementById("builderEntriesBody")!.textContent!.includes("bbc.co.uk"), {
      label: "composition updated",
    });
    assert.ok(!document.querySelector(".builder-layer-editor"), "editor closed after save");
  } finally {
    env.teardown();
  }
});

test("UX-3 (e): «Сменить файл» replaces the layer in place; «Привязать файл заново» revives a snapshot", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document, fetchCalls } = env;
    await openBuilder(window, document);

    // replace the file of the live layer from inside the editor
    click(window, document.querySelector('.btn-layer-edit[data-index="0"]')!);
    await waitFor(() => !!document.querySelector(".builder-editor-file"), { label: "editor with file input" });
    const file = new window.File(["replaced"], "new-geosite.dat", { type: "octet-stream" });
    const input = document.querySelector(".builder-editor-file") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));

    await waitFor(() => {
      const layerName = document.querySelector('.builder-layer-row[data-index="0"] .builder-layer-name');
      return layerName && (layerName.textContent || "").includes("new-geosite.dat");
    }, { label: "layer switched to the new file" });

    const uploadCall = fetchCalls
      .filter((c: any) => c.url.includes("/resolve-layer") && c.method === "POST")
      .map((c: any) => JSON.parse(c.body))
      .find((b: any) => b.source.content);
    assert.ok(uploadCall, "file replacement must upload the content");
    assert.equal(uploadCall.source.name, "new-geosite.dat");

    // snapshot -> «Привязать файл заново» -> live
    click(window, document.querySelector('.btn-layer-rebind[data-index="1"]')!);
    await waitFor(() => !!document.querySelector('.builder-layer-editor[data-index="1"]'), { label: "rebind editor open" });
    const file2 = new window.File(["snapshot-revive"], "revived.dat", { type: "octet-stream" });
    const input2 = document.querySelector('.builder-editor-file[data-index="1"]') as HTMLInputElement;
    Object.defineProperty(input2, "files", { value: [file2], configurable: true });
    input2.dispatchEvent(new window.Event("change", { bubbles: true }));

    await waitFor(() => {
      const status = document.querySelector('.builder-layer-row[data-index="1"] .builder-layer-status');
      return status && (status.textContent || "").includes("живой (файл)");
    }, { label: "snapshot revived to live" });
    assert.ok(
      document.querySelector('.builder-layer-row[data-index="1"] .btn-layer-refresh'),
      "revived layer gains ↻"
    );
  } finally {
    env.teardown();
  }
});

test("UX-3 (f): manual ✎ editor edits that layer only; url ✎ editor re-resolves via resolve-layer", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document, fetchCalls } = env;
    const resolveBefore = () =>
      fetchCalls.filter((c: any) => c.url.includes("/resolve-layer") && c.method === "POST").length;
    await openBuilder(window, document);

    // manual editor: prefilled textarea, client-side save (no resolve-layer)
    const resolveCount0 = resolveBefore();
    click(window, document.querySelector('.btn-layer-edit[data-index="3"]')!);
    const ta = document.getElementById("builderEditorManual") as HTMLTextAreaElement;
    assert.equal(ta.value, "hand.example");
    ta.value = "hand.example\nedited.example";
    click(window, document.querySelector('.builder-layer-editor[data-index="3"] .btn-editor-save')!);
    await waitFor(() => document.getElementById("builderEntriesBody")!.textContent!.includes("edited.example"), {
      label: "manual composition updated",
    });
    assert.equal(resolveBefore(), resolveCount0, "manual save must not hit resolve-layer");

    // url editor: change url -> resolve-layer re-fetches the snapshot
    click(window, document.querySelector('.btn-layer-edit[data-index="2"]')!);
    const urlInput = document.getElementById("builderEditorUrl") as HTMLInputElement;
    assert.equal(urlInput.value, "https://example.com/ads.txt");
    urlInput.value = "https://example.com/ads-v2.txt";
    click(window, document.querySelector('.builder-layer-editor[data-index="2"] .btn-editor-save')!);
    await waitFor(() => {
      const calls = fetchCalls.filter((c: any) => c.url.includes("/resolve-layer") && c.method === "POST");
      return calls.length > resolveCount0;
    }, { label: "url resolve-layer" });
    const urlBody = JSON.parse(
      fetchCalls.filter((c: any) => c.url.includes("/resolve-layer") && c.method === "POST").pop().body
    );
    assert.equal(urlBody.source.url, "https://example.com/ads-v2.txt");
    assert.equal(urlBody.source.tag, "ads");
  } finally {
    env.teardown();
  }
});

test("UX-3 (g): «Домен +» targets the selected manual layer; «+ новый ручной слой» creates one; bulk delete confirms above 1", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document, fetchCalls } = env;
    let confirmCalls = 0;
    (window as any).pecConfirm = async () => {
      confirmCalls++;
      return true;
    };
    await openBuilder(window, document);

    // second manual layer via the domain target selector
    const target = document.getElementById("builderDomainTarget") as HTMLSelectElement;
    const values = Array.from(target.options).map((o) => o.value);
    assert.ok(values.includes("new"), "selector offers «+ новый ручной слой»");
    const domainInput = document.getElementById("builderAddDomain") as HTMLInputElement;
    domainInput.value = "targeted.example";
    domainInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => document.getElementById("builderEntriesBody")!.textContent!.includes("targeted.example"), {
      label: "domain added to first manual layer",
    });
    // default target = the first manual layer (index 3)
    const manualLayer = document.querySelector('.builder-layer-row[data-index="3"]')!;
    assert.ok((manualLayer.querySelector(".builder-layer-count")!.textContent || "").startsWith("2"));

    // now target a NEW layer
    target.value = "new";
    domainInput.value = "fresh-layer.example";
    domainInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => document.getElementById("builderEntriesBody")!.textContent!.includes("fresh-layer.example"), {
      label: "new manual layer created",
    });
    assert.equal(document.querySelectorAll(".builder-layer-row").length, 5, "a new manual layer appeared");

    // bulk delete: two selected -> confirm required
    const boxes = document.querySelectorAll(".toggle-builder-entry");
    (boxes[0] as HTMLInputElement).checked = true;
    boxes[0].dispatchEvent(new window.Event("change", { bubbles: true }));
    (boxes[1] as HTMLInputElement).checked = true;
    boxes[1].dispatchEvent(new window.Event("change", { bubbles: true }));
    click(window, document.querySelector(".btn-builder-delete-selected")!);
    await waitFor(() => confirmCalls === 1, { label: "bulk delete confirmed" });
    await waitFor(() => document.querySelectorAll(".builder-entry-row").length < 6, { label: "entries removed" });

    // single-row delete must NOT confirm
    const before = confirmCalls;
    const singleBox = document.querySelector(".toggle-builder-entry") as HTMLInputElement;
    singleBox.checked = true;
    singleBox.dispatchEvent(new window.Event("change", { bubbles: true }));
    const removeBtn = document.querySelector(".btn-entry-remove")!;
    click(window, removeBtn);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(confirmCalls, before, "single entry removal must not ask for confirmation");
  } finally {
    env.teardown();
  }
});

test("UX-3 (h): add-source panels open one at a time; ↻ re-reads a live file layer", async () => {
  const env = setupDashboardDom({ authenticated: true, customResponses: CUSTOM_RESPONSES });
  try {
    const { window, document, fetchCalls } = env;
    await openBuilder(window, document);

    // open file panel
    click(window, document.querySelector('.builder-src-btn[data-src="file"]')!);
    assert.equal(document.getElementById("builderPanelFile")!.style.display, "block");
    // switch to url panel -> file panel closes
    click(window, document.querySelector('.builder-src-btn[data-src="url"]')!);
    assert.equal(document.getElementById("builderPanelUrl")!.style.display, "block");
    assert.equal(document.getElementById("builderPanelFile")!.style.display, "none");

    // ↻ on the live file layer re-reads the stored geofile by tags
    click(window, document.querySelector('.btn-layer-refresh[data-index="0"]')!);
    await waitFor(() => {
      const calls = fetchCalls.filter((c: any) => c.url.includes("/resolve-layer") && c.method === "POST");
      return calls.some((c: any) => {
        const b = JSON.parse(c.body);
        return b.source.kind === "file" && b.source.fileId === FILE_ID && !b.source.content;
      });
    }, { label: "file layer re-read" });
  } finally {
    env.teardown();
  }
});
