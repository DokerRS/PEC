# Agent Observation Registry

Cumulative registry of findings, non-obvious environment quirks, and practical solutions.
Entries are added strictly via the `record-observation` skill in a concise table format (1 line per fact).

---

| Date | Category | Component / Path | Observation / Issue | Solution / Workaround |
| :--- | :--- | :--- | :--- | :--- |
| 2026-11-09 | [init] | repo/init | Meta-project repository initialization | Baseline scaffold deployed |
| 2026-11-09 | [runtime] | src/jsonStore.ts | Windows file lock (EPERM/EBUSY) during atomic rename | Unlink target before rename in Windows error handler |
| 2026-11-09 | [security] | src/rotate.ts | DNS rebinding bypass of private network check | Use async DNS lookup (`validateSafeEndpointUrlAsync`) before outbound requests |
| 2026-11-09 | [build] | Dockerfile | MinGW-w64 & msitools required for client builds | Multi-stage Dockerfile includes tools in both builder and runner stages |
| 2026-11-09 | [security] | server.ts | Accidental token parity between ADMIN and FLEET | Hard fatal exit check if `ADMIN_TOKEN === EXT_SHARED_TOKEN` |
| 2026-11-09 | [build] | client/Windows/gui, src/appPackager.ts | MinGW build failure from strsafe lstrcpyW deprecation and packager guiErrorDetails scope | Replace lstrcpyW with StringCchCopyW and hoist guiErrorDetails to function scope |
| 2026-11-09 | [theme] | client/Windows/gui, public/dashboard.js | App Studio theme desync: stale profile in %APPDATA%, missing autosave on build, dark mode text contrast on light bg | Overwrite stale user copy if src newer, detect bg luminance in ImGui theme, autosave config before build |
| 2026-11-09 | [theme] | public/dashboard.js, client/Windows/gui/ui/theme.h | Enterprise Light 5th dot forced light mode in dark panel | Decouple palette from mode, add dark background/card values to enterprise-light |
| 2026-11-09 | [theme] | src/routes/appSyncRoutes.ts, client/Windows/gui | Dynamic sync route forced light mode for enterprise-light preset | Decouple preset style from defaultThemeMode and sanitize light colors during dark sync |
| 2026-11-10 | [runtime] | server.ts, test/gracefulShutdown.test.ts | Windows Winsock TCP RST (`ECONNRESET`) during server shutdown when keep-alive sockets are closed abruptly before HTTP response completes | Set `Connection: close` on shutdown, immediately call `server.close()`, allow in-flight requests a 500ms grace window, and then drain remaining idle keep-alive sockets with `server.closeIdleConnections()` |
| 2026-11-10 | [build] | .npmrc | Broken proxy in global `~/.npmrc` (`ECONNRESET` during npm TLS handshake) blocks dependency installation | Project-level `.npmrc` with `proxy=null` and `https-proxy=null` overrides user config and enables direct connections |
| 2026-11-10 | [test] | test/helpers/dashboardDom.ts, tsconfig.json | Тестовый стенд jsdom исполнял устаревший public/dashboard.js вместо скомпилированного public/dashboard.min.js, а tsconfig исключал src/client, создавая ложноположительные прогоны тестов | Переключить DASHBOARD_JS_PATH на dashboard.min.js и включить src/client в tsconfig.json |
| 2026-11-10 | [orchestration] | .agents/skills/tune-meta-project | Сессия калибровки окружения по навыку tune-meta-project: верифицирован баланс 6 ролей, подтверждено 100% покрытие boundaries.md, актуализированы срезы weak_spots.md | Использовать навык tune-meta-project для периодического аудита трения в коммитах |
| 2026-11-11 | [ci] | scripts/patch-node20.cjs, scripts/run-tests.ts | jsdom@30 и undici@8 используют ES2024 фичи (Iterator Helpers, Promise.withResolvers, zlib.createZstdDecompress, worker_threads.markAsUncloneable), отсутствующие в Node 20 | Создан предзагрузочный полифилл scripts/patch-node20.cjs, внедряющий методы в V8 и VM-контексты JSDOM |
| 2026-11-16 | [init] | .agents/meta-project.json, scripts/ | Legacy-unregistered meta-project (no registry, stale .agents/scripts, outdated skills) adopted to current upstream vlv-code/meta-project@main via init Scenario 5 | Registry schema 1.1.0 created (zc-main/zcode, 6 roles, shared_repo); 8 canonical scripts deployed verbatim to scripts/ with md5 verification; 9 skills refreshed; AGENTS.md upgraded to 8-section format |
