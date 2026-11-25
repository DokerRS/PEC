import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  clearRoutingPresetsCache,
  getRoutingPresets,
  getRoutingPresetsPath,
  saveRoutingPresets,
  saveGeofile,
} from "../src/storage.js";
import { expandRuleDomains, generatePacScript, materializePresetSources } from "../src/routing.js";
import { saveProfile, getAllProfiles } from "../src/routing.js";
import { getProxyConfig } from "../src/instances.js";
import type { PresetSource, RoutingPresetItem, RoutingProfile, RoutingRule } from "../src/types.js";

/**
 * VERIFY-BUILDER-QA (independent QA pass over GEO-PRESET-UX-2/3, 270185d+78cbe6a
 * + 5ca4542): closes coverage holes found by the pass —
 *   (1) live file layer whose geofile is MISSING on this server must fall back
 *       to the entries snapshot (the "import on a clean server" case, the
 *       !buffer branch in getPresetSourceEntries that shipped without a test);
 *   (2) a USER layered preset referenced by a routing profile must expand
 *       through the real PAC generator (generatePacScript), not only through
 *       expandRuleDomains directly;
 *   (3) full server-level round-trip of a legacy flat store: read (migrates +
 *       backup) -> upsert with modified sources -> read again (stable,
 *       idempotent second migration).
 */

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function uniqueEntry(): string {
  return `qa-${Math.random().toString(36).slice(2, 10)}.example`;
}

test("VERIFY-QA (1): live file layer with a MISSING geofile falls back to the entries snapshot", () => {
  const dataDir = makeTempDir("pec-qa-data-");
  const geoDir = makeTempDir("pec-qa-geo-");
  process.env.DATA_DIR = dataDir;
  process.env.GEOFILES_DIR = geoDir;
  clearRoutingPresetsCache();

  const fileId = saveGeofile(Buffer.from("sniff via the stored file\n", "utf-8"), ".txt").fileId;
  const snapshot = [uniqueEntry(), uniqueEntry()];
  const preset: RoutingPresetItem = {
    id: "preset:qa_missing_geofile",
    name: "QA Missing Geofile",
    category: "qa",
    description: "",
    type: "domain",
    source: "file",
    entries: snapshot,
    sources: [
      { kind: "manual", entries: ["manual-qa.example"] },
      // live layer whose backing file will disappear (clean-server import)
      { kind: "file", fileId, fileName: "qa-missing.txt", tags: ["QA"], entries: snapshot },
    ],
  } as RoutingPresetItem;
  saveRoutingPresets([preset]);

  // simulate the clean-server case: the geofile store does not have this file
  const stored = path.join(geoDir, getStoredGeofileName(geoDir, fileId));
  assert.ok(stored && fs.existsSync(stored), "geofile must exist before removal");
  fs.unlinkSync(stored);

  const restored = getRoutingPresets().find((p) => p.id === preset.id) as RoutingPresetItem;
  const materialized = materializePresetSources(restored.sources as PresetSource[]);
  // manual layer + the snapshot fallback of the orphaned file layer — NOT empty
  assert.deepEqual(
    materialized,
    ["manual-qa.example", ...snapshot],
    "missing geofile must degrade to the entries snapshot, preserving the union",
  );

  // the PAC-facing expansion must see the same flat list
  const rule: RoutingRule = {
    id: "r_qa",
    name: "qa",
    targetType: "preset",
    pattern: "preset:qa_missing_geofile",
    action: "proxy",
    enabled: true,
  } as RoutingRule;
  assert.deepEqual(expandRuleDomains(rule), ["manual-qa.example", ...snapshot]);
});

test("VERIFY-QA (2): a USER layered preset referenced by a profile expands through generatePacScript", () => {
  const dataDir = makeTempDir("pec-qa-data2-");
  process.env.DATA_DIR = dataDir;
  clearRoutingPresetsCache();

  const manualEntry = uniqueEntry();
  const fileEntry = uniqueEntry();
  const layered: RoutingPresetItem = {
    id: "preset:qa_pac_layers",
    name: "QA PAC Layers",
    category: "qa",
    description: "",
    type: "domain",
    source: "file",
    entries: [manualEntry, fileEntry],
    sources: [
      { kind: "manual", entries: [manualEntry] },
      { kind: "file", name: "qa-pac.txt", entries: [fileEntry] },
    ],
  } as RoutingPresetItem;
  saveRoutingPresets([layered]);

  const profile = {
    id: "prof_qa_pac",
    name: "QA PAC Profile",
    description: "",
    defaultPolicy: "direct",
    targetScope: "all",
    isDefault: false,
    updatedAt: new Date().toISOString(),
    rules: [
      {
        id: "r1",
        name: "QA Layers to Proxy",
        targetType: "preset",
        pattern: "preset:qa_pac_layers",
        action: "proxy",
        enabled: true,
      },
    ],
  } as unknown as RoutingProfile;
  saveProfile(profile);
  const saved = getAllProfiles().find((p) => p.id === profile.id) as RoutingProfile;
  assert.ok(saved, "profile must persist");

  const pac = generatePacScript(saved, getProxyConfig());
  assert.ok(pac.includes(manualEntry), "manual layer entry must reach the PAC script");
  assert.ok(pac.includes(fileEntry), "file snapshot layer entry must reach the PAC script");
});

test("VERIFY-QA (3): legacy flat store round-trip — migrate, upsert, re-read is stable", () => {
  const dataDir = makeTempDir("pec-qa-data3-");
  const presetsPath = path.join(dataDir, "routing_presets.json");
  process.env.DATA_DIR = dataDir;
  clearRoutingPresetsCache();

  // legacy flat shape (no sources[])
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    presetsPath,
    JSON.stringify([
      {
        id: "preset:qa_legacy",
        name: "QA Legacy",
        category: "qa",
        description: "",
        type: "domain",
        source: "file",
        sourceUrl: "https://qa.example/legacy.txt",
        sourceTag: "ads",
        entries: ["legacy-a.example", "legacy-b.example"],
      },
    ]),
    "utf-8",
  );

  // read #1 migrates flat -> layers with a backup
  const first = getRoutingPresets();
  const migrated = first.find((p) => p.id === "preset:qa_legacy") as RoutingPresetItem;
  assert.equal(migrated.sources?.[0]?.kind, "url", "sourceUrl branch must yield a url layer");
  const backupName = fs.readdirSync(dataDir).find((f) => f.startsWith("routing_presets.json.backup-"));
  assert.ok(backupName, "first read must leave a timestamped backup");

  // builder-equivalent write: modify sources via the storage upsert path
  const newEntry = uniqueEntry();
  const updatedSources: PresetSource[] = [
    { kind: "manual", entries: ["legacy-a.example", newEntry] },
    { kind: "url", url: "https://qa.example/legacy.txt", tag: "ads", entries: ["legacy-b.example"] },
  ];
  saveRoutingPresets(
    first.map((p) => (p.id === "preset:qa_legacy" ? { ...p, sources: updatedSources, entries: ["legacy-a.example", newEntry, "legacy-b.example"] } : p)),
  );
  clearRoutingPresetsCache();

  // read #2 and #3: stable, and migration must NOT re-wrap the layered shape
  const second = getRoutingPresets().find((p) => p.id === "preset:qa_legacy") as RoutingPresetItem;
  assert.deepEqual(second.sources?.map((s) => s.kind), ["manual", "url"]);
  const third = getRoutingPresets().find((p) => p.id === "preset:qa_legacy") as RoutingPresetItem;
  assert.deepEqual(third.sources, second.sources, "second read must be idempotent (no re-wrap)");

  // only one backup must exist: no backup churn on already-migrated stores
  const backups = fs.readdirSync(dataDir).filter((f) => f.startsWith("routing_presets.json.backup-"));
  assert.equal(backups.length, 1, "idempotent migration must not create extra backups");
});

/** Locate the on-disk geofile for a fileId (content-addressed <sha256><ext>). */
function getStoredGeofileName(geoDir: string, fileId: string): string {
  const hit = fs.readdirSync(geoDir).find((f) => f.startsWith(fileId));
  if (hit) return hit;
  // getGeofileName() is null without the store index; fall back to hashing-free scan
  const files = fs.readdirSync(geoDir);
  if (files.length === 1) return files[0];
  throw new Error(`geofile for ${fileId} not found in ${geoDir}: ${files.join(",")}`);
}
