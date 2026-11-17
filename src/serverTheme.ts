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
