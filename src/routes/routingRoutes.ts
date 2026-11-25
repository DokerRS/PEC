import crypto from "node:crypto";
import { Router, Request, Response } from "express";
import { GEO_PRESETS, getAllProfiles, saveProfile, deleteProfile } from "../routing.js";
import {
  findGeoPresetById,
  getPresetSourceEntries,
  inferPresetSourceType,
  materializePresetEntries,
  materializePresetSources,
} from "../routing.js";
import {
  getRoutingPresets,
  saveRoutingPresets,
  saveGeofile,
  readGeofile,
  getGeofileName,
} from "../storage.js";
import { PresetSource, RoutingPresetItem } from "../types.js";
import {
  parseGeoSite,
  parseGeoIp,
  parsePlaintextList,
  parseGeodataBuffer,
  listGeodataTags,
} from "../geodata/datParser.js";
import { validateSafeEndpointUrlAsync, createSsrfPinnedFetch } from "../rotate.js";
import { MAX_ROUTING_PRESET_ENTRIES, isWithinPresetEntryLimit } from "../routing.js";
import { recordAudit, getClientIp } from "../audit.js";

async function downloadBodyWithLimit(response: globalThis.Response, maxSize: number): Promise<Buffer> {
  const clHeader = response.headers.get("content-length");
  if (clHeader) {
    const cl = parseInt(clHeader, 10);
    if (!isNaN(cl) && cl > maxSize) {
      throw new Error(`Downloaded file exceeds limit of ${Math.round(maxSize / (1024 * 1024))}MB`);
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const ab = await response.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length > maxSize) {
      throw new Error(`Downloaded file exceeds limit of ${Math.round(maxSize / (1024 * 1024))}MB`);
    }
    return buf;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.length;
      if (totalBytes > maxSize) {
        try { reader.cancel(); } catch {}
        throw new Error(`Downloaded file exceeds limit of ${Math.round(maxSize / (1024 * 1024))}MB`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

// ============================================================================
// GEO-PRESET-UX-2: layered preset sources (sources[]).
// The flat entries/domains fields stay derived projections (materialized
// union) so the PAC contract remains a plain string list.
// ============================================================================

type SourceValidationResult =
  | { ok: true; source: PresetSource }
  | { ok: false; error: string };

function cleanSourceEntries(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    return raw.map(String).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return parsePlaintextList(raw);
  }
  return null;
}

/** GEO-PRESET-UX-2: a geoip/CIDR layer must not land in a domain preset and vice versa. */
function assertSourceTypeMatch(
  source: PresetSource,
  presetType: "domain" | "cidr",
  label: string
): string | null {
  const layerType = inferPresetSourceType(source);
  if (layerType !== presetType) {
    if (source.kind === "geo-tag") {
      return layerType === "cidr"
        ? `Layer "${label}" is a geoip list and cannot be added to a ${presetType} preset`
        : `Layer "${label}" is a domain list and cannot be added to a ${presetType} preset`;
    }
    return `Layer "${label}" contains ${layerType === "cidr" ? "CIDR" : "domain"} entries that do not match the ${presetType} preset type`;
  }
  return null;
}

/**
 * Shape-validate one raw source object against the container preset type.
 * geo-tag refs are resolved live against GEO_PRESETS; url layers carry an
 * optional fetched snapshot; file/manual layers require non-empty entries.
 */
function validatePresetSource(raw: any, presetType: "domain" | "cidr", index: number): SourceValidationResult {
  const label = `#${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `sources[${index}] must be an object` };
  }
  switch (raw.kind) {
    case "geo-tag": {
      if (typeof raw.ref !== "string" || !raw.ref.trim()) {
        return { ok: false, error: `sources[${index}].ref is required for geo-tag layers` };
      }
      const ref = raw.ref.trim();
      if (!findGeoPresetById(ref)) {
        return { ok: false, error: `sources[${index}]: unknown geo-tag ref "${ref}" (not in GEO_PRESETS)` };
      }
      const source: PresetSource = { kind: "geo-tag", ref };
      const mismatch = assertSourceTypeMatch(source, presetType, ref);
      if (mismatch) return { ok: false, error: mismatch };
      return { ok: true, source };
    }
    case "url": {
      if (typeof raw.url !== "string" || !raw.url.trim()) {
        return { ok: false, error: `sources[${index}].url is required for url layers` };
      }
      const source: PresetSource = {
        kind: "url",
        url: raw.url.trim(),
        ...(typeof raw.tag === "string" && raw.tag.trim() ? { tag: raw.tag.trim() } : {}),
        ...(Array.isArray(raw.entries) ? { entries: cleanSourceEntries(raw.entries) || [] } : {}),
        ...(typeof raw.lastUpdated === "string" ? { lastUpdated: raw.lastUpdated } : {}),
      };
      if (source.entries && source.entries.length > MAX_ROUTING_PRESET_ENTRIES) {
        return { ok: false, error: `sources[${index}] exceeds the ${MAX_ROUTING_PRESET_ENTRIES} entry limit` };
      }
      const mismatch = assertSourceTypeMatch(source, presetType, source.url);
      if (mismatch) return { ok: false, error: mismatch };
      return { ok: true, source };
    }
    case "file": {
      // GEO-BUILDER-UX-3: a file layer is live when it references a stored
      // geofile ({fileId, fileName, tags[]}); a plain {name, entries} object
      // stays a legacy snapshot layer.
      const fileId = typeof raw.fileId === "string" && raw.fileId.trim() ? raw.fileId.trim() : undefined;
      if (fileId && !/^[a-f0-9]{64}$/.test(fileId)) {
        return { ok: false, error: `sources[${index}].fileId must be a sha256 hex digest` };
      }
      const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
      const fileName = typeof raw.fileName === "string" && raw.fileName.trim() ? raw.fileName.trim() : undefined;
      const tags = Array.isArray(raw.tags)
        ? raw.tags.map(String).map((t) => t.trim().toUpperCase()).filter(Boolean)
        : undefined;
      const entries = cleanSourceEntries(raw.entries);
      const hasEntries = !!entries && entries.length > 0;
      if (!fileId && (!entries || entries.length === 0)) {
        return { ok: false, error: `sources[${index}].entries is required (non-empty) for file layers` };
      }
      if (hasEntries && entries.length > MAX_ROUTING_PRESET_ENTRIES) {
        return { ok: false, error: `sources[${index}] exceeds the ${MAX_ROUTING_PRESET_ENTRIES} entry limit` };
      }
      const display = fileName || name || fileId || "file";
      const source: PresetSource = {
        kind: "file",
        ...(name ? { name } : {}),
        ...(typeof raw.tag === "string" && raw.tag.trim() ? { tag: raw.tag.trim().toUpperCase() } : {}),
        ...(tags && tags.length ? { tags } : {}),
        ...(fileId ? { fileId } : {}),
        ...(fileName ? { fileName } : {}),
        entries: hasEntries ? entries : [],
      };
      const mismatch = assertSourceTypeMatch(source, presetType, display);
      if (mismatch) return { ok: false, error: mismatch };
      return { ok: true, source };
    }
    case "manual": {
      const entries = cleanSourceEntries(raw.entries);
      if (!entries || entries.length === 0) {
        return { ok: false, error: `sources[${index}].entries is required (non-empty) for manual layers` };
      }
      if (entries.length > MAX_ROUTING_PRESET_ENTRIES) {
        return { ok: false, error: `sources[${index}] exceeds the ${MAX_ROUTING_PRESET_ENTRIES} entry limit` };
      }
      const source: PresetSource = { kind: "manual", entries };
      const mismatch = assertSourceTypeMatch(source, presetType, "manual");
      if (mismatch) return { ok: false, error: mismatch };
      return { ok: true, source };
    }
    default:
      return { ok: false, error: `sources[${index}].kind must be one of: geo-tag, url, file, manual` };
  }
}

function validatePresetSources(rawSources: unknown, presetType: "domain" | "cidr"): SourceValidationResult {
  if (!Array.isArray(rawSources)) {
    return { ok: false, error: "sources must be an array" };
  }
  const sources: PresetSource[] = [];
  for (let i = 0; i < rawSources.length; i++) {
    const res = validatePresetSource(rawSources[i], presetType, i);
    if (!res.ok) return res;
    sources.push(res.source);
  }
  return { ok: true, source: sources as unknown as PresetSource };
}

/** geo-tag layers materialize live; inline their current content for GET/export round-trips. */
function inlineSourceEntries(source: PresetSource): PresetSource {
  if (source.kind === "geo-tag") {
    const geo = findGeoPresetById(source.ref);
    return { ...source, entries: geo ? [...geo.domains] : source.entries || [] };
  }
  return source;
}

/** GET/export projection: legacy flat fields + layer union + per-layer inline entries. */
function serializePresetForApi(p: RoutingPresetItem) {
  const entries = materializePresetEntries(p);
  return {
    ...p,
    sources: (p.sources || []).map(inlineSourceEntries),
    entries,
    entriesCount: entries.length,
  };
}

/** Derive the legacy top-level source/sourceUrl/sourceTag fields from layers (first url layer wins). */
function deriveLegacySourceFields(sources: PresetSource[]): {
  source: "remote" | "file";
  sourceUrl?: string;
  sourceTag?: string;
} {
  const urlLayer = sources.find((s) => s.kind === "url") as Extract<PresetSource, { kind: "url" }> | undefined;
  if (urlLayer) {
    return {
      source: "remote",
      sourceUrl: urlLayer.url,
      ...(urlLayer.tag ? { sourceTag: urlLayer.tag } : {}),
    };
  }
  const tagLayer = sources.find((s) => s.kind === "file" && s.tag) as
    | Extract<PresetSource, { kind: "file" }>
    | undefined;
  return { source: "file", ...(tagLayer?.tag ? { sourceTag: tagLayer.tag } : {}) };
}

/** Parse an uploaded .dat/.txt body into entries (shared by import-file and resolve-layer). */
function decodeUploadedFileContent(filename: string, content: unknown): Buffer {
  if (filename.toLowerCase().endsWith(".dat")) {
    return Buffer.from(String(content), "base64");
  }
  const contentStr = String(content);
  if (
    !contentStr.includes("\n") &&
    !contentStr.includes("\r") &&
    /^[A-Za-z0-9+/=]+$/.test(contentStr.trim()) &&
    contentStr.trim().length > 16
  ) {
    try {
      const decoded = Buffer.from(contentStr, "base64");
      const decodedStr = decoded.toString("utf-8");
      if (decodedStr.includes("\n") || decodedStr.includes(".")) {
        return decoded;
      }
      return Buffer.from(contentStr, "utf-8");
    } catch {
      return Buffer.from(contentStr, "utf-8");
    }
  }
  return Buffer.from(contentStr, "utf-8");
}

function slugifyPresetId(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "preset";
  return `preset:${slug}-${crypto.randomBytes(3).toString("hex")}`;
}



export function createRoutingRouter(): Router {
  const router = Router();

  // Presets CRUD
  router.get("/api/routing/presets", (_req: Request, res: Response) => {
    const presets = getRoutingPresets();
    res.json(presets.map(serializePresetForApi));
  });

  router.get("/api/routing/presets/:id", (req: Request, res: Response) => {
    const presets = getRoutingPresets();
    const preset = presets.find((p) => p.id === req.params.id);
    if (!preset) {
      return res.status(404).json({ error: "Preset not found" });
    }
    res.json(serializePresetForApi(preset));
  });

  router.post("/api/routing/presets", (req: Request, res: Response) => {
    try {
      const { id, name, category, description } = req.body;
      if (!id || typeof id !== "string" || !id.trim()) {
        return res.status(400).json({ error: "id is required" });
      }
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "name is required" });
      }

      const presets = getRoutingPresets();
      const cleanId = id.trim();
      const existingIdx = presets.findIndex((p) => p.id === cleanId);
      if (
        (existingIdx >= 0 && presets[existingIdx].source === "builtin") ||
        GEO_PRESETS.some((gp) => gp.id === cleanId)
      ) {
        return res.status(400).json({ error: "Cannot overwrite builtin preset" });
      }

      if (
        req.body.source === "builtin" ||
        (typeof req.body?.source === "string" && req.body.source.trim().toLowerCase() === "builtin")
      ) {
        return res.status(400).json({ error: "Cannot create or modify builtin presets" });
      }

      // Type is immutable on update (GEO-PRESET-UX-2): an existing preset keeps its type.
      const existing = existingIdx >= 0 ? presets[existingIdx] : undefined;
      const presetType: "domain" | "cidr" = existing
        ? existing.type === "cidr"
          ? "cidr"
          : "domain"
        : req.body.type === "cidr"
          ? "cidr"
          : "domain";

      // Layer payload (sources[]) takes precedence; plain entries/domains are
      // wrapped as a single manual layer for backward compatibility.
      const hasSources = Array.isArray(req.body.sources);
      const rawEntries = req.body.entries !== undefined ? req.body.entries : req.body.domains;
      if (!hasSources && rawEntries === undefined) {
        return res.status(400).json({ error: "entries or sources are required" });
      }

      let cleanSources: PresetSource[];
      let cleanEntries: string[];
      if (hasSources) {
        const validated = validatePresetSources(req.body.sources, presetType);
        if (validated.ok === false) {
          return res.status(400).json({ error: validated.error });
        }
        cleanSources = validated.source as unknown as PresetSource[];
        // GEO-BUILDER-UX-3: keep live file layers' entries snapshots in sync
        // with the stored geofile so export round-trips carry the content.
        for (const s of cleanSources) {
          if (s.kind === "file" && s.fileId) {
            s.entries = getPresetSourceEntries(s);
          }
        }
        cleanEntries = materializePresetSources(cleanSources, []);
        if (cleanEntries.length === 0) {
          return res.status(400).json({ error: "preset materializes to an empty entry list" });
        }
        if (!isWithinPresetEntryLimit(cleanEntries.length)) {
          return res.status(400).json({ error: `Preset too large: ${cleanEntries.length} entries exceed the ${MAX_ROUTING_PRESET_ENTRIES} entry limit` });
        }
      } else {
        cleanEntries = Array.isArray(rawEntries)
          ? rawEntries.map(String).map((s) => s.trim()).filter(Boolean)
          : typeof rawEntries === "string"
            ? parsePlaintextList(rawEntries)
            : [];
        if (cleanEntries.length === 0) {
          return res.status(400).json({ error: "entries cannot be empty" });
        }
        // AUDIT-SRV-P3: cap preset size (PAC generation guard)
        if (!isWithinPresetEntryLimit(cleanEntries.length)) {
          return res.status(400).json({ error: `Preset too large: ${cleanEntries.length} entries exceed the ${MAX_ROUTING_PRESET_ENTRIES} entry limit` });
        }
        cleanSources = [{ kind: "manual", entries: cleanEntries }];
      }

      // Legacy flat fields stay in sync: when layers are provided they are
      // authoritative and the flat source fields are re-derived from them;
      // otherwise the historical upsert merge rules apply.
      const derived = deriveLegacySourceFields(cleanSources);
      const presetItem: RoutingPresetItem = {
        id: cleanId,
        name: name.trim(),
        category: category || (existing ? existing.category : "custom"),
        description:
          description !== undefined
            ? String(description).trim()
            : existing
              ? existing.description
              : "",
        type: presetType,
        ...(hasSources
          ? derived
          : {
              source: (req.body.source || (existing ? existing.source : "file")) as RoutingPresetItem["source"],
              sourceUrl: req.body.sourceUrl || (existing ? existing.sourceUrl : undefined),
              sourceTag: req.body.sourceTag || (existing ? existing.sourceTag : undefined),
            }),
        lastUpdated: new Date().toISOString(),
        entries: cleanEntries,
        domains: cleanEntries,
        sources: cleanSources,
      };

      if (existingIdx >= 0) {
        presets[existingIdx] = presetItem;
      } else {
        presets.push(presetItem);
      }
      saveRoutingPresets(presets);

      recordAudit({
        ip: getClientIp(req),
        endpoint: "/api/routing/presets",
        status: 200,
        result: "CONFIG_UPDATED",
        details: `Preset: ${presetItem.name} (${presetItem.id}, ${cleanEntries.length} entries, ${cleanSources.length} layers)`,
      });

      res.json({ ok: true, preset: serializePresetForApi(presetItem) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.delete("/api/routing/presets/:id", (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      const presets = getRoutingPresets();
      const idx = presets.findIndex((p) => p.id === id);
      if (idx < 0) {
        return res.status(404).json({ error: "Preset not found" });
      }
      const target = presets[idx];
      if (target.source === "builtin" || GEO_PRESETS.some((gp) => gp.id === id)) {
        return res.status(400).json({ error: "Cannot delete builtin preset" });
      }
      presets.splice(idx, 1);
      saveRoutingPresets(presets);

      recordAudit({
        ip: getClientIp(req),
        endpoint: `/api/routing/presets/${id}`,
        status: 200,
        result: "CONFIG_UPDATED",
        details: `Deleted preset: ${target.name} (${target.id})`,
      });

      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.post("/api/routing/presets/import-url", async (req: Request, res: Response) => {
    try {
      const { url, tag, name, description, type } = req.body;
      if (!url || typeof url !== "string" || !url.trim()) {
        return res.status(400).json({ error: "url is required" });
      }

      const safeCheck = await validateSafeEndpointUrlAsync(url.trim());
      if (!safeCheck.valid) {
        return res.status(400).json({ error: "SSRF validation failed: target is forbidden" });
      }

      // AUDIT-SEC-2: pin the connection to the DNS-verified addresses so a
      // rebinding record flipped after validation cannot redirect this fetch.
      const plan = await createSsrfPinnedFetch(url.trim());
      if (!plan.valid) {
        return res.status(400).json({ error: "SSRF validation failed: target is forbidden" });
      }

      let buffer: Buffer;
      try {
        let response: globalThis.Response;
        try {
          response = await plan.fetch(url.trim(), {
            redirect: "manual",
            signal: AbortSignal.timeout(10000),
          });
        } catch (fetchErr: any) {
          return res.status(400).json({ error: `Failed to fetch URL: ${fetchErr?.message || fetchErr}` });
        }

        if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
          return res.status(400).json({ error: "HTTP redirects are forbidden for security reasons" });
        }

        if (!response.ok) {
          return res.status(400).json({ error: `Remote server returned HTTP ${response.status}` });
        }

        const MAX_SIZE = 20 * 1024 * 1024; // 20MB
        buffer = await downloadBodyWithLimit(response, MAX_SIZE);
      } finally {
        plan.close();
      }

      const { entries, inferredType } = parseGeodataBuffer(buffer, url, type, tag);
      // AUDIT-SRV-P3: cap preset size at import so PAC generation cannot be
      // blown up by an oversized geodata list.
      if (!isWithinPresetEntryLimit(entries.length)) {
        return res.status(400).json({ error: `Imported preset too large: ${entries.length} entries exceed the ${MAX_ROUTING_PRESET_ENTRIES} entry limit` });
      }
      let parsedUrlPath = "";
      try {
        parsedUrlPath = new URL(url).pathname.split("/").pop() || "";
      } catch {
        // ignore
      }
      const cleanName = name || (tag ? `GeoData ${tag}` : parsedUrlPath || "Imported Preset");
      const id = req.body.id || `preset:${crypto.randomBytes(4).toString("hex")}`;

      const preset: RoutingPresetItem = {
        id,
        name: cleanName,
        category: req.body.category || "custom",
        description: description || `Imported from ${url}`,
        type: type || inferredType,
        // GEO-PRESET-UX-2: url imports become a live url layer (+ snapshot).
        source: "remote",
        sourceUrl: url.trim(),
        sourceTag: tag,
        lastUpdated: new Date().toISOString(),
        entries,
        domains: entries,
        sources: [
          {
            kind: "url",
            url: url.trim(),
            ...(tag ? { tag } : {}),
            entries,
            lastUpdated: new Date().toISOString(),
          },
        ],
      };

      const presets = getRoutingPresets();
      const existingIdx = presets.findIndex((p) => p.id === preset.id);
      if (
        (existingIdx >= 0 && presets[existingIdx].source === "builtin") ||
        GEO_PRESETS.some((gp) => gp.id === preset.id)
      ) {
        return res.status(400).json({ error: "Cannot overwrite builtin preset" });
      }
      if (existingIdx >= 0) {
        presets[existingIdx] = preset;
      } else {
        presets.push(preset);
      }
      saveRoutingPresets(presets);

      recordAudit({
        ip: getClientIp(req),
        endpoint: "/api/routing/presets/import-url",
        status: 200,
        result: "CONFIG_UPDATED",
        details: `Imported ${entries.length} entries from ${url} as ${preset.name}`,
      });

      res.json({ ok: true, preset: { ...preset, entriesCount: entries.length } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.post("/api/routing/presets/import-file", (req: Request, res: Response) => {
    try {
      const { filename, content, tag, name, description, type } = req.body;
      if (!filename || typeof filename !== "string") {
        return res.status(400).json({ error: "filename is required" });
      }
      if (content === undefined || content === null) {
        return res.status(400).json({ error: "content is required" });
      }

      let buf: Buffer = decodeUploadedFileContent(filename, content);

      const { entries, inferredType } = parseGeodataBuffer(buf, filename, type, tag);
      // AUDIT-SRV-P3: cap preset size at import (PAC generation guard)
      if (!isWithinPresetEntryLimit(entries.length)) {
        return res.status(400).json({ error: `Imported preset too large: ${entries.length} entries exceed the ${MAX_ROUTING_PRESET_ENTRIES} entry limit` });
      }
      // GEO-BUILDER-UX-3: store the upload content-addressed so the layer can
      // stay live (re-parse by tags without re-upload).
      const stored = saveGeofile(buf, filename.toLowerCase().endsWith(".dat") ? ".dat" : ".txt");
      const rawTags = (tag || "")
        .split(/[,;]+/)
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean);
      const availableTags = listGeodataTags(buf, filename);
      const cleanName = name || filename;
      const id = req.body.id || `preset:${crypto.randomBytes(4).toString("hex")}`;

      const preset: RoutingPresetItem = {
        id,
        name: cleanName,
        category: req.body.category || "custom",
        description: description || `Imported from ${filename}`,
        type: type || inferredType,
        // GEO-BUILDER-UX-3: file imports become a LIVE geofile layer.
        source: "file",
        sourceTag: tag,
        lastUpdated: new Date().toISOString(),
        entries,
        domains: entries,
        sources: [
          {
            kind: "file",
            name: filename,
            fileId: stored.fileId,
            fileName: filename,
            ...(rawTags.length ? { tags: rawTags } : {}),
            ...(tag ? { tag } : {}),
            entries,
          },
        ],
      };

      const presets = getRoutingPresets();
      const existingIdx = presets.findIndex((p) => p.id === preset.id);
      if (
        (existingIdx >= 0 && presets[existingIdx].source === "builtin") ||
        GEO_PRESETS.some((gp) => gp.id === preset.id)
      ) {
        return res.status(400).json({ error: "Cannot overwrite builtin preset" });
      }
      if (existingIdx >= 0) {
        presets[existingIdx] = preset;
      } else {
        presets.push(preset);
      }
      saveRoutingPresets(presets);

      recordAudit({
        ip: getClientIp(req),
        endpoint: "/api/routing/presets/import-file",
        status: 200,
        result: "CONFIG_UPDATED",
        details: `Imported ${entries.length} entries from file ${filename} as ${preset.name} (geofile ${stored.fileId.slice(0, 12)}…)`,
      });

      res.json({
        ok: true,
        preset: { ...preset, entriesCount: entries.length },
        // GEO-BUILDER-UX-3: live file layer handles for the constructor
        fileId: stored.fileId,
        fileName: filename,
        deduped: stored.deduped,
        availableTags,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.post("/api/routing/presets/:id/refresh", async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      const presets = getRoutingPresets();
      const preset = presets.find((p) => p.id === id);
      if (!preset) {
        return res.status(404).json({ error: "Preset not found" });
      }

      // GEO-PRESET-UX-2: refresh updates ONLY url layers (re-downloaded) and
      // geo-tag layers (re-resolved from GEO_PRESETS). manual/file layers and
      // their snapshots are never touched by a refresh.
      const sources: PresetSource[] = Array.isArray(preset.sources)
        ? preset.sources
        : // Defensive legacy fallback (presets are migrated on read; a direct
          // store write without sources is still treated as a single url layer).
          preset.sourceUrl
          ? [{ kind: "url", url: preset.sourceUrl, ...(preset.sourceTag ? { tag: preset.sourceTag } : {}) }]
          : [];
      const urlLayerIdxs: number[] = [];
      let hasGeoTag = false;
      sources.forEach((s, i) => {
        if (s.kind === "url") urlLayerIdxs.push(i);
        if (s.kind === "geo-tag") hasGeoTag = true;
      });

      if (urlLayerIdxs.length === 0 && !hasGeoTag) {
        return res.status(400).json({ error: "Preset has no refreshable layers (url/geo-tag)" });
      }

      const presetType: "domain" | "cidr" = preset.type === "cidr" ? "cidr" : "domain";

      // Download every url layer first; only apply the whole batch when all
      // layers succeeded, so a partial failure never corrupts the preset.
      const refreshedSnapshots = new Map<number, string[]>();
      for (const idx of urlLayerIdxs) {
        const layer = sources[idx] as Extract<PresetSource, { kind: "url" }>;
        const safeCheck = await validateSafeEndpointUrlAsync(layer.url);
        if (!safeCheck.valid) {
          return res.status(400).json({ error: "SSRF validation failed: target is forbidden" });
        }

        // AUDIT-SEC-2: pin the connection to the DNS-verified addresses so a
        // rebinding record flipped after validation cannot redirect this fetch.
        const plan = await createSsrfPinnedFetch(layer.url);
        if (!plan.valid) {
          return res.status(400).json({ error: "SSRF validation failed: target is forbidden" });
        }

        let buffer: Buffer;
        try {
          let response: globalThis.Response;
          try {
            response = await plan.fetch(layer.url, {
              redirect: "manual",
              signal: AbortSignal.timeout(10000),
            });
          } catch (fetchErr: any) {
            return res.status(400).json({ error: `Failed to refresh URL: ${fetchErr?.message || fetchErr}` });
          }

          if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
            return res.status(400).json({ error: "HTTP redirects are forbidden for security reasons" });
          }

          if (!response.ok) {
            return res.status(400).json({ error: `Remote server returned HTTP ${response.status}` });
          }

          const MAX_SIZE = 20 * 1024 * 1024;
          buffer = await downloadBodyWithLimit(response, MAX_SIZE);
        } finally {
          plan.close();
        }

        const { entries, inferredType } = parseGeodataBuffer(buffer, layer.url, presetType, layer.tag);
        if (inferredType !== presetType) {
          return res.status(400).json({
            error: `Layer "${layer.url}" returned ${inferredType} entries which do not match the ${presetType} preset type`,
          });
        }
        // AUDIT-SRV-P3: cap preset size on refresh (PAC generation guard)
        if (!isWithinPresetEntryLimit(entries.length)) {
          return res.status(400).json({ error: `Refreshed preset too large: ${entries.length} entries exceed the ${MAX_ROUTING_PRESET_ENTRIES} entry limit` });
        }
        refreshedSnapshots.set(idx, entries);
      }

      const now = new Date().toISOString();
      for (const [idx, entries] of refreshedSnapshots) {
        const layer = sources[idx] as Extract<PresetSource, { kind: "url" }>;
        layer.entries = entries;
        layer.lastUpdated = now;
      }

      const materialized = materializePresetSources(sources, []);
      preset.entries = materialized;
      preset.domains = materialized;
      preset.lastUpdated = now;
      preset.sources = sources;

      saveRoutingPresets(presets);

      recordAudit({
        ip: getClientIp(req),
        endpoint: `/api/routing/presets/${id}/refresh`,
        status: 200,
        result: "CONFIG_UPDATED",
        details: `Refreshed ${refreshedSnapshots.size} url layer(s) of preset ${preset.name} (${materialized.length} entries total)`,
      });

      res.json({ ok: true, preset: serializePresetForApi(preset) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // GEO-BUILDER-UX-3: available tags of a stored geofile (tag-editor checklist
  // data: search + per-tag entry counts + multiselect).
  router.get("/api/routing/geofiles/:fileId/tags", (req: Request, res: Response) => {
    const fileId = String(req.params.fileId || "").trim();
    const storedName = getGeofileName(fileId);
    if (!storedName) {
      return res.status(404).json({ error: "Stored geofile not found for the given fileId" });
    }
    const buf = readGeofile(fileId)!;
    res.json({ fileId, fileName: storedName, availableTags: listGeodataTags(buf, storedName) });
  });

  // GEO-PRESET-UX-2: resolve a raw layer into a validated PresetSource.
  // url layers are SSRF-checked + downloaded + parsed here; file layers are
  // decoded/parsed here; geo-tag/manual layers are shape/type-checked only.
  // The endpoint does NOT persist anything — the constructor assembles
  // sources client-side and persists them via the upsert POST (single write path).
  router.post("/api/routing/presets/resolve-layer", async (req: Request, res: Response) => {
    try {
      const presetType: "domain" | "cidr" = req.body?.type === "cidr" ? "cidr" : "domain";
      const raw = req.body?.source;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return res.status(400).json({ error: "source object is required" });
      }

      if (raw.kind === "url") {
        if (typeof raw.url !== "string" || !raw.url.trim()) {
          return res.status(400).json({ error: "url is required for url layers" });
        }
        const url = raw.url.trim();
        const tag = typeof raw.tag === "string" && raw.tag.trim() ? raw.tag.trim() : undefined;

        const safeCheck = await validateSafeEndpointUrlAsync(url);
        if (!safeCheck.valid) {
          return res.status(400).json({ error: "SSRF validation failed: target is forbidden" });
        }
        const plan = await createSsrfPinnedFetch(url);
        if (!plan.valid) {
          return res.status(400).json({ error: "SSRF validation failed: target is forbidden" });
        }
        let buffer: Buffer;
        try {
          let response: globalThis.Response;
          try {
            response = await plan.fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) });
          } catch (fetchErr: any) {
            return res.status(400).json({ error: `Failed to fetch URL: ${fetchErr?.message || fetchErr}` });
          }
          if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
            return res.status(400).json({ error: "HTTP redirects are forbidden for security reasons" });
          }
          if (!response.ok) {
            return res.status(400).json({ error: `Remote server returned HTTP ${response.status}` });
          }
          buffer = await downloadBodyWithLimit(response, 20 * 1024 * 1024);
        } finally {
          plan.close();
        }

        const { entries, inferredType } = parseGeodataBuffer(buffer, url, presetType, tag);
        const validated = validatePresetSource({ kind: "url", url, ...(tag ? { tag } : {}), entries }, presetType, 0);
        if (validated.ok === false) return res.status(400).json({ error: validated.error });
        if (inferredType !== presetType) {
          return res.status(400).json({ error: `Layer "${url}" returned ${inferredType} entries which do not match the ${presetType} preset type` });
        }
        return res.json({
          ok: true,
          source: { kind: "url", url, ...(tag ? { tag } : {}), entries, lastUpdated: new Date().toISOString() },
        });
      }

      if (raw.kind === "file") {
        // GEO-BUILDER-UX-3: two modes.
        // 1) {fileId} without content -> re-parse the STORED geofile by
        //    (possibly changed) tags: the tag editor / rebind flows.
        // 2) {content, name} -> upload (or file replacement): store the body
        //    content-addressed and return a LIVE layer + available tags.
        const rawTags = Array.isArray(raw.tags)
          ? raw.tags.map(String).map((t) => t.trim().toUpperCase()).filter(Boolean)
          : [];
        const singleTag = typeof raw.tag === "string" && raw.tag.trim() ? raw.tag.trim().toUpperCase() : undefined;
        const tags = rawTags.length ? rawTags : singleTag ? [singleTag] : [];

        const hasContent = raw.content !== undefined && raw.content !== null;
        const hasFileId = typeof raw.fileId === "string" && raw.fileId.trim().length > 0;

        if (hasFileId && !hasContent) {
          const fileId = String(raw.fileId).trim();
          const storedName = getGeofileName(fileId);
          if (!storedName) {
            return res.status(404).json({ error: "Stored geofile not found for the given fileId" });
          }
          const buf = readGeofile(fileId)!;
          let parsed: { entries: string[]; inferredType: "domain" | "cidr" };
          try {
            parsed = parseGeodataBuffer(buf, storedName, presetType, tags.join(","));
          } catch (err: unknown) {
            return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
          }
          const validated = validatePresetSource(
            { kind: "file", fileId, fileName: storedName, tags, entries: parsed.entries },
            presetType,
            0
          );
          if (validated.ok === false) return res.status(400).json({ error: validated.error });
          if (parsed.inferredType !== presetType) {
            return res.status(400).json({ error: `Stored geofile contains ${parsed.inferredType} entries which do not match the ${presetType} preset type` });
          }
          return res.json({
            ok: true,
            source: { kind: "file", fileId, fileName: storedName, tags, entries: parsed.entries },
            availableTags: listGeodataTags(buf, storedName),
          });
        }

        if (!hasContent) {
          return res.status(400).json({ error: "content is required for file layers (or pass fileId to re-parse a stored geofile)" });
        }
        const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "upload.dat";
        const buf = decodeUploadedFileContent(name, raw.content);
        const parsed = parseGeodataBuffer(buf, name, presetType, tags.join(","));
        const stored = saveGeofile(buf, name.toLowerCase().endsWith(".dat") ? ".dat" : ".txt");
        const validated = validatePresetSource(
          { kind: "file", name, fileId: stored.fileId, fileName: name, tags, entries: parsed.entries },
          presetType,
          0
        );
        if (validated.ok === false) return res.status(400).json({ error: validated.error });
        if (parsed.inferredType !== presetType) {
          return res.status(400).json({ error: `Layer "${name}" contains ${parsed.inferredType} entries which do not match the ${presetType} preset type` });
        }
        return res.json({
          ok: true,
          source: {
            kind: "file",
            name,
            fileId: stored.fileId,
            fileName: name,
            tags,
            entries: parsed.entries,
          },
          availableTags: listGeodataTags(buf, name),
          deduped: stored.deduped,
        });
      }

      // geo-tag / manual layers need no ingestion — shape + type validation only.
      const validated = validatePresetSource(raw, presetType, 0);
      if (validated.ok === false) return res.status(400).json({ error: validated.error });
      return res.json({ ok: true, source: validated.source });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // GEO-PRESET-UX-2: preset JSON export (round-trip: the payload is accepted
  // back by POST /api/routing/presets/import-preset on another installation).
  router.get("/api/routing/presets/:id/export", (req: Request, res: Response) => {
    const presets = getRoutingPresets();
    const preset = presets.find((p) => p.id === req.params.id);
    if (!preset) {
      return res.status(404).json({ error: "Preset not found" });
    }
    const safeName = String(preset.id).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "preset";
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.json"`);
    res.json({
      format: "pec-preset",
      version: 2,
      exportedAt: new Date().toISOString(),
      // GEO-BUILDER-UX-3: file layers are exported with their entries SNAPSHOT.
      // The referenced geofile (fileId = sha256 of the content) is NOT
      // transferred: on a server that does not hold the same content-addressed
      // file the layer degrades to a plain snapshot; where the identical file
      // exists, the layer re-binds live by fileId.
      note: "file layers with fileId degrade to entries snapshots on servers without the same stored geofile (content-addressed by sha256)",
      preset: {
        id: preset.id,
        name: preset.name,
        description: preset.description || "",
        category: preset.category || "custom",
        type: preset.type === "cidr" ? "cidr" : "domain",
        sources: (preset.sources || []).map(inlineSourceEntries),
      },
    });
  });

  // GEO-PRESET-UX-2: preset JSON import. Deliberately a dedicated endpoint
  // instead of overloading the upsert POST: imported files are untrusted
  // artifacts, and an id collision on upsert would silently overwrite a
  // curated preset from another installation. import-preset NEVER overwrites
  // — on collision it assigns a fresh suffixed id (append-only ingestion).
  router.post("/api/routing/presets/import-preset", (req: Request, res: Response) => {
    try {
      const imported: any = req.body?.preset && typeof req.body.preset === "object" ? req.body.preset : req.body;
      if (!imported || typeof imported !== "object" || Array.isArray(imported)) {
        return res.status(400).json({ error: "preset object is required" });
      }
      if (typeof imported.name !== "string" || !imported.name.trim()) {
        return res.status(400).json({ error: "preset.name is required" });
      }
      const presetType: "domain" | "cidr" = imported.type === "cidr" ? "cidr" : "domain";

      const validated = validatePresetSources(Array.isArray(imported.sources) ? imported.sources : [], presetType);
      if (validated.ok === false) {
        return res.status(400).json({ error: validated.error });
      }
      const sources = validated.source as unknown as PresetSource[];
      if (sources.length === 0) {
        return res.status(400).json({ error: "imported preset has no layers" });
      }

      const entries = materializePresetSources(sources, []);
      if (entries.length === 0) {
        return res.status(400).json({ error: "imported preset materializes to an empty entry list" });
      }
      if (!isWithinPresetEntryLimit(entries.length)) {
        return res.status(400).json({ error: `Imported preset too large: ${entries.length} entries exceed the ${MAX_ROUTING_PRESET_ENTRIES} entry limit` });
      }

      const presets = getRoutingPresets();
      let cleanId = slugifyPresetId(imported.name.trim());
      while (presets.some((p) => p.id === cleanId)) {
        cleanId = slugifyPresetId(imported.name.trim());
      }

      const derived = deriveLegacySourceFields(sources);
      const presetItem: RoutingPresetItem = {
        id: cleanId,
        name: imported.name.trim(),
        category: imported.category || "custom",
        description: imported.description !== undefined ? String(imported.description).trim() : "",
        type: presetType,
        ...derived,
        lastUpdated: new Date().toISOString(),
        entries,
        domains: entries,
        sources,
      };
      presets.push(presetItem);
      saveRoutingPresets(presets);

      recordAudit({
        ip: getClientIp(req),
        endpoint: "/api/routing/presets/import-preset",
        status: 200,
        result: "CONFIG_UPDATED",
        details: `Imported preset: ${presetItem.name} (${presetItem.id}, ${entries.length} entries, ${sources.length} layers)`,
      });

      res.json({ ok: true, preset: serializePresetForApi(presetItem) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // Profiles CRUD
  router.get("/api/routing/profiles", (_req: Request, res: Response) => {
    res.json(getAllProfiles());
  });

  router.post("/api/routing/profiles", (req: Request, res: Response) => {
    try {
      const saved = saveProfile(req.body);
      recordAudit({
        ip: getClientIp(req),
        endpoint: "/api/routing/profiles",
        status: 200,
        result: "CONFIG_UPDATED",
        details: `Profile: ${saved.name} (Policy: ${saved.defaultPolicy})`,
      });
      res.json(saved);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.delete("/api/routing/profiles/:id", (req: Request, res: Response) => {
    try {
      const ok = deleteProfile(req.params.id);
      res.json({ ok });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  return router;
}
