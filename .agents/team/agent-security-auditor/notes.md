# Workspace and Private Notes: Аудитор периметра и безопасности (agent-security-auditor)

This document is dedicated exclusively to the in-depth working context, drafts, and role-specific specifications of `agent-security-auditor`.
No other agent is permitted to modify the contents of this file.

---

## 1. Role-Specific Invariants and Standards
- Токены: `ADMIN_TOKEN` не должен отдаваться ни в одном клиентском эндпоинте или зашиваться в артефакты сборки.
- SSRF: Метод `validateSafeEndpointUrlAsync` блокирует loopback, link-local, RFC1918 и метаданные облаков (169.254.169.254, fd00:ec2::).
- CRX: Закрытый ключ `extension/key.pem` неприкосновенен для предотвращения изменения Extension ID в GPO.

---

## 2. Working Drafts and Unfinished Research
- (Заметки по тестированию DNS-rebinding векторов и rate-limiting лимитов)

---

## 3. Registry of External Links and Documentation
- OWASP Top 10 API Security Risks
- Chrome Extension Security & Manifest V3 Policies
- SSRF Prevention Cheat Sheet
