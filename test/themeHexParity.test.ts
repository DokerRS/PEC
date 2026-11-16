import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { APP_PALETTES } from "../src/client/dashboard/core/theme.js";

/**
 * THEME-QA-2a/2b: hex-parity between the three copies of the theme contract.
 *
 * - theme.ts (src/client/dashboard/core/theme.ts) is the canonical web palette
 *   (THEME-WEB-4 declared it the source of truth).
 * - pec_imgui_theme.h carries the native dark/light ImGui palette as ImVec4
 *   floats with trailing hex comments (THEME-NAT-3 canonicalized them). This
 *   suite pins BOTH directions: floats must round-trip their hex comment, and
 *   the hex set must equal the web canon.
 * - ui/theme.h (GDI) owns no palettes — it clamps a loaded profile to canon
 *   targets (#0b1120/#131d36 dark, #f8fafc/#ffffff light) with the unified
 *   light predicate from THEME-NAT-3. Neither file was hex-covered before.
 *
 * Anti-regression anchors for the native theme wave (TS-observable parts):
 * - THEME-NAT-1: PecProfileLock is a real CRITICAL_SECTION (not a C no-op).
 * - THEME-NAT-2: the ImGui custom-card branch guards with IsLightMode.
 * - THEME-NAT-3: identical lum>175 / all>180 predicate in both GUI headers.
 *
 * Coverage map of the THEME wave (verification):
 * - THEME-WEB-1 -> dashboardThemeSyncAndAppStudio.test.ts round-trip gate +
 *   dashboardClientUnits.test.ts theme-sync units (THEME-QA-2d)
 * - THEME-WEB-2 -> appBuilderRoutes.test.ts whitelist/hex matrix
 * - THEME-WEB-3 -> themeLuminanceClamps.test.ts (both clamp sites, nord E2E)
 * - THEME-WEB-4 -> themePaletteParity.test.ts (canon vs server copies)
 * - THEME-NAT-1/2/3 -> structural anchors below + native cl.exe verification
 */

const IMGUI_HEADER = path.resolve("client/Windows/gui/pec_imgui_theme.h");
const GDI_HEADER = path.resolve("client/Windows/gui/ui/theme.h");
const STUDIO = path.resolve("src/client/dashboard/tabs/studio.ts");
const PEC_SYNC = path.resolve("client/Windows/gui/ui/pec_sync.h");

interface ImVecLine {
  id: string;
  r: number;
  g: number;
  b: number;
  hex: string;
}

function parseImVecLines(source: string): ImVecLine[] {
  const lines: ImVecLine[] = [];
  const re = /PecTheme::(\w+)\s*=\s*ImVec4\(\s*([-\d.]+)f\s*,\s*([-\d.]+)f\s*,\s*([-\d.]+)f\s*,\s*([-\d.]+)f\s*\);\s*\/\/\s*#([0-9A-Fa-f]{6})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    lines.push({
      id: m[1],
      r: parseFloat(m[2]),
      g: parseFloat(m[3]),
      b: parseFloat(m[4]),
      hex: `#${m[6]}`.toLowerCase(),
    });
  }
  return lines;
}

test("THEME-NAT-3: every ImVec4 float triple round-trips its hex comment in pec_imgui_theme.h", () => {
  const lines = parseImVecLines(fs.readFileSync(IMGUI_HEADER, "utf8"));
  assert.ok(lines.length >= 40, `expected the full palette file, found only ${lines.length} annotated colors`);

  for (const l of lines) {
    const digits = l.hex.slice(1); // strip '#'
    const expect = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
    const actual = [l.r, l.g, l.b].map((f) => Math.round(f * 255));
    actual.forEach((ch, i) => {
      assert.ok(
        Math.abs(ch - expect[i]) <= 1,
        `PecTheme::${l.id} // #${l.hex}: channel ${i} float ${l.r}/${l.g}/${l.b} -> ${actual.join(",")} drifts from hex (drift guard THEME-NAT-3)`
      );
    });
  }
});

test("THEME-QA-2a: theme.ts APP_PALETTES hex-parity with pec_imgui_theme.h (bg/card/accent trio)", () => {
  const lines = parseImVecLines(fs.readFileSync(IMGUI_HEADER, "utf8"));
  const commentsOf = (...ids: string[]) =>
    new Set(lines.filter((l) => ids.includes(l.id)).map((l) => l.hex));

  const canvas = commentsOf("CanvasBg");
  const card = commentsOf("CardBg");
  const accents = commentsOf("PrimaryAccent", "HoverAccent", "ActiveAccent");

  for (const [key, pal] of Object.entries(APP_PALETTES)) {
    assert.ok(
      canvas.has(pal.bg.toLowerCase()),
      `palette ${key}: bg ${pal.bg} must exist as a CanvasBg hex comment in pec_imgui_theme.h`
    );
    assert.ok(
      card.has(pal.card.toLowerCase()),
      `palette ${key}: card ${pal.card} must exist as a CardBg hex comment in pec_imgui_theme.h`
    );
    assert.ok(
      accents.has(pal.accent.toLowerCase()),
      `palette ${key}: accent ${pal.accent} must exist among Primary/Hover/ActiveAccent hex comments`
    );
  }

  // Light-mode canvas: the light surface is theme.ts light's lightBg, and the
  // light card is #ffffff — both must appear in the ImGui light branch.
  assert.ok(canvas.has(APP_PALETTES.light.lightBg.toLowerCase()), "light CanvasBg must equal APP_PALETTES.light.lightBg");
  assert.ok(card.has("#ffffff"), "light CardBg must be #ffffff");
});

test("THEME-QA-2a: ui/theme.h GDI clamp targets are hex-parity with the web canon", () => {
  const src = fs.readFileSync(GDI_HEADER, "utf8");
  const rgbHexes = new Set<string>();
  const re = /RGB\(\s*0x([0-9A-Fa-f]{2})\s*,\s*0x([0-9A-Fa-f]{2})\s*,\s*0x([0-9A-Fa-f]{2})\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    rgbHexes.add(`#${m[1]}${m[2]}${m[3]}`.toLowerCase());
  }

  // Dark-mode stale-light guards clamp to the cyber canvas/card (canon).
  assert.ok(rgbHexes.has(APP_PALETTES.cyber.bg.toLowerCase()), `ui/theme.h dark bg guard must clamp to ${APP_PALETTES.cyber.bg}`);
  assert.ok(rgbHexes.has(APP_PALETTES.cyber.card.toLowerCase()), `ui/theme.h dark card guard must clamp to ${APP_PALETTES.cyber.card}`);
  // Light-mode stale-dark guards clamp to nord lightBg / white (canon).
  assert.ok(rgbHexes.has(APP_PALETTES.nord.lightBg.toLowerCase()), `ui/theme.h light bg guard must clamp to ${APP_PALETTES.nord.lightBg}`);
  assert.ok(rgbHexes.has("#ffffff"), "ui/theme.h light card guard must clamp to #ffffff");
});

test("THEME-NAT-3: both GUI headers use the identical unified light predicate (lum>175 OR all>180)", () => {
  const imgui = fs.readFileSync(IMGUI_HEADER, "utf8");
  const gdi = fs.readFileSync(GDI_HEADER, "utf8");
  for (const [name, src] of [
    ["pec_imgui_theme.h", imgui],
    ["ui/theme.h", gdi],
  ] as const) {
    assert.ok(src.includes("lum > 175.0f"), `${name} must use the 175 luminance threshold`);
    assert.ok(src.includes("> 180"), `${name} must use the all-channels>180 branch of the unified predicate`);
  }
});

test("THEME-NAT anchors: real profile lock (NAT-1) and light-guarded custom card (NAT-2)", () => {
  // THEME-NAT-1: the profile lock must be a real CRITICAL_SECTION in the
  // unity build — the old C-build no-op allowed theme RMW races with the UI.
  const sync = fs.readFileSync(PEC_SYNC, "utf8");
  assert.match(
    sync,
    /PecProfileLock\(\)\s*\{[^}]*EnterCriticalSection/,
    "PecProfileLock must enter a real CRITICAL_SECTION in both build paths (THEME-NAT-1)"
  );

  // THEME-NAT-2: the custom-card override must be light-guarded the same way
  // ui/theme.h guards, so a dark custom card cannot leak onto a light profile.
  const imgui = fs.readFileSync(IMGUI_HEADER, "utf8");
  const guardIdx = imgui.indexOf("if (PecTheme::IsLightMode &&");
  assert.notEqual(guardIdx, -1, "custom-card branch must be guarded by PecTheme::IsLightMode (THEME-NAT-2)");
  const guardWindow = imgui.slice(guardIdx, guardIdx + 400);
  assert.ok(guardWindow.includes("< 160"), "light custom-card guard must use the any-channel<160 threshold (parity with ui/theme.h)");
});

// ---------------------------------------------------------------------------
// THEME-QA-2b: studio.ts APP_THEME_PRESETS vs the canon (theme.ts)
// ---------------------------------------------------------------------------

interface StudioPreset {
  primary?: string;
  background?: string;
  card?: string;
  lightBackground?: string;
  lightCard?: string;
}

function parseStudioPresets(): Record<string, StudioPreset> {
  const src = fs.readFileSync(STUDIO, "utf8");
  const start = src.indexOf("export const APP_THEME_PRESETS");
  assert.notEqual(start, -1, "studio.ts must define APP_THEME_PRESETS");
  const end = src.indexOf("};", start);
  const block = src.slice(start, end);

  const presets: Record<string, StudioPreset> = {};
  const blockRe = /'([a-z-]+)':\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(block)) !== null) {
    const preset: StudioPreset = {};
    const fieldRe = /(\w+):\s*'(#[0-9a-fA-F]{6})'/g;
    let f: RegExpExecArray | null;
    while ((f = fieldRe.exec(m[2])) !== null) {
      (preset as any)[f[1]] = f[2];
    }
    presets[m[1]] = preset;
  }
  return presets;
}

test("THEME-QA-2b: studio APP_THEME_PRESETS are hex-parity with the theme.ts canon", () => {
  const studio = parseStudioPresets();

  for (const [paletteKey, pal] of Object.entries(APP_PALETTES)) {
    const st = studio[pal.style];
    assert.ok(st, `studio.ts must define preset '${pal.style}' for palette ${paletteKey}`);
    assert.equal(st.primary?.toLowerCase(), pal.accent.toLowerCase(), `${pal.style}.primary must equal canon ${paletteKey}.accent`);
    assert.equal(st.background?.toLowerCase(), pal.bg.toLowerCase(), `${pal.style}.background must equal canon ${paletteKey}.bg`);
    assert.equal(st.card?.toLowerCase(), pal.card.toLowerCase(), `${pal.style}.card must equal canon ${paletteKey}.card`);
    if (paletteKey !== "emerald") {
      // Emerald's light surface is pinned by the dedicated STUDIO-EMERALD-
      // LIGHTBG-REGRESSION handoff test below until the studio copy converges.
      assert.equal(
        st.lightBackground?.toLowerCase(),
        pal.lightBg.toLowerCase(),
        `${pal.style}.lightBackground must equal canon ${paletteKey}.lightBg`
      );
    }
    assert.equal(st.lightCard?.toLowerCase(), pal.lightCard.toLowerCase(), `${pal.style}.lightCard must equal canon ${paletteKey}.lightCard`);
  }

  // Native-alias contract: emerald-sentinel is a documented alias of
  // emerald-secops in studio (pec_imgui_theme.h aliases it natively), and
  // minimal-light must exist for the native alias (styleAudit).
  assert.deepEqual(
    studio["emerald-sentinel"],
    studio["emerald-secops"],
    "emerald-sentinel must stay an exact alias of emerald-secops in studio.ts"
  );
  assert.ok(studio["minimal-light"], "studio.ts must keep the minimal-light preset (native alias target)");
  assert.ok(
    fs.readFileSync(STUDIO, "utf8").includes("APP_THEME_PRESETS['amber'] = APP_THEME_PRESETS['sunset-amber'];"),
    "studio.ts must keep the runtime amber alias for APP_THEME_PRESETS"
  );
});

test("THEME-QA-2b REGRESSION HANDOFF (-> agent-general-worker): studio palette whitelist must cover every canon palette (amber currently falls back to cyber)", () => {
  // Found while building the parity harness: setStudioPalette whitelists only
  // 5 palettes while the canon (theme.ts APP_PALETTES), the packager and the
  // popup all support amber. The leftover 'sunset-amber': 'amber' mappings
  // (studio.ts highlightStyleChip / loadBuilderConfig) therefore silently
  // fall back to CYBER: highlightStyleChip('sunset-amber') activates the
  // cyber chip and paints the brand color #38bdf8 instead of amber #f59e0b.
  // The amber APP_THEME_PRESETS alias still works, so only the builder
  // palette-chip chain is broken. Stay RED until amber joins validPalettes
  // (see Delegated Subtasks, STUDIO-AMBER-PALETTE-REGRESSION).
  const src = fs.readFileSync(STUDIO, "utf8");
  const wl = src.match(/const validPalettes = \[([^\]]+)\]/);
  assert.ok(wl, "studio.ts must declare validPalettes in setStudioPalette");
  const whitelisted = (wl[1].match(/'([a-z]+)'/g) || []).map((s) => s.slice(1, -1));

  for (const key of Object.keys(APP_PALETTES)) {
    assert.ok(
      whitelisted.includes(key),
      `canon palette '${key}' must be whitelisted in setStudioPalette (validPalettes=${JSON.stringify(whitelisted)})`
    );
  }
});

test("THEME-QA-2b REGRESSION HANDOFF (-> agent-general-worker): studio emerald light surface must equal the canon lightBg", () => {
  // Canon (theme.ts APP_PALETTES.emerald.lightBg = #f0fdf4) is what the
  // server-side dark-sync clamp applies (appSyncRoutes emerald branch) and
  // what EXTENSION_STYLES_MAP carries. studio.ts emerald-secops/emerald-sentinel
  // still ship lightBackground #ecfdf5 (the old value) — a light-mode App
  // Studio preview diverges from everything the fleet actually receives.
  // Stay RED until studio converges (see Delegated Subtasks,
  // STUDIO-EMERALD-LIGHTBG-REGRESSION).
  const studio = parseStudioPresets();
  assert.equal(
    studio["emerald-secops"]?.lightBackground?.toLowerCase(),
    APP_PALETTES.emerald.lightBg.toLowerCase(),
    "emerald-secops.lightBackground must equal canon emerald.lightBg"
  );
});
