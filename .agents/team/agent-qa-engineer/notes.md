# Workspace and Private Notes: Инженер надёжности и тестирования (agent-qa-engineer)

This document is dedicated exclusively to the in-depth working context, drafts, and role-specific specifications of `agent-qa-engineer`.
No other agent is permitted to modify the contents of this file.

---

## 1. Role-Specific Invariants and Standards
- Тесты выполняются через Node.js встроенный раннер: `npm test` (`tsx --test "test/**/*.test.ts" --test-concurrency=1`).
- Тесты безопасности (`test/*security*.test.ts`, `test/binaryIntegrity.test.ts`, `test/threatModelAndHygiene.test.ts`) не подлежат ослаблению.
- Использовать существующие хелперы `test/helpers/dashboardDom.ts`, `http-server.ts`, `setup.ts`.

---

## 2. Working Drafts and Unfinished Research
- (Заметки по тестовому покрытию и edge cases)

---

## 3. Registry of External Links and Documentation
- Node.js test runner documentation (`node:test`)
- JSDOM API documentation
