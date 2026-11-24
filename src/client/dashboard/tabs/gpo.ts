// Active Directory & GPO Management Module for PEC Dashboard
import { state } from '../core/state.js';
import { adminFetch, extractError, esc } from '../core/api.js';
import { toast, pecConfirm } from '../core/notify.js';

export function toggleAdFieldsState() {
  const enabledInput = document.getElementById('adEnabled') as HTMLInputElement | null;
  const container = document.getElementById('adFieldsContainer');
  if (!container || !enabledInput) return;

  const isEnabled = enabledInput.checked;
  container.style.opacity = isEnabled ? '1' : '0.6';
}

export async function loadAdStatus() {
  const isRu = state.currentLang === 'ru';
  try {
    const res = await adminFetch('/api/ad/status');
    if (!res.ok) return;
    const data = await res.json();

    const enabledInput = document.getElementById('adEnabled') as HTMLInputElement | null;
    const urlInput = document.getElementById('adUrl') as HTMLInputElement | null;
    const bindDnInput = document.getElementById('adBindDn') as HTMLInputElement | null;
    const passwordInput = document.getElementById('adPassword') as HTMLInputElement | null;
    const passwordHint = document.getElementById('adPasswordHint');
    const baseDnInput = document.getElementById('adBaseDn') as HTMLInputElement | null;
    const groupDnInput = document.getElementById('adGroupDn') as HTMLInputElement | null;
    const intervalInput = document.getElementById('adInterval') as HTMLInputElement | null;
    const migrationSelect = document.getElementById('adMigrationMode') as HTMLSelectElement | null;
    const tlsRejectInput = document.getElementById('adTlsReject') as HTMLInputElement | null;

    if (enabledInput) enabledInput.checked = Boolean(data.enabled);
    if (urlInput) urlInput.value = data.ldapUrl || '';
    if (bindDnInput) bindDnInput.value = data.bindDn || '';
    if (baseDnInput) baseDnInput.value = data.searchBase || '';
    if (groupDnInput) groupDnInput.value = data.requiredGroupDn || '';
    if (intervalInput) intervalInput.value = String(data.syncIntervalSec || 300);
    if (migrationSelect) migrationSelect.value = data.rejectUnknownUsers ? 'strict' : 'soft';
    if (tlsRejectInput) tlsRejectInput.checked = data.tlsRejectUnauthorized !== false;

    if (passwordInput) {
      if (data.hasPassword) {
        passwordInput.placeholder = isRu ? '•••••••• (пароль сохранен)' : '•••••••• (password saved)';
        if (passwordHint) {
          passwordHint.textContent = isRu ? '(сохранен, оставьте пустым для сохранения прежнего)' : '(saved, leave blank to keep current)';
        }
      } else {
        passwordInput.placeholder = isRu ? 'Введите пароль...' : 'Enter password...';
        if (passwordHint) {
          passwordHint.textContent = '';
        }
      }
    }

    const badgeStatus = document.getElementById('badgeAdStatus');
    if (badgeStatus) {
      if (!data.enabled) {
        badgeStatus.className = 'badge badge-secondary';
        badgeStatus.textContent = isRu ? 'Отключено' : 'Disabled';
        badgeStatus.title = '';
      } else if (data.lastSyncError) {
        badgeStatus.className = 'badge badge-danger';
        badgeStatus.textContent = isRu ? 'Ошибка синхронизации' : 'Sync Error';
        badgeStatus.title = data.lastSyncError;
        // AD-DX-1: show the classified error (phase/kind/data + hint) inline
        const errDetail = document.getElementById('adErrorDetail');
        if (errDetail) {
          errDetail.textContent = data.lastSyncError;
          errDetail.style.display = 'block';
        }
      } else {
        badgeStatus.className = 'badge badge-online';
        const errDetailHide = document.getElementById('adErrorDetail');
        if (errDetailHide) errDetailHide.style.display = 'none';
        badgeStatus.textContent = isRu ? 'Активно / В сети' : 'Active / Online';
        badgeStatus.title = '';
      }
    }

    const lastSyncEl = document.getElementById('lblAdLastSync');
    if (lastSyncEl) {
      lastSyncEl.textContent = data.lastSyncAt ? new Date(data.lastSyncAt).toLocaleString() : '—';
    }

    const usersCountEl = document.getElementById('lblAdUsersCount');
    if (usersCountEl) {
      // AD-UX-2: identifiers = sam + UPN + mail entries used for login matching
      usersCountEl.textContent = String(data.usersCount || 0);
    }
    const uniqueUsersEl = document.getElementById('lblAdUniqueUsers');
    if (uniqueUsersEl) {
      uniqueUsersEl.textContent = String(data.uniqueUsersCount || 0);
    }

    toggleAdFieldsState();
  } catch (err) {
    console.warn('Failed to load AD status:', err);
  }
}

export async function saveAdConfigAction() {
  const isRu = state.currentLang === 'ru';
  const enabledInput = document.getElementById('adEnabled') as HTMLInputElement | null;
  const urlInput = document.getElementById('adUrl') as HTMLInputElement | null;
  const bindDnInput = document.getElementById('adBindDn') as HTMLInputElement | null;
  const passwordInput = document.getElementById('adPassword') as HTMLInputElement | null;
  const baseDnInput = document.getElementById('adBaseDn') as HTMLInputElement | null;
  const groupDnInput = document.getElementById('adGroupDn') as HTMLInputElement | null;
  const intervalInput = document.getElementById('adInterval') as HTMLInputElement | null;
  const migrationSelect = document.getElementById('adMigrationMode') as HTMLSelectElement | null;
  const tlsRejectInput = document.getElementById('adTlsReject') as HTMLInputElement | null;
  const saveBtn = document.getElementById('btnSaveAdConfig') as HTMLButtonElement | null;

  const isEnabled = Boolean(enabledInput?.checked);
  const ldapUrl = (urlInput?.value || '').trim();

  if (isEnabled && (!ldapUrl || (!ldapUrl.startsWith('ldap://') && !ldapUrl.startsWith('ldaps://')))) {
    toast(isRu ? 'Укажите корректный LDAP/LDAPS URL (например: ldaps://dc.corp.local:636)' : 'Please specify a valid LDAP/LDAPS URL', 'error');
    if (urlInput) urlInput.focus();
    return;
  }

  const payload: Record<string, any> = {
    enabled: isEnabled,
    ldapUrl,
    bindDn: (bindDnInput?.value || '').trim(),
    searchBase: (baseDnInput?.value || '').trim(),
    requiredGroupDn: (groupDnInput?.value || '').trim(),
    syncIntervalSec: Math.max(10, parseInt(intervalInput?.value || '300', 10) || 300),
    rejectUnknownUsers: migrationSelect?.value === 'strict',
    tlsRejectUnauthorized: Boolean(tlsRejectInput?.checked),
  };

  if (passwordInput && passwordInput.value) {
    payload.bindPassword = passwordInput.value;
  }

  const originalBtnText = saveBtn ? saveBtn.innerHTML : '';
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner-sm"></span> ' + (isRu ? 'Сохранение...' : 'Saving...');
  }

  try {
    const res = await adminFetch('/api/ad/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      toast(isRu ? 'Настройки Active Directory успешно сохранены' : 'Active Directory settings saved', 'success');
      if (passwordInput) passwordInput.value = '';
      await loadAdStatus();
    } else {
      toast(extractError(res, data, isRu ? 'Ошибка сохранения настроек AD' : 'Failed to save AD settings'), 'error');
    }
  } catch (err: any) {
    toast(err?.message || (isRu ? 'Сетевая ошибка при сохранении' : 'Network error during save'), 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = originalBtnText;
    }
  }
}

export async function testAdConnectionAction() {
  const isRu = state.currentLang === 'ru';
  const urlInput = document.getElementById('adUrl') as HTMLInputElement | null;
  const bindDnInput = document.getElementById('adBindDn') as HTMLInputElement | null;
  const passwordInput = document.getElementById('adPassword') as HTMLInputElement | null;
  const tlsRejectInput = document.getElementById('adTlsReject') as HTMLInputElement | null;
  const testBtn = document.getElementById('btnTestAdConnection') as HTMLButtonElement | null;

  const ldapUrl = (urlInput?.value || '').trim();
  if (!ldapUrl) {
    toast(isRu ? 'Укажите LDAP/LDAPS URL для проверки' : 'Please specify LDAP/LDAPS URL to test', 'error');
    if (urlInput) urlInput.focus();
    return;
  }

  const payload: Record<string, any> = {
    ldapUrl,
    bindDn: (bindDnInput?.value || '').trim(),
    tlsRejectUnauthorized: Boolean(tlsRejectInput?.checked),
  };
  if (passwordInput && passwordInput.value) {
    payload.bindPassword = passwordInput.value;
  }

  const originalBtnText = testBtn ? testBtn.innerHTML : '';
  if (testBtn) {
    testBtn.disabled = true;
    testBtn.innerHTML = '<span class="spinner-sm"></span> ' + (isRu ? 'Проверка...' : 'Testing...');
  }

  try {
    const res = await adminFetch('/api/ad/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      toast(isRu ? 'Подключение к контроллеру домена успешно установлено!' : 'Successfully connected to Domain Controller!', 'success');
    } else {
      const errorMsg = data.error || (isRu ? 'Не удалось подключиться к контроллеру домена' : 'Connection failed');
      toast(errorMsg, 'error');
      await pecConfirm({
        title: isRu ? 'Диагностика подключения AD' : 'AD Connection Diagnostics',
        message: (isRu ? 'Ошибка соединения с контроллером домена:\n\n' : 'Domain Controller connection error:\n\n') + errorMsg,
        isDanger: true,
        confirmText: 'OK',
      });
    }
  } catch (err: any) {
    const errText = err?.message || (isRu ? 'Сетевая ошибка проверки соединения' : 'Network error during test');
    toast(errText, 'error');
  } finally {
    if (testBtn) {
      testBtn.disabled = false;
      testBtn.innerHTML = originalBtnText;
    }
  }
}

export async function syncAdNowAction() {
  const isRu = state.currentLang === 'ru';
  const syncBtn = document.getElementById('btnSyncAdNow') as HTMLButtonElement | null;

  const originalBtnText = syncBtn ? syncBtn.innerHTML : '';
  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.innerHTML = '<span class="spinner-sm"></span> ' + (isRu ? 'Синхронизация...' : 'Syncing...');
  }

  try {
    const res = await adminFetch('/api/ad/sync-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      const countMsg = isRu ? `Синхронизация завершена. Пользователей в кэше: ${data.usersCount}` : `Sync complete. Users in cache: ${data.usersCount}`;
      toast(countMsg, 'success');
      if (data.warning) {
        toast((isRu ? 'Предупреждение: ' : 'Warning: ') + data.warning, 'error');
      }
      await loadAdStatus();
    } else {
      toast(extractError(res, data, isRu ? 'Ошибка синхронизации AD' : 'AD sync failed'), 'error');
    }
  } catch (err: any) {
    toast(err?.message || (isRu ? 'Сетевая ошибка синхронизации' : 'Network error during sync'), 'error');
  } finally {
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.innerHTML = originalBtnText;
    }
  }
}

// Window bindings for inline onclick/onchange handlers
if (typeof window !== 'undefined') {
  const w = window as any;
  w.toggleAdFieldsState = toggleAdFieldsState;
  w.loadAdStatus = loadAdStatus;
  w.saveAdConfigAction = saveAdConfigAction;
  w.testAdConnectionAction = testAdConnectionAction;
  w.syncAdNowAction = syncAdNowAction;
}
