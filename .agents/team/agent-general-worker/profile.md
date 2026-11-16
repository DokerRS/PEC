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
