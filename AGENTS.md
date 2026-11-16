# Project Passport: PEC - Proxy Extension Corp

## 1. Concept, Principles, and North Stars
- **Service Purpose:** Enterprise proxy fleet synchronization, live extension builder studio, Windows Active Directory GPO distribution, native desktop clients (C / DirectX 11 / Dear ImGui), and automated 3x-ui / Xray credential rotation.
- **Technology Stack:** Node.js >=20.0.0, TypeScript 5.7, Express 4.21, esbuild, tsx, MinGW-w64, C/C++, Chrome Extension Manifest V3, Docker.
- **Critical Invariant:** Strict privilege separation (`ADMIN_TOKEN !== EXT_SHARED_TOKEN` enforced at startup) and immutable preservation of `extension/key.pem` to maintain deterministic Chrome extension ID required for enterprise Active Directory GPO policies (`ExtensionInstallForcelist`).
- **Principles and Architectural Orientations (North Stars):**
  - **Perimeter-first security & two-token isolation:** Fleet tokens (`EXT_SHARED_TOKEN`) are low-privilege and baked into client artifacts. Administrative access (`ADMIN_TOKEN`) is strictly server-bound. All outbound integrations enforce async DNS rebinding and SSRF defenses.
  - **Atomic, zero-dependency persistence:** State is stored in flat-file JSON via atomic temporary-file writes (`writeJsonAtomic`) with automatic corruption recovery (`.corrupt-<timestamp>`). No heavy ORM or external database dependencies.
  - **Fleet resilience & deterministic updates:** Extension and desktop client pairing, PAC generation, and update manifests must support graceful fallbacks and offline resilience without sudden breaking changes across the fleet.
  - **Circuit Breaker & Flow Tracing:** Prohibit repetitive code edits during cross-component defects without first mapping the data path. Stop on 2nd consecutive fix in the same module to perform root cause investigation.
  - **Default Deny Boundaries:** Any directory or file path not explicitly mapped in `boundaries.md` is strictly Red Zone by default.
  *(Any decisions conflicting with these orientations are prohibited)*

## 2. Repository Meta-Map
- Core server code: `src/` (routes, middleware, views, templates, utils, geodata)
- Entry points: `server.ts`
- Build & packager scripts: `scripts/` (TS packaging utilities + zero-dependency meta-project runtime scripts: `inspect_meta_project.py`, `verify_identity.py`, `check_boundaries.py`, `manage_reports.py`, `record_obs.py`, `compact_memory.py`, `update_meta_project.py`, `sync_templates.py`)
- Meta-project registry & agent team: `.agents/` (`meta-project.json`, `project_knowledge/`, `skills/`, `team/`, `reports/`)
- Browser extension source: `extension/`
- Native desktop clients: `client/Windows/` (DirectX 11 GUI & Service), `client/Linux/` (CLI & Daemon)
- Configuration: `.env.example`, `tsconfig.json`, `docker-compose.yml`, `docker-compose.prod.yml`, `Dockerfile`
- Tests: `test/`
- Persistent state directory: `data/`
- Built artifacts: `dist/`

## 3. Meta-Knowledge Directive Protocol
Before taking action, the agent must consult the corresponding knowledge slices.
**Principle of Opportunistic Refresh:** when reading any slice, evaluate completeness — add missing details, correct obsolete information, and fill gaps in the cohesive vision of the project:

- **Areas of Responsibility and Boundaries (`.agents/project_knowledge/boundaries.md`):**
  - *When to consult:* before modifying data schemas, route controllers, templates, dependencies, security middleware, or configs.
  - *What to refresh:* supplement and refine file path glob patterns for actual repository structure.
- **Weak Spots and Risks (`.agents/project_knowledge/weak_spots.md`):**
  - *When to consult:* before editing packaging engines, 3x-ui integration, monolithic views (`dashboardView.ts`), or cryptographic signing.
  - *What to refresh:* log newly identified risks, hidden couplings, and remove resolved issues.
- **Architectural Foundations (`.agents/project_knowledge/architecture.md`):**
  - *When to consult:* before introducing new subsystems, changing sync protocols, or modifying PAC generation contracts.
  - *What to refresh:* eliminate blind spots in subsystem map, describe actual connections and data flows (directly or via `sync-architecture` skill).
- **Observation Registry (`.agents/project_knowledge/observations.md`):**
  - *When to consult:* during build or runtime errors, test failures, or unexpected Windows/container behavior.
  - *What to refresh:* immediately log resolved non-trivial quirks atomically via `record-observation` skill.
- **Active Tasks (`.agents/project_knowledge/tasks.md`):**
  - *When to consult:* at the beginning of any session and upon completing subtasks.
  - *What to refresh:* track execution progress, register new tasks and delegated steps with authorship and timestamp `[<actor_id> @ YYYY-MM-DD HH:MM]`; never delete or modify entries written by other agents.

## 4. Procedural Skills Registry
### Bundled meta-project skills:
- `init-meta-project` — repository scaffolding, survey, scenario agreement, and non-destructive legacy adoption (never deploys teams).
- `manage-meta-project` — scale-adaptive agent team orchestration, role materialization, and bindings configuration.
- `ground-meta-project` — emergency grounding, runaway edit halt, and context recalibration.
- `decommission-meta-project` — safe decommissioning and context archival of agent roles.
- `record-observation` — atomic logging of findings, environment quirks, and fixes in `observations.md`.
- `sync-architecture` — component map and data flow synchronization in `architecture.md`.
- `scan-meta-project` — inspect meta-knowledge integrity, verify 100% boundary coverage, and detect architectural drift.
- `tune-meta-project` — calibrate agent environment, analyze git friction, role topology, and core invariants.
- `update-meta-project` — safely update meta-project canonical skills, templates, and scripts from upstream source.

### Skill Responsibility Boundaries (invariant):
| Skill | Owns | Must NOT do |
|---|---|---|
| init | survey, scenario agreement, scaffold prep | deploy teams |
| manage | roles & bindings configuration | re-agree the scenario |
| update | framework components & migrations | revise team composition or North Stars |
| ground | recover understanding of goal/state/authority | change configuration to silence a discrepancy |
| tune | propose config improvements with evidence | apply them directly (routes via manage/update/decommission) |

### Connected stack skills from shell:
- `typescript-expert` — TypeScript 5.7, Express 4, type safety, and async patterns.
- `docker-expert` — Multi-stage Dockerfile, MinGW cross-compiler integration, and Docker Compose orchestration.
- `github-actions-creator` — CI/CD automation pipelines (`.github/workflows/ci.yml`, `release.yml`).
- `bash-linux` — Linux native client build and deployment scripts (`client/Linux/build.sh`, `deploy.sh`).
- `clean-code`, `code-reviewer` — Pragmatic coding standards, minimal changes, and review checklists.
- `remnawave-xray` — 3x-ui / Xray proxy rotation, Reality/Vision protocol, and routing presets.
- `security-review` — SSRF validation, DNS rebinding guards, sliding-window rate limiters, token models.
*(Build management, linting, tests, and framework specifics are delegated to these skills)*

## 5. Local Verification Tooling & Autonomous Fallback
Zero-dependency Python 3.10+ stdlib utilities (canonical copies from upstream `vlv-code/meta-project`):
- **Repository Inspection & Capability Audit:**
  `python scripts/inspect_meta_project.py --json --harness zcode --installation zc-main`
- **Role Identity & Binding Verification:**
  `python scripts/verify_identity.py --check`
- **Boundary Gate & Responsibility Audit:**
  `python scripts/check_boundaries.py --boundaries .agents/project_knowledge/boundaries.md --audit-tree`
- **Working Tree Diff Verification:**
  `python scripts/check_boundaries.py --boundaries .agents/project_knowledge/boundaries.md --diff HEAD --allow-red-zone`
- **Memory Compaction Check:**
  `python scripts/compact_memory.py --dry-run`
- **Atomic Observation Logging:**
  `python scripts/record_obs.py --category <cat> --path <path> --issue <text> --solution <text>`
- **Initialization & Management Report Audit:**
  `python scripts/manage_reports.py [init|manage|latest|verify]`

### Read-Only Exploration Mode
When tasked with code exploration, repository assessment, or architecture review without explicit instruction to implement changes:
- Do NOT generate temporary files, `.lock` files, or intermediate scratchpads.
- Do NOT add telemetry rows to role profiles or tasks to `tasks.md`.
- Use `python scripts/inspect_meta_project.py --read-only --json` for safe discovery.

## 6. Baseline Operating Protocol
1. Consult Section 1: ensure proposed solution does not violate project principles and invariants.
2. Read target slice from Section 3; upon detecting gaps or inaccuracies, immediately refresh slice.
3. Apply stack skills from Section 4 to modify code and execute tests.
4. Changes must be minimally sufficient; refactoring unrelated areas is prohibited; diffs must be minimal in width, but maximal in root-cause depth. Before editing multi-component interfaces, map the End-to-End Data Flow.
5. Whenever trigger events from Section 3 occur, immediately update corresponding meta-knowledge slice via `record-observation`.
6. Circuit Breaker: upon encountering a 2nd failed attempt or secondary regression in the same module, cease editing, zoom out, trace the full data lifecycle, and invoke `ground-meta-project` if context drifted.

## 7. Project Agent Team & Multi-Harness Identity (.agents/team/)
Project roles and multi-harness bindings are authoritative in `.agents/meta-project.json` (schema 1.1.0, project `vlv-code/PEC`, installation `zc-main` / harness `zcode`).
- **Identity Determination Protocol:** Every agent operating in the repository must resolve its qualified `actor_id` (`vlv-code/PEC::zcode::zc-main::<role_id>`) from `.agents/meta-project.json` using `python scripts/verify_identity.py --check`.
- **Invariance of Identity:** Reading another role's passport (`profile.md`) or private workspace (`notes.md`) does NOT alter the active actor's identity. If identity cannot be verified, the agent must fail closed and report an unresolved identity.
- **Agreed Scenario:** `active_development` / `shared_repo` / `specialized_swarm` (7 roles) / `strict_independent` / `controlled`.

### Active Team Roster:
- [Диспетчер входящих запросов](.agents/team/agent-intake-dispatcher/profile.md) (`agent-intake-dispatcher`) — Первичный приём, декомпозиция задач, двухскоростная маршрутизация (Fast-Track / Deep-Track) и подготовка Handoff-пакетов (invoked by: "разбери задачу", "декомпозируй", "кому передать", "с чего начать", "план работ", "входная точка", "диспетчер", "распредели задачи")
- [Базовый разработчик](.agents/team/agent-general-worker/profile.md) (`agent-general-worker`) — Реализация Express-сервера, маршрутизации PAC, компонентов расширения и нативных клиентов PEC-App (invoked by: "добавь фичу", "реализуй эндпоинт", "исправь баг", "добавь прокси", "настрой pac", "добавь клиентскую логику")
- [Хранитель архитектуры](.agents/team/agent-meta-guardian/profile.md) (`agent-meta-guardian`) — Контроль паспорта AGENTS.md, актуализация срезов знаний, соблюдение инвариантов и протоколов (invoked by: "проверь паспорт", "аудит агентов", "обнови архитектуру", "проверь инварианты", "аудит базы знаний")
- [Инженер надёжности и тестирования](.agents/team/agent-qa-engineer/profile.md) (`agent-qa-engineer`) — Разработка тестов (50+ сьютов), поддержание антирегрессионного правила, верификационные прогоны (invoked by: "запусти тесты", "напиши тест", "проверь регрессию", "проверь покрытие", "верифицируй фикс")
- [Инфраструктурный архитектор и GitHub-стюард](.agents/team/agent-devops-infra/profile.md) (`agent-devops-infra`) — Контейнеризация, кросс-компиляция, CI/CD, состояние GitHub репозитория, документация и Code-to-README Truth Parity (invoked by: "собери docker", "настрой ci/cd", "проверь github", "обнови readme", "проверь соответствие документации", "подготовь релиз", "настрой deploy")
- [Аудитор периметра и безопасности](.agents/team/agent-security-auditor/profile.md) (`agent-security-auditor`) — Аудит SSRF/DNS-rebinding, двухтокенная изоляция, лимиты запросов, криптографические подписи CRX/Authenticode/HMAC (invoked by: "проверь безопасность", "аудит ssrf", "проверь токены", "проверь подписи", "аудит rate limit")
- [Нативный десктоп-разработчик](.agents/team/agent-native-desktop/profile.md) (`agent-native-desktop`) — Windows GUI (C/C++, DirectX 11, Dear ImGui) и сервис, Linux CLI/daemon, MinGW-w64 кросс-компиляция, паритет тем с веб-дашбордом (invoked by: "собери клиент", "нативный клиент", "directx", "imgui", "mingw", "кросс-компиляция", "клиент windows", "клиент linux", "windivert")

## 8. Dual-Entry & Canonical Repository Badge
For shared discovery across human operators and external agent harnesses, `README.md` incorporates the canonical block:
```markdown
<!-- META-PROJECT:ENTRY:BEGIN -->
[![Built with Meta-Project](https://img.shields.io/badge/Built%20with-Meta--Project-blueviolet)](https://github.com/vlv-code/meta-project)

Agent instructions: [AGENTS.md](AGENTS.md) | Policy: [.agents/project_knowledge/boundaries.md](.agents/project_knowledge/boundaries.md)
*To inspect, configure, or adapt your environment, run `python scripts/inspect_meta_project.py` or invoke the `init-meta-project` skill.*
<!-- META-PROJECT:ENTRY:END -->
```
