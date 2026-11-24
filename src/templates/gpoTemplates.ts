/**
 * GPO Templates: Corporate Active Directory GPMC deployment guide and documentation.
 */

export function renderGpoReadme(
  extensionId: string,
  serverUrl: string
): string {
  const safeServerUrl = serverUrl.replace(/\/+$/, "");

  const chromeSettingsVal = JSON.stringify({
    "*": {
      install_sources: [`${safeServerUrl}/*`],
    },
    [extensionId]: {
      installation_mode: "force_installed",
      update_url: `${safeServerUrl}/updates/updates.xml`,
      override_update_url: true,
    },
  });

  const edgeSettingsVal = JSON.stringify({
    "*": {
      install_sources: [`${safeServerUrl}/*`],
    },
    [extensionId]: {
      installation_mode: "force_installed",
      update_url: `${safeServerUrl}/updates/updates.xml`,
      override_update_url: true,
    },
  });

  const yandexSettingsVal = JSON.stringify({
    "*": {
      install_sources: [`${safeServerUrl}/*`],
    },
    [extensionId]: {
      installation_mode: "normal_installed",
      update_url: `${safeServerUrl}/updates/updates.xml`,
      override_update_url: true,
    },
  });

  return `# PEC Corporate GPO Deployment Package

Данный пакет содержит конфигурации и файлы для централизованного развертывания браузерного расширения **PEC (Proxy Extension Corp)** через групповые политики Active Directory.

- **Extension ID:** \`${extensionId}\`
- **Server URL:** \`${safeServerUrl}\`
- **Целевые браузеры:** Google Chrome, Microsoft Edge, Яндекс.Браузер, Opera

---

## Содержимое пакета

1. **\`pec-policy-user.reg\`** — готовый файл реестра текущего пользователя (\`HKCU\`) со всеми параметрами для всех 4 браузеров.
2. **\`pec-policy-machine.reg\`** — готовый файл реестра для всего компьютера (\`HKLM\`).
3. **\`README-GPO.txt\`** — данная инструкция администратора.

---

## Канонический способ развертывания через GPO (GPMC)

Развертывание выполняется через консоль **Group Policy Management** (\`gpmc.msc\`) с помощью прямого импорта готовых \`.REG\` файлов или ручной настройки параметров реестра.

### 1. Топология размещения и привязки GPO

1. Откройте консоль **Group Policy Management** (\`gpmc.msc\`).
2. Создайте объект групповой политики (GPO), например: \`PEC-Proxy-Extension-Deployment\`.
3. **Привязка к OU:** Свяжите объект GPO с OU пользователей (\`HKCU\`) или компьютеров (\`HKLM\`).
4. **Фильтры безопасности (Security Filtering):**
   - Укажите целевую группу безопасности пользователей или компьютеров Active Directory.
5. ⚠️ **КРИТИЧЕСКИ ВАЖНО В ДЕЛЕГИРОВАНИИ (Delegation):**
   - Перейдите на вкладку **Delegation (Делегирование)** созданного объекта GPO.
   - Нажмите **Add (Добавить)** и ОБЯЗАТЕЛЬНО укажите группу **\`Authenticated Users\`** («Прошедшие проверку») с разрешением **«Read» (Чтение)**.
   > **Почему это обязательно?**  
   > В соответствии с бюллетенем безопасности Microsoft **MS16-072 (KB3163622)**, групповые политики пользователя считываются рабочей станцией в контексте учетной записи компьютера. Если у \`Authenticated Users\` отсутствует право на чтение объекта GPO, компьютер не сможет прочесть файлы политики из SYSVOL, и параметры реестра **не применятся**.
6. **Режим замыкания (Loopback Processing) при привязке к OU компьютеров:**
   - Если GPO привязана к OU с компьютерами сотрудников:
   - \`Конфигурация компьютера → Политики → Административные шаблоны → Система → Групповая политика\`
   - Включите: **«Режим обработки пользовательской групповой политики замыкания»** (\`Configure user Group Policy loopback processing mode\`) = **Включено (Объединение / Merge)**.

---

### 2. Размещение параметров в GPMC

В редакторе GPO перейдите по пути:
\`Конфигурация пользователя (или Компьютера) → Настройка → Конфигурация Windows → Реестр\`
*(Preferences → Windows Settings → Registry)*

Для каждого целевого браузера задаются следующие ключевые параметры (статический .REG-экспорт использует индекс \`100\` для пары Allowlist/Sources):

#### 1. ExtensionInstallAllowlist + ExtensionInstallSources (Разрешение и источник установки)
- **Куст:** \`HKEY_CURRENT_USER\` (пользовательская конфигурация; для машинной — \`HKEY_LOCAL_MACHINE\`)
- **Путь к разделу:**
  - Chrome: \`Software\\Policies\\Google\Chrome\\ExtensionInstallAllowlist\` и \`...\\ExtensionInstallSources\`
  - Edge: \`Software\\Policies\\Microsoft\Edge\\ExtensionInstallAllowlist\` и \`...\\ExtensionInstallSources\`
  - Яндекс.Браузер: \`Software\\Policies\\YandexBrowser\\ExtensionInstallAllowlist\` и \`...\\ExtensionInstallSources\`
  - Opera: \`Software\\Policies\\Opera Software\Opera\\ExtensionInstallAllowlist\` и \`...\\ExtensionInstallSources\`
- **Имя параметра:** настраиваемый индекс (по умолчанию \`100\`; номера могут конфликтовать с чужими корпоративными расширениями)
- **Тип:** \`REG_SZ\`
- **Значения:** Allowlist — \`\${extensionId}\`; Sources — \`\${safeServerUrl}/*\` (со звёздочкой)
- **Канал установки:** параметр \`ExtensionSettings\` (ниже) с \`normal_installed\` + \`update_url\` + \`override_update_url\` — обновления расширения доказанно работают через него.
> **Legacy-вариант:** \`ExtensionInstallForcelist\` (принудительная установка по ID) больше не генерируется: в доменной среде номера значений Forcelist конфликтуют с чужими корпоративными расширениями. При необходимости принудительной установки включите её вручную, назначив свободный индекс.

#### 2. ExtensionSettings (Источник обновлений и режим)
- **Куст:** \`HKEY_CURRENT_USER\` (или \`HKEY_LOCAL_MACHINE\`)
- **Путь к разделу:**
  - Chrome: \`Software\\Policies\\Google\\Chrome\`
  - Edge: \`Software\\Policies\\Microsoft\\Edge\`
  - Яндекс.Браузер: \`Software\\Policies\\YandexBrowser\`
  - Opera: \`Software\\Policies\\Opera Software\\Opera\`
- **Имя параметра:** \`ExtensionSettings\`
- **Тип:** \`REG_SZ\`
- **Значение (Chrome/Edge/Opera):**
  \`\`\`json
  ${chromeSettingsVal}
  \`\`\`
- **Значение (Яндекс.Браузер):**
  \`\`\`json
  ${yandexSettingsVal}
  \`\`\`

#### 3. domainUser (Сквозная идентификация для Active Directory Zero-Trust)
- **Куст:** \`HKEY_CURRENT_USER\` (или \`HKEY_LOCAL_MACHINE\`)
- **Путь к разделу:**
  - Chrome: \`Software\\Policies\\Google\\Chrome\\3rdparty\\extensions\\${extensionId}\\policy\`
  - Edge: \`Software\\Policies\\Microsoft\\Edge\\3rdparty\\extensions\\${extensionId}\\policy\`
  - Яндекс.Браузер: \`Software\\Policies\\YandexBrowser\\3rdparty\\extensions\\${extensionId}\\policy\`
  - Opera: \`Software\\Policies\\Opera Software\\Opera\\3rdparty\\extensions\\${extensionId}\\policy\`
- **Имя параметра:** \`domainUser\`
- **Тип:** \`REG_SZ\`
- **Значение:** \`%USERDOMAIN%\\%USERNAME%\`
> ⚠️ **Обязательно для привязки к AD:** без передачи этого параметра расширения работают в режиме Legacy (без Kill-Switch и AD-авторизации).

---

### ⚠️ Особенность Яндекс.Браузера

> Если версия Яндекс.Браузера **не управляется через корпоративную консоль администрирования Яндекса**, режим \`force_installed\` ставить нельзя (расширение будет заблокировано защитной системой браузера).
> Для Яндекс.Браузера используйте готовый \`.REG\` файл или режим **\`normal_installed\`**.

---

### Быстрый импорт через .REG файлы

Вместо ручного заведения параметров вы можете применить готовые файлы из пакета:
- \`pec-policy-user.reg\` — для применения в контексте пользователя (\`HKCU\`).
- \`pec-policy-machine.reg\` — для применения в контексте компьютера (\`HKLM\`).

---

### Восстановление канала обновления (Extensions\\<ID>\\updateurl)

Если политики валидны, но расширение перестало обновляться — проверьте наличие ветки **per-extension update channel** (может быть удалена сторонним ПО или ручной чисткой реестра):

reg query "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Edge\Extensions\<ID>"
reg query "HKEY_LOCAL_MACHINE\SOFTWARE\Google\Chrome\Extensions\<ID>"

Ожидаемое значение updateurl — <server>/updates/updates.xml. Если ветка отсутствует — пересоздайте её импортом готового .REG файла (значение updateurl включено в генерацию) или вручную:

reg add "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Edge\Extensions\<ID>" /v updateurl /t REG_SZ /d "<server>/updates/updates.xml" /f
reg add "HKEY_LOCAL_MACHINE\SOFTWARE\Google\Chrome\Extensions\<ID>" /v updateurl /t REG_SZ /d "<server>/updates/updates.xml" /f

При полном отзыве расширения удалите ветку (кроме обычной чистки политик):

reg delete "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Edge\Extensions\<ID>" /f
reg delete "HKEY_LOCAL_MACHINE\SOFTWARE\Google\Chrome\Extensions\<ID>" /f

### Проверка применения политик на рабочем месте

После выполнения \`gpupdate /force\` проверьте статус применения в браузере:
- **Chrome:** \`chrome://policy\` → кнопка *«Перезагрузить политики»*

### Восстановление канала обновления (Extensions\\\\<ID>\\\\updateurl)

Если политики валидны, но расширение перестало обновляться — проверьте наличие ветки **per-extension update channel** (может быть удалена сторонним ПО или ручной чисткой реестра):

\`\`\`powershell
reg query "HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\Microsoft\\\\Edge\\\\Extensions\\\\<ID>"
reg query "HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\Google\\\\Chrome\\\\Extensions\\\\<ID>"
\`\`\`

Ожидаемое значение \`updateurl\` — \`<server>/updates/updates.xml\`. Если ветка отсутствует — пересоздайте её импортом готового \`.REG\` файла (значение \`updateurl\` включено в генерацию) или вручную:

\`\`\`powershell
reg add "HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\Microsoft\\\\Edge\\\\Extensions\\\\<ID>" /v updateurl /t REG_SZ /d "<server>/updates/updates.xml" /f
reg add "HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\Google\\\\Chrome\\\\Extensions\\\\<ID>" /v updateurl /t REG_SZ /d "<server>/updates/updates.xml" /f
\`\`\`

При полном отзыве расширения удалите ветку (кроме обычной чистки политик):

\`\`\`powershell
reg delete "HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\Microsoft\\\\Edge\\\\Extensions\\\\<ID>" /f
reg delete "HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\Google\\\\Chrome\\\\Extensions\\\\<ID>" /f
\`\`\`
- **Edge:** \`edge://policy\` → кнопка *«Перезагрузить политики»*
- **Яндекс.Браузер:** \`browser://policy\` → кнопка *«Перезагрузить политики»*
`;
}
