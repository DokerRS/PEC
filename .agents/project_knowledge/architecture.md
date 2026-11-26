# Architectural Foundations: PEC - Proxy Extension Corp

Architectural map, subsystem interaction, and data flows.

---

## 1. High-Level Technology Stack
- **Runtime & Language:** Node.js (>=20.0.0), TypeScript 5.7, Express 4.21, `undici` for HTTP client calls.
- **Build & Development Tooling:** `esbuild` for server (`dist/server.cjs`) and modular UI bundle (`public/dashboard.min.js`), `tsx` for TypeScript execution, Node built-in test runner (`node:test`), Biome 2.6 for static analysis and formatting (`biome.json`), OpenAPI 3.1 specification (`docs/openapi.yaml`).
- **Native Clients:** C/C++ native desktop clients:
  - Windows: DirectX 11 GUI, Dear ImGui, Windows Service (`PECAppSvc`), NSIS / WiX MSI installer.
  - Linux: C CLI, daemon, systemd unit, and GTK helper.
- **Browser Extension:** Google Chrome Manifest V3 (MV3) background service worker, popup UI, dynamic PAC routing.
- **Deployment & Containers:** Docker (Debian Bookworm slim multi-stage build with MinGW-w64 cross-compiler and msitools), Docker Compose.

---

## 2. Core Subsystems

```
                               +-----------------------------+
                               |     Active Directory /      |
                               |    GPO Registry Policies    |
                               +--------------+--------------+
                                              | (updates.xml & CRX)
                                              v
+----------------------------+   Heartbeat    +-----------------------------+
| Chrome Extension (MV3)     | -------------> | Express Server (server.ts)  |
| - background.js            | <------------- | - Security Middleware       |
| - popup.html / popup.js    |  Credentials   | - Route Controllers         |
+----------------------------+                +--------------+--------------+
              ^                                              |
              | Loopback                                     | Inbound Creds
              | (127.0.0.1)                                  v Rotation
              | per-user HTTP/SOCKS                          |
              | listener from local Xray core                |
+----------------------------+                +-----------------------------+
| Desktop Client (PEC-App)   | -------------> | Remnawave Panel             |
| - DirectX 11 / Dear ImGui  |   Sync Telemetry| (SSRF Guard & DNS Rebinding |
| - Service / Daemon         |                |  Protection)                |
| - Local Xray Core (child)  |                +-----------------------------+
+----------------------------+
```

### 2.1 Server Core & Security Gateway
- **Entry point:** `server.ts`
- **Security:** `src/middleware/security.ts` (sliding-window rate limiters, token validation, segmented CORS, security headers), `src/auth.ts` (scrypt password hashing, session tokens).
- **Two-Token Model:** `ADMIN_TOKEN` protects management endpoints; `EXT_SHARED_TOKEN` authenticates fleet clients.

### 2.2 Storage & Persistence
- **Storage modules:** `src/storage.ts`, `src/jsonStore.ts`.
- **Strategy:** Zero-DB flat-file JSON persistence in `DATA_DIR` (`./data/`).
- **Atomic Writes:** `writeJsonAtomic` and `writeFileAtomic` write to `.tmp.<hex>` and atomically rename. On Windows, handles `EPERM`/`EBUSY` with explicit unlink fallback. Broken stores are preserved as `.corrupt-<timestamp>`.

### 2.3 Routing Engine & Smart PAC
- **Modules:** `src/routing.ts`, `src/geodata/datParser.ts`, `src/defaultPresets.ts`, `src/pacSigner.ts`, `src/routes/routingRoutes.ts`.
- **Function:** Dynamic Proxy Auto-Configuration (`/proxy.pac`) script generation with Direct-default or Proxy-default tunneling, geosite/geoip binary dat parsing, domain/CIDR rule matching, and HMAC-SHA256 signature verification.
- **Layered preset model (GEO-PRESET-UX-2 / GEO-BUILDER-UX-3):** a routing preset carries `sources: PresetSource[]` — ordered layers `{kind: geo-tag(ref→GEO_PRESETS live) | url(snapshot entries + ↻ re-fetch) | file(LIVE: fileId→content-addressed geofile, re-parsed by tags[]; entries snapshot stays as fallback for legacy/no-file layers) | manual}`. Uploaded .dat/.txt bodies persist once per content sha256 in `data/geofiles/` (`saveGeofile`/`readGeofile`/`getGeofileName` in `src/storage.ts`, `GEOFILES_DIR` env, id = sha256 hex with a pattern guard) so file layers re-parse by tags without re-upload (`materializeLiveFileLayer` in `src/routing.ts`, immutable fileId+tags cache, snapshot fallback for unknown files). The single materialization function `materializePresetSources` (`src/routing.ts`) unions layers in order with global dedup, hard-capped at `MAX_ROUTING_PRESET_ENTRIES` (500k); `expandRuleDomains` (PAC path) and the REST GET projection (`serializePresetForApi`: `sources` + flat `entries` + `entriesCount`, geo-tag entries inlined, live file layers' snapshots synced with the file on upsert) both consume it — the PAC contract stays a plain string list. Type isolation: a geoip/CIDR layer cannot enter a `domain` preset and vice versa (`inferPresetSourceType`). Legacy flat stores migrate on read in `getRoutingPresets` (`src/storage.ts`, idempotent, timestamped `.backup-` copy): `sourceUrl→url`, `sourceTag→file`, else `manual`. Writes: `POST /api/routing/presets` accepts `sources[]` (authoritative; legacy `entries` wrapped as a manual layer; type immutable on update); `POST /api/routing/presets/resolve-layer` ingests url/file layers (SSRF-pinned fetch; file = upload→store OR {fileId}→re-parse by tags, persists nothing — the constructor assembles `sources` client-side and persists via upsert); `GET /api/routing/geofiles/:fileId/tags` lists a stored geofile's tags with entry counts; GEO-BUILDER-UX-4 adds the full geobase editor surface on a parsed-map cache (keyed by fileId, valid while the stored name matches): `GET /geofiles/:fileId/manifest` (ALL lists + counts + totalEntries + type), `GET /geofiles/:fileId/lists/:tag/entries?offset&limit` (paged preview, 200/page cap), `GET /geofiles/:fileId/search?q=` (substring case-insensitive over list names AND domains -> the lists a domain lives in, 50-result cap), `POST /geofiles/:fileId/union-count` (dedup counter for the editor footer); the dashboard's full-screen `geoEditorPage` (above the constructor page) consumes them: manifest checkboxes, [▾] paged previews, domain search with in-place list checkboxes, live «Доменов попадёт в слой (дедуп)» footer, «Сменить файл» with selection reset + warning, snapshot rebind; `POST /:id/refresh` re-downloads ONLY url layers and re-resolves geo-tag layers (manual/file snapshots untouched — fixes the old whole-replace refresh); `GET /:id/export` ⇄ `POST /api/routing/presets/import-preset` round-trip `sources[]` (pec-preset format v2 + degradation note: file layers with fileId degrade to entries snapshots on servers without the same content-addressed file and re-bind live where it exists; import never overwrites — fresh suffixed id on collision; builtin duplicate uses the same endpoint). Dashboard UI: full-width constructor sub-page inside the Routing tab (`presetBuilderPage` markup in `dashboardView.ts`, logic + delegated click listeners in `tabs/routing.ts`): structured layer cards (source name, tag chips, honest per-layer count, live/snapshot status), ✎ inline editors (file tag checklist from the tags endpoint, «Сменить файл», snapshot «Привязать файл заново», url/geo/manual editors), sectioned left column («СЛОИ ПРЕСЕТА (n)» + «ДОБАВИТЬ ИСТОЧНИК» with five one-open dialogs), short unique origin badges with full-path titles, honest counters (per-layer sum vs deduped union), «Домен +» with a target-manual-layer selector, bulk-delete confirm above one entry; per-card actions live behind the `btn-preset-menu` «⋮» dropdown (`aria-haspopup`, items `pm-edit`/`pm-view`/`pm-refresh`/`pm-export`/`pm-duplicate`, single-open invariant, outside-click + Escape dismiss listeners ported at module scope — POPOVER-CLOSE discipline); the geobase-inspector/preset-edit/import-presets modals are removed (together with the dead `test/geoPresetEdit.test.ts`). Suites: `test/routingPresetSources.test.ts` + `test/geofilesStorage.test.ts` (server), `test/presetBuilderUi.test.ts` + `test/presetCardMenu.test.ts` + `test/builderLayersUi.test.ts` (click-path, `dispatchEvent` on real controls).

### 2.4 Credential Rotation & External Integration
- **Modules:** `src/rotate.ts`, `src/scheduler.ts`, `src/routes/rotationRoutes.ts`.
- **Function:** Authenticates to Remnawave with a panel API token (`Authorization: Bearer`), resolves users by username, and rotates credentials through the user revoke action while preserving subscription identifiers. Legacy panel records without an API token retain username/password login compatibility.
- **API client:** `src/remnawave.ts` uses configured API tokens directly and falls back to `POST /api/auth/login` only for legacy credentials; authenticated health checks use the same Bearer/JWT path, alongside user/node listing and `POST /api/users/{userId}/actions/revoke` with `revokeOnlyPasswords: true`. `src/rotate.ts` adapts those operations to the credential store and rotation scheduler; API tokens are stored in the Remnawave panel registry and masked in dashboard responses.
- **SSRF Hardening:** Synchronous and asynchronous DNS resolution checks (`validateSafeEndpointUrlAsync`) blocking loopback, link-local, RFC1918 private subnets, and cloud metadata endpoints (`169.254.169.254`).
- **SSRF TOCTOU Pinning (AUDIT-SEC-2):** `createSsrfPinnedFetch` / `makePinnedLookup` (`src/rotate.ts`) freeze validated DNS answers into a custom `undici` Agent `lookup` with `redirect: "manual"`, so panel fetches never re-resolve to a rebound address between validation and connection. Used by Remnawave API calls and `routingRoutes` import-url/refresh.

### 2.5 Packaging & Builder Studio
- **Modules:** `src/packager.ts`, `src/appPackager.ts`, `src/codeSigner.ts`, `src/routes/builderRoutes.ts`, `src/routes/appBuilderRoutes.ts`.
- **Function:** Compiles and signs `.CRX` extension packages with 2048-bit RSA keys (`extension/key.pem`), generates canonical GPO deployment package (`pec-policy-user.reg`, `pec-policy-machine.reg`, `README-GPO.txt`), and builds cross-platform desktop installers.
- **MV3 CSP-Safe Popup Theme Bootstrap (AUDIT-EXT-2):** `extension/popupTheme.js` — external pre-paint theme script loaded in `popup.html` `<head>` (replaces the former inline FOUC bootstrap rejected by MV3 CSP `script-src 'self'`); generated from `src/templates/popupThemeTemplate.ts` and kept in sync via `npm run sync:templates`.
- **Test Sandbox Contract (AUDIT-NAT-2-TS):** `writeVersionGenHeaders` sanitizes placeholder fleet tokens into an empty `PEC_DEFAULT_FLEET_TOKEN`, and `test/helpers/setup.ts` redirects header regeneration into a sandbox replica via `PEC_CLIENT_WIN_DIR` — `npm test` can never rewrite the committed `client/Windows/**/version_gen.h` copies.

### 2.6 Fleet Telemetry & Sync
- **Modules:** `src/instances.ts`, `src/routes/instancesRoutes.ts`, `src/routes/appSyncRoutes.ts`.
- **Function:** Ingests heartbeats (`POST /api/sync`) from extensions and desktop clients, manages instance state with LRU capacity protection, browser detection (`Chrome`, `Edge`, `Yandex`, `Opera`, `Brave`, `Vivaldi`), and provides global kill-switch and Zero-Trust AD Auto-Recovery / Unrevoke capability.
- **Enrollment rate limiting:** `EnrollmentTracker` (`src/routes/credsRoutes.ts`) throttles credential-enrollment bursts with an injectable clock (`nowFn`, default `Date.now`) enabling deterministic virtual-time tests (AUDIT-QA-2).

### 2.7 Logging, Observability & Prometheus Metrics
- **Modules:** `src/logger.ts`, `src/metrics.ts`, `src/routes/metricsRoutes.ts`.
- **Function:** Structured logging engine (JSON in production, human-readable text in dev) with automated masking of sensitive keys, passwords, and HTTP Basic Auth credentials. Prometheus exposition endpoint (`GET /metrics`) protected by `ADMIN_TOKEN`.

### 2.8 Release Management & Safe Forward-Rollback
- **Modules:** `src/releases.ts`, `src/routes/releasesRoutes.ts`, `src/utils/semver.ts`.
- **Function:** Release lifecycle and distribution management for desktop and browser clients. Enforces Safe Forward-Rollback for Chrome MV3 extensions (`bumpPatchVersion`), automatically updating `manifest.json`, re-packing, and re-signing CRX archives with RSA key `key.pem`.

### 2.9 Modular Dashboard Frontend
- **Modules:** `src/client/dashboard/` (`core/`: `api.ts`, `state.ts`, `theme.ts`, `notify.ts`, `i18n.ts`; `tabs/`: `proxies.ts`, `routing.ts`, `studio.ts`, `telemetry.ts`), `src/views/dashboardView.ts`.
- **Function:** Modular browser interface built with TypeScript, compiled via `esbuild` (`npm run build:ui`) into `public/dashboard.min.js`. Integrates full bilingual localization dictionary with 100% ru/en parity and is tested directly through `test/helpers/dashboardDom.ts`.
- **UI Truth Parity:** Dashboard text and tooltips strictly mirror runtime realities — 15m routing sync intervals, Zero-Trust Pull model (~5m sync / restart), audit code legends, and exact fleet status latency thresholds (ONLINE <6m / STALE 6-15m / OFFLINE >15m).
- **Theme-Sync Toggle E2E Gate (THEME-WEB-1, superseded by THEME-SRC):** `localStorage pec_theme_sync_enabled` (`theme.ts` `setThemeSyncEnabled`) persists locally; the original per-config push (`{ themeSyncEnabled }` → `POST /api/builder/config` + `POST /api/app-builder/config`) and its omit-on-`false` delivery semantics were replaced by the global dashboard-as-source store below. Both config routes still whitelist and strictly normalize the key (`ALLOWED_BUILD_CONFIG_KEYS` / `ALLOWED_APP_CONFIG_KEYS`, `=== true || === "true"`) — now serving as the legacy per-config fallback. The safety property stands: the theme flag gates theme delivery only — credentials, kill-switch, and update fields are untouched and evaluated earlier; native clients keep their own defaults (`profile.c` `hasTheme`, `pec_sync.h` object guard).
- **Dashboard-as-Source Server Theme Store (THEME-SRC-1..3):** `src/serverTheme.ts` persists the dashboard «Внешний вид» appearance to `data/server_theme.json` (`writeJsonAtomic`, `{palette, mode, syncEnabled}`; whitelist — 6 palettes, 2 modes, strict boolean — applied on BOTH write and read, so corrupted/hand-edited files degrade to defaults; `SERVER_THEME_PATH` env for test isolation). `GET/POST /api/server-theme` (`src/routes/serverThemeRoutes.ts`, mounted `server.ts` behind `adminAuth` — fleet token gets 401 on both read and write); the dashboard pushes merged appearance patches via `theme.ts pushAppearancePatch` → `adminFetch` (fire-and-forget, failure toast; push points: `setServerTheme`/`setServerThemeMode`/`setThemeSyncEnabled`). `resolveFleetTheme()` derives the client-facing theme ONLY from the fixed registers `PALETTE_TO_APP_STYLE` + `APP_STYLE_SURFACES` — raw store strings never pass beyond palette/mode ids. Global toggle semantics (`resolveThemeSyncEnabled`: store wins → legacy per-config `themeSyncEnabled` fallback → default true): **ON** = clients follow the panel theme on every channel without rebuild — `/api/sync` returns the additive theme block + `colorPalette` (`credsRoutes.ts`), `/api/app/sync` and `buildAppProfile` take preset/mode/surfaces from the panel (THEME-WEB-3 luminance clamps still apply on both branches); **OFF** = constructor themes from `extension_build_config`/`app_build_config` (classic behavior); store missing → neutral defaults. Matrices: `test/serverThemeSync.test.ts` + `test/serverThemeQaMatrix.test.ts` (user case cyber→light lands `#2563eb`/light on all channels without rebuild).
- **Palette Registry Convergence (THEME-WEB-4):** `theme.ts APP_PALETTES` is the single canon (6 palettes: cyber, obsidian, nord, emerald, amber, light); copies in `studio.ts` (validPalettes + chip map), `packager.ts` (`EXTENSION_STYLES_MAP`/`paletteColors`) and `popupHtmlTemplate.ts` (CSS) are converged onto it, with `emerald-sentinel`/`minimal-light` as documented aliases of the native `pec_imgui_theme.h`. Drift protection is a CI gate, not a manual discipline: `test/themePaletteParity.test.ts` + `test/themeHexParity.test.ts` assert hex equality canon↔extension-map↔popup↔both native headers (incl. ImVec4 float↔hex comment roundtrip) — a palette edit without synchronized propagation fails `npm test`.
- **Preset Composer Sub-Page (GEO-PRESET-UX-2):** the Routing tab hosts a full-width preset-constructor sub-page (`presetBuilderPage` in `dashboardView.ts`, logic in `tabs/routing.ts`) — layers panel + composition table with per-entry origin badges, search, and a 500-row render window; card actions live behind the per-card `btn-preset-menu` «⋮» dropdown (outside-click/Escape close at module scope — POPOVER-CLOSE family). Server side of the layered preset model: see §2.3.
- **Perceptual Luminance Clamps (THEME-WEB-3):** `computeHexLuminance` / `isDarkHexColor` / `isLightHexColor` (`appPackager.ts`, weights 0.299/0.587/0.114, dark < 100, light > 175) replaced the leaky `^#2[0-4]` prefix-regex heuristic in both dark-sync clamp sites (`appPackager` profile path + `appSyncRoutes` sync path); non-colors are never clamped. Clamp matrix and the behavioral nord `#2e3440` sync-route case are covered by `test/themeLuminanceClamps.test.ts`.
- **Reactive Studio Simulator Bus (UI-PREVIEW-FLEET-CLEAN-1):** In `studio.ts`, the Extension Studio preview iframe eliminates 404 console errors by directly inlining the theme bootstrap into `<script>` inside `generateMockPopupHtml` rather than requesting the external `popupTheme.js`. The extension preview state (`liveSimState`) dynamically mirrors actual fleet proxies (`availableProxies`, `activeProxyId`, host/port/protocol), PAC routing presets, and permission toggles (`allowUserProxySwitch`, `allowUserBypass`) with two-way `SET_ACTIVE_PROXY` messaging. App Studio replaces the static 30s timing hardcode with dynamic interval display (`appSyncIntervalMinutes`), reactive log sync ticks, and a dynamic traffic intercept generator matching active rules (`currentAppRules`).
- **Fleet Telemetry Contract Hygiene (UI-PREVIEW-FLEET-CLEAN-1):** Removed redundant desktop pairing badges (`🔗 Десктоп`) from the extensions table user column, ensuring clean visual separation between the browser extensions fleet table and native application instances table.
- **Multi-Panel Remnawave Fleet Rotation & Micro-Editor:** `PanelRemnawaveConfig` supports per-panel rotation flags (`rotationEnabled`, `targetUsername`, `rotationIntervalMinutes`) with rotation isolated to active Remnawave-backed proxy nodes. App Studio code editor is upgraded to a lightweight CodeJar + Prism.js micro-implementation with syntax highlighting, indentation, and responsive container bounds. Dashboard assets enforce automatic cache-busting (`?v=${currentVersion}`).

### 2.10 Deployment Secrets & Secret Scanning
- **Modules:** `src/loadEnv.ts` (`loadDockerSecrets`), `docker-compose.yml` / `docker-compose.prod.yml`, `.gitleaks.toml`, `.github/workflows/security.yml`.
- **Function:** Compose deployments can inject all five sensitive variables (`ADMIN_TOKEN`, `EXT_SHARED_TOKEN`, `ADMIN_PASSWORD`, `PAC_SIGNING_SECRET`, `CODE_SIGN_MASTER_KEY`) as `<VAR>_FILE` Docker secrets, resolved by `loadDockerSecrets` with plain-env fallback. `.gitleaks.toml` extends the SHA-pinned gitleaks action with PEC-specific token patterns and fixture allowlists (AUDIT-INFRA-P3).

### 2.11 Per-User Xray Runtime (REMNA-PERUSER-XRAY-1)
- **Modules:** `src/xrayRuntime.ts`, `src/xrayBinaries.ts`, `src/routes/xrayRuntimeRoutes.ts`; consumers `extension/background.js` (mirrored in `src/templates/backgroundTemplate.ts`) and `client/Windows/gui/ui/xray_rt.h` (wired via `client/Windows/gui/ui/pec_sync.h`).
- **Function:** The PEC server is a control plane only — it never runs Xray and never stores subscriptions. Admin pins one Xray core version in the dashboard; the server caches pinned GitHub release archives (`src/xrayBinaries.ts`) and serves them to the fleet over `GET /api/xray-runtime/binaries/:version/download` (fleet-token authenticated, SHA-256 verified).
- **Per-user derivation:** For each AD user, `buildXraySyncBlock` derives a personal localhost listener port via `deriveLocalPort(username, basePort)` (HMAC-SHA256 of `pec-xray-port-v1:{user}` keyed by the master secret, offset into a 4096-port window) and a personal proxy secret. The rendered Xray config's HTTP/SOCKS inbound accounts use exactly the delivered `proxyUser`/`proxyPass` pair, so extension and PEC-App authenticate identically.
- **Consumption:** The extension stores Xray credentials in a separate realm (`memoryXrayCreds` / `chrome.storage.session` key `pecXrayCreds`) and points Chrome at `127.0.0.1:{listenPort}`, failing closed to the legacy PAC when the local listener is dead. PEC-App downloads the pinned core, atomically writes `config.json`, and supervises a local `xray.exe run` child process.

---

## 3. Key Data Flows

1. **Fleet Heartbeat & Sync:**
   - Chrome Extension or PEC-App issues `POST /api/sync` or `GET /creds` with `X-Ext-Token` or `X-Fleet-Token`.
   - Rate limiters evaluate the sliding window.
   - Server registers/refreshes instance metadata in `instances.ts` and returns current proxy credentials and active routing policy.

2. **On-Demand Extension Compilation:**
   - Admin triggers build via `/api/builder/build`.
   - `packager.ts` reads `extension/` sources, injects configuration, signs with `key.pem`, and outputs `.crx` + `updates.xml` to `dist/updates/`.

3. **Scheduled Credential Rotation:**
   - `scheduler.ts` triggers `rotateCredentials()` based on `ROTATION_INTERVAL_MIN`.
   - `rotate.ts` connects to the configured Remnawave panel over a validated, DNS-pinned URL, resolves the target username, revokes only its passwords, and updates `current_creds.json` atomically after the panel confirms the new credential.

4. **Per-User Xray Delivery (REMNA-PERUSER-XRAY-1):**
   - Extension/PEC-App sync (`POST /api/sync`, `GET /api/app/sync`) receives an `xrayRuntime` block built by `buildXraySyncBlock`: enabled flag, pinned core version, per-user derived `listenPort`/`socksPort`, and `proxyUser`/`proxyPass`.
   - The consumer downloads the pinned core from `/api/xray-runtime/binaries/:version/download` (fleet token, SHA-256 verified), runs a local Xray core, and routes traffic through the loopback listener authenticated with the same per-user credentials.

---

## 4. End-to-End Data Flows (Pre-Flight Flow Tracing)
Every multi-tier feature or bugfix touching client-server, UI, or storage boundaries must map the flow across components before making code changes:

```
[Origin: UI/CLI/Event] ➔ [Transport: API Route / Message] ➔ [Domain / Storage: Persistence] ➔ [Assembly / Packager] ➔ [Consumer: Client / Daemon]
```

### Primary Flow 1: Client Profile & Theme Synchronization
```
[App Studio UI: src/client/dashboard/tabs/studio.ts -> public/dashboard.min.js]
                 │ (saveAppStudioConfigAction ➔ POST /api/app-builder/config)
                 ▼
[Server Persistence: data/app_build_config.json via writeJsonAtomic]
                 │
       ┌─────────┴────────────────────────┐
       ▼ (On-Demand Packaging)            ▼ (Dynamic Fleet Sync)
[src/appPackager.ts: buildAppProfile]   [src/routes/appSyncRoutes.ts: POST /api/app/sync]
       │                                  │ (JSON response with Theme payload)
       ▼                                  ▼
[Installer Artifact: .pbprofile]        [Runtime Sync: pec_sync.c]
       │                                  │
       ▼ (First run / install)            ▼
[%APPDATA%\ProxyExtensionCorp\*.pbprofile (CompareFileTime guard)]
       │
       ▼ (ApplyProfileTheme)
[Native GUI Rendering: pec_imgui_theme.h (DirectX 11 ImGui) & ui/theme.h (Win32 GDI)]
```
- **Single Source of Truth:** `data/app_build_config.json` (server) & active `.pbprofile` (client).
- **Persistence & Caching:** Profile cached per-user in `%APPDATA%\ProxyExtensionCorp\pec_profile.pbprofile`. Overwrite requires checking `CompareFileTime` against the installer template.
- **Contract Duplication Guard:** Theming logic is mirrored in `src/client/dashboard/core/theme.ts`, `src/appPackager.ts`, `src/routes/appSyncRoutes.ts`, `pec_imgui_theme.h`, and `ui/theme.h`. Changes to color palettes, mode switches, or fallback luminance thresholds MUST be audited across all five files simultaneously.

### Primary Flow 2: Native Client Verified Self-Update (AUDIT-NAT-1)
```
[Origin: POST /api/app/sync response "update" object (downloadUrl, sha256)]
                 │ (pec_sync.h sync worker ➔ WM_APP_UPDATE ➔ UpdInfo)
                 ▼
[Scheme Gate: UpdIsHttpUrl — only http(s); non-loopback http rejected in UpdOpenGet]
                 ▼
[Transport: gui/ui/update_core.h — UpdDownload (WinHTTP) ➔ %TEMP%\sanitized-basename.exe]
                 ▼
[Verification: UpdVerifyFileSha256 (feed digest mandatory) ➔ UpdVerifyAuthenticode (WinVerifyTrust)]
                 ▼
[Consumer: ShellExecuteW on the VERIFIED LOCAL FILE only, then app quits for install]
```
- **Both GUIs share one pipeline:** `main.c` (classic dialog, `ui/update.h`) and `main_imgui.cpp` (tray MessageBox flow) resolve `ui/update_core.h`; raw `downloadUrl` is never passed to the shell.
- **Single Source of Truth:** download/verify/launch sequence + filename sanitization live only in `ui/update_core.h` (`UpdMakeSafeDest`, `UpdVerifyAndLaunch`).
- **Unity-build include contract:** `update_core.h` requires `profile/profile.h` context (`PB_WriteAppLog`) before inclusion; `WM_APP_DLPROG` is defined there (guarded) — GUI-specific `WM_APP_UPDATE`/`WM_APP_DLDONE` stay in `update.h`.
