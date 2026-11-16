# Weak Spots, Risks, and Technical Debt

Registry of fragile areas, latent risks, and known repository constraints.

---

## 1. Fragile Modules and High Coupling
- **Modularized Dashboard Frontend & Server View (`src/views/dashboardView.ts` & `src/client/dashboard/`):** Клиентский JS вынесен из монолита в модульный TypeScript (`src/client/dashboard/`) и собирается через esbuild в `public/dashboard.min.js`. Тестовый стенд jsdom (`test/helpers/dashboardDom.ts`) исполняет непосредственно скомпилированный бандл. Сам `dashboardView.ts` генерирует каркас разметки (~158 KB), требуя верификации DOM-тестами (`test/dashboard*.test.ts`).
- **Binary Packaging Engines (`src/appPackager.ts` & `src/packager.ts`):** Highly complex packaging logic (~121 KB and ~52 KB) coupling MinGW-w64 cross-compilers, NSIS/wixl MSI generation, zip archive creation, and Authenticode signing. Heavily dependent on host system toolchains and path resolution.
- **Embedded JavaScript Extension Templates (`src/templates/popupJsTemplate.ts` & `backgroundTemplate.ts`):** Large JavaScript templates (~57 KB and ~74 KB) maintained as TypeScript template literals. Synchronized with `extension/` via `npm run sync:templates`. Syntax errors in template literals bypass `tsc` and fail only at extension runtime.
- **Cross-Layer Theme Synchronization Coupling:** Theming contracts are duplicated across 5 files in two languages (`public/dashboard.js`, `src/appPackager.ts`, `src/routes/appSyncRoutes.ts`, `client/Windows/gui/pec_imgui_theme.h`, `client/Windows/gui/ui/theme.h`). Ad-hoc heuristic checks for color brightness or regex sanitizing can cause cascading regressions between dark and light modes.

---

## 2. Environment and Runtime Constraints
- **Stable Extension ID Invariant (`extension/key.pem`):** Chrome enterprise GPO deployments (`ExtensionInstallForcelist`) depend strictly on the RSA-2048 public key hash. Overwriting or losing `key.pem` permanently breaks extension installation and updates across the entire enterprise AD fleet.
- **Two-Token Model Separation (`ADMIN_TOKEN` vs `EXT_SHARED_TOKEN`):** `EXT_SHARED_TOKEN` is low-privilege and baked into public CRX/GPO artifacts. `ADMIN_TOKEN` grants full management access. If `ADMIN_TOKEN === EXT_SHARED_TOKEN`, `server.ts` aborts with a fatal exit.
- **Container Cross-Compilation Toolchain:** Docker container builds require `mingw-w64`, `msitools`, and `wixl` in the runner image to support on-demand desktop client packaging.
- **File-Based JSON Storage Concurrency (`src/jsonStore.ts`):** Zero external database; persistence relies on atomic temp-file creation and rename. On Windows environments, file locking (`EPERM`/`EBUSY`) requires the explicit unlink-before-rename fallback in `writeJsonAtomic`.
- **SSRF and DNS Rebinding Protection (`src/rotate.ts`):** Outbound requests to 3x-ui panels resolve hostname via DNS (`validateSafeEndpointUrlAsync`) to block rebinding attacks against loopback or RFC1918 private subnets unless explicitly enabled with `ALLOW_INTERNAL_PANEL=true`.
- **Windows User Profile Caching (`%APPDATA%`):** Desktop client caches profile in `%APPDATA%\ProxyExtensionCorp\pec_profile.pbprofile`. Reinstalling updated packages requires explicit `CompareFileTime` checks against installer defaults to prevent silently serving obsolete configurations.

---

## 3. Deferred Technical Debt
- **Process Memory State for Rate Limiting & Instances:** Rate limiters and instance registry rely on in-memory LRU caches (`src/instances.ts`, `src/middleware/security.ts`). Multi-replica horizontal scaling would require external shared caching (e.g., Redis).
- **Automated Template Drift Verification:** Ручная синхронизация (`npm run sync:templates`) закрыта автоматическим барьером в CI (`.github/workflows/ci.yml: template-drift-check`), блокирующим расхождение кода `extension/` и строковых шаблонов `src/templates/`.
