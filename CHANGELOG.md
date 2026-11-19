# Журнал изменений (CHANGELOG)

Все заметные изменения в проекте **PEC - Proxy Extension Corp** документируются в этом файле.

## [0.9.7-alpha] - 2026-11-19
### Added
- **EXT-DOMAINUSER-1**: Automatic `domainUser` propagation in `deploy-pec-gpo.ps1` with fallback to `$env:USERDOMAIN\$env:USERNAME`, enabling seamless enterprise domain identity in fleet telemetry via Managed Storage.
- **AD-UX-2**: Honest AD metrics — distinct counts for unique AD user accounts vs. multi-attribute identifiers (`sAMAccountName`, `userPrincipalName`, `mail`) in the GPO tab and status API.
### Changed
- **FLEET-UI-1**: Fleet telemetry tables unified to fixed 420px height with sticky headers and distinct `Extensions` / `Applications` section titles.

## [v0.9.6-alpha] - 2026-11-18 — Patch: Managed Schema JSON Escape (Update-Channel Blocker)

**P1-блокер всего update-канала расширения**: `managed_schema.json` нёс невалидный JSON-escape (одиночный backslash вместо удвоенного в `DOMAIN+\\username` подстановке domainUser) — браузеры скачивали обновление и падали на парсе схемы (воспроизведено на живом проде: Edge загрузил пакет и отклонил установку).

### 🔧 Исправления
- **EXT-SCHEMA-ESCAPE-1** (a3b1282): `managedSchemaTemplate.ts` — учверённое экранирование в TS-литерале так, чтобы в артефакте было валидное `\\` (DOMAIN + 2 backslash + username); `extension/managed_schema.json` перегенерирован через `sync:templates` (strict JSON.parse OK).
- **Новый гарант** (`extensionArtifactJson.test.ts`): strict `JSON.parse` шиппимого `managed_schema.json` + всех генерируемых build-output `.json` + всех `.json`-entries упакованного CRX-зипа (AdmZip) — RED 0/4 на битом артефакте, GREEN 4/4 после фикса.
- **Аудит** остальных генерируемых `.json`/`.xml`: GPP Registry.xml/updates.xml не содержат unicode-escape класса (амперсанды экранированы, path-бэкслеши — легитимные XML-данные); backslash-u литералов в gpoTemplates/translations нет.

### 📌 После обновления
`git pull` → деплой → **пересборка расширения в студии** → публикация → управляемые машины обновятся автоматически (механизм подтверждён логом Edge).

## [v0.9.5-alpha] - 2026-11-18 — Patch: Popup Theme Priority & Stale-Bake Root Cause

Патч-релиз к v0.9.4-alpha: закрывает красную нить пользовательской диагностики попапа («значок и часть вставок остаются фиолетовыми ни от смены тем, ни от пересборки»). Полный сьют 851 тестов, lint/build зелёные.

### 🎨 Темы попапа (dashboard-as-source доводка)
- **Приоритет серверной темы с маркером источника** (3fb19d2, THEME-SRC-FIX-3): theme-блоки `/api/sync` и `/api/app/sync` несут `source: 'dashboard' | 'constructor'`; попап применяет `data-theme` сервера при активной панельной теме (sync ON), локальный тумблер режима продолжает работать оффлайн и при конструкторной теме; контракт задокументирован в tooltip переключателя (ru/en: при активной серверной теме панель перекроет выбор при следующей синхронизации).
- **Корень «пересборка не меняет вставки»** (132bb29, THEME-SRC-FIX-5): найден и устранён `writeGeneratedFile`-гейт — EXT-копии писались только при `!exists`, **первая сборка навсегда замораживала тему** артефактов (фиолетовые `#c084fc` вкладки/бейджи/кнопки из build-time конструкторной палитры переживали любые пересборки); packagePackage больше не копирует устаревшие EXT-файлы (manual edits защищены overriddenFiles-контрактом, тест перевёрнут); все поверхности попапа унифицированы на CSS-переменные (grep-тест: 0 inline-hex вне white-list), иконка запекается темой панели при sync ON (FIX-4 слит сюда, контракт решён пользователем).

### 🧪 Гигиена тестов и артефактов
- Observation [testing] (08a9b05): builder-сьют вне изоляции `npm test` может загрязнять реальные `extension/` артефакты — задокументировано.
- Resync артефактов (bbec4c8): `extension/` приведён к каноническому дефолт-рендеру после инцидента загрязнения.

## [v0.9.4-alpha] - 2026-11-17 — Patch: Theme Propagation Follow-ups & AD/LDAPS Fix

Патч-релиз к v0.9.3-alpha: два доводка dashboard-as-source (закрывают хвосты пользовательского сценария) и критичный фикс AD-интеграции. Полный сьют — 844/844, lint/build зелёные.

### 🎨 Темы (доводка dashboard-as-source)
- **Boot reconciliation** (30d764f, THEME-SRC-FIX-1): при загрузке дашборда `reconcileAppearanceWithServer()` единожды за сессию пушит текущее `{palette, mode, syncEnabled}` в `/api/server-theme` (fire-and-forget, идемпотентно) — закрыт класс «стор разошёлся с панелью» (деплой фичи, очистка `data/`, второй админ-браузер). RED-тест: пустой стор + nord/light в localStorage → `/api/sync` отдаёт тему панели без ручных действий.
- **Запекание темы панели в extension-билд** (360e95c, THEME-SRC-FIX-2): при `syncEnabled=true` и непустом сторе пакетировщик применяет тему панели к артефактам (popup `data-palette`/`--primary`, `getThemeStyles`, иконки; студийный live-preview — тот же контракт); при OFF/пустом сторе — конструкторная конфигурация. Красная нить пользователя: «собрал расширение при синей панели — попап фиолетовый» — теперь ON-билд несёт панельную тему даже до первой синхронизации.

### 🔧 AD / LDAP
- **AD-TLS-OPT-1** (0439aa9, P1-блокер AD-функциональности): `adSync.ts` передаёт `tlsOptions` только для `ldaps://` (helper `buildClientOptions`, применён в `testConnection` и `sync`; гвард версии ldapts@9.2.0). Причина: ldapts при передаче `tlsOptions` на `ldap://` вызывает ECONNRESET до LDAP-диалога — воспроизведено на проде трёхвариантной бисекцией, observation записана. После обновления: `git pull` + `docker compose build/up` + «Синхронизировать сейчас».

## [v0.9.3-alpha] - 2026-11-17 — THEME-SRC-2026-11-17: Dashboard-as-Source Theme Propagation

Дашборд «Внешний вид» становится источником тем для клиентов при включённом тумблере синка (устранение пользовательского репорта «у расширения фиолетовый акцент» при синей палитре панели). Нативные клиенты не затронуты (payload `/api/app/sync` и `.pbprofile` неизменны — меняется источник значений на сервере). Независимая верификация — **THEME-SRC-VERIFY-SEC PASS** + **THEME-SRC-QA GREEN** (полный сьют 842/842, lint/build зелёные).

### ✨ Новая функциональность
- **Серверный стор темы панели** (030ce62, THEME-SRC-1): `data/server_theme.json` (`{palette, mode, syncEnabled}`) через `writeJsonAtomic`; `GET/POST /api/server-theme` строго за adminAuth (fleet-токен — 401 на запись и чтение); whitelist palette (6) / mode (2) + strict-boolean coercion **на чтении и записи**; `SERVER_THEME_PATH` для тест-изоляции; регистры `PALETTE_TO_APP_STYLE` + `APP_STYLE_SURFACES` (hex-parity с EXTENSION_STYLES_MAP закреплена тестом); `resolveThemeSyncEnabled` (глобальный wins → legacy per-config → дефолт true).
- **Пуш темы из дашборда** (fdd6888, THEME-SRC-2): `setServerTheme` / `setServerThemeMode` / `setThemeSyncEnabled` пушат appearance-патч в `/api/server-theme` (fire-and-forget, toast при неудаче); localStorage остаётся мгновенным UI-состоянием дашборда; legacy per-config пуш THEME-WEB-1 заменён глобальным.
- **Dashboard-as-source на всех каналах** (0afd199, THEME-SRC-3): тумблер ON → тема панели доставляется в `/api/sync` (extension: additive theme-block `{palette, preset, mode, primary, background, card}` + `colorPalette`), `/api/app/sync` (app-пресет с THEME-WEB-3 клампами) и `buildAppProfile` (.pbprofile) — **без пересборки артефактов**; OFF / отсутствует стор → темы конструкторов (классическое поведение); legacy `themeSyncEnabled` в builder-конфигах — fallback без обрыва инсталляций, глобальный флаг приоритетен.

### 🛠️ Уточнения и регрессии
- **Честная семантика тумблера** (d7fc65d, THEME-SRC-4): i18n метки и hint (ru/en) — «клиенты следуют теме панели; при выключении применяются темы конструкторов».
- **S-06** (407549b): закрыта регрессия prefix-less маунта appearance-роута — прод-маунт `/api/server-theme` (server.ts), перехват всех запросов исключён, закреплено serverHygiene S-06 и тест-харнессом с прод-префиксом.

### 🧪 Верификация
- **THEME-SRC-QA** (79b5e05): независимая матрица `serverThemeQaMatrix` 7/7 через реальный `POST /api/server-theme` за adminAuth — RED→GREEN кейс пользователя (obsidian #c084fc при OFF → панель light/#2563eb на всех трёх каналах без пересборки), OFF/absent/legacy/global-wins, 6 палитр × 3 канала vs канон, auth-матрица (fleet/anon/wrong-token 401, отклонённая запись не мутирует стор), whitelist-инъекции без 500; полный прогон **842/842**.
- **THEME-SRC-VERIFY-SEC: PASS** — запись admin-only (двойной auth-контур), инжект-поверхностей нет (выход только из фиксированных регистров), привилегии fleet-токена не расширены, в theme-payload нет токенов/кредов/admin-полей.

### ⚙️ Инфраструктура
- README-бейджи релиза ×2 актуализированы до v0.9.3-alpha.

## [v0.9.2-alpha] - 2026-11-17 — THEME-2026-11-16: Theme Contract Deep Audit Remediation

Устранение находок аудита темового контракта (3 параллельных flash-аудита: web/server, натив+артефакты, расширение+Linux; 1×P1, 8×P2, ~10×P3). Инвариант Contract Duplication Guard (5 файлов темовой логики) удержан; независимая верификация — **VERIFY-SEC PASS** + **VERIFY-QA GREEN** (полный сьют 823/823, lint/build зелёные).

### 🔴 P1 — E2E тумблер синка тем
- **THEME-WEB-1** (d7e3743): `themeSyncEnabled` пробрасывается в `POST /api/builder/config` и `POST /api/app-builder/config` (strict-boolean, whitelist), гейтит Theme-секцию в `buildAppProfile` и `/api/app/sync` (sync=false → клиенты не получают тему, Icon/PecSync не затронуты; kill-switch/anti-spoofing выполняются раньше и безусловно). Дефолт `true` — поведение существующих инсталляций не меняется. Честная формулировка метки (без «и значок»), UI-локи студий сохранены.

### 🟠 P2
- **THEME-WEB-2** (2dfeefe): app-builder config/build — whitelist `ALLOWED_APP_CONFIG_KEYS` (26 ключей) + hex-валидация `^#[0-9a-fA-F]{6}$` для themeColor/themeBackground/themeCard на обоих эндпоинтах; `updatedAt` server-owned (зеркало builderRoutes).
- **THEME-WEB-3** (b1e452e): leaky-регекс `^#2[0-4]` заменён перцептивными luminance-клампами (0.299/0.587/0.114, dark<100, light>175, референс pec_imgui_theme.h) в appPackager и appSyncRoutes — «тёмные карточки на light-сборках» (#2e3440 nord, #261805 amber, #2a2a3a) устранены.
- **THEME-WEB-4** (affcc58): конвергенция копий палитр к канону theme.ts (studio, packager EXTENSION_STYLES_MAP, popupTemplate, colorMap #c084fc, styleToPalette; мёртвая sunset удалена; setServerTheme whitelist 5 тем). Дрейф-защита — test/themePaletteParity.test.ts.
- **THEME-NAT-1** (3f53c63): PecProfileLock — реальный CRITICAL_SECTION в C-сборке (no-op удалён); UI-свапы профиля (SwitchToProfile, PB_ProfileSave) держат лок — гонка theme-RMW × sync-поток закрыта.
- **THEME-NAT-2** (567df96): ImGui light-гвард custom card (IsLightMode + канал <160 → белый, паритет с ui/theme.h) — единый контракт ImGui↔GDI на одном профиле.
- **THEME-NAT-3** (690310f, P3-пакет): единый предикат light-детекции в обоих GUI (lum>175 OR all>180); first-run theme-adoption в ImGui (card/layout) и GDI (content-diff); float↔hex дрифт 6 ImVec4 приведён к канону (79 цветов сверены, 0 дрифта); Linux pb_profile — Theme/PecSync больше не теряются в round-trip (jv_dump re-emit).
- **THEME-QA-1/2** (f3a58ee): миграция сьютов с мёртвого public/dashboard.js на dashboard.min.js; новый test/themeHexParity.test.ts — hex-parity канон↔ImVec4↔GDI↔студия, drift-guard всех ~50 float-комментариев, юнит-тесты theme-sync (дефолт true, coercion, persist+push).

### 🛡️ Верификационные регрессии (пойманы новыми тестами до релиза)
- **POPOVER-CLOSE** (31742ec): восстановлены document-listeners — закрытие popoverCustomization/popoverVersionRelease кликом мимо и Escape (третья потеря порта UI-MODULAR-1).
- **STUDIO-AMBER** (4f84046): палитра amber в whitelist валидных + собственный чип (highlightStyleChip('sunset-amber') больше не падает молча на cyber).
- **STUDIO-EMERALD** (be0cdd9): lightBackground emerald сходится к канону #f0fdf4 (серверный clamp и packager синхронны).

### ⚙️ Инфраструктура
- README-бейджи релиза ×2 (README.md, README.ru.md) актуализированы до v0.9.2-alpha.

## [v0.9.1-alpha] - 2026-11-16 — AUDIT-2026-11-16: Deep Audit Remediation

Устранение находок глубокого аудита репозитория (6 доменных flash-аудитов, 0×P0 / 3×P1 / 19×P2 / ~50×P3), скоординированных диспетчером в три волны; независимая верификация — **вердикт PASS** (agent-security-auditor, strict_independent, полный сьют 795/795).

### 🔴 Волна 1 — блокеры P1
- **AUDIT-NAT-1**: server-controlled `update.downloadUrl` более не запускается через `ShellExecuteW` напрямую — единый verified-pipeline `update_core.h` (гейт схемы `UpdIsHttpUrl` → `UpdDownload` → SHA-256 → WinVerifyTrust/Authenticode → запуск); паритет ImGui и классического GUI (коммиты a033423, d32785e).
- **AUDIT-NAT-2**: `PEC_DEFAULT_FLEET_TOKEN` во всех 5 копиях `version_gen.h` — пустая строка (безопасный дефолт); example.com/test-token guards; санитизация `PLACEHOLDER_FLEET_TOKENS` в appPackager; sandbox `PEC_CLIENT_WIN_DIR` для тестовых пересборок.
- **AUDIT-INFRA-4**: CI — `build:ui` до `npm test` + drift-гейт `public/dashboard.min.js` (коммит e60e454).
- **AUDIT-SEC-1**: `/api/app/sync` больше не раскрывает креды в `availableProxies` — только назначенный `activeProxy` (97b873d).
- **AUDIT-SRV-1**: `instances_meta.json` через `readJsonStore` (.corrupt-<ts> контракт) с loud-warn (97b873d).

### 🟠 Волна 2 — P2
- **AUDIT-SEC-2**: SSRF TOCTOU — `createSsrfPinnedFetch`/`makePinnedLookup` (undici Agent с замороженным lookup, validated-адреса, `redirect: manual`).
- **AUDIT-SEC-3**: подпись Authenticode без пароля PFX в argv (`/sha1` thumbprint; пароль только через `$env:PFX_PASS` в PowerShell-импорте) + P3-B: env signtool-процесса очищен от `PFX_PASS` (e95b6c5).
- **AUDIT-SRV-2/3**: кламп `syncIntervalSec` 5..86400; транзакционность ротации (`rotationInFlight`, ретраи записи, честная диагностика FLEET DESYNC).
- **AUDIT-EXT-1/2**: гейт `SET_ENABLED(true)` при killSwitch/revoked; inline FOUC-бутстрап темы вынесен в `popupTheme.js` (MV3 CSP `script-src 'self'`).
- **AUDIT-NAT-3..7**: teardown сервиса (CancelSynchronousIo по thread-handle, bounded joins), PecProfileLock-снапшоты, {0}-инициализация wide-строк, нормализация byte-order портов.
- **AUDIT-INFRA-1/2/3**: `.dockerignore` — крипто-материал исключён из build context (инвариант детерминированного extension ID); gitleaks-action пиннинг по SHA; OpenAPI — фиктивные пути заменены реальными эндпоинтами, license → AGPL-3.0-or-later (e60e454).

### 🟡 Волна 3 — P3
- **AUDIT-INFRA-P3**: удалены фиктивные `METRICS_PORT`/`METRICS_AUTH`; `.env.example`/README дополнены 9 реальными ключами (Truth Parity); SECURITY.md версии → 0.9.x-alpha; compose `<VAR>_FILE`-секреты; `docker-build` CI job; `.gitleaks.toml` (7 PEC-правил).
- **AUDIT-QA-1/2/P3**: миграция сьютов на `dashboard.min.js`; виртуальные часы в EnrollmentTracker; sleep→await, source-content→поведенческие ассерты; юнит-тесты `src/client/dashboard` (70b00d4).
- **AUDIT-SRV-P3/NAT-P3**: readJsonStore loud degradation, re-arm таймера ротации; DPAPI at-rest, bounded strings, единый источник версий, WM_NCDESTROY cleanup (6ea9033, 1ad6f0c).
- **P3-A/B/C**: https-гейт syslink release_notes (8750304); env signtool без PFX_PASS (e95b6c5); ENOTFOUND-классификация в ssrfPinnedFetch-тестах (9e2599d).

### 🛠 Инфраструктура и гигиена
- `.gitignore`: `.agents/project_knowledge/*.lock` (0-байтовый остаток lock-контракта `record_obs.py` — by-design).
- CI: docker-build job (без push), permissions не расширены.

### ⏳ Известные ограничения (known issues)
- **Stale-бинарники**: `templates/app/windows/PEC-App.exe`, `.pristine/PEC-App.exe`, `PEC-App.msi` (+`.pristine`) содержат маркеры-плейсхолдеры (`test-admin-token` utf16le / `corp-proxy-secret-token-change-me`) — known-issue до релизной пересборки (DISPATCH-CLOSURE-4). Эмпирически установлено: пересборка из HEAD устраняет оба маркера-секрета, однако литералы NAT-2-гардов (`wcsstr(..., L"test-admin-token")` в main.c/main_imgui.cpp) компилируются в exe как UTF-16LE и формально ломают bytescan-критерий приёмки «0 обоих маркеров» — зарегистрирован Handoff на agent-native-desktop (literal-free guards); после фикса — пересборка + обновление SHA-256 пина в `test/binaryIntegrity.test.ts`.
- **libsecret для Linux-клиента — решение infra: DEFER** (отложено до пост-альфа). Обоснование: Linux-клиент эксплуатируется преимущественно как headless systemd-демон на серверах/шлюзах (см. SECURITY.md, модель угроз п.3), где Secret Service/libsecret требует графическую сессию и отсутствует; текущая митигация — права `0600 root` (AR-4). Новая зависимость будет пересмотрена при появлении поддерживаемого desktop-Linux-сценария.

## [v0.9.0-alpha] - 2026-11-11 (Public Alpha)

Первый открытый альфа-выпуск платформы централизованного управления парком прокси и политиками маршрутизации **PEC (Proxy Extension Corp)** для открытого тестирования функционала сообществом. Серверное ядро и веб-синхронизация проверены в эксплуатации, а нативные клиенты (Windows/Linux) и сценарии развертывания Active Directory GPO находятся в фазе активного сбора обратной связи.

### 🌟 Ключевые возможности платформы

#### 1. PEC Server & Management Dashboard
- **Централизованный сервер синхронизации**: высокопроизводительный бэкенд на базе Node.js LTS и Express с поддержкой защищенного протокола синхронизации политик `/api/sync`.
- **Административная веб-панель**: современный адаптивный дашборд для управления парком устройств, узлами прокси, маршрутами PAC и конструктором сборок.
- **Безопасная аутентификация**: сессионный механизм на базе cookie `HttpOnly`, `SameSite=Strict` с защитой от CSRF (`X-Requested-With: pec-dashboard`) и scrypt-хешированием учетных записей администраторов.
- **Изоляция привилегий**: строгое разделение административного токена (`X-Admin-Token`) и токена парка рабочих станций (`X-Fleet-Token`).

#### 2. Chrome Extension (Manifest V3) & Live Studio
- **Корпоративное расширение Manifest V3**: фоновый сервис-воркер, периодическая синхронизация правил, перехват прокси-аутентификации (HTTP 407) и динамическое управление PAC-скриптом.
- **Extension Constructor Studio**: интерактивный визуальный конструктор с живой песочницей (Live Sandbox), предпросмотром всплывающего окна (popup), симуляцией сетевых состояний и кастомизацией тем оформления (Cyber Blue, Emerald, Obsidian, Sunset, Minimal Light).
- **Автоматическая упаковка дистрибутивов**: генерация подписанных `.zip` и `.crx` пакетов расширения с динамической привязкой адреса корпоративных обновлений (`update_url`).
- **Групповые политики Active Directory (GPO)**: генерация файлов политик (`.reg`, `.adm`, `.admx`) для развертывания через `ExtensionInstallForcelist` на Google Chrome и Microsoft Edge в масштабах предприятия.

#### 3. PEC-App — Нативный десктопный клиент (Windows и Linux)
- **Современный GUI**: легковесный графический интерфейс на базе DirectX 11 и Dear ImGui с фирменным стилем Cyber Blue и полной русской локализацией.
- **Прозрачная маршрутизация на уровне ОС**: перехват и селективное туннелирование системного сетевого трафика через драйвер ядра WinDivert 2.2.2-A (на Windows) и расширенную фильтрацию сокетов.
- **Мониторинг соединений в реальном времени**: живой поток сетевых сессий (live connection stream), переключение активного профиля и выбор целевого прокси-узла непосредственно из интерфейса приложения.
- **Интеграция с ОС**: автоматический запрос прав администратора (UAC) при запуске и поддержка работы в качестве фоновой системной службы Windows (`PECAppSvc`).
- **Готовый инсталлятор**: автоматизированная сборка `PEC-App-Setup.exe` с контролем целостности и скрипты сборки под MinGW-w64 и MSVC.
- **Поддержка Linux**: консольный режим (CLI), фоновый демон, скрипты автоматического развертывания и systemd-сервис `pec-app-linux.service`.

#### 4. Сопряжение клиента и расширения (Desktop-Extension Pairing)
- **Автоматическое обнаружение**: бесшовное связывание браузерного расширения с локальным десктопным клиентом через защищенный loopback-канал.
- **Сквозная телеметрия**: единое отображение статуса подключения, версий компонентов и активного egress-узла между браузером и операционной системой.

#### 5. Multi-Proxy Hub & Автоматическая ротация
- **Управление флотом прокси**: централизованный реестр узлов с поддержкой ручных HTTP/SOCKS5 прокси и динамического импорта инбаундов из панелей 3x-ui.
- **Диагностика сети**: встроенная проверка задержки (latency probe) и определение реального внешнего IP-адреса (egress IP).
- **Автоматическая ротация паролей**: планировщик периодической смены учетных данных в панелях 3x-ui с защитой от гонок (мьютекс), таймаутами и предотвращением SSRF.

#### 6. Smart PAC Engine & Geodata Routing
- **Высокоскоростная гео-маршрутизация**: встроенный парсер бинарных баз `geosite.dat` и `geoip.dat` (Google Protobuf).
- **Гибкие профили маршрутизации**: поддержка режимов прямого доступа с селективным проксированием (Direct by Default) и полного туннелирования.
- **Предустановленные наборы правил**: корпоративный интранет, популярные веб-ресурсы, AI-сервисы (ChatGPT, Claude, Gemini) и фильтрация рекламы/телеметрии (sinkhole).
- **Пользовательские исключения**: оперативное добавление собственных доменов и правил прямо из интерфейса попапа расширения.

---

### 🛡️ Архитектура безопасности и надежность
- **Эшелонированная защита периметра**: безопасность строится на изоляции корпоративного контура, фильтрации прав Active Directory и динамической ротации паролей.
- **Криптографическая верификация**: проверка контрольных сумм SHA-256 для всех дистрибутивов и обновлений десктопного клиента перед запуском.
- **Защита от SSRF**: валидация внешних URL-адресов панелей управления и блокировка обращений к локальным/приватным подсетям RFC 1918 по умолчанию.
- **Безопасность телеметрии**: автоматическое очищение чувствительных параметров, токенов и query-строк перед логированием событий.
- **Атомарность данных**: транзакционная запись конфигурационных файлов (`writeJsonAtomic`) с предотвращением повреждения состояния при сбоях питания.
- **Полное покрытие тестами**: автоматизированный набор из **414+ тестов** с непрерывным прогоном в GitHub Actions CI на Ubuntu, Windows и macOS (Node.js 20 и 22 LTS).

---

### 🔒 История устранения замечаний безопасности (Security Remediation History)

По результатам независимого комплексного аудита безопасности и архитектурного ревью кодовой базы PEC были реализованы три волны защитных мер (Waves 1–3) и финальный пакет устранения замечаний (N-1 – N-8):

#### Финальный пакет доработок (Post-Audit Hardening: N-1, N-8)
- **N-1 (P0/Critical) — Устранение утечки Fleet-токена на скачивание бинарников и зачистка паролей из профилей**:
  - Эндпоинты скачивания десктопного приложения и MSI-пакетов (`/api/releases/download/app/:version`, `/api/releases/download/msi/:version`) переведены исключительно на аутентификацию администратора (`X-Admin-Token` / сессионная cookie). Использование `X-Fleet-Token` на этих путях возвращает `401 Unauthorized` и разрешено только для скачивания пакетов расширения (`type === 'extension'`).
  - Из статических профилей `pec_profile.pbprofile` и `Default.pbprofile`, вкладываемых в архивы дистрибутивов, удалены открытые пароли узлов (`Password: ""`). Десктопный клиент получает актуальные учетные данные исключительно динамически в runtime через `/api/app/sync` под назначенным `instanceId`.
- **N-8 — Консолидация каталогов шаблонов**:
  - Каталог `templates/app/windows/` зафиксирован как единый авторитетный источник шаблонов бинарников.
  - Дублирующий каталог `dist/templates/` исключен из индекса версионного контроля git, а правило `!dist/templates/` удалено из `.gitignore` для единообразного игнорирования каталога `dist/`.
  - Метод `getTemplatesAppDir()` оптимизирован и возвращает `process.env.PEC_TEMPLATES_DIR || path.resolve("./templates/app")` без рассинхронизации и дублирования файлов.

#### Волна 1 (Wave 1: Архитектурные границы и изоляция контуров)
- Зафиксирована модель доверия предприятия (Enterprise Threat Model) и документированы границы применимости (отклонение 5 неприменимых для on-prem рекомендаций аудита: mTLS в MV3, публичные EV/HSM сертификаты, D-Bus демоны для Linux GUI, запрет HKCU GPO и русификация системных драйверов).
- Изолирован публичный контур `/updates` (отдает только `.crx` и `updates.xml`, скачивание десктопных пакетов через этот путь полностью заблокировано).
- Внедрен двухуровневый RBAC-контроль management API со строгой изоляцией `X-Admin-Token` и `X-Fleet-Token`.

#### Волна 2 (Wave 2: Защита учетных данных и сетевой периметр)
- Реализована защита от SSRF при обращении к панелям 3x-ui: валидация внешних URL с блокировкой локальных адресов и диапазонов RFC 1918 по умолчанию (`ALLOW_INTERNAL_PANEL=false`).
- Нулевое хранение паролей в локальном хранилище расширения: миграция учетных данных строго в `chrome.storage.session`.
- Внедрена 3-уровневая защита от утечек реального IP через WebRTC в расширении (`disable_non_proxied_udp`, `no_multiple_routes`, `no_non_proxied_udp`).
- Обеспечено строгое SDDL-ограничение привилегий интерактивных пользователей (IU) на службу Windows `PECAppSvc`.

#### Волна 3 (Wave 3: Качество кода, сборка и верификация)
- Внедрена нативная компиляция десктопного GUI на базе DirectX 11 и Dear ImGui с полным исключением веб-сервера и веб-ассетов из состава дистрибутива.
- Реализована генерация MSI-установщиков и автоматическая цифровая подпись артефактов (Authenticode / SignTool / OpenSSL).
- Добавлено многоуровневое тестирование: PE64-структура, аутентификация роутов, изоляция хранилищ и покрытие тестами 410+ сценариев.

---

### ⚖️ Лицензирование и открытый исходный код
- Платформа лицензирована под **GNU Affero General Public License v3.0 (AGPL-3.0-or-later)**.
- Полная юридическая атрибуция всех сторонних компонентов:
  - **WinDivert** (LGPL-3.0) — Copyright (C) Basil 00;
  - **Dear ImGui** (MIT) — Copyright (C) Omar Cornut;
  - **ProxyBridge** (MIT) — Copyright (C) Sourav Kalal / InterceptSuite.
- Тексты лицензий (`LICENSE`, `LICENSE-LGPL-3.0.txt`, `THIRD-PARTY-NOTICES.txt`) автоматически вкладываются во все формируемые сервером дистрибутивы (`.zip` / `.tar.gz`).
