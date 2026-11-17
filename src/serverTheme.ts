import { readJsonStore, writeJsonAtomic } from "./jsonStore.js";
import { getServerThemePath } from "./storage.js";
import { logger } from "./logger.js";

/**
 * THEME-SRC-1: server-side store for the dashboard appearance
 * (data/server_theme.json). The dashboard "Appearance" popover is the source
 * of truth for fleet theming while the sync toggle is ON (THEME-SRC-3);
 * writes go through the admin-only endpoint - the fleet token never gets
 * write access.
 */

export type ServerThemePalette = "cyber" | "obsidian" | "nord" | "emerald" | "amber" | "light";
export type ServerThemeMode = "dark" | "light";

export interface ServerThemeState {
  palette: ServerThemePalette;
  mode: ServerThemeMode;
  syncEnabled: boolean;
}

export const SERVER_THEME_PALETTES: ReadonlySet<string> = new Set(["cyber", "obsidian", "nord", "emerald", "amber", "light"]);
export const SERVER_THEME_MODES: ReadonlySet<string> = new Set(["dark", "light"]);

export const DEFAULT_SERVER_THEME: ServerThemeState = {
  palette: "cyber",
  mode: "dark",
  syncEnabled: true,
};

/**
 * THEME-SRC-3: dashboard palette id -> app presetStyle (the style field of
 * theme.ts APP_THEME_PRESETS; hex parity of these values with the server
 * EXTENSION_STYLES_MAP is enforced by themePaletteParity.test.ts).
 */
export const PALETTE_TO_APP_STYLE: Record<ServerThemePalette, string> = {
  cyber: "cyber-blue",
  obsidian: "dark-obsidian",
  nord: "nordic-arctic",
  emerald: "emerald-secops",
  amber: "sunset-amber",
  light: "enterprise-light",
};

/**
 * THEME-SRC-3: canonical dark surfaces per app presetStyle (theme.ts
 * APP_THEME_PRESETS bg/card + accent; enterprise-light carries its light
 * surface #f1f5f9/#ffffff — in dark mode the THEME-WEB-3 luminance clamps
 * flip it to the dark defaults, matching APP_PALETTES.light dark fallback).
 * Lives here instead of importing EXTENSION_STYLES_MAP to avoid a
 * serverTheme -> packager -> appPackager -> serverTheme import cycle; hex
 * parity with EXTENSION_STYLES_MAP is asserted in serverThemeSync.test.ts.
 */
export const APP_STYLE_SURFACES: Record<string, { primary: string; background: string; card: string }> = {
  "cyber-blue": { primary: "#38bdf8", background: "#0b1120", card: "#131d36" },
  "dark-obsidian": { primary: "#c084fc", background: "#0d1117", card: "#161b22" },
  "nordic-arctic": { primary: "#88c0d0", background: "#242933", card: "#2e3440" },
  "emerald-secops": { primary: "#34d399", background: "#06130d", card: "#0b1f16" },
  "sunset-amber": { primary: "#f59e0b", background: "#1c1307", card: "#261805" },
  "enterprise-light": { primary: "#2563eb", background: "#f1f5f9", card: "#ffffff" },
};

export interface FleetTheme {
  palette: ServerThemePalette;
  mode: ServerThemeMode;
  syncEnabled: boolean;
  style: string;
  primary: string;
  background: string;
  card: string;
}

/**
 * THEME-SRC-3: the dashboard theme resolved into fleet-facing values.
 * Null when the dashboard never pushed (consumers fall back to the
 * legacy/neutral sources).
 */
export function resolveFleetTheme(): FleetTheme | null {
  const theme = loadServerTheme();
  if (!theme) return null;
  const style = PALETTE_TO_APP_STYLE[theme.palette];
  const surface = APP_STYLE_SURFACES[style];
  return { ...theme, style, primary: surface.primary, background: surface.background, card: surface.card };
}

export interface ClientTheme {
  palette: string;
  preset: string;
  mode: string;
  primary: string;
  background: string;
  card: string;
  /** THEME-SRC-FIX-3: "dashboard" while the global sync toggle is ON —
   * popup clients apply this mode server-first; "constructor" keeps the
   * local theme toggle in charge. */
  source: "dashboard" | "constructor";
}

/**
 * THEME-SRC-3 core: resolve the theme delivered to sync consumers.
 *   global sync ON            -> the dashboard panel theme (dashboard-as-source)
 *   global OFF / no store     -> the constructor themes (classic behavior,
 *                                replacing the THEME-WEB-1 neutral semantics);
 *                                absent config keys degrade to the neutral
 *                                cyber-blue defaults
 *   no global store           -> legacy per-config themeSyncEnabled decides
 *                                (migration without breaking installations)
 */
export function resolveSyncThemeForClients(cfg: {
  colorPalette?: string;
  presetStyle?: string;
  defaultThemeMode?: string;
  themeColor?: string;
  themeBackground?: string;
  themeCard?: string;
  themeSyncEnabled?: boolean;
}): { themeSyncOn: boolean; theme: ClientTheme } {
  const themeSyncOn = resolveThemeSyncEnabled(cfg.themeSyncEnabled);
  const fleet = resolveFleetTheme();
  if (themeSyncOn && fleet) {
    return {
      themeSyncOn: true,
      theme: {
        palette: fleet.palette,
        preset: fleet.style,
        mode: fleet.mode,
        primary: fleet.primary,
        background: fleet.background,
        card: fleet.card,
        source: "dashboard",
      },
    };
  }
  const preset = typeof cfg.presetStyle === "string" && cfg.presetStyle ? cfg.presetStyle : "cyber-blue";
  const styles = APP_STYLE_SURFACES[preset] || APP_STYLE_SURFACES["cyber-blue"];
  const palette =
    (typeof cfg.colorPalette === "string" && cfg.colorPalette) ||
    Object.keys(PALETTE_TO_APP_STYLE).find((id) => PALETTE_TO_APP_STYLE[id as ServerThemePalette] === preset) ||
    "cyber";
  return {
    themeSyncOn: false,
    theme: {
      palette,
      preset,
      mode: cfg.defaultThemeMode || "dark",
      primary: cfg.themeColor || styles.primary,
      background: cfg.themeBackground || styles.background,
      card: cfg.themeCard || styles.card,
      source: "constructor",
    },
  };
}

/**
 * THEME-SRC-FIX-2: overlay the dashboard theme onto an extension build
 * configuration while the global sync toggle is ON and the store is
 * non-empty (read-only via resolveFleetTheme - raw localStorage-style
 * strings never reach the build). OFF or an empty store returns the
 * constructor configuration untouched (legacy behavior, no breakage).
 * Shared by the packager build pipeline and the studio live preview so
 * both follow the same contract as the app path (buildAppProfile).
 */
export function applyDashboardThemeToClientConfig<T extends {
  colorPalette?: string;
  presetStyle?: string;
  defaultThemeMode?: string;
  themeColor?: string;
  themeBackground?: string;
  themeCard?: string;
  themeSyncEnabled?: boolean;
}>(cfg: T): T {
  const fleet = resolveFleetTheme();
  if (!resolveThemeSyncEnabled((cfg as any).themeSyncEnabled) || !fleet) {
    return cfg;
  }
  return {
    ...cfg,
    colorPalette: fleet.palette,
    presetStyle: fleet.style,
    defaultThemeMode: fleet.mode,
    themeColor: fleet.primary,
    themeBackground: fleet.background,
    themeCard: fleet.card,
  };
}

/**
 * Returns the stored dashboard theme, or null when no theme was ever pushed
 * (server_theme.json absent/unreadable). Null means "dashboard never spoke":
 * consumers fall back to legacy per-config behavior / neutral defaults.
 */
export function loadServerTheme(): ServerThemeState | null {
  const stored = readJsonStore<Partial<ServerThemeState>>(getServerThemePath());
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return null;
  }
  return {
    palette: SERVER_THEME_PALETTES.has(String(stored.palette)) ? (stored.palette as ServerThemePalette) : DEFAULT_SERVER_THEME.palette,
    mode: SERVER_THEME_MODES.has(String(stored.mode)) ? (stored.mode as ServerThemeMode) : DEFAULT_SERVER_THEME.mode,
    syncEnabled: stored.syncEnabled === undefined ? DEFAULT_SERVER_THEME.syncEnabled : stored.syncEnabled === true,
  };
}

export function saveServerTheme(updates: Partial<ServerThemeState>): ServerThemeState {
  const current = loadServerTheme() || DEFAULT_SERVER_THEME;
  const merged: ServerThemeState = {
    palette: SERVER_THEME_PALETTES.has(String(updates.palette)) ? (updates.palette as ServerThemePalette) : current.palette,
    mode: SERVER_THEME_MODES.has(String(updates.mode)) ? (updates.mode as ServerThemeMode) : current.mode,
    syncEnabled: updates.syncEnabled === undefined ? current.syncEnabled : updates.syncEnabled === true,
  };
  writeJsonAtomic(getServerThemePath(), merged);
  logger.info(`[serverTheme] Dashboard appearance updated: palette=${merged.palette}, mode=${merged.mode}, syncEnabled=${merged.syncEnabled}`);
  return { ...merged };
}

/**
 * THEME-SRC-3: global sync gate. The dashboard store wins when it exists;
 * otherwise the legacy per-config themeSyncEnabled flag (THEME-WEB-1) applies
 * so existing installations keep their behavior. Both default to ON.
 */
export function resolveThemeSyncEnabled(legacyPerConfig?: boolean): boolean {
  const global = loadServerTheme();
  if (global) {
    return global.syncEnabled;
  }
  return legacyPerConfig !== false;
}
