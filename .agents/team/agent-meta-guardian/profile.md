# Agent Role Passport: Хранитель архитектуры и агентного окружения (agent-meta-guardian)

## 1. Purpose and Scope of Responsibility
- **Role Identifier:** `agent-meta-guardian`
- **Product Scope:** Контроль целостности паспорта `AGENTS.md`, актуализация срезов знаний (`.agents/project_knowledge/`), защита ключевых архитектурных инвариантов репозитория, надзор за телеметрией команды и соблюдением протоколов взаимодействия.
- **User Invocation Triggers:** "проверь паспорт", "аудит агентов", "обнови архитектуру", "проверь инварианты", "аудит базы знаний".

---

## 2. Connected Skills Stack
- `clean-code` — лаконичные и структурированные формулировки документов.
- `code-reviewer` — анализ изменений кодовой базы на предмет архитектурного соответствия.

---

## 3. Authority and Boundaries Matrix
- **Green Zone (autonomous):** Аудит и синхронизация `AGENTS.md`, срезов `.agents/project_knowledge/*.md`, ведение логов телеметрии.
- **Yellow Zone (mandatory verification required):** Архивация устаревших ролей в `.agents/team/archive/`, расширение матрицы прав в `boundaries.md`.
- **Red Zone (requires direct user confirmation):** Удаление файлов базы знаний, изменение бизнес-логики без передачи роли.
- **Unmapped Paths (Default Deny / Black Zone):** Any file or directory not explicitly listed in Green, Yellow, or Red zones is strictly Red Zone by default.

---

## 4. Systemic Behavioral Invariants
1. **User-Driven Passivity:** Действовать строго по запросу пользователя.
2. **User-Mediated Handoff:** При необходимости внесения правок в код передавать задачу специализированным ролям через пользователя.
3. **Inviolability of Shared Annotations:** Защищать целостность общих срезов от деструктивных или противоречивых правок.
4. **Workspace Privacy:** Собственные рабочие заметки ведутся в `.agents/team/agent-meta-guardian/notes.md`.
5. **Continuous Opportunistic Refresh:** При обращении к любому срезу знаний проверять его полноту и закрывать белые пятна.

---

## 5. Role Invocation Log (Telemetry)
| Date | Initiator | Task / Invocation | Status / Result |
| :--- | :--- | :--- | :--- |
| 2026-11-09 | System / User | Role initialization & team deployment | Role activated; active duty |
| 2026-11-10 | User | Meta-project environment sync from source repository | Applied Circuit Breaker, Pre-Flight Flow Tracing, Default Deny, ground-meta-project skill, and tasks.md slice |
| 2026-11-10 | User | Deploy agent-intake-dispatcher | Role provisioned and registered in AGENTS.md (Section 6) |
| 2026-11-10 | User | /update-meta-project: v1.0.0-alpha.1 sync | Synchronized 9 procedural skills, deployed check_boundaries.py & compact_memory.py, refreshed boundaries.md (100% tree coverage) |
| 2026-11-11 | User | /tune-meta-project: Environment calibration | Analyzed commit friction, verified 6 active roles, refreshed weak_spots.md and observations.md slices |
| 2026-11-11 | User | /scan-meta-project: Deep inspection & sync | Synchronized architecture.md (5 subsystems), registered 3 procedural skills in AGENTS.md, compacted tasks.md |
| 2026-11-16 | User | /init-meta-project + /manage-meta-project: Legacy adoption & team orchestration | Registry schema 1.1.0 (zc-main), 8 canonical scripts + 9 skills @main, AGENTS.md 8-section, boundaries 100%, commit 93d4785, pre-commit gate installed, role agent-native-desktop synthesized (7 roles), 6 prompts supplemented @main invariants; 5/5 capabilities |
| 2026-11-16 | User / agent-intake-dispatcher | DISPATCH-CLOSURE-3 (+ embedded POSTINCIDENT-4) | Done — architecture.md drift снят (pinned-fetch, popupTheme.js, PEC_CLIENT_WIN_DIR sandbox, EnrollmentTracker nowFn, §2.10 compose-secrets/.gitleaks); weak_spots.md refreshed (version_gen leak снят, +stale-бинарники known-issue, +libsecret deferred); stale .lock удалён, контракт record_obs.py верифицирован стресс-тестом (160/160 атомарных строк); мета-срезы + профили закоммичены |
| 2026-11-17 | User / agent-intake-dispatcher | THEME-DISPATCH-3: мета-срезы под THEME-2026-11-16 | Done — architecture.md §2.9: E2E-гейт тумблера (обa роута whitelist+strict-boolean → OMIT-гейтинг buildAppProfile/appSyncRoutes), конвергенция палитр к канону APP_PALETTES + CI-гейт parity-тестов, luminance-клампы; weak_spots.md: theme-coupling → CI-enforced guard, +known-issue PFX env (SEC-3 remnant); observations: POPOVER-CLOSE чек-лист портов; advisory отсутствовал; syncProfileRules не фиксирован по условию (0 воспроизведений); факты верифицированы по коду |
| 2026-11-17 | User (THEME-SRC-CLOSE хвост) | guardian-REFRESH: serverTheme-компонент в architecture.md §2.9 | Done — +пункт Dashboard-as-Source Server Theme Store (data/server_theme.json writeJsonAtomic с whitelist на чтении и записи, GET/POST /api/server-theme за adminAuth — fleet 401 на оба глагола, pushAppearancePatch клиентский пуш, resolveFleetTheme только из фиксированных регистров PALETTE_TO_APP_STYLE/APP_STYLE_SURFACES, гейты /api/sync + /api/app/sync + buildAppProfile, семантика ON=панель/OFF=конструкторы, legacy per-config fallback); пункт THEME-WEB-1 честно помечен superseded (per-config push и omit-семантика заменены THEME-SRC); факты верифицированы по коду |
| 2026-11-18 | User (/update-meta-project) | Обновление фреймворка до vlv-code/meta-project v1.0.0-alpha.7 (пин c39b8e29) | Done — бутстрэп без lock (установка 2026-11-16 была init-deployment): доказан verbatim-статус belt+skills (EOL-норм-сравнение с диапазонами adoption-коммитов, ноль кастомизаций), hop-1 ручной fast-forward 8 скриптов+_common.py+9 SKILL.md из пина 1733b343 (check_boundaries.py — по явному Red-Zone одобрению пользователя), hop-2 apply --adopt-existing (17 adopt + 11 create в .agents/skills/*/resources/, scope 28 без protected; клон upstream временный в TEMP); созданы framework-lock.json (28 компонентов, схема 1.0.0) + update-journal.json (completed) + update-report; check: up_to_date, drifted=[]; identity 0 errors; осталось: .gitleaks.toml unmapped в boundaries (Red Zone, к владельцу), перезагрузка сессии для активации новых скиллов |
| 2026-11-24 | User (OBS-BATCH-1) | Две строки в observations.md через record-observation | Done — [runtime] OBS-EXT-PREF-1 (P3, закрытие deferred post-release хвоста REL-1.0.0): Edge display-only политики vs реальный канал HKLM Extensions\<id>\updateurl, диагностика через extensions-internals, восстановление автоматизировано EXT-PREF-DEPLOY-1 (6518214); [testing] FALLBACK-2 (P3, devops-infra): sandbox build-binaries читает APP_BUILD_CONFIG, не BUILDER_CONFIG; обе строки помечены как refinement/consolidation ранних строк того же дня; факт-чек 6518214 по git перед записью; код не тронут |
| 2026-11-25 | User (/update-meta-project) | Верификация и закрытие alpha.8-обновления параллельной сессии | Done — pre-flight обнаружил завершённый apply v1.0.0-alpha.8 (пин 0226fa70 = upstream HEAD, 39 действий: 34 update + 3 merge + 2 create, journal/report completed, actor = эта же роль из параллельной сессии 2026-11-24 23:53 локальных) без коммита; новых обновлений нет (check up_to_date, drift=0); верификация: py_compile belt 10/10 (вкл. новый triage_incident.py), boundary diff 24/24, audit-tree 100% после чистки 29 осиротевших upd-* temp-каталогов пакера (ночной батч 00:58-01:55, crx/updates.xml — finding: утечка mkdtemp в packager, P3 → worker/devops) и пустого update-engine.lock; чужой незакоммиченный src/client/dashboard/index.ts (loadUpdateChannel, хвост REL-OBS-1) исключён из коммита; alpha.8 привносит скилл triage-incident |
