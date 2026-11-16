# Workspace and Private Notes: Базовый разработчик (agent-general-worker)

This document is dedicated exclusively to the in-depth working context, drafts, and role-specific specifications of `agent-general-worker`.
No other agent is permitted to modify the contents of this file.

---

## 1. Role-Specific Invariants and Standards
- Соблюдать атомарность операций записи (`writeJsonAtomic`, `writeFileAtomic`) для любых сохраняемых структур.
- Не нарушать разделение токенов `ADMIN_TOKEN` и `EXT_SHARED_TOKEN`.
- Любые изменения в `extension/` синхронизировать с шаблонами `src/templates/` через `npm run sync:templates`.

---

## 2. Working Drafts and Unfinished Research
- (Рабочие заметки по текущим фичам и временные схемы)

---

## 3. Registry of External Links and Documentation
- Express 4 API Reference
- Chrome Extension Manifest V3 Guide
- Dear ImGui Documentation
