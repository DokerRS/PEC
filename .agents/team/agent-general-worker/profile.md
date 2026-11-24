# Agent Role Passport: Базовый разработчик (agent-general-worker)

## 1. Purpose and Scope of Responsibility
- **Role Identifier:** `agent-general-worker`
- **Product Scope:** Реализация функционала Express-сервера, генератора PAC-скриптов, взаимодействия с Chrome-расширением и нативных десктопных клиентов PEC-App (Windows C/DirectX 11 и Linux CLI/демон).
- **User Invocation Triggers:** "добавь фичу", "реализуй эндпоинт", "исправь баг", "добавь прокси", "настрой pac", "добавь клиентскую логику".

---

## 2. Connected Skills Stack
- `typescript-expert` — TypeScript 5.7, Express 4, строгая типизация и роуты.
- `clean-code` — лаконичный код без избыточных абстракций.
- `code-reviewer` — самоконтроль качества перед завершением задачи.
- `systematic-debugging` — систематический поиск причин дефектов перед правкой кода.
- `remnawave-xray` — специфика интеграции с 3x-ui / Xray и правила маршрутизации.

---

## 3. Authority and Boundaries Matrix
- **Green Zone (autonomous):** Реализация функционала в `src/`, утилит `src/utils/**`, вспомогательных скриптов `scripts/**`, новых тестов под фичи `test/**/*.test.ts`.
- **Yellow Zone (mandatory verification required):** Изменение публичных API контрактов (`src/routes/**`), схемы типов (`src/types.ts`), шаблонов генерации (`src/templates/**`, `src/views/**`), зависимостей `package.json`.
- **Red Zone (requires direct user confirmation):** Деструктивные действия, изменение механизмов авторизации (`src/auth.ts`, `src/middleware/security.ts`), обход модели двух токенов.
- **Unmapped Paths (Default Deny / Black Zone):** Any file or directory not explicitly listed in Green, Yellow, or Red zones is strictly Red Zone by default.

---

## 4. Systemic Behavioral Invariants
1. **User-Driven Passivity:** Действовать строго по запросу пользователя.
2. **User-Mediated Handoff:** При выходе задачи за рамки специализации формировать пакет передачи (Handoff Packet) через пользователя (лимит цепочки = 2 шага).
3. **Inviolability of Shared Annotations:** Запрещено перезаписывать чужие записи в общих срезах (`tasks.md`, `observations.md`, `architecture.md`).
4. **Workspace Privacy:** Собственные рабочие заметки ведутся исключительно в `.agents/team/agent-general-worker/notes.md`.
5. **Parallel Subagent Delegation (`dispatching-parallel-agents`):** При пакетных независимых задачах делегировать подзадачи изолированным субагентам.

---

## 5. Role Invocation Log (Telemetry)
| Date | Initiator | Task / Invocation | Status / Result |
| :--- | :--- | :--- | :--- |
| 2026-11-09 | System / User | Role initialization | Role activated |
| 2026-11-09 | User | Fix MinGW build failure (lstrcpyW deprecation & guiErrorDetails scope) | Fixed & verified |
| 2026-11-09 | User | Fix theme synchronization between App Studio and native desktop client | Fixed & verified |
| 2026-11-09 | User | Enterprise Blue / dark mode parity across sync, builder & desktop theme | Fixed & verified |
| 2026-11-09 | User | Unbind enterprise-light preset from forced light mode in sync routes, appPackager & C++ GUI | Fixed & verified |
| 2026-11-10 | User | DEV-1 (Graceful shutdown), DEV-2 (Biome linter/formatter), DEV-3 (simple-git-hooks & lint-staged) | Completed & verified (689/689 tests pass) |
| 2026-11-10 | User | LOG-METRICS (src/logger.ts, src/metrics.ts, GET /metrics route, server integration) | Completed & verified (696/696 tests pass) |
| 2026-11-10 | agent-security-auditor | SEC-FIX-1 (VULN-LOG-1 sensitive key pattern & URL Basic Auth masking; VULN-METRICS-1 admin auth on /metrics) | Completed & verified (697/697 tests pass) |
| 2026-11-10 | User | UI-MODULAR (Modularization of public/dashboard.js into src/client/dashboard/ and esbuild build:ui) | Completed & verified |
| 2026-11-10 | User | FIX-UI-BUNDLE (Fix ReferenceError in dashboard.min.js: window bindings, telemetry imports, globals.d.ts, full test suite pass on bundle) | Completed & verified (717/717 tests pass) |
| 2026-11-10 | User | I18N-RESTORE (Restore full 772-entry I18N dictionary in core/i18n.ts and safe icon-preserving setLanguage in core/theme.ts) | Completed & verified (717/717 tests pass) |
| 2026-11-10 | User | FORWARD-ROLLBACK (Safe Forward-Rollback for Chrome extensions with bumped patch semver, CRX re-signing, and UI warning) | Completed & verified (719/719 tests pass) |
| 2026-11-11 | User | AD-USER-ID & GPP-REG (End-to-end domainUser identity in Managed Storage & sync; renderGppRegistryXml generator per MS-GPPREG; Registry.xml in buildGpoPackage zip) | Completed & verified (721/721 tests pass) |
| 2026-11-11 | User | AD-LDAP-SYNC (Server Active Directory integration module via ldapts; recursive group memberOf, disabled accounts filter, atomic cache, scheduler hooks) | Completed & verified (9/9 adSync tests, build:server & lint clean) |
| 2026-11-11 | User | AD-KILL-SWITCH (AD membership enforcement in /api/sync & /api/app/sync, anti-spoofing domainUser lock, instance revocation, renderPacForInstance DIRECT fallback) | Completed & verified (5/5 adKillSwitch tests, build & lint clean) |
| 2026-11-12 | agent-security-auditor | SEC-AD-2 & SEC-AD-1 (Desktop username anti-spoofing binding in appSyncRoutes.ts & instances.ts; security warning in adSync.ts for insecure TLS) | Fixed & verified (7/7 adKillSwitch tests, build & lint clean) |
| 2026-11-13 | User | AD-CONFIG-ROUTES (Persistent ad_config.json storage, /api/ad/* admin endpoints status/config/test/sync-now, soft migration isLegacy flag) | Completed & verified (29/29 AD tests pass, lint clean) |
| 2026-11-13 | User | AD-UI-INTEGRATION (Active Directory / LDAPS management card in GPO tab, modular tabs/gpo.ts, fleet search & domainUser/legacy badges in telemetry.ts, RU/EN i18n, build:ui) | Completed & verified (49/49 dashboard & AD tests pass, build & lint clean) |
| 2026-11-16 | User (AUDIT-2026-11-16 Deep-Track) | Волна 1 (AUDIT-SEC-1, AUDIT-SRV-1) + Волна 2 (AUDIT-SEC-2/3, AUDIT-SRV-2/3, AUDIT-EXT-1/2) + AUDIT-SRV-P3 (12 позиций): two-token isolation в /api/app/sync, readJsonStore+loud-warn для instances_meta/rotation_config/build_config, SSRF TOCTOU IP-pinning (createSsrfPinnedFetch), signtool passwordless cert-store /sha1, adSync interval clamp 5..86400, транзакционность ротации с DESYNC-диагностикой, kill-switch гейт SET_ENABLED + serverDisabled, popupTheme.js вне MV3 CSP (sync:templates), fsync+EBUSY-ретраи, EADDRINUSE, 5xx-masking, drift re-arm, promise-coalescing, PAC-лимит 500k, log-forging sanitize, PAC host:port allowlist, legacy-seed миграция, Windows-ACL секретных сторов | Completed & verified (полный сьют 785/786; единственный фейл — чужой in-flight client/Windows/gui/ui/update.h у agent-native-desktop; lint/tsc/boundary-gate чистые; key.pem не тронут) |
| 2026-11-16 | User (DISPATCH-POSTINCIDENT-2) | UI-HANDLERS-REGRESSION (toggle-обёртки theme.ts + window-экспозиция, RED→GREEN без правок теста) + AUDIT-NAT-2-TS (санитизация плейсхолдер-токенов в writeVersionGenHeaders, PEC_CLIENT_WIN_DIR sandbox, revert загрязнения version_gen.h ×5) | Completed & verified (appPackager 31/31, dashboardThemeSyncAndAppStudio 6/6, headers clean) |
| 2026-11-16 | Dispatcher (P3-B Fast-Track) | codeSigner P3-B: PFX_PASS вырезан из env signtool-процесса (passwordless /sha1 флоу), тесты N-1/codeSignerArgs перевёрнуты | Completed & committed (e95b6c5, 19/19, tsc/biome clean) |
| 2026-11-16 | Dispatcher (THEME-2026-11-16) | THEME-WEB-1..4: E2E themeSyncEnabled (оба конфиг-роута + гейты buildAppProfile/appSyncRoutes + честная метка), app-builder whitelist + hex-валидация, luminance-клампы вместо ^#2[0-4], конвергенция палитр к канону theme.ts + hex-parity тест | Completed & committed (d7e3743, 2dfeefe, b1e452e, affcc58; lint/tsc clean) |
| 2026-11-17 | agent-qa-engineer (THEME-DISPATCH-1-A) | POPOVER-CLOSE-REGRESSION (document-listeners restored in index.ts) + STUDIO-AMBER-PALETTE-REGRESSION (amber in validPalettes + chip) + STUDIO-EMERALD-LIGHTBG-REGRESSION (#f0fdf4 ×2) — все RED-тесты GREEN без правок тестов | Completed & committed (31742ec, 4f84046, be0cdd9; lint/tsc clean; build:ui on every step) |
| 2026-11-17 | Dispatcher (THEME-SRC-2026-11-17) | THEME-SRC-1..4: server_theme.json стор + admin-only /api/server-theme, dashboard appearance push (palette/mode/syncEnabled), dashboard-as-source на /api/sync + /api/app/sync + buildAppProfile (ON=панель/OFF=конструкторы/absent=нейтраль/legacy fallback), честный i18n+hint | Completed & committed (030ce62, fdd6888, 0afd199, d7fc65d; lint/tsc clean) |
| 2026-11-17 | Dispatcher (THEME-SRC-FIX, пост-релизный репорт) | FIX-1: boot-reconciliation appearance store (once-per-session push из bootDashboard, localStorage fallback) + FIX-2: extension build запекает тему панели при ON (applyDashboardThemeToClientConfig в packager + preview; красная нить «синяя панель — фиолетовый попап» закрыта) | Completed & committed (30d764f, 360e95c; lint/tsc clean, sync:templates/build:ui) |
| 2026-11-17 | Dispatcher (AD-TLS-OPT-1 Fast-Track) | buildClientOptions: ldapts tlsOptions только для ldaps:// (ECONNRESET-кворк 9.2.0, прод-бисекция); testConnection+sync переведены; версия-гвард + observation [runtime] | Completed & committed (0439aa9; adSync 14/14; tsc/biome clean) |
| 2026-11-17 | Dispatcher (THEME-SRC-FIX-3/5, живая диагностика v1.0.19) | FIX-3: popup server-theme mode priority (source marker, background persist, vm-тесты) + FIX-5: packageExtension panel-theme overlay, writeGeneratedFile gate устранён (корень «пересборка не меняет вставки»), grep white-list, builder-контракт перевёрнут | Completed & committed (3fb19d2, 132bb29; lint/tsc clean) |
| 2026-11-18 | Dispatcher (EXT-SCHEMA-ESCAPE-1 P1, update-channel blocker) | managed_schema.json domainUser: валидный JSON-escape (учетверение в TS-литерале), sync:templates регенерация, гарант-сьют strict JSON.parse артефактов+CRX-zip+XML-audit (RED 0/4 → GREEN 4/4) | Completed & committed (a3b1282; tsc/biome clean) |
| 2026-11-19 | Dispatcher (FLEET-UI-1 Fast-Track) | Fleet page: обе таблицы фиксированной одинаковой высоты со sticky-заголовками; заголовки Расширения/Приложения (i18n ru/en) | Completed & committed (abc238b; devicesView+dashboard+i18n 18/18; lint clean) |
| 2026-11-19 | Dispatcher (AD-UX-2 Fast-Track) | countUniqueUsers (уникальные sAMAccountName) + usersCount/uniqueUsersCount в status/sync-now, два бейджа с tooltip на форме AD, i18n ru/en, golden-ассерты | Completed & committed (11bca8c; AD-сьюты 48/48; lint clean) |
| 2026-11-19 | Dispatcher (EXT-DOMAINUSER-1 P2) | GPO domainUser propagation & managed storage chain: vm-тест background->/api/sync, deploy -DomainUserName override + %USERNAME% fallback, verify WARN on missing key, guide §3 note, anti-spoofing leak fix in instances.ts | Completed & committed (test GREEN 3/3, AD 39/39, lint clean) |
| 2026-11-21 | User (GPO-CANONICAL-REG-1) | Полное удаление GPP Registry.xml и скриптов PowerShell; канонизация GPO развертывания на .REG и GPMC (3 параметра реестра) | Completed (build OK, lint 0 errors, tests GREEN) |
| 2026-11-22 | Dispatcher (THEME-APP-PREVIEW-1 Fast-Track) | App Studio preview follows panel palette/mode: neutral listener registry (state.ts), publish из setServerTheme/Mode, studio подписка, бейдж при lock = панельный пресет, vm-тесты | Completed & committed (1820436; 4/4; lint/build clean) |
| 2026-11-22 | Dispatcher (EXT-GPO-ALLOWLIST-1 Deep-Track-lite) | .reg генерация: ExtensionInstallForcelist → indexed Allowlist/Sources (default 100, installIndex опция), renderGpoReadme/guide/README/telemetry — синхронная замена | Completed & committed (4e3a823; GPO-сьюты 32/32; lint clean) |
| 2026-11-24 | Dispatcher (MSI-SILENT-1 P1) | MSI-канал: относительные Source в wxs + cwd wixl + Platform удалён; hasWixl/success=false логи; реальный baseUrl; download/msi пометка template-fallback; stderr проброс | Completed & committed (50c3b91; msiSilent 5/5; tsc/biome clean) |
