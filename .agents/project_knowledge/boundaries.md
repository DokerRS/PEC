# Areas of Responsibility and Change Boundaries

This document defines agent freedom levels when modifying the repository using explicit file path glob patterns.

---

## Green Zone (Autonomous Modification Allowed)
- `test/**/*.test.ts` — creating new tests for newly implemented features (TDD).
- `src/utils/**` — stateless helper utilities (e.g. `semver.ts`).
- `docs/**`, `*.md` (except the root AGENTS.md) — documentation and guides.
- `scratch/**` — local temporary scripts and test artifacts.
- `assets/**` — static assets, documentation images, and third-party license notices (`assets/licenses/**`).

---

## Yellow Zone (Modification with Mandatory Verification)
- `AGENTS.md` — root project passport (careful verification and opportunistic refresh only; preserve custom North Stars).
- `test/**` — existing regression test suite. **Anti-regression guard:** strictly prohibited from weakening `assert` or modifying golden expectation fixtures to match broken code. Must run `npm test`.
- `src/**` — application source code (`src/routes/**`, `src/views/**`, `src/templates/**`, `src/client/**`, `src/geodata/**`, `src/*.ts`).
- `server.ts` — application entry point and HTTP server lifecycle.
- `extension/**` — browser extension source (`background.js`, `popup.html`, `popup.js`, `scripts/**`, icons, manifests).
- `public/**` — dashboard web assets, CSS, client scripts, icons, and favicons (`public/dashboard.css`, `public/dashboard.js`, `public/dashboard.min.js`, `public/icons/**`).
- `templates/**` — client distribution templates and precompiled binaries (`templates/app/linux/**`, `templates/app/windows/**`).
- `client/**` — native desktop client C/C++ source code, build scripts (`build.sh`, `Makefile`), and GUI layouts.
- `scripts/**` — build and packaging helper utilities (`pack-extension.ts`, `sync-templates.ts`, etc.) and zero-dependency meta-project runtime scripts (`inspect_meta_project.py`, `verify_identity.py`, `record_obs.py`, `manage_reports.py`, `compact_memory.py`, `update_meta_project.py`, `sync_templates.py`); **except `scripts/check_boundaries.py` (Red Zone)**.
- `deploy/**` — deployment scripts and systemd/nginx configuration templates.
- `.agents/**` — meta-project framework components: `.agents/meta-project.json` (identity registry), `.agents/skills/**`, `.agents/team/**` (role profiles; editing restricted to own role entries per tasks.md protocol), `.agents/reports/**`, `.agents/project_knowledge/**` slices except `boundaries.md` (Red Zone).
- `.npmrc` — npm registry and proxy configuration (project-level override of global user config).
- `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`, `.editorconfig`, `.gitattributes` — dependency manifests, compiler configurations, and repository hygiene rules.

---

## Red Zone (Modification Prohibited Without Explicit User Approval)
- Architectural integrity, threat model, and contract tests: `test/*security*.test.ts`, `test/threatModelAndHygiene.test.ts`, `test/binaryIntegrity.test.ts`, `test/ssrfGuard.test.ts`.
- `scripts/check_boundaries.py` — core boundary gate and security enforcement script (canonical copy from upstream meta-project).
- `.agents/project_knowledge/boundaries.md` — this responsibility boundary definition itself.
- `src/middleware/security.ts`, `src/auth.ts` — authentication tokens, session verification, rate limiters, CORS policies.
- `data/**`, `*.json` in data store (`proxies.json`, `current_creds.json`, `dashboard_auth.json`, `routing_profiles.json`, etc.) — persistent storage and runtime secrets.
- `extension/key.pem`, `*.pem`, `*.key`, `*.pfx`, `certs/**` — cryptographic keys and Authenticode certificates (vital to preserve deterministic Chrome extension ID and GPO bindings).
- `.env*` — configuration with production tokens and credentials.
- `Dockerfile*`, `docker-compose*.yml`, `docker-compose.prod.yml`, `.dockerignore` — container build definitions and orchestration.
- `.github/**` — CI/CD automation pipelines, issue templates, and bot workflows (`.github/workflows/**`, `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/**`).
- `LICENSE`, `.gitignore` — project licensing, copyright terms, and version control exclusion rules.

---

## Default Deny (Black Zone / Unmapped Paths Invariant)
Any directory or file path not explicitly listed in Green, Yellow, or Red zones above is strictly classified as **Red Zone by Default**. Autonomous modifications to unmapped paths are prohibited. Prior to touching unmapped code, the agent MUST consult the user and perform an *Opportunistic Refresh* of `boundaries.md` to map the path to its appropriate zone.
