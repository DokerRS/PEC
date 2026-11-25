import "./loadEnv.js";
import fs from "node:fs";
import path from "node:path";
import type { PresetSource, RoutingPresetItem } from "./types.js";
import { readJsonStore, writeJsonAtomic } from "./jsonStore.js";
import { GEO_PRESETS } from "./defaultPresets.js";


export function getDataDir(): string {
  const dir = path.resolve(process.env.DATA_DIR || "./data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getProxiesStorePath(): string {
  return path.resolve(process.env.PROXIES_STORE_PATH || path.join(getDataDir(), "proxies.json"));
}

export function getCredsStorePath(): string {
  return path.resolve(process.env.CREDS_STORE || path.join(getDataDir(), "current_creds.json"));
}

export function getProxyConfigPath(): string {
  return path.resolve(process.env.PROXY_CONFIG_PATH || path.join(getDataDir(), "proxy_config.json"));
}

export function getRoutingProfilesPath(): string {
  return path.resolve(process.env.ROUTING_PROFILES_PATH || path.join(getDataDir(), "routing_profiles.json"));
}

export function getInstancesMetaPath(): string {
  return path.resolve(process.env.INSTANCES_META_PATH || path.join(getDataDir(), "instances_meta.json"));
}

export function getRotationConfigPath(): string {
  return path.resolve(process.env.ROTATION_CONFIG_PATH || path.join(getDataDir(), "rotation_config.json"));
}

export function get3xuiPanelsPath(): string {
  return path.resolve(process.env.PANELS_3XUI_PATH || path.join(getDataDir(), "panels_3xui.json"));
}

export function getRotationHistoryPath(): string {
  return path.resolve(process.env.ROTATION_HISTORY_PATH || path.join(getDataDir(), "rotation_history.json"));
}

export function getDashboardAuthPath(): string {
  return path.resolve(process.env.DASHBOARD_AUTH_PATH || path.join(getDataDir(), "dashboard_auth.json"));
}

export function getAdCachePath(): string {
  return path.resolve(process.env.AD_CACHE_PATH || path.join(getDataDir(), "ad_cache.json"));
}

export function getAdConfigPath(): string {
  return path.resolve(process.env.AD_CONFIG_PATH || path.join(getDataDir(), "ad_config.json"));
}

export function getServerThemePath(): string {
  return path.resolve(process.env.SERVER_THEME_PATH || path.join(getDataDir(), "server_theme.json"));
}

export function getBuilderConfigPath(): string {
  return path.resolve(process.env.BUILDER_CONFIG || path.join(getDataDir(), "extension_build_config.json"));
}

export function getAppBuildConfigPath(): string {
  return path.resolve(process.env.APP_BUILD_CONFIG || path.join(getDataDir(), "app_build_config.json"));
}

export function getAppBuildInfoPath(): string {
  return path.resolve(process.env.APP_BUILD_INFO || path.join(getDataDir(), "app_build_info.json"));
}

export function getReleasesMetaPath(): string {
  return path.resolve(process.env.RELEASES_META_PATH || path.join(getDataDir(), "releases_meta.json"));
}

export function getReleasesDir(): string {
  return path.resolve(process.env.PEC_RELEASES_DIR || "./dist/releases");
}

let cachedRoutingPresetsPath: string | null = null;
let cachedRoutingPresets: RoutingPresetItem[] | null = null;

export function clearRoutingPresetsCache(): void {
  cachedRoutingPresetsPath = null;
  cachedRoutingPresets = null;
}

/**
 * GEO-PRESET-UX-2: one-time legacy migration (flat preset -> single layer).
 * Idempotent: items that already carry a `sources` array pass through
 * untouched. Kind inference follows the agreed table:
 *   1. sourceUrl set            -> { kind: "url", url, tag: sourceTag }  (old remote imports)
 *   2. only sourceTag set       -> { kind: "file", name, tag, entries } (old file imports with tag)
 *   3. neither field set        -> { kind: "manual", entries }          (hand-made, builtin snapshots)
 * The flat entries/domains/source* fields are preserved as-is so the
 * materialized projection stays byte-identical after migration.
 */
function migratePresetItemToSources(item: RoutingPresetItem): RoutingPresetItem | null {
  if (item && Array.isArray((item as any).sources)) {
    return null; // already migrated
  }
  const snapshot: string[] = Array.isArray(item?.entries)
    ? item.entries
    : Array.isArray(item?.domains)
      ? item.domains
      : [];
  const sourceUrl = typeof item?.sourceUrl === "string" ? item.sourceUrl.trim() : "";
  const sourceTag = typeof item?.sourceTag === "string" ? item.sourceTag.trim() : "";

  let layer: PresetSource;
  if (sourceUrl) {
    layer = {
      kind: "url",
      url: sourceUrl,
      ...(sourceTag ? { tag: sourceTag } : {}),
      entries: [...snapshot],
      ...(item.lastUpdated ? { lastUpdated: item.lastUpdated } : {}),
    };
  } else if (sourceTag) {
    layer = { kind: "file", name: item?.name || item?.id || "imported list", tag: sourceTag, entries: [...snapshot] };
  } else {
    layer = { kind: "manual", entries: [...snapshot] };
  }
  return { ...item, sources: [layer] };
}

/**
 * Migrate a whole preset store. Returns the original array reference when
 * nothing needs changing (common case after the first run).
 */
function migrateRoutingPresetsList(list: RoutingPresetItem[]): RoutingPresetItem[] | null {
  let changed = false;
  const migrated = list.map((item) => {
    const next = migratePresetItemToSources(item);
    if (next) {
      changed = true;
      return next;
    }
    return item;
  });
  return changed ? migrated : null;
}

function backupRoutingPresetsFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = `${filePath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  } catch (err) {
    console.error("[storage] Failed to create routing presets backup:", err);
    return null;
  }
}

export function getRoutingPresetsPath(): string {
  return path.resolve(process.env.ROUTING_PRESETS_PATH || path.join(getDataDir(), "routing_presets.json"));
}

export function saveRoutingPresets(items: RoutingPresetItem[]): void {
  const filePath = getRoutingPresetsPath();
  cachedRoutingPresetsPath = filePath;
  cachedRoutingPresets = items;
  writeJsonAtomic(filePath, items);
}

export function getRoutingPresets(): RoutingPresetItem[] {
  const filePath = getRoutingPresetsPath();
  if (cachedRoutingPresets && cachedRoutingPresetsPath === filePath) {
    return cachedRoutingPresets;
  }
  const loaded = readJsonStore<RoutingPresetItem[]>(filePath);
  if (Array.isArray(loaded) && loaded.length > 0) {
    let updated = false;
    for (const geo of GEO_PRESETS || []) {
      const existing = loaded.find((item) => item.id === geo.id && item.source === "builtin");
      if (existing) {
        const existingDomains = existing.domains || [];
        const existingEntries = existing.entries || [];
        const missingDomains = geo.domains.filter(
          (d) => !existingDomains.includes(d) && !existingEntries.includes(d)
        );
        if (missingDomains.length > 0) {
          existing.domains = Array.from(new Set([...existingDomains, ...geo.domains]));
          existing.entries = Array.from(new Set([...existingEntries, ...geo.domains]));
          updated = true;
        }
      }
    }
    if (updated) {
      try {
        saveRoutingPresets(loaded);
      } catch (err) {
        console.error("[storage] Failed to update builtin routing presets:", err);
      }
    }

    // GEO-PRESET-UX-2: legacy flat presets -> single-layer `sources` shape.
    // Idempotent; the original file is backed up before the atomic rewrite.
    const migrated = migrateRoutingPresetsList(loaded);
    if (migrated) {
      try {
        backupRoutingPresetsFile(filePath);
        saveRoutingPresets(migrated);
        console.log("[storage] Migrated legacy routing presets to sources[] layers");
      } catch (err) {
        console.error("[storage] Failed to persist routing presets migration:", err);
      }
      cachedRoutingPresetsPath = filePath;
      cachedRoutingPresets = migrated;
      return migrated;
    }

    cachedRoutingPresetsPath = filePath;
    cachedRoutingPresets = loaded;
    return loaded;
  }
  const seeded: RoutingPresetItem[] = (GEO_PRESETS || []).map((p) => {
    const entries = [...p.domains];
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      description: p.description,
      type: p.id === "preset:corporate_internal" ? "cidr" : "domain",
      source: "builtin",
      domains: entries,
      entries,
      // GEO-PRESET-UX-2: builtin snapshots materialize as a manual layer
      // (inference rule 3: no sourceUrl/sourceTag). "Duplicate to custom"
      // copies this layer verbatim.
      sources: [{ kind: "manual", entries: [...entries] }] as PresetSource[],
      lastUpdated: new Date().toISOString(),
    };
  });
  try {
    saveRoutingPresets(seeded);
  } catch (err) {
    console.error("[storage] Failed to save default routing presets:", err);
  }
  cachedRoutingPresetsPath = filePath;
  cachedRoutingPresets = seeded;
  return seeded;
}

