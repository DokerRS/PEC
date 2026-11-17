import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EXTENSION_STYLES_MAP, getThemeStyles } from "../src/packager.js";
import { renderPopupHtml } from "../src/templates/popupHtmlTemplate.js";

/**
 * THEME-WEB-4: the dashboard theme.ts palettes are the canonical source.
 * Server-side copies (EXTENSION_STYLES_MAP, getThemeStyles paletteColors,
 * popup CSS) historically drifted (obsidian #09090b/#18181b, emerald
 * #061e14/#0d3322, light bg #f8fafc, cyber #090e1a/#111a2e). A shared
 * constant module was evaluated and rejected: the copies carry different
 * structures (border/text/card-inner/light variants, popup is a CSS string),
 * so full unification is a disproportionate diff. This test provides the
 * same drift protection by asserting hex parity against the canon.
 */

// Canon: src/client/dashboard/core/theme.ts APP_THEME_PRESETS (accent/bg/card)
const CANON_PRESETS: Record<string, { accent: string; bg: string; card: string }> = {
  "cyber-blue": { accent: "#38bdf8", bg: "#0b1120", card: "#131d36" },
  "dark-obsidian": { accent: "#c084fc", bg: "#0d1117", card: "#161b22" },
  "nordic-arctic": { accent: "#88c0d0", bg: "#242933", card: "#2e3440" },
  "emerald-secops": { accent: "#34d399", bg: "#06130d", card: "#0b1f16" },
  "sunset-amber": { accent: "#f59e0b", bg: "#1c1307", card: "#261805" },
  // enterprise-light stores the dark fallback in bg/card; the light surface
  // is the dedicated lightBg #f1f5f9 (see APP_PALETTES.light).
  "enterprise-light": { accent: "#2563eb", bg: "#f1f5f9", card: "#ffffff" },
};

// Aliases mandated by the native ImGui theme map (pec_imgui_theme.h,
// guarded by styleAudit.test.ts) - they must stay in parity with their
// target palettes instead of being deleted.
const ALIAS_TARGETS: Record<string, string> = {
  "emerald-sentinel": "emerald-secops",
  "minimal-light": "enterprise-light",
};

test("THEME-WEB-4: EXTENSION_STYLES_MAP is hex-parity with the dashboard canon", () => {
  for (const [preset, canon] of Object.entries(CANON_PRESETS)) {
    const ext = EXTENSION_STYLES_MAP[preset];
    assert.ok(ext, `${preset} must exist in EXTENSION_STYLES_MAP`);
    assert.equal(ext.primary.toLowerCase(), canon.accent.toLowerCase(), `${preset} primary must match canon accent`);
    assert.equal(ext.bg.toLowerCase(), canon.bg.toLowerCase(), `${preset} bg must match canon`);
    assert.equal(ext.card.toLowerCase(), canon.card.toLowerCase(), `${preset} card must match canon`);
  }
  for (const [alias, target] of Object.entries(ALIAS_TARGETS)) {
    assert.deepEqual(
      {
        primary: EXTENSION_STYLES_MAP[alias].primary.toLowerCase(),
        bg: EXTENSION_STYLES_MAP[alias].bg.toLowerCase(),
        card: EXTENSION_STYLES_MAP[alias].card.toLowerCase(),
      },
      {
        primary: EXTENSION_STYLES_MAP[target].primary.toLowerCase(),
        bg: EXTENSION_STYLES_MAP[target].bg.toLowerCase(),
        card: EXTENSION_STYLES_MAP[target].card.toLowerCase(),
      },
      `${alias} must stay in parity with its target palette ${target}`
    );
  }
});

test("THEME-WEB-4: getThemeStyles paletteColors are hex-parity with the canon", () => {
  const palettes: Array<[string, string, string, string]> = [
    ["cyber", "cyber-blue", "#0b1120", "#131d36"],
    ["obsidian", "dark-obsidian", "#0d1117", "#161b22"],
    ["nord", "nordic-arctic", "#242933", "#2e3440"],
    ["emerald", "emerald-secops", "#06130d", "#0b1f16"],
    ["amber", "sunset-amber", "#1c1307", "#261805"],
    ["light", "enterprise-light", "#f1f5f9", "#ffffff"],
  ];
  for (const [palette, preset, bg, card] of palettes) {
    const styles = getThemeStyles({ colorPalette: palette as any });
    const canon = CANON_PRESETS[preset];
    assert.equal(styles.primary.toLowerCase(), canon.accent.toLowerCase(), `${palette} primary must match canon`);
    assert.equal(styles.bg.toLowerCase(), bg, `${palette} bg must match canon`);
    assert.equal(styles.card.toLowerCase(), card, `${palette} card must match canon`);
  }
});

test("THEME-WEB-4: popup CSS dark surfaces are hex-parity with the canon", () => {
  const html = renderPopupHtml();
  // cyber was the drift case (#090e1a/#111a2e); all five dark palettes checked
  const expected: Array<[string, string, string]> = [
    ["cyber", "#0b1120", "#131d36"],
    ["obsidian", "#0d1117", "#161b22"],
    ["nord", "#242933", "#2e3440"],
    ["emerald", "#06130d", "#0b1f16"],
  ];
  for (const [palette, bg, card] of expected) {
    const re = new RegExp(`--bg:\\s*${bg.replace("#", "#")}\\s*;\\s*--card:\\s*${card.replace("#", "#")}`);
    assert.match(
      html.replace(/\s+/g, " "),
      new RegExp(`\\[data-palette="${palette}"\\][^{]*\\{\\s*--bg: ${bg};\\s*--card: ${card};`.replace(/\s+/g, "\\s*")),
      `popup ${palette} dark surfaces must match the canon (${bg}/${card})`
    );
  }
  // light palette dark-fallback surfaces
  assert.match(html, /--bg: #0f172a; --card: #1e293b;/, "light palette dark fallback must stay intact");
});

test("THEME-WEB-4: studio APP_THEME_PRESETS are hex-parity with the canon (bundled)", () => {
  const js = fs.readFileSync(path.join(process.cwd(), "public", "dashboard.min.js"), "utf-8");
  const checks: Array<[string, string, string]> = [
    ["cyber-blue", "#0b1120", "#131d36"],
    ["dark-obsidian", "#0d1117", "#161b22"],
    ["emerald-secops", "#06130d", "#0b1f16"],
  ];
  for (const [preset, bg, card] of checks) {
    assert.ok(
      js.includes(`"${preset}":{primary:"`),
      `${preset} must be present in the shipped bundle`
    );
    // esbuild minified shape: background:"#...",card:"#..."
    const seg = js.split(`"${preset}":{primary:"`)[1]?.slice(0, 140) || "";
    assert.ok(seg.length > 0, `${preset} segment must be extractable`);
    assert.ok(
      seg.includes(`background:"${bg}"`) && seg.includes(`card:"${card}"`),
      `${preset} bg/card must match the canon (${bg}/${card}), got: ${seg.slice(0, 80)}`
    );
  }
  // nordic-arctic lightBackground parity with the canon lightBg #f8fafc
  const nordSeg = js.split(`"nordic-arctic":{primary:"`)[1]?.slice(0, 160) || "";
  assert.ok(nordSeg.includes('lightBackground:"#f8fafc"'), "nordic-arctic lightBackground must be #f8fafc");
});

test("THEME-WEB-4: dead sunset palette removed; setServerTheme whitelists the five CSS themes", () => {
  const themeSrc = fs.readFileSync(path.join(process.cwd(), "src", "client", "dashboard", "core", "theme.ts"), "utf-8");
  assert.ok(!/^  sunset: \{/m.test(themeSrc), "APP_PALETTES must not contain the dead sunset duplicate");
  assert.ok(/SERVER_THEME_WHITELIST/.test(themeSrc), "setServerTheme must apply a whitelist");
  assert.match(themeSrc, /new Set\(\['cyber', 'obsidian', 'nord', 'emerald', 'light'\]\)/, "whitelist must cover the five CSS themes");
  // Fallback semantics: anything outside the whitelist (stale 'sunset', garbage) resets to cyber
  assert.match(
    themeSrc,
    /if \(!theme \|\| !SERVER_THEME_WHITELIST\.has\(theme\)\) \{\s*theme = 'cyber';\s*\}/,
    "unknown/stale themes must fall back to cyber"
  );
  // The shipped bundle must carry the same whitelist
  const js = fs.readFileSync(path.join(process.cwd(), "public", "dashboard.min.js"), "utf-8");
  assert.ok(js.includes('"cyber","obsidian","nord","emerald","light"'), "shipped bundle must contain the server-theme whitelist");
});
