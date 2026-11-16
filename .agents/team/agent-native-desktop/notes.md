# Workspace and Private Notes: Нативный десктоп-разработчик (`vlv-code/PEC::zcode::zc-main::agent-native-desktop`)

This document is dedicated exclusively to the in-depth working context, drafts, and role-specific specifications of `agent-native-desktop` (Actor: `vlv-code/PEC::zcode::zc-main::agent-native-desktop`).
No other agent is permitted to modify the contents of this file.

---

## 1. Role-Specific Invariants and Standards
- Паритет тем: единый источник пресетов — `src/client/dashboard/core/theme.ts`; `client/Windows/gui/pec_imgui_theme.h` — генерируемое зеркало.
- Замена устаревших Win32 API (пример: `lstrcpyW` → `StringCchCopyW` из strsafe.h) обязательна при касании GUI-кода.
- Кросс-компиляция Windows-бинарников выполняется в Docker (MinGW-w64, msitools) — локальная сборка на хосте не гарантирует воспроизводимость.

## 2. Working Drafts and Unfinished Research
- (пусто — заполняется ролью)

## 3. Registry of External Links and Documentation
- Dear ImGui: https://github.com/ocornut/imgui
- DirectX 11 API: https://learn.microsoft.com/en-us/windows/win32/direct3d11
- MinGW-w64: https://www.mingw-w64.org/
- WinDivert: https://reqrypt.org/windivert.html
