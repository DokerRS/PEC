import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { setupDashboardDom } from "./helpers/dashboardDom.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * GEO-PRESET-UX-2: preset constructor sub-page (client).
 *
 * CLICK-PATH INVARIANT (DIAG-GEO-UX-1): every interaction in this suite goes
 * through dispatchEvent(click/change/keydown) on the actual buttons/inputs —
 * direct calls of new-flow exports (openPresetBuilder / savePresetBuilder /
 * addBuilderDomain ...) are forbidden here, because the buttons were dead
 * before the delegated listeners were added.
 */

const BUILTIN_PRESET = {
  id: "builtin:ai",
  name: "AI & LLM Services (builtin)",
  description: "Builtin AI domains",
  source: "builtin",
  type: "domain",
  entries: ["openai.com", "chatgpt.com", "anthropic.com"],
  sources: [{ kind: "geo-tag", ref: "builtin:ai", entries: ["openai.com", "chatgpt.com", "anthropic.com"] }],
};

const REMOTE_PRESET = {
  id: "remote:ads",
  name: "Ads Blocklist",
  description: "Remote ads list",
  source: "remote",
  sourceUrl: "https://example.com/ads.txt",
  type: "domain",
  entries: ["ads.example.com", "tracker.example.net"],
  sources: [
    {
      kind: "url",
      url: "https://example.com/ads.txt",
      entries: ["ads.example.com", "tracker.example.net"],
    },
  ],
};

function click(win: any, el: Element): void {
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function openBuilderViaCard(
  win: any,
  document: Document,
  preset: any,
  opts: { readOnly?: boolean } = {}
): Promise<void> {
  await win.loadPresets();
  // CARD-MENU click-path: ⋮ -> menu item (pm-edit / pm-view)
  const menuBtn = document.querySelector(`.btn-preset-menu[data-id="${preset.id}"]`);
  assert.ok(menuBtn, "preset card must render the ⋮ menu button");
  click(win, menuBtn);
  const itemClass = opts.readOnly ? ".pm-view" : ".pm-edit";
  const item = document.querySelector(`${itemClass}[data-id="${preset.id}"]`);
  assert.ok(item, `open menu must expose ${itemClass} for the preset`);
  click(win, item);
  await waitFor(() => document.getElementById("presetBuilderPage")?.style.display === "block", {
    label: "preset builder page visible",
  });
}

test("GEO-UX2 (a): ✏️ click-path (⋮ → Редактировать) opens the constructor sub-page (full-width detail view)", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [BUILTIN_PRESET, REMOTE_PRESET],
      "/api/routing/presets/remote%3Aads": REMOTE_PRESET,
    },
  });
  try {
    const { window, document } = env;
    await openBuilderViaCard(window, document, REMOTE_PRESET);

    const page = document.getElementById("presetBuilderPage")!;
    assert.equal(page.style.display, "block");
    assert.equal(document.getElementById("branchExtView")!.style.display, "none", "main routing view must hide");
    assert.equal(document.getElementById("routingBranchSwitcher")!.style.display, "none");

    assert.equal((document.getElementById("builderNameInput") as HTMLInputElement).value, "Ads Blocklist");
    assert.equal(document.getElementById("builderTypeBadge")!.textContent, "DOMAIN");
    assert.equal(document.getElementById("builderPresetId")!.textContent, "remote:ads");
    assert.equal(document.getElementById("builderBuiltinBadge")!.style.display, "none");

    // layers panel: one url layer with count + no manual layer
    const layerRows = document.querySelectorAll(".builder-layer-row");
    assert.equal(layerRows.length, 1);
    assert.match(layerRows[0].textContent || "", /example\.com/, "url layer header shows the source host");
    assert.equal(document.querySelectorAll(".btn-layer-refresh").length, 1, "url layer gets a ↻ button");

    // composition: rows with origin badges, url rows are not editable
    const entryRows = document.querySelectorAll(".builder-entry-row");
    assert.equal(entryRows.length, 2);
    assert.equal(document.querySelectorAll(".builder-entry-origin").length, 2);
    assert.equal(document.querySelectorAll(".btn-entry-remove").length, 0, "live url entries must not be line-removable");
    assert.ok(document.querySelector("#builderEntriesBody")!.textContent!.includes("ads.example.com"));
  } finally {
    env.teardown();
  }
});

test("GEO-UX2 (b): builtin gating — 👁 read-only view, no ✏️/🗑, «Дублировать в свой» posts a copy", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [BUILTIN_PRESET, REMOTE_PRESET],
      "/api/routing/presets/builtin%3Aai": BUILTIN_PRESET,
      "/api/routing/presets/import-preset": {
        ok: true,
        preset: { id: "preset:copy-1", name: "AI copy", sources: BUILTIN_PRESET.sources, entries: BUILTIN_PRESET.entries, entriesCount: 3 },
      },
    },
  });
  try {
    const { window, document, fetchCalls } = env;
    await window.loadPresets();

    const builtinCard = document.querySelector(`.btn-preset-menu[data-id="${BUILTIN_PRESET.id}"]`)?.closest(".preset-card");
    assert.ok(builtinCard, "builtin card must render");
    const builtinHtml = builtinCard!.innerHTML;
    assert.ok(!builtinHtml.includes("btn-preset-open"), "builtin must not show an edit entry point");
    assert.ok(builtinHtml.includes("btn-preset-menu"), "builtin card must show the ⋮ menu");
    const builtinMenu = builtinCard!.querySelector(".preset-card-menu") as HTMLElement;
    assert.ok(builtinMenu.innerHTML.includes("pm-view"), "builtin menu must show View layers");
    assert.ok(builtinMenu.innerHTML.includes("pm-duplicate"), "builtin menu must show Duplicate");
    assert.ok(!builtinMenu.innerHTML.includes("pm-edit"), "builtin menu must not show Edit");
    assert.ok(!builtinMenu.innerHTML.includes("pm-delete"), "builtin menu must not show Delete");
    const remoteCard = document.querySelector(`.btn-preset-menu[data-id="${REMOTE_PRESET.id}"]`)?.closest(".preset-card");
    assert.ok(remoteCard, "non-builtin card must render");
    assert.ok(remoteCard!.querySelector(".pm-edit"), "non-builtin menu must show Edit");

    // 👁 click-path (⋮ → Просмотр слоёв) -> read-only builder
    await openBuilderViaCard(window, document, BUILTIN_PRESET, { readOnly: true });
    assert.equal((document.getElementById("builderNameInput") as HTMLInputElement).readOnly, true);
    assert.equal(document.getElementById("builderBuiltinBadge")!.style.display, "inline-flex");
    assert.equal(document.getElementById("btnBuilderSave")!.style.display, "none");
    assert.equal(document.getElementById("builderAddLayerBlock")!.style.display, "none");
    assert.equal(document.getElementById("builderFooter")!.style.display, "none");
    assert.equal(document.getElementById("builderDuplicateBtn")!.style.display, "inline-flex");

    // «Дублировать в свой» -> POST import-preset with copied layers
    click(window, document.getElementById("builderDuplicateBtn")!);
    await waitFor(() => fetchCalls.some((c: any) => c.url.includes("/api/routing/presets/import-preset")), {
      label: "import-preset POST",
    });
    const dupCall = fetchCalls.find((c: any) => c.url.includes("/api/routing/presets/import-preset"));
    assert.equal(dupCall.method, "POST");
    const body = JSON.parse(dupCall.body);
    assert.match(body.preset.name, /копия|copy/);
    assert.equal(body.preset.sources.length, 1, "builtin layers must be copied");
    assert.equal(body.preset.type, "domain");

    // after duplication the constructor opens the new copy
    await waitFor(() => fetchCalls.some((c: any) => c.url === "/api/routing/presets/preset%3Acopy-1"), {
      label: "copy opened in constructor",
    });
  } finally {
    env.teardown();
  }
});

test("GEO-UX2 (c): «+ Слой из файла» click-path — change on file input resolves a file layer", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [REMOTE_PRESET],
      "/api/routing/presets/remote%3Aads": REMOTE_PRESET,
      "/api/routing/presets/resolve-layer": {
        ok: true,
        source: { kind: "file", name: "extra.txt", entries: ["extra-a.example", "extra-b.example"] },
      },
    },
  });
  try {
    const { window, document, fetchCalls } = env;
    await openBuilderViaCard(window, document, REMOTE_PRESET);

    const fileInput = document.getElementById("builderLayerFileInput") as HTMLInputElement;
    assert.ok(fileInput, "file input must exist in the add-layer block");
    const file = new window.File(["extra-a.example\nextra-b.example\n"], "extra.txt", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));

    await waitFor(() => document.querySelectorAll(".builder-layer-row").length === 2, {
      label: "second layer row rendered",
    });

    const resolveCall = fetchCalls.find((c: any) => c.url.includes("/resolve-layer"));
    assert.ok(resolveCall, "resolve-layer must be called");
    const resolveBody = JSON.parse(resolveCall.body);
    assert.equal(resolveBody.source.kind, "file");
    assert.equal(resolveBody.source.name, "extra.txt");
    assert.ok(resolveBody.source.content.length > 0, "file content must be sent (base64)");
    assert.equal(resolveBody.type, "domain");

    // new layer entries appear in the composition table
    const rows = document.querySelectorAll(".builder-entry-row");
    assert.equal(rows.length, 4, "2 url + 2 file entries");
    assert.ok(
      Array.from(document.querySelectorAll(".builder-entry-origin")).some((b) =>
        (b.textContent || "").includes("extra.txt")
      ),
      "origin badge must show the layer name"
    );
  } finally {
    env.teardown();
  }
});

test("GEO-UX2 (d): «Домен +» (Enter) appends to a manual layer; ✕ removes layer and entry; Save payload carries sources+entries+source fields", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": (init: any) =>
        init?.method === "POST" ? { ok: true, preset: REMOTE_PRESET } : [REMOTE_PRESET],
      "/api/routing/presets/remote%3Aads": REMOTE_PRESET,
      // echo-server: resolve-layer returns the requested source unchanged
      "/api/routing/presets/resolve-layer": (init: any) => {
        const b = JSON.parse(init?.body || "{}");
        return { ok: true, source: b.source };
      },
    },
  });
  try {
    const { window, document, fetchCalls } = env;
    (window as any).pecConfirm = async () => true;
    await openBuilderViaCard(window, document, REMOTE_PRESET);

    // 1. add a domain via Enter in the "Домен +" input
    const domainInput = document.getElementById("builderAddDomain") as HTMLInputElement;
    console.log("DBG-d0:", "openBtn?", !!document.querySelector('.btn-preset-open[data-id="remote:ads"]'),
      "viewBtn?", !!document.querySelector('.btn-preset-view[data-id="remote:ads"]'),
      "nameRO?", (document.getElementById("builderNameInput") as HTMLInputElement).readOnly,
      "saveDisp?", document.getElementById("btnBuilderSave")!.style.display,
      "layers?", document.querySelectorAll(".builder-layer-row").length);
    domainInput.value = "custom-domain.example";
    domainInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    console.log("DBG-d1:", "layers:", document.querySelectorAll(".builder-layer-row").length,
      "entries:", document.querySelectorAll(".builder-entry-row").length);

    await waitFor(() => document.querySelectorAll(".builder-entry-row").length === 3, {
      label: "manual entry rendered",
    });
    const layerRows = document.querySelectorAll(".builder-layer-row");
    assert.equal(layerRows.length, 2, "manual layer auto-created");
    assert.match(layerRows[1].textContent || "", /Ручной список|Manual list/);

    // 2. remove the manual entry via row ✕
    const removeBtn = Array.from(document.querySelectorAll(".btn-entry-remove")).find(
      (b) => b.getAttribute("data-entry") === "custom-domain.example"
    );
    assert.ok(removeBtn, "manual entries must be line-removable");
    click(window, removeBtn!);
    await waitFor(() => document.querySelectorAll(".builder-entry-row").length === 2, {
      label: "entry removed",
    });

    // 3. re-add via the add-source panel (✏️ Вручную), then remove the layer with confirm
    click(window, document.querySelector('.builder-src-btn[data-src="manual"]')!);
    await waitFor(() => document.getElementById("builderPanelManual")!.style.display === "block", {
      label: "manual panel open",
    });
    const manualTa = document.getElementById("builderManualEntries") as HTMLTextAreaElement;
    manualTa.value = "m1.example\nm2.example";
    click(window, document.querySelector(".btn-add-manual-confirm")!);
    await waitFor(() => document.querySelectorAll(".builder-layer-row").length === 3, {
      label: "manual layer added",
    });

    const layerRemoveBtn = document.querySelector('.btn-layer-remove[data-index="2"]')!;
    click(window, layerRemoveBtn);
    await waitFor(() => document.querySelectorAll(".builder-layer-row").length === 2, {
      label: "layer removed after confirm",
    });

    // 4. edit the name and Save
    const nameInput = document.getElementById("builderNameInput") as HTMLInputElement;
    nameInput.value = "Ads Blocklist v2";
    nameInput.dispatchEvent(new window.Event("input", { bubbles: true }));

    click(window, document.querySelector(".btn-builder-save")!);
    await waitFor(() => fetchCalls.some((c: any) => c.method === "POST" && c.url === "/api/routing/presets"), {
      label: "save POST",
    });
    const saveCall = fetchCalls.find((c: any) => c.method === "POST" && c.url === "/api/routing/presets");
    const payload = JSON.parse(saveCall.body);
    assert.equal(payload.id, "remote:ads");
    assert.equal(payload.name, "Ads Blocklist v2");
    assert.equal(payload.type, "domain");
    assert.ok(Array.isArray(payload.sources) && payload.sources.length === 2, "payload carries sources[]");
    assert.ok(payload.entries.includes("ads.example.com"), "payload carries flat entries");
    assert.equal(payload.source, "remote", "payload re-sends source fields");
    assert.equal(payload.sourceUrl, "https://example.com/ads.txt");

    // after successful save the constructor closes and the card list is back
    await waitFor(() => document.getElementById("presetBuilderPage")!.style.display === "none", {
      label: "builder closed after save",
    });
  } finally {
    env.teardown();
  }
});

test("GEO-UX2 (e): layer ✕ with declined confirm keeps the layer; 400 limit surfaces a toast and keeps the builder open", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [REMOTE_PRESET],
      "/api/routing/presets/remote%3Aads": REMOTE_PRESET,
      "/api/routing/presets/resolve-layer": {
        error: "Layer too large: 700000 entries exceed the 500000 entry limit",
      },
      "/api/routing/presets/resolve-layer:status": 400,
    },
  });
  try {
    const { window, document } = env;
    await openBuilderViaCard(window, document, REMOTE_PRESET);

    // declined confirm -> layer stays
    (window as any).pecConfirm = async () => false;
    console.log("DBG-e0:", "layerBtns:", document.querySelectorAll(".btn-layer-remove").length,
      "rows:", document.querySelectorAll(".builder-layer-row").length);
    click(window, document.querySelector('.btn-layer-remove[data-index="0"]')!);
    await new Promise((r) => setTimeout(r, 30));
    console.log("DBG-e1:", "rows after declined:", document.querySelectorAll(".builder-layer-row").length,
      "pecConfirm is fn:", typeof (window as any).pecConfirm);
    assert.equal(document.querySelectorAll(".builder-layer-row").length, 1, "declined confirm must keep the layer");

    // 400 from resolve-layer -> toast with the limit message, builder stays open
    (window as any).pecConfirm = async () => true;
    click(window, document.querySelector('.builder-src-btn[data-src="manual"]')!);
    const manualTa = document.getElementById("builderManualEntries") as HTMLTextAreaElement;
    manualTa.value = "boom.example";
    click(window, document.querySelector(".btn-add-manual-confirm")!);
    await waitFor(() => {
      const host = document.getElementById("toastHost");
      return !!host && (host.textContent || "").includes("entry limit");
    }, { label: "limit toast shown" });
    assert.equal(document.getElementById("presetBuilderPage")!.style.display, "block", "builder must stay open");
    assert.equal(document.querySelectorAll(".builder-layer-row").length, 1, "rejected layer must not be appended");
  } finally {
    env.teardown();
  }
});

test("GEO-UX2 (f): composition panel — search filters rows, render limit 500 + «Показать ещё», select-all + delete selected via checkboxes", async () => {
  const bigEntries: string[] = [];
  for (let i = 0; i < 600; i++) bigEntries.push(`bulk-${String(i).padStart(4, "0")}.example`);
  const BIG_PRESET = {
    id: "file:bulk",
    name: "Bulk List",
    description: "big file snapshot",
    source: "file",
    type: "domain",
    entries: bigEntries,
    sources: [{ kind: "file", name: "bulk.txt", entries: bigEntries }],
  };
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [BIG_PRESET],
      "/api/routing/presets/file%3Abulk": BIG_PRESET,
    },
  });
  try {
    const { window, document } = env;
    (window as any).pecConfirm = async () => true;
    await openBuilderViaCard(window, document, BIG_PRESET);

    // render limit: 500 of 600 + show-more button
    await waitFor(() => document.querySelectorAll(".builder-entry-row").length === 500, {
      label: "500 rows rendered",
    });
    const showMore = document.getElementById("btnBuilderShowMore") as HTMLButtonElement;
    assert.equal(showMore.style.display, "inline-flex", "show-more must be visible above the limit");
    click(window, showMore);
    await waitFor(() => document.querySelectorAll(".builder-entry-row").length === 600, {
      label: "all rows after show-more",
    });
    assert.equal(showMore.style.display, "none", "show-more hides when everything is rendered");

    // search filters rows
    const search = document.getElementById("builderEntrySearch") as HTMLInputElement;
    search.value = "bulk-0042";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await waitFor(() => document.querySelectorAll(".builder-entry-row").length === 1, {
      label: "search filtered to 1 row",
    });
    search.value = "";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    // search input resets the render window to the 500-entry limit
    await waitFor(() => document.querySelectorAll(".builder-entry-row").length === 500, {
      label: "search reset",
    });

    // select one entry via its checkbox (delegated change), then delete selected
    const checkbox = document.querySelector('.toggle-builder-entry[data-entry="bulk-0000.example"]') as HTMLInputElement;
    assert.ok(checkbox, "file-layer entries must have checkboxes");
    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => (document.getElementById("builderSelectedCount")?.textContent || "").includes("1"), {
      label: "selection counter updated",
    });
    click(window, document.querySelector(".btn-builder-delete-selected")!);
    // render window stays at 500; deletion is observable via the entry
    // disappearing from the rendered rows and the total counter dropping
    await waitFor(() => {
      const body = document.getElementById("builderEntriesBody");
      const total = document.getElementById("builderEntriesTotal");
      return !!body && !(body.textContent || "").includes("bulk-0000.example") &&
        !!total && (total.textContent || "").includes("599");
    }, { label: "selected entry removed" });
    assert.ok(
      !Array.from(document.querySelectorAll(".builder-entry-row")).some((r) => (r.textContent || "").includes("bulk-0000.example")),
      "removed entry must disappear from the table"
    );
  } finally {
    env.teardown();
  }
});

test("GEO-UX2 (g): card 🔄 refresh and 🗑 delete click-paths (via ⋮ menu) fire the API calls", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [REMOTE_PRESET],
      "/api/routing/presets/remote%3Aads/refresh": { ok: true, preset: REMOTE_PRESET },
    },
  });
  try {
    const { window, document, fetchCalls } = env;
    (window as any).pecConfirm = async () => true;
    await window.loadPresets();

    const menuBtn = document.querySelector(`.btn-preset-menu[data-id="${REMOTE_PRESET.id}"]`)!;
    click(window, menuBtn);
    click(window, document.querySelector(`.pm-refresh[data-id="${REMOTE_PRESET.id}"]`)!);
    await waitFor(() => fetchCalls.some((c: any) => c.method === "POST" && c.url.includes("/refresh")), {
      label: "refresh POST",
    });

    click(window, menuBtn);
    click(window, document.querySelector(`.pm-delete[data-id="${REMOTE_PRESET.id}"]`)!);
    await waitFor(() => fetchCalls.some((c: any) => c.method === "DELETE"), { label: "delete DELETE" });
    const delCall = fetchCalls.find((c: any) => c.method === "DELETE");
    assert.equal(delCall.url, "/api/routing/presets/remote%3Aads");
  } finally {
    env.teardown();
  }
});

test("GEO-UX2 (h): «+ Геосписок» from the dropdown resolves a geo-tag layer with type matching", async () => {
  const env = setupDashboardDom({
    authenticated: true,
    customResponses: {
      "/api/routing/presets": [BUILTIN_PRESET, REMOTE_PRESET],
      "/api/routing/presets/remote%3Aads": REMOTE_PRESET,
      "/api/routing/presets/resolve-layer": { ok: true, source: { kind: "geo-tag", ref: "builtin:ai" } },
    },
  });
  try {
    const { window, document, fetchCalls } = env;
    await openBuilderViaCard(window, document, REMOTE_PRESET);

    const geoSelect = document.getElementById("builderGeoSelect") as HTMLSelectElement;
    assert.ok(geoSelect, "geo dropdown must exist");
    assert.match(geoSelect.innerHTML, /builtin%3Aai|builtin:ai/, "dropdown must list builtin geo presets");

    const option = Array.from(geoSelect.querySelectorAll("option")).find((o) => o.value);
    assert.ok(option, "dropdown must have a selectable option");
    console.log("DBG-h0:", "opts:", geoSelect.querySelectorAll("option").length,
      "val:", JSON.stringify(geoSelect.value), "optVal:", JSON.stringify(option!.value));
    geoSelect.value = option!.value;
    click(window, document.querySelector('.builder-src-btn[data-src="geo"]')!);
    click(window, document.querySelector(".btn-add-geo-confirm")!);
    await new Promise((r) => setTimeout(r, 60));
    console.log("DBG-h1:", "resolveCalls:", fetchCalls.filter((c: any) => c.url.includes("resolve-layer")).length,
      "layers:", document.querySelectorAll(".builder-layer-row").length,
      "errs:", JSON.stringify(env.loggedErrors).slice(0, 200));

    await waitFor(() => document.querySelectorAll(".builder-layer-row").length === 2, {
      label: "geo-tag layer added",
    });
    const resolveCall = fetchCalls.find((c: any) => c.url.includes("/resolve-layer"));
    const resolveBody = JSON.parse(resolveCall.body);
    assert.equal(resolveBody.source.kind, "geo-tag");
    assert.equal(resolveBody.type, "domain");
  } finally {
    env.teardown();
  }
});
