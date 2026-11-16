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
              v (127.0.0.1)                                  v Rotation
+----------------------------+                +-----------------------------+
| Desktop Client (PEC-App)   | -------------> | 3x-ui / Xray Panels         |
| - DirectX 11 / Dear ImGui  |   Sync Telemetry| (SSRF Guard & DNS Rebinding |
| - Service / Daemon         |                |  Protection)                |
+----------------------------+                +-----------------------------+
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

### 2.4 Credential Rotation & External Integration
- **Modules:** `src/rotate.ts`, `src/scheduler.ts`, `src/routes/rotationRoutes.ts`.
- **Function:** Automated rotation of proxy credentials with 3x-ui / Xray panels.
- **SSRF Hardening:** Synchronous and asynchronous DNS resolution checks (`validateSafeEndpointUrlAsync`) blocking loopback, link-local, RFC1918 private subnets, and cloud metadata endpoints (`169.254.169.254`).
- **SSRF TOCTOU Pinning (AUDIT-SEC-2):** `createSsrfPinnedFetch` / `makePinnedLookup` (`src/rotate.ts`) freeze validated DNS answers into a custom `undici` Agent `lookup` with `redirect: "manual"`, so panel fetches never re-resolve to a rebound address between validation and connection. Used by all 3x-ui panel calls and `routingRoutes` import-url/refresh.

### 2.5 Packaging & Builder Studio
- **Modules:** `src/packager.ts`, `src/appPackager.ts`, `src/codeSigner.ts`, `src/routes/builderRoutes.ts`, `src/routes/appBuilderRoutes.ts`.
- **Function:** Compiles and signs `.CRX` extension packages with 2048-bit RSA keys (`extension/key.pem`), generates GPO deployment files (`.reg`, PowerShell scripts), and builds cross-platform desktop installers.
- **MV3 CSP-Safe Popup Theme Bootstrap (AUDIT-EXT-2):** `extension/popupTheme.js` — external pre-paint theme script loaded in `popup.html` `<head>` (replaces the former inline FOUC bootstrap rejected by MV3 CSP `script-src 'self'`); generated from `src/templates/popupThemeTemplate.ts` and kept in sync via `npm run sync:templates`.
- **Test Sandbox Contract (AUDIT-NAT-2-TS):** `writeVersionGenHeaders` sanitizes placeholder fleet tokens into an empty `PEC_DEFAULT_FLEET_TOKEN`, and `test/helpers/setup.ts` redirects header regeneration into a sandbox replica via `PEC_CLIENT_WIN_DIR` — `npm test` can never rewrite the committed `client/Windows/**/version_gen.h` copies.

### 2.6 Fleet Telemetry & Sync
- **Modules:** `src/instances.ts`, `src/routes/instancesRoutes.ts`, `src/routes/appSyncRoutes.ts`.
- **Function:** Ingests heartbeats (`POST /api/sync`) from extensions and desktop clients, manages instance state with LRU capacity protection, and provides global kill-switch capability.
- **Enrollment rate limiting:** `EnrollmentTracker` (`src/routes/credsRoutes.ts`) throttles credential-enrollment bursts with an injectable clock (`nowFn`, default `Date.now`) enabling deterministic virtual-time tests (AUDIT-QA-2).

### 2.7 Logging, Observability & Prometheus Metrics
- **Modules:** `src/logger.ts`, `src/metrics.ts`, `src/routes/metricsRoutes.ts`.
- **Function:** Structured logging engine (JSON in production, human-readable text in dev) with automated masking of sensitive keys, passwords, and HTTP Basic Auth credentials. Prometheus exposition endpoint (`GET /metrics`) protected by `ADMIN_TOKEN`.

### 2.8 Release Management & Safe Forward-Rollback
- **Modules:** `src/releases.ts`, `src/routes/releasesRoutes.ts`, `src/utils/semver.ts`.
- **Function:** Release lifecycle and distribution management for desktop and browser clients. Enforces Safe Forward-Rollback for Chrome MV3 extensions (`bumpPatchVersion`), automatically updating `manifest.json`, re-packing, and re-signing CRX archives with RSA key `key.pem`.

### 2.9 Modular Dashboard Frontend
- **Modules:** `src/client/dashboard/` (`core/`: `api.ts`, `state.ts`, `theme.ts`, `notify.ts`, `i18n.ts`; `tabs/`: `proxies.ts`, `routing.ts`, `studio.ts`, `telemetry.ts`), `src/views/dashboardView.ts`.
- **Function:** Modular browser interface built with TypeScript, compiled via `esbuild` (`npm run build:ui`) into `public/dashboard.min.js`. Integrates full 772-entry bilingual localization dictionary and is tested directly through `test/helpers/dashboardDom.ts`.

### 2.10 Deployment Secrets & Secret Scanning
- **Modules:** `src/loadEnv.ts` (`loadDockerSecrets`), `docker-compose.yml` / `docker-compose.prod.yml`, `.gitleaks.toml`, `.github/workflows/security.yml`.
- **Function:** Compose deployments can inject all five sensitive variables (`ADMIN_TOKEN`, `EXT_SHARED_TOKEN`, `ADMIN_PASSWORD`, `PAC_SIGNING_SECRET`, `CODE_SIGN_MASTER_KEY`) as `<VAR>_FILE` Docker secrets, resolved by `loadDockerSecrets` with plain-env fallback. `.gitleaks.toml` extends the SHA-pinned gitleaks action with PEC-specific token patterns and fixture allowlists (AUDIT-INFRA-P3).

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
   - `rotate.ts` connects to 3x-ui panel over validated URL (SSRF check passed), rotates inbound client password, and updates `current_creds.json` atomically.

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
