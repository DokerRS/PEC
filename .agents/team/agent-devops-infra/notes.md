# Workspace and Private Notes: Инфраструктурный архитектор и GitHub-стюард (agent-devops-infra)

This document is dedicated exclusively to the in-depth working context, drafts, and role-specific specifications of `agent-devops-infra`.
No other agent is permitted to modify the contents of this file.

---

## 1. Role-Specific Invariants and Standards
- Dockerfile должен оставаться мультистейджевым: `builder` с полным набором компиляторов и `runner` с минимально необходимым рантаймом.
- Наличие MinGW-w64 и msitools в контейнере runner критично для сборки клиентских инсталляторов на лету.
- Документация ведется на двух языках: `README.md` (English) и `README.ru.md` (Русский). Изменения функционала синхронизируются в обоих файлах.

---

## 2. Working Drafts and Unfinished Research
- (Заметки по оптимизации кэширования слоев Docker и матрице CI GitHub Actions)
- Интеграция сборки UI (`npm run build:ui`) в общий `npm run build` и пайплайн CI (`.github/workflows/ci.yml`). Бандл дашборда вынесен в `public/dashboard.min.js`, сборка через esbuild занимает ~100-200мс. Валидация OpenAPI через `@redocly/cli lint` встроена в CI.
- Коммит `e4486dd` успешно запушен в `origin/main`.
- Очистка репозитория по протоколу github-management: удалено 17 локальных устаревших файлов (.obj, .lib, .exp, .res, scratch/*.cjs, logs), обновлена Token Permission Matrix в SECURITY.md (эндпоинт /metrics), коммит `4eb9677` отправлен в `origin/main`.
- Скомпонованы 3 коммита этапа (f13d95c, e4486dd, 4eb9677) в единый коммит `c1d5ee2`. Проведён автоматический аудит 477 файлов на отсутствие секретов/токенов/паролей. Выполнен force-push в `origin/main`.
- Закоммичен и отправлен в `origin/main` фикс бандла UI (`d6b24db`): `globals.d.ts`, включение `src/client` в корневой `tsconfig.json`, переход тестового стенда на `public/dashboard.min.js`.
- Восстановлен полный билингвальный словарь I18N (386 ключей en/ru, `src/client/dashboard/core/i18n.ts`) и безопасная смена языка `setLanguage()` в `core/theme.ts`. Коммит `b801202` запушен в `origin/main`.
- Реализован Safe Forward-Rollback для Chrome расширений (`src/releases.ts`, `src/utils/semver.ts`, `src/routes/releasesRoutes.ts`, UI в `telemetry.ts`). Коммит `d185ccc` запушен в `origin/main`.

---

## 3. Registry of External Links and Documentation
- Docker Best Practices & Multi-stage builds
- GitHub Actions Workflow Syntax
- WiX / msitools documentation
