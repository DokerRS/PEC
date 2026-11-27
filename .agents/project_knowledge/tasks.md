# Current and Active Project Tasks

Coordination registry for tasks and progress between agents and the user.
Before starting work, every agent MUST review the active task list and, if necessary, log subtasks with their authorship.

---

## Team Task Management Rules
1. **Authorship and Timestamp Logging:** Every task and subtask is logged in the format:
   `- [ ] [agent-id @ YYYY-MM-DD HH:MM] Task description`
2. **Delegation (Out-of-Scope Handoff):** If a subtask exceeds the current agent's boundaries, it is logged in "Delegated Subtasks" with the target role (`agent-<role>`).
3. **Step Completion:** Upon completing a task, change the status to `- [x]` and optionally append a 1-line summary result.
4. **Sanctity of Other Agents' Notes:** Agents are prohibited from deleting or modifying entries written by others. Editing is restricted to own entries (status, details). Upon finding an error in another agent's note, present the conflict description with arguments to the user.

---

## Active Objective
- **Task:** Meta-Project Environment Synchronization & Invariant Hardening
- **Initiator:** User
- **Start Date:** 2026-11-10

---

## Execution Plan and Checklist
> [!NOTE]
> Earlier completed tasks archived in `.agents/project_knowledge/archive/tasks_archive.md`.


---

## Delegated Subtasks and Blockers
- [ ] [agent-native-desktop -> agent-general-worker @ 2026-11-16 14:05] AUDIT-NAT-2-TS (handoff): src/appPackager.ts:1753 writeVersionGenHeaders fallback `fleetToken || process.env.EXT_SHARED_TOKEN || defaultToken || "corp-proxy-secret-token-change-me"` — при прогоне npm test env EXT_SHARED_TOKEN="test-admin-token" (test/helpers/setup.ts:181) перезаписывает 5 закоммиченных client/Windows/**/version_gen.h и повторно вшивает токен в собираемые артефакты; C-side guards нейтрализуют seeding, но нужен безопасный fallback генератора (пустая строка) и/или sandbox-директория в тесте. Сопровождение: templates/app/windows/*.exe(msi) со вшитым токеном требуют пересборки релизным пайплайном
- [ ] [agent-qa-engineer -> agent-general-worker @ 2026-11-16 17:40] UI-HANDLERS-REGRESSION (handoff, найдено при AUDIT-QA-1): модульный бандл public/dashboard.min.js потерял window-экспозиции toggleCustomizationPopover и toggleSyncThemeWithApps при портировании UI-MODULAR-1 — dashboardView.ts:46 `onclick="toggleCustomizationPopover(event)"` (кнопка Кастомизация, вход во ВСЕ настройки оформления) и :151 `onchange="toggleSyncThemeWithApps(this.checked)"` мертвы в проде (ReferenceError); theme.ts УЖЕ экспортирует openCustomizationPopover/closeCustomizationPopover/setThemeSyncEnabled — не хватает toggle-обёртки и Object.assign(window,...) экспозиций в index.ts. RED-тест уже стоит: dashboardThemeSyncAndAppStudio.test.ts «REGRESSION HANDOFF (AUDIT-QA-1 -> agent-general-worker)»; при фиксе тест станет GREEN без правок теста

---

## Active Objective Extension — AUDIT-2026-11-16: Deep Audit Remediation
- **Task:** Устранение находок глубокого аудита репозитория (6 доменных flash-аудитов + мета-прогоны диспетчера: 0×P0, 3×P1, 19×P2, ~50×P3)
- **Initiator:** User @ 2026-11-16 (маршрутизация подтверждена: Полный Deep-Track)
- **Start Date:** 2026-11-16
- **Координатор:** agent-intake-dispatcher. Верификация — strict_independent (agent-security-auditor + agent-qa-engineer); антирегрессионное правило: каждый фикс закрывается тестом.

## Execution Plan: AUDIT-2026-11-16
### Волна 1 — блокеры P1 и критичные quick wins

### Волна 2 — P2

### Волна 3 — P3-пакеты (по готовности волн 1-2)

### Верификация (strict_independent)
- [ ] [agent-intake-dispatcher -> agent-security-auditor @ 2026-11-16 11:18] AUDIT-VERIFY-SEC: независимая проверка фиксов AUDIT-SEC-1..3, AUDIT-SRV-1..3, AUDIT-EXT-1..2, AUDIT-NAT-1..2 после волны 2 (+ проверка бинарников на вшитый токен)

### Координация диспетчера — пост-инцидентная
- [ ] [agent-intake-dispatcher @ 2026-11-16 16:28, актуализировано 17:27] DISPATCH-POSTINCIDENT-0 (БЛОКЕР КОММИТА): прогресс — server/extension/тесты волн 1-2 закоммичены (97b873d, 1ad6f0c), нативная реставрация + AUDIT-NAT-P3 закоммичены (a033423, d32785e, 6ea9033), загрязнение version_gen.h снято (санитизация + sandbox PEC_CLIENT_WIN_DIR, воспроизводимость исключена); ОСТАЛОСЬ незакоммичено (37 позиций): зона infra/docs (.dockerignore, .env.example, ci.yml, security.yml, README×2, SECURITY.md, compose×2, openapi.yaml, .gitleaks.toml), QA-миграции test/* (12 M + 4 untracked), мета-срезы (architecture/weak_spots/observations + 4 профиля), PEC-App.msi (тест-артефакт — revert по PROCESS-RULE п.3), stale-lock observations.md.lock — до любых restore/clean операций
- [ ] [agent-intake-dispatcher @ 2026-11-16 16:28] PROCESS-RULE (вывод из инцидента, обязательна для всех ролей в сценарии shared_repo): (1) завершённый фикс коммитится немедленно, не копится в рабочем дереве; (2) перед любой git restore/clean — обязательная сверка git status с открытыми handoff'ами в tasks.md; (3) PEC-App.msi в M-состоянии — ревизия перед коммитом (вероятный тест-артефакт пересборки)

### Координация диспетчера — закрытие AUDIT-2026-11-16
- [ ] [agent-intake-dispatcher -> agent-devops-infra @ 2026-11-16 17:27, гейт снят 20:00 по вердикту PASS @ 70b00d4] DISPATCH-CLOSURE-4 (строго после вердикта DISPATCH-CLOSURE-2): пересборка stale-бинарников релизным пайплайном, запись раздела CHANGELOG по AUDIT-2026-11-16, решение по libsecret для Linux-клиента (отложено agent-native-desktop в AUDIT-NAT-P3 — новая зависимость требует infra-согласования), подготовка PR dev/ad-security-integration → main. КРИТЕРИЙ ПРИЁМКИ ПЕРЕСБОРКИ (по bytescan аудитора): отсутствие ОБОИХ маркеров (test-admin-token И corp-proxy-secret-token-change-me) в ascii + UTF-16LE по всем templates/app/windows/* и .pristine/*; текущая рабочая копия PEC-App.msi НЕ приёмочна (corp-плейсхолдер @0xEA69B) — не коммитить, заменить релизной пересборкой; в PR включить фиксы P3-A/B/C и мета-срезы из CLOSURE-3(d) — [agent-devops-infra @ 2026-11-16 21:30] ЧАСТИЧНО: (1) ✅ CHANGELOG-раздел AUDIT-2026-11-16 (коммит 1fb8fca, с реестром known-issues и решением libsecret=DEFER: headless-демон доминирует, Secret Service требует графическую сессию, текущая митигация AR-4 0600 root; пересмотр при появлении desktop-Linux-сценария); (2) ✅ .gitignore += .agents/project_knowledge/*.lock (POSTINCIDENT-4, коммит 1fb8fca, Red Zone bypass по явному приказу пользователя); (3) ⛔ ПЕРЕСБОРКА ЗАБЛОКИРОВАНА ФУНДАМЕНТАЛЬНО: полная чистая пересборка PEC-App.exe из HEAD (cl.exe BuildTools 2022, vcvars64+nmake, scratch/build_app.cmd) даёт corp-плейсхолдер 0/2, НО литералы NAT-2-гардов wcsstr(...,L"test-admin-token") (main.c:2100, main_imgui.cpp:3084) компилируются в exe как UTF-16LE (@0xB1C38, кластер с L"example.com") — критерий «0 обоих маркеров» недостижим без правки нативного кода; бинарники НЕ закоммичены (критерий не нарушен), см. handoff CLOSURE-4-REBUILD-BLOCKER → agent-native-desktop; после фикса: пересборка exe (драйвер готов) → templates + .pristine → MSI через tools/wix WiX v3 c cfg.defaultToken="" (FLEET_TOKEN, appPackager.ts:783; сборку гнать без EXT_SHARED_TOKEN в env до закрытия связки с генератором) → обновление SHA-256 пина binaryIntegrity.test.ts:13 → контрольный bytescan; (4) ✅ PR создан: https://github.com/vlv-code/PEC/pull/13 (base main ← dev/ad-security-integration, 15 коммитов включая P3-A/B/C 8750304/e95b6c5/9e2599d и мета-срезы 1a1ca1d); push доавторизован workflow-scope через device-flow (FCA3-31D3, после разблокировки oauth-endpoint пользователем; DPI периметра ранее рвал обмен токена direct+SOCKS); (5) ✅ РЕЛИЗ v0.9.1-alpha [agent-devops-infra @ 2026-11-16 22:55, по приказу пользователя «релизь»]: CI-матрица PR доведена до 12/12 GREEN (be5f9ae: portability-фиксы тестов — jsonStore retry skip на non-win32 по контракту хелпера, EXT-2 popupTheme CRLF-нормализация против autocrlf-checkout; оба фикса локально 14/14, biome 0, boundary gate прошёл без bypass), версия 0.9.0-alpha→0.9.1-alpha + CHANGELOG [Unreleased]→[v0.9.1-alpha] (0e6b2d6); PR #13 смержен merge-commit 460eb52; тег v0.9.1-alpha → release.yml success: релиз опубликован (assets server.cjs + sha256sums.txt по контракту L-38, notes = полная CHANGELOG-секция)

### Координация диспетчера — пост-верификационные P3 (из находок DISPATCH-CLOSURE-2, вердикт не блокируют)

### Координация диспетчера — разблокировка пересборки (CLOSURE-4-REBUILD-BLOCKER)

---

## Active Objective Extension — THEME-2026-11-16: Theme Contract Deep Audit Remediation
- **Task:** Устранение находок аудита темового контракта (3 параллельных flash-аудита: ①источник/транспорт/тесты ②натив+артефакты ③расширение+Linux+сквозной toggle — 1×P1, 8×P2, ~10×P3; R1-R5 не регрессировали, артефакты дистрибуции PASS)
- **Initiator:** User @ 2026-11-16 (маршрутизация подтверждена: Полный Deep-Track + E2E-реализация тумблера синка тем)
- **Start Date:** 2026-11-16
- **Координатор:** agent-intake-dispatcher. Ключевой инвариант: Contract Duplication Guard — темовая логика в 5 файлах (theme.ts / appPackager.ts / appSyncRoutes.ts / pec_imgui_theme.h / ui/theme.h); правки палитр — синхронно по всем затронутым; extension↔templates — через npm run sync:templates.

## Execution Plan: THEME-2026-11-16
### Волна 1 — web/server (general-worker) и натив (native-desktop), параллельно (файлы не пересекаются)
### Волна 2 — тесты (после Волны 1)
### Верификация (strict_independent, после волн 1-2)

### Координация диспетчера — закрытие THEME-2026-11-16

---

## Active Objective Extension — THEME-SRC-2026-11-17: Dashboard-as-Source Theme Propagation
- **Task:** Дашборд «Внешний вид» = источник тем для клиентов при включённом тумблере синка (решение пользователя после репорта «у расширения фиолетовый акцент»: THEME-WEB-1 дал гейтинг доставки, но не сменил источник — тема дашборда pec_server_theme живёт только в localStorage, сервер о ней не знает, grep подтверждён theme.ts:57,67)
- **Initiator:** User @ 2026-11-17 (скриншоты: расширение Dark Obsidian #c084fc при синей палитре дашборда и включённом тумблере; семантика A подтверждена через AskUserQuestion)
- **Start Date:** 2026-11-17
- **Координатор:** agent-intake-dispatcher. Нативные клиенты НЕ затрагиваются (контракт payload /api/app/sync и .pbprofile неизменен — меняется источник значений на сервере). Инварианты: extension↔templates синхронно (sync:templates), запись темы — только admin-контур (fleet read-only), дефолты для существующих инсталляций без обрыва.

## Execution Plan: THEME-SRC-2026-11-17
### Волна 1 — general-worker (сервер + дашборд)
### Волна 2 — верификация

### Координация диспетчера — закрытие THEME-SRC-2026-11-17

### Координация диспетчера — пост-релизный репорт пользователя (store пуст после деплоя)


- [ ] [agent-intake-dispatcher -> agent-general-worker @ 2026-11-17 16:20] AD-UI-URL-INVISIBLE (P2, UX-блокер настройки AD через панель): пользователь не видит поле LDAP/LDAPS URL в форме интеграции AD (вкладка GPO), хотя верифицировано диспетчером по живому проду: input#adUrl ЕСТЬ в отдаваемом HTML (позиция 117794, между label и Bind DN) и НЕТ скрывающих CSS-правил (dashboard.css: 0 упоминаний adUrl/adFieldsContainer; generic input-правила чисты); toggleAdFieldsState (gpo.ts:6-13) меняет только opacity контейнера. Задача: воспроизвести локально (npm run dev + вкладка GPO, DevTools на #adUrl — computed display/height/position), найти причину (кандидаты: grid-2 auto-fit minmax(360px) при узком окне, label padding-перекрытие, смешанный кэш HTML/CSS старой версии — у пользователя прод v0.9.3), починить, тест на видимость поля в dashboardAd.test.ts (rendered form contains visible #adUrl). Workaround пользователю выдан: настройка через POST /api/ad/config с X-ADMIN-TOKEN. ДИАГНОСТИКА ДИСПЕТЧЕРА (управляемый браузер, живой прод): input#adUrl ПРИСУТСТВУЕТ в DOM (eval: present, computed display inline-block/34px/visible), при программной активации #tab-gpo рендерится ШТАТНО — rect 600x34 @ правильной позиции потока, все 8 элементов формы (4 пары label+input) корректны; скрывающих CSS-правил нет; скрытие только display:none неактивной вкладки (норма). Приложение НЕ воспроизводится в чистом браузере — вероятная причина у пользователя: смешанный кэш HTML/CSS (лечится Ctrl+Shift+R) либо browser-extension; UI-дефект кода не подтверждён — задача сводится к воспроизведению на стороне пользователя (DevTools) и опциональному защитному тесту видимости в dashboardAd.test.ts. Коммит сразу (PROCESS-RULE) — [финал @ 17:08]: пользователь подтвердил — в инкогнито поле отображается; причина = смешанный кэш основного профиля после деплоя v0.9.3 (старый CSS + новый HTML); код-фикс не требуется, исполнение не назначалось; рекомендация: Ctrl+Shift+R в основном профиле, при повторении — проверить расширения браузера; опциональный защитный тест видимости поля остаётся на усмотрение qa при следующем касании dashboardAd

### Координация диспетчера — интеграция AD у пользователя (живая эксплуатация)
[дополнение EXT-PREF-DEPLOY-1 b/c/d от 2026-11-24]: renderGpoReadme дополнен секцией «Восстановление канала обновления» (verify: reg query Edge/Chrome + Extensions/<id>; recreate: reg add updateurl; remove: reg delete /f) — коммит bd43932; tsc/biome чистые.

### Координация диспетчера — AD ECONNRESET root cause (воспроизведён)

### Координация диспетчера — THEME-SRC частичное наследование (репорт пользователя, прод v0.9.4)


### Координация диспетчера — релиз v0.9.5-alpha (agent-devops-infra)

### Координация диспетчера — EDGE-канал обновлений (репорт «после v0.9.5 не падают версии»)
- [ ] [agent-intake-dispatcher -> agent-devops-infra @ 2026-11-18 08:05] REL-OBS-1 (P3, observability канала обновлений — породил час путаницы «собрал ≠ опубликовано ≠ установлено») — [agent-devops-infra @ 2026-11-25 12:10] выполнено: (a) GET /api/releases/update-channel (admin) — parse /updates/updates.xml (updatecheck-anchored: XML-декларация version='1.0' больше не матчится), crxSha256/crxSize из байт extension.crx, publishedAt (mtime), updatesXmlUrl + absolute (curl-клип), matchesRecorded vs releases_meta (built≠published детектор), {exists:false, reason} при отсутствии; переиспользован getActiveRelease, без дублей источника; (b/c) вкладка Релизы — карточка updateChannelCard (версия/дата/sha/размер + curl-линк с копикой + MISMATCH-баннер + 'matches recorded' бейдж, RU/EN), telemetry.loadUpdateChannel/copyUpdateChannelUrl + tab hook + window exposure, dashboard.min.js пересобран; (d) test/updateChannel.test.ts 5/5 (schema/mismatch/match/401/DOM+i18n parity en+ru); (e) lint/build, полный сьют 892/892 exit 0; коммит fbdadee. Тегов не ставилось (по условию): панель, вкладка Релизы/Студия — карточка «Канал обновлений»: версия в updates.xml, дата последней публикации, sha256/размер extension.crx, прямой линк на /updates/updates.xml; API GET /api/releases/update-channel; тест golden-ассерта — [deferred: post-release, по обратной связи]


### Координация диспетчера — INCIDENT-EDGE-UPDATE-2026-11-18 (ЗАКРЫТ)


### Координация диспетчера — TRUE ROOT CAUSE найден (лог Edge line 152)

### Координация диспетчера — релиз v0.9.6-alpha (agent-devops-infra)


### Координация диспетчера — INCIDENT-EDGE-UPDATE ЗАКРЫТ (полный цикл)
- [ ] [agent-intake-dispatcher -> agent-qa-engineer @ 2026-11-19 09:40] P3-наблюдение (не блокер, из живого лога пользователя): после пере-установки sync пингует сервер пачками каждые 1-15 секунд (вместо интервала 30 мин) в периоды активности — вероятно известное поведение wake-driven SW (tabs.onUpdated будит SW -> syncWithServer), усиливается после пере-установки; оценить: дедуп/троттлинг sync на пробуждениях (уже было в аудите EXT P3-lifecycle), не срочно — [deferred: post-release, по обратной связи (sync-frequency)]


### Координация диспетчера — флот: косметика таблиц + диагностика domainUser (репорт пользователя, прод v0.9.6)

### Координация диспетчера — глобальное устранение несоответствий UI (Truth Parity)

### Координация диспетчера — Active Directory Kill-Switch Auto-Recovery & Unrevoke
  (a) В `src/instances.ts`: добавлен метод `unrevokeInstanceToken(id)` и поле `revokedReason?: string` (различение `ad_killswitch` и `manual`);
  (b) В `src/routes/credsRoutes.ts` и `src/routes/appSyncRoutes.ts`: реализован Auto-Unrevoke в `/api/sync` и `/api/app/sync` при подтверждении членства пользователя в AD (`isDomainUserAllowed`) и валидном bootstrap-токене; anti-spoofing инвариант сохранён;
  (c) В `src/routes/instancesRoutes.ts`: добавлен эндпоинт `POST /api/instances/:id/unrevoke-token` для ручного снятия блокировки администратором;
  (d) В `src/templates/backgroundTemplate.ts`: самовосстановление расширения при 403 Forbidden на `pecInstanceToken` (сброс локального токена и мгновенный повтор с `managed.extToken` из GPO);
  (e) В `src/client/dashboard/tabs/telemetry.ts`: кнопка `🔄` («Восстановить доступ») в таблице флота рядом с бейджем `[🚫 Отозван]`;
  (f) Тесты: добавлены 3 сьюта в `test/adKillSwitch.test.ts` (авто-восстановление расширения, изоляция ручной блокировки admin, авто-восстановление десктопного клиента); 10/10 тестов passed, полный регрессионный сьют зелёный, 0 ошибок lint/typecheck.

### Координация диспетчера — Канонизация развертывания GPO (.REG и GPMC) и удаление артефактов GPP / PowerShell
  (a) В `src/templates/gpoTemplates.ts`: удалены функции `renderDeployGpoScript`, `renderVerifyGpoScript`, `renderGppRegistryXml`; `renderGpoReadme()` переписан на ручную настройку реестра в GPMC (ExtensionInstallForcelist, ExtensionSettings, domainUser) и работу с .REG файлами;
  (b) В `src/packager.ts`: `generateGpoConfig()` типизирован чистым интерфейсом `GpoConfig` без legacy-полей; `generateGpoDeploymentPack()` формирует zip строго из трех файлов (`pec-policy-user.reg`, `pec-policy-machine.reg`, `README-GPO.txt`);
  (c) В `src/routes/builderRoutes.ts`: удалены эндпоинты `GET /api/builder/registry-xml` и `GET /api/builder/script/:name`;
  (d) В `src/views/dashboardView.ts` и `src/client/dashboard/`: удалены кнопки скачивания скриптов и Registry.xml, удалены неиспользуемые JS-функции; в `i18n.ts` обновлены описания пакета и удалены устаревшие ключи со 100% паритетом ru/en;
  (e) В `test/`: обновлены `test/gpo.test.ts`, `test/domainUserManagedChain.test.ts`, `test/extensionArtifactJson.test.ts`, `test/gppRegistryXml.test.ts`, `test/gpoRoutes.test.ts`, `test/securityFixes.test.ts`;
  (f) Сборка и верификация: `npm run build` (`public/dashboard.min.js` 354.8kb, `dist/server.cjs` 951.5kb), `npm run lint` (0 ошибок tsc/biome), все тесты GREEN.

### Координация диспетчера — Очистка бейджей флота и реактивный предпросмотр конструкторов
  (a) В `src/client/dashboard/tabs/telemetry.ts`: полностью удален вывод бейджа `🔗 Десктоп` из таблицы расширений флота (`userDisplay`), в `test/dashboardReleasesUI.test.ts` обновлен ассерт на чистый рендеринг строки инстанса без `🔗`;
  (b) В `src/client/dashboard/tabs/studio.ts`: устранена ошибка 404 в iframe-песочнице за счет инлайнинга скрипта темы вместо внешнего `<script src="popupTheme.js">`, добавлена синхронизация `liveSimState` с реальными прокси флота (`availableProxies`, `activeProxyId`, `host`, `port`, `protocol`), текущим PAC-профилем и чекбоксами разрешений (`allowUserProxySwitch`, `allowUserBypass`), добавлена обработка `SET_ACTIVE_PROXY`;
  (c) В `src/views/dashboardView.ts` и `src/client/dashboard/tabs/studio.ts`: в App Studio убран хардкод тайминга 30 секунд в пользу динамического отображения интервала синхронизации (`appSyncIntervalMinutes`), сделаны реактивными консоль журнала, список перехватов трафика (на основе заданных правил `currentAppRules`), состояние туннеля и сервиса;
  (d) Сборка и верификация: `npm run build` (`public/dashboard.min.js`, `dist/server.cjs`), `npm run lint` (0 ошибок tsc/biome), `npm test` (858/858 passed, 100% GREEN).
  (a) Исправление P0 дефектов логики UI: синхронизация id гео-импорта в routing.ts и dashboardView.ts, считывание действия inspectorActionSelect при добавлении правил, сбор чекбоксов branch-app-rule-checkbox в студии, защита автосохранения от слепого сброса allowUserBypass/showIpGeoChecker, закрытие credsModal по Escape и клику вне окна;
  (b) Безопасность и целостность флота: подтверждение pecConfirm при генерации кода из пресетов студии и активации прокси-нод, селектор #fleetSelectAll выбирает только отфильтрованные поиском строки, IsActive=false по умолчанию в форме добавления прокси;
  (c) Мультисерверная архитектура ротации 3x-ui: расширение типа Panel3xuiConfig (rotationEnabled, targetRemark, rotationIntervalMinutes), персистентность в rotationRoutes.ts и rotate.ts, разделение ротации для включенных панелей без задевания статических прокси-нод, рефакторинг панели расписания в чистый Fleet Rotation Scheduler с колонкой ротации в таблице панелей и модалке;
  (d) Встроенный легковесный редактор кода (микро-реализация CodeJar + Prism.js) с подсветкой JS/HTML, обработкой Tab, автопереносом строк и min-height 500px;
  (e) Устранение регрессий и кэш-бастинг: исправление navigator.language для Node.js окружения тестов в popup.js и popupJsTemplate.ts, cache-busting (?v=currentVersion) для dashboard.min.js и dashboard.css, ликвидация дубликата ID btnRotateNow, добавление шаблона tmplRuleReorderBtns;
  (f) Сборка и верификация: npm run build (public/dashboard.min.js 370.5kb, dist/server.cjs 957.0kb), npm run lint (237 файлов, 0 ошибок tsc/biome), целевые тесты (test/duplicateDomIds.test.ts, test/popupLogic.test.ts, test/popupProxySwitcher.test.ts, test/popupUxImprovements.test.ts, test/purity.test.ts, test/routingHierarchy.test.ts, test/rotation.test.ts) — 100% GREEN.

### Координация диспетчера — релиз v0.9.13-alpha (agent-devops-infra)


### Координация диспетчера — App Studio preview не следует теме панели (репорт, прод v0.9.13, панель cyber)

### Координация диспетчера — релиз v0.9.14-alpha (agent-devops-infra)


### Координация диспетчера — THEME-APP-PREVIEW слой 2: кастомные hex из конструктора перебивают панель в превью

### Координация диспетчера — релиз v0.9.15-alpha (agent-devops-infra)


### Координация диспетчера — смена стратегии деплоя: Forcelist -> Allowlist+Sources (страта пользователя, прод)


### Координация диспетчера — README: дайджест-интро в начале (материал из промо-поста)


### Координация диспетчера — ОФИЦИАЛЬНЫЙ РЕЛИЗ v1.0.0 (решение пользователя)


### Координация диспетчера — MSI-фоллбэк маскирует неудачную сборку (репорт пользователя)


### Координация диспетчера — MSI embeds STALE staging (распаковка пользователя, P1)


### Координация диспетчера — FINAL ROOT CAUSE (подтверждено кодом + логом пользователя)

### Координация диспетчера — GEO-пресеты не редактируемы в UI (репорт пользователя)

### Координация диспетчера — релиз v1.0.1 (agent-devops-infra)

— [мех.закрытие диспетчера @ 2026-11-24 15:10]: OBS-EXT-PREF-1 выполнен OBS-BATCH-1 (69c175b/ff6a599, обе observation-строки в реестре); MSI-FALLBACK-1 и MSI-STAGING-1 поглощены MSI-SILENT-1 (closeout 50c3b91: «поглощены, root cause один») — по конвенции релизной гигиены чекбоксы закрыты, авторство сохранено
- ЗАКРЫТИЕ ДИСПЕТЧЕРА @ 2026-11-25: GEO-PRESET-EDIT-1(+1b) ЗАВЕРШЁН: (a)(c)(d) checkpoint 50ff005, (b)(e)+фиксы верификации 61d9f27; поведенческая верификация диспетчера RED→GREEN 5/5 (гейтинг/payload source-resend/inspector-delete/DELETE/refresh), tsc 0, бандл свеж, полный сьют exit 0 (releasesRoutes — флейк, изолированно 5/5); воркер-код валиден, коммиты на стороне мейн-сессии (уточнение пользователя: воркеры не коммитят)

### Координация диспетчера — релиз v1.0.2 (agent-devops-infra)

### Координация диспетчера — Конструктор пресетов (редизайн по репорту пользователя)

### Координация диспетчера — релиз v1.0.3 (agent-devops-infra)

### Координация диспетчера — Конструктор UX-итерация 2 (репорт пользователя по скриншоту)
- [ ] [agent-meta-guardian -> agent-general-worker @ 2026-11-25 21:25] GEOFILE-GC-DESIGN (P3, из VERIFY-BUILDER-QA): у хранилища data/geofiles нет пути удаления — append-only растёт неограниченно (дедуп только идентичного контента; изменение файла = новый blob, старые живут вечно); нужен дизайн-решение: DELETE-эндпоинт/GC по счётчику ссылок из слоёв пресетов либо явная документированная политика append-only + дисковая гигиена (devops); приёмка: удаление последнего ссылающегося слоя не оставляет сироту-файл ИЛИ политика зафиксирована в docs + boundaries — deferred: post-release, по обратной связи
- [ ] [agent-meta-guardian -> agent-qa-engineer @ 2026-11-25 21:25] QA-BUILDER-COVERAGE-TAILS (P3-пакет, из VERIFY-BUILDER-QA): (a) UI-тест «мигрированный flat-пресет в конструкторе» — все builder-фикстуры слоёные, мигрированная форма (GET после wrap) в UI не прогоняется; добавить кейс: flat-фикстура → GET-мок возвращает sources после серверной миграции → рендер слоёв + Save; (b) builderLayersUi (b): формат geo-бейджа «гео:x» не ассертится (есть url:ads/вручную/файл-префикс) — добавить geo-tag слой в фикстуру + ассерт; (c) по желанию: кейс импорта pec-preset v2 на ЧИСТЫЙ сервер (fileId-слой без geofile) как UI-аналог verifyBuilderQa (1) — deferred: post-release, по обратной связи

### Координация диспетчера — релиз v1.0.4 (agent-devops-infra)

### Координация диспетчера — Полноценный редактор геобаз (репорт пользователя, 3-я итерация)
- [x] [agent-intake-dispatcher -> agent-general-worker @ 2026-11-25 23:05] GEO-BUILDER-UX-4 (P1 для пользователя, 3-я итерация): полноэкранный Редактор геобазы (manifest/search/preview эндпоинты + чек-лист списков с доменами) + пер-слойные формы правки (url/geo-tag/manual); см. промпт. Релиз: если v1.0.4 ещё не тегался — включить, иначе v1.0.5 — [agent-devops-infra @ 2026-11-26 20:45] механическое закрытие: реализация = коммит 9390c4d, вошла в релиз v1.0.5 (published 19:05Z); сьют 946/946 (+13 UX-4), пост-правочный tsc чистый
- [x] [agent-general-worker @ 2026-11-26 11:30] GEO-BUILDER-UX-4 ВЫПОЛНЕНО (полноценный редактор геобаз; требование пользователя tasks.md @23:05 дословно): (1) СЕРВЕР — 4 эндпоинта поверх geofiles-хранилища: GET /geofiles/:fileId/manifest (ВСЕ списки + счётчики, totalEntries, type geosite/geoip/plaintext), GET /geofiles/:fileId/lists/:tag/entries?offset&limit (пагинация, кап 200/стр), GET /geofiles/:fileId/search?q= (поиск по ИМЕНИ СПИСКА и по ДОМЕНУ → списки, где домен живёт; подстрока case-insensitive, лимит 50), POST /geofiles/:fileId/union-count (дедуп-счётчик выбранных списков — добавлен к трём из спеки ради живого футера «Доменов попадёт в слой (дедуп)»); parsed-map кэш в памяти по fileId (контент-адресность = валидность), cap 16 записей; (2) КЛИЕНТ — полноэкранная подстраница geoEditorPage над builder-страницей: шапка (имя файла, тип-бейдж, fileId, [Сменить файл]), строки списков (чекбокс + счётчик + [▾] постраничный предпросмотр «Показать ещё», выбранные сверху), поиск с блоком «Найденные домены — отметьте список не отходя от результата» (чекбоксы прямо в результатах), футер «Выбрано списков: N · Доменов попадёт в слой: M (дедуп)», [Сохранить слой] → resolve-layer {fileId, tags} → состав пересобран; «Сменить файл» → новый манифест + выбор сброшен + warning; снапшот-слой → rebind-режим (привязка → полный функционал); ✎ file-слоя теперь открывает этот редактор (readonly-дамп тегов из DIAG удалён вместе с inline-чек-листом UX-3), url/geo/manual — компактные inline-формы остались; карточка file-слоя: «списков: N · доменов: M» (prefetch манифестов при открытии builder, кэш geoManifestCache); editable-строки состава = manual + snapshot (живые — 🔒); (3) ТЕСТЫ — НОВЫЕ geofilesEditor.test.ts 5/5 (манифест/сортировка/404, пагинация+кап, search имена+домены+wildcard+лимит 50+пустой q, union-дедуп, plaintext-манифест) и geobaseEditorUi.test.ts 8/8 (полный клик-путь: ✎→манифест→чекбокс→футер-дедуп 2→5→[▾]→пагинация→поиск домена→чекбокс из результата→Сохранить→tags обновлён+состав пересобран; смена файла=сброс+warning; rebind; back не сохраняет); builderLayersUi (d)/(e) переведены на редактор, (a) — новый count-лайн «списков: N · доменов: M»; dashboardDom: function-ответы получают (init, rawInput) для query-зависимых моков; affected-набор 78/78, широкий 53/53; build:ui, tsc после каждой правки, biome, boundary-gate — чисты; архитектура §2.3 дополнена

### Координация диспетчера — релиз v1.0.5 (agent-devops-infra)
- [x] [User -> agent-devops-infra @ 2026-11-26 11:30] RELEASE-v1.0.5: пятый патч официального релиза (GEO-BUILDER-UX-4 полноценный редактор геобаз: полноэкранный file-слой с манифестом списков/дедуп-счётчиком/пагинацией/кросс-поиском, пер-слойные формы url/geo-tag/manual, эндпоинты manifest/lists-entries/search; коммит 9390c4d; +13 тестов) — [agent-devops-infra @ 2026-11-26 20:30] выполнено: ГЕЙТ 0 — CI success + Security success на 9390c4d (обе матрицы); CHANGELOG v1.0.5 + бамп 1.0.4→1.0.5 + бейджи ×2 (a5d1d74); локальные гейты: lint/build ✅ + полный сьют 946/946 exit 0 (+13 UX-4) + пост-правочный tsc ✅; обе матрицы GREEN на a5d1d74 → тег v1.0.5 (один ретрай после TLS-обрыва периметра) → release.yml success → опубликован 19:05Z (assets server.cjs + sha256sums.txt; контрольный sha256 3ca09447… ↔ sums OK; маркеры geofiles/manifest/search в бандле — ложная тревога первого probe: фактические маршруты /lists/:tag/entries). (5) Ledger: GEO-BUILDER-UX-4 + REL-1.0.5 закрыты (ниже); deferred-хвосты (GEOFILE-GC-DESIGN, QA-BUILDER-COVERAGE-TAILS) не тронуты — остаются post-release


### Продолжение миграции Remnawave
- [x] [vlv-code/PEC::zcode::zc-main::agent-general-worker @ 2026-11-26 13:16] REMNAWAVE-API-TOKEN-1: Replaced Remnawave panel GUI username/password fields with an API-token field; Bearer auth, server-side masking/preservation, legacy login compatibility, tests/docs, and generated dashboard bundle updated. Verified the bundle with Rolldown v1.2.19 (API-token field and Remnawave route present; old 3x-ui route and credential field IDs absent), `node --check public/dashboard.min.js`, TypeScript syntax checks, and `git diff --check`. Focused tests remain blocked: `tsx`/project dependencies are absent, and native `node --test` cannot resolve the test's `.js` specifier to its `.ts` helper.
- [x] [vlv-code/PEC::zcode::zc-main::agent-general-worker @ 2026-11-26 13:45] REMNAWAVE-PRIVATE-PANEL-1: Forwarded `ALLOW_INTERNAL_PANEL` through both Compose profiles with a secure `false` default, so an explicit `.env` opt-in reaches the existing Remnawave SSRF guard. Verified `true` is passed by `docker compose config` for both profiles.
- [x] [vlv-code/PEC::zcode::zc-main::agent-general-worker @ 2026-11-26 13:49] REMNAWAVE-HEALTH-AUTH-1: The supplied OpenAPI requires Authorization on `GET /api/system/health`; changed the probe to use the shared authenticated request path, so API tokens use Bearer and legacy configs use login/JWT. Updated the fake panel to require auth and added token-health coverage. TypeScript syntax, boundary gate, and diff checks passed; npm tests remain unavailable without `tsx`/dependencies.
- [ ] [agent-general-worker @ 2026-11-26 12:24] REMNAWAVE-TESTS-1 (BLOCKED): тесты основных API/rotation сценариев и актуальная архитектурная документация переведены с 3x-ui inbound-контракта на Remnawave user/JWT/revokeOnlyPasswords; остаточные XUI_* / старые URL оставлены только для compatibility coverage. `npm test` остановлен (`tsx` отсутствует), `npm run lint` (`tsc` отсутствует), `npm run build:ui` (`esbuild` отсутствует); node_modules отсутствует, установка зависимостей была отклонена средой ранее, поэтому бандл и полный прогон не проверены.
  - [x] [agent-general-worker @ 2026-11-26 12:31] Повторная полная проверка: `npm test` blocked (`tsx` отсутствует), `npm run lint` blocked (`tsc` отсутствует), `npm run build` и `npm run build:server` blocked (`esbuild` отсутствует); `node_modules` нет. VS Code Problems по затронутым TS-файлам: ошибок не найдено; `node --check public/dashboard.min.js` и `git diff --check` прошли. Дополнительно `node --check public/dashboard.js` выявил SyntaxError duplicate declaration `switchPreviewWindowTab` в legacy dashboard.js; это отдельный не-собираемый legacy asset, не dashboard.min.js.
  - [x] [agent-general-worker @ 2026-11-26 12:45] По прямому запросу пользователя запущен `npm ci`; загрузка 147 package tarballs завершилась/зависла на `ETIMEDOUT` от `https://registry.npmjs.org/`, отдельный `curl.exe -I --max-time 15 https://registry.npmjs.org/tsx` также завершился timeout. Установка остановлена после подтверждения недоступности registry; созданный этой попыткой неполный `node_modules` удален. Верификация остается заблокированной сетевым доступом к npm registry.

- [ ] [vlv-code/PEC::zcode::zc-main::agent-general-worker @ 2026-11-26 15:24] REMNA-PERUSER-XRAY-1: По решению пользователя перейти к машинной установке PEC для всех пользователей с per-user ACL/AD доступом, персональными Remnawave subscriptions, одним общим proxy listener и маршрутизацией по подтверждённой Windows identity; расширение и desktop-клиент используют общий локальный host, Remnawave rotation удаляется. Не вшивать API token/subscription в CRX и не сохранять общий пул VLESS outbounds на PEC control server.
  - [x] [vlv-code/PEC::zcode::zc-main::agent-general-worker @ 2026-11-26 15:40] REMNA-PERUSER-XRAY-1 SCHEMA (схема согласована и предъявлена пользователю): оба прокси-сервера = ноды единой Remnawave-панели; подписка пользователя = GET /api/subscriptions/by-username/{sAMAccountName} (метод уже реализован). PEC-App service (SYSTEM, машинная установка через GPO MSI) получает персональную подписку только для AD-авторизованного залогиненного пользователя и собирает конфиг локального Xray (версия пинится админом в панели PEC): один inbound HTTP+SOCKS на 127.0.0.1:PORT с accounts по пользователям + routing user→outbound, per-user VLESS outbounds живут только на машине клиента. Расширение (GPO ExtensionInstallForcelist + managed policy serverUrl/domainUser) и GUI клиента ходят в 127.0.0.1:PORT, onAuthRequired подставляет domainUser+per-user секрет из /api/sync. Реестр подписок на PEC control server не хранится (pass-through). Фазы: 1) серверная выдача подписки в /api/app/sync + настройка версии Xray; 2) Windows service: процесс-менеджер Xray + hot-reload по logon/logoff; 3) расширение: локальный proxy-режим + секрет; 4) GPO-пакет и документация.
  - [x] [vlv-code/PEC::zcode::zc-main::agent-general-worker @ 2026-11-26 20:30] REMNA-PERUSER-XRAY-1 Phase 1 (сервер) завершён: src/xrayRuntime.ts (HMAC master secret, deriveProxySecret, parseVlessLink, buildXrayUserConfig: один общий inbound HTTP+SOCKS 127.0.0.1, per-user accounts, per-user VLESS outbounds remna_N + balancer, private-IP bypass), админ-роутер /api/xray-runtime (admin-only, masterSecret никогда не отдаётся), блок xrayRuntime в /api/app/sync, карточка Xray Runtime в дашборде (enabled/version/port) + клиентский UI. Баг-фикс: saveXrayRuntimeSettings сохраняет masterSecret (observation записана); saveRemnawavePanel сохраняет targetUsername. Тесты: test/xrayRuntime.test.ts (7 шт.), устаревшие ротационные тесты удалены (proxySyncMutex, rotationTransactionality) или переписаны под read-only политику (rotation, proxiesRoutes, dashboard, remnawavePanels, rotate, rotationConfigRemnawave). Проверки: tsc+biome чисто, build:ui OK, npm test 941: 940 pass, 1 fail githubReleasesRoute (внешняя сеть: TLS-interception, SELF_SIGNED_CERT_IN_CHAIN — environment quirk, observation записана). Осталось: Phase 2 (Windows service Xray process manager), Phase 3 (расширение: local proxy + onAuthRequired), Phase 4 (GPO пакет, документация, sync-architecture).
  - [x] [vlv-code/PEC::zcode::zc-main::agent-general-worker @ 2026-11-26 21:10] REMNA-PERUSER-XRAY-1 Phases 2-3 завершены (per-user порты + расширение + клиент): src/xrayRuntime.ts — deriveLocalPort (HMAC per-user порт в окне 4096, observation записана), buildXraySyncBlock отдаёт персональные listenPort/socksPort, accounts HTTP/SOCKS инбаундов выровнены с proxyUser/proxyPass; extension/background.js (+ BACKGROUND_TEMPLATE перегенерирован sync-паритетом) — локальный Xray-режим: memoryXrayCreds/pecXrayCreds (изоляция realm от fleet-кредов), HEAD-probe живости 127.0.0.1 listener, applyXrayLocalProxy с fail-closed откатом на legacy PAC, onAuthRequired fast-path; client/Windows/gui/ui/xray_rt.h (НОВЫЙ) — загрузка pinned xray.exe (fleet token + SHA-256), атомарная запись config.json, запуск/надзор xray.exe run, подключён в pec_sync.h (PecXrayHandleSyncBlock + PecXrayShutdown); компиляция cl /W4 подтверждена для main_imgui.cpp (C++) и main.c (C-фолбэк). Тесты: xrayRuntime 10/10 (новая deriveLocalPort), расширение 31/31, полный npm test 944: 943 pass, 1 fail githubReleasesRoute (внешняя TLS-интерцепция, известный environment quirk). tsc/biome/build:ui чисто; boundary gate OK; architecture.md дополнен разделом 2.11 и data-flow #4. Осталось: Phase 4 (GPO пакет MSI/документация).
  - [x] [vlv-code/PEC::zcode::zc-main::agent-general-worker @ 2026-11-27 10:56] REMNA-PERUSER-XRAY-1 Phase 4 завершён (GPO-пакет и документация): src/packager.ts — generateGpoConfig формирует regContentClientApp (HKLM\SOFTWARE\PEC-App: ServerUrl + только FleetToken, админ-токен не покидает сервер), GPO Deployment Pack дополнен pec-app-client.reg (UTF-8 BOM); src/types.ts — GpoConfig.regContentClientApp; src/templates/gpoTemplates.ts — README-GPO.txt: состав пакета, раздел развёртывания PEC-App (Xray-режим: GPO Software Installation /SILENT /NORESTART, импорт reg, pinned xray.exe с SHA-256, per-user порты, AD Security Filtering); docs/gpo-deployment-guide.md — Шаг 4 раздела 3, дополнены разделы 1/4/5. Контракт: reg-файл заполняет HKLM\Software\PEC-App — fallback-чтение main_imgui.cpp (~3098). Тесты: gpo.test.ts (состав zip + содержимое client reg + отсутствие ADMIN_TOKEN + README), 9 GPO-сьютов 47/47; полный npm test 944: 943 pass, 1 fail githubReleasesRoute (известная внешняя TLS-интерцепция). tsc/biome чисто; boundary gate OK; architecture.md: 2.11 Machine bootstrap + состав GPO пакета. Ветка remna, фаза 4.
  - [x] [vlv-code/PEC::zcode::zc-main::agent-general-worker @ 2026-11-27 11:15] REMNA-PERUSER-XRAY-1 UX: версия ядра Xray выбирается из выпадающего списка GitHub-релизов. src/xrayBinaries.ts — listXrayCoreVersions (api.github.com XTLS/Xray-core releases, фильтр isValidXrayVersion, кэш 10 мин, GITHUB_TOKEN + env-proxy через undici ProxyAgent); src/routes/xrayRuntimeRoutes.ts — GET /api/xray-runtime/versions (admin-only, 502 при недоступности GitHub); dashboardView.ts — input#xrayRuntimeVersion заменён на select; telemetry.ts — setXrayVersionOptions/loadXrayCoreVersions (подстановка текущей версии, ?refresh=1); бандл пересобран. Тест: /versions admin-only + устойчив к отсутствию GitHub (200 массив либо чистый 502). npm test 945: 944 pass, 1 fail githubReleasesRoute (известная внешняя TLS-интерцепция). tsc/biome/build:ui чисто; boundary gate OK (architecture.md 2.11 обновлён).

- [x] [vlv-code/PEC::zcode::zc-main::agent-general-worker @ 2026-11-27 12:40] FIX INSTALLER-EMBED-1: автономный PEC-App-Setup.exe падал с «Failed to verify digital signature (Authenticode) of fallback installer files» — setup.rc встраивает payload.zip (RCDATA 101) только под EMBED_PAYLOAD, который никогда не определялся ни одним билдом; standalone-EXE всегда уходил в CopyFromSourceFolder и не находил бинарники рядом. src/appPackager.ts — buildInstallerPayloadZip (AdmZip: PEC-App.exe/PEC-CLI.exe/PECAppSvc.exe + подписанные PECAppCore.dll/WinDivert*, иначе исключение); MinGW windres получает -DEMBED_PAYLOAD, MSVC rc — /dEMBED_PAYLOAD; payload.zip добавлен в cleanAppBinaries. setup.c — сообщение об ошибке fallback переформулировано (отсутствующий payload vs подпись). Тест: buildInstallerPayloadZip (пусто->ok:false, фильтрация <1KB, состав zip). Проверки: tsc чисто, appPackager 32/32, MSVC rc+cl компиляция setup.rc(/dEMBED_PAYLOAD)+setup.c OK, полный npm test (см. ниже).
