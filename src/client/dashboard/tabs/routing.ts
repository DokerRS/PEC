// Routing & Profiles Tab Module for PEC Dashboard
import { state } from '../core/state.js';
import { adminFetch, esc, escapeHtml, extractError } from '../core/api.js';
import { toast, pecConfirm, pecPrompt, registerModalCloser } from '../core/notify.js';

let hasUnsavedRouting = false;

export function setUnsavedRouting(dirty: boolean) {
  hasUnsavedRouting = !!dirty;
  state.hasUnsavedRouting = hasUnsavedRouting;
  const badge = document.getElementById('unsavedChangesBadge');
  if (badge) {
    badge.style.display = hasUnsavedRouting ? 'inline-flex' : 'none';
  }
}

export function initRoutingDirtyTracking() {
  ['profName', 'profTargetGroup'].forEach(id => {
    const el = document.getElementById(id) as any;
    if (el && !el._dirtyBound) {
      el.addEventListener('input', () => setUnsavedRouting(true));
      el._dirtyBound = true;
    }
  });
  ['profDefaultPolicy', 'profTargetScope', 'profFailClosed'].forEach(id => {
    const el = document.getElementById(id) as any;
    if (el && !el._dirtyBound) {
      el.addEventListener('change', () => setUnsavedRouting(true));
      el._dirtyBound = true;
    }
  });
  const instList = document.getElementById('profTargetInstancesList') as any;
  if (instList && !instList._dirtyBound) {
    instList.addEventListener('change', () => setUnsavedRouting(true));
    instList._dirtyBound = true;
  }
}

let lastLoadedPresets: any[] = [];

function isRuGlobal(): boolean { return state.currentLang === 'ru'; }

function isBuiltinPreset(p: any): boolean {
  return p && p.source === 'builtin';
}

export async function loadPresets() {
  try {
    const res = await adminFetch('/api/routing/presets');
    const presets = await res.json();
    lastLoadedPresets = presets;
    const container = document.getElementById('presetsContainer');
    if (!container) return;

    const isRu = state.currentLang === 'ru';
    container.innerHTML = presets.map((p: any) => {
      const entriesList = p.entries || p.domains || [];
      const count = entriesList.length;
      const canRefresh = p.source === 'remote' ||
        (Array.isArray(p.sources) && p.sources.some((s: any) => s && s.kind === 'url'));

      // Check if preset is already in currentProfile
      const existingRule = (state.currentProfile && Array.isArray(state.currentProfile.rules))
        ? state.currentProfile.rules.find((r: any) => r.targetType === 'preset' && r.pattern === p.id)
        : null;

      let badgeHtml = '';
      if (existingRule) {
        const act = (existingRule.action || 'proxy').toLowerCase();
        const actLabel = isRu
          ? (act === 'proxy' ? 'ПРОКСИ' : act === 'direct' ? 'НАПРЯМУЮ' : 'БЛОК')
          : act.toUpperCase();
        badgeHtml = `<span class="preset-in-profile-badge action-${esc(act)}">${isRu ? 'В профиле: ' : 'In Profile: '}${esc(actLabel)}</span>`;
      }

      // GEO-PRESET-UX-2 CARD-MENU: the ✏️/🗑/🔄 actions moved into a per-card
      // «⋮» dropdown (btn-preset-menu); 🔍 stays removed. Items depend on the
      // preset source: builtin -> read-only view + duplicate; custom ->
      // edit / refresh (url layers only) / export / delete (danger).
      // Bottom quick-add row and the in-profile badge are untouched.
      const isBuiltinCard = p.source === 'builtin';
      const menuBtn = '<button type="button" class="btn-icon btn-preset-menu" data-id="' + esc(p.id) + '" aria-haspopup="menu" aria-expanded="false" title="' + (isRu ? 'Меню пресета' : 'Preset menu') + '" style="font-size: 14px; padding: 2px 7px; line-height: 1;">⋮</button>';
      const menuItem = (cls: string, icon: string, label: string, styleExtra: string = ''): string =>
        '<button type="button" class="preset-menu-item ' + cls + '" data-id="' + esc(p.id) + '"' +
        ' style="display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: none; color: ' + (styleExtra ? styleExtra : 'var(--text)') + '; font-size: 12px; padding: 8px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;">' +
        (icon ? icon + ' ' : '') + esc(label) + '</button>';
      const menuItems: string[] = [];
      if (isBuiltinCard) {
        menuItems.push(menuItem('pm-view', '👁', isRu ? 'Просмотр слоёв' : 'View layers'));
        menuItems.push(menuItem('pm-duplicate', '📄', isRu ? 'Дублировать в свой' : 'Duplicate to custom'));
      } else {
        menuItems.push(menuItem('pm-edit', '✏️', isRu ? 'Редактировать' : 'Edit'));
        if (canRefresh) menuItems.push(menuItem('pm-refresh', '🔄', isRu ? 'Обновить' : 'Refresh'));
        menuItems.push(menuItem('pm-export', '⬇', isRu ? 'Экспорт JSON' : 'Export JSON'));
        menuItems.push(menuItem('pm-delete', '🗑', isRu ? 'Удалить' : 'Delete', 'var(--danger, #ef4444)'));
      }
      const cardMenu =
        '<div class="preset-card-menu" data-menu-for="' + esc(p.id) + '"' +
        ' style="display: none; position: absolute; top: 30px; right: 10px; z-index: 1000; min-width: 200px; flex-direction: column; gap: 2px; padding: 4px; background: var(--card-bg, #111827); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);">' +
        menuItems.join('') +
        '</div>';

      return `
      <div class="preset-card" style="position: relative;">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 6px; margin-bottom: 4px;">
            <h4 style="margin: 0; font-size: 13px; font-weight: 600;">${esc(p.name)}</h4>
            ${menuBtn}
          </div>
          ${cardMenu}
          <p style="margin: 0 0 6px 0;">${esc(p.description)} (${count} ${isRu ? 'записей' : 'entries'})</p>
          ${badgeHtml ? `<div style="margin-bottom: 6px;">${badgeHtml}</div>` : ''}
        </div>
        ${p.source !== 'builtin' ? `
        <div style="display: flex; gap: 6px; margin-top: 6px;">
          <button type="button" class="btn-secondary btn-add-preset-rule" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-action="proxy" style="font-size: 11px; padding: 4px 8px; flex: 1;">+ ${isRu ? 'Прокси' : 'Proxy'}</button>
          <button type="button" class="btn-secondary btn-add-preset-rule" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-action="direct" style="font-size: 11px; padding: 4px 8px; flex: 1;">+ ${isRu ? 'Напрямую' : 'Direct'}</button>
          <button type="button" class="btn-danger btn-add-preset-rule" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-action="block" style="font-size: 11px; padding: 4px 8px; flex: 1;">+ ${isRu ? 'Блок' : 'Block'}</button>
        </div>` : ''}
      </div>
      `;
    }).join('');
  } catch (e) {
    console.error(e);
  }
}

export async function loadProfiles() {
  try {
    const res = await adminFetch('/api/routing/profiles');
    if (!res.ok) return;
    state.allProfiles = await res.json();
    const sel = document.getElementById('profileSelect') as HTMLSelectElement | null;
    if (sel) {
      sel.innerHTML = state.allProfiles.map((p: any) =>
        `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.defaultPolicy.toUpperCase())} default)${p.isDefault ? ' [DEFAULT]' : ''}</option>`
      ).join('');
    }

    if (state.allProfiles.length > 0) {
      state.currentProfile = state.allProfiles[0];
      (window as any).currentProfile = state.currentProfile;
      renderProfile(state.currentProfile);
      const hdr = document.getElementById('hdrActiveProfile');
      if (hdr) hdr.textContent = state.currentProfile.name;
    }
  } catch (e) {
    console.error(e);
  }
}

export async function loadSelectedProfile() {
  const sel = document.getElementById('profileSelect') as HTMLSelectElement | null;
  if (!sel) return;
  const prevId = state.currentProfile ? state.currentProfile.id : '';
  const newId = sel.value;
  if (prevId === newId) return;

  if (hasUnsavedRouting) {
    const isRu = state.currentLang === 'ru';
    const ok = await pecConfirm({
      title: isRu ? 'Несохраненные изменения' : 'Unsaved Changes',
      message: isRu
        ? 'У вас есть несохраненные изменения в текущем профиле. Сбросить их?'
        : 'You have unsaved changes in the current profile. Discard them?',
      isDanger: true,
      confirmText: isRu ? 'Сбросить' : 'Discard'
    });
    if (!ok) {
      sel.value = prevId;
      return;
    }
    setUnsavedRouting(false);
  }

  const found = state.allProfiles.find((p: any) => p.id === newId);
  if (found) {
    state.currentProfile = found;
    (window as any).currentProfile = state.currentProfile;
    renderProfile(state.currentProfile);
  }
}

export async function populateProfileInstancesList(selectedIds: string[] = []) {
  const container = document.getElementById('profTargetInstancesList');
  if (!container) return;
  if (!state.lastLoadedInstances || !state.lastLoadedInstances.length) {
    try {
      const res = await adminFetch('/api/instances');
      if (res.ok) {
        const data = await res.json();
        state.lastLoadedInstances = data.instances || [];
      }
    } catch (_) {}
  }
  const instances = state.lastLoadedInstances || [];
  const set = new Set(selectedIds || []);
  const isRu = state.currentLang === 'ru';
  if (instances.length === 0) {
    container.innerHTML = '<span style="color: var(--text-muted); font-size: 12px;">' + (isRu ? 'Нет подключенных устройств' : 'No instances connected yet') + '</span>';
    return;
  }
  container.innerHTML = instances.map((inst: any) => {
    const id = esc(inst.instanceId);
    const name = esc(inst.username || inst.ip || inst.instanceId);
    const checked = set.has(inst.instanceId) ? ' checked' : '';
    return '<label style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 12px; cursor: pointer;">' +
      '<input type="checkbox" class="prof-instance-checkbox" value="' + id + '"' + checked + ' style="margin: 0; width: 14px; height: 14px;"> ' +
      '<span><code>' + id + '</code> (' + name + ')</span>' +
      '</label>';
  }).join('');
}

export function renderProfile(p: any) {
  if (!p) return;
  const nameEl = document.getElementById('profName') as HTMLInputElement | null;
  if (nameEl) nameEl.value = p.name || '';
  const defPolicyEl = document.getElementById('profDefaultPolicy') as HTMLSelectElement | null;
  if (defPolicyEl) defPolicyEl.value = p.defaultPolicy || 'direct';
  const targetScopeEl = document.getElementById('profTargetScope') as HTMLSelectElement | null;
  if (targetScopeEl) targetScopeEl.value = p.targetScope || 'all';
  const targetGroupEl = document.getElementById('profTargetGroup') as HTMLInputElement | null;
  if (targetGroupEl) targetGroupEl.value = p.targetGroup || '';
  const failClosedEl = document.getElementById('profFailClosed') as HTMLInputElement | null;
  if (failClosedEl) failClosedEl.checked = Boolean(p.failClosed);
  const descEl = document.getElementById('profDesc');
  if (descEl) descEl.textContent = p.description || 'Configured routing rules.';

  const groupRow = document.getElementById('groupTargetRow');
  if (groupRow) groupRow.style.display = p.targetScope === 'group' ? 'block' : 'none';

  const instRow = document.getElementById('instancesTargetRow');
  if (instRow) {
    instRow.style.display = p.targetScope === 'instances' ? 'block' : 'none';
    if (p.targetScope === 'instances') {
      populateProfileInstancesList(p.targetInstanceIds || []);
    }
  }

  const pacPreviewBtn = document.getElementById('btnPacPreview') as HTMLAnchorElement | null;
  if (pacPreviewBtn) pacPreviewBtn.href = '/proxy.pac?profileId=' + p.id;
  setUnsavedRouting(false);
  initRoutingDirtyTracking();
  renderRules(p.rules || []);
  loadPresets();
}

export function renderRules(rules: any[]) {
  const tbody = document.getElementById('rulesTableBody');
  const isRu = state.currentLang === 'ru';
  if (!tbody) return;
  if (!rules || !rules.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">' + (isRu ? 'В этом профиле нет правил. Используйте кнопки выше для добавления пресетов или кастомных правил.' : 'No rules defined for this profile. Use buttons above to add presets or custom rules.') + '</td></tr>';
    return;
  }

  tbody.innerHTML = rules.map((r: any, idx: number) => {
    let badge = 'badge-action-proxy';
    if (r.action === 'direct') badge = 'badge-action-direct';
    else if (r.action === 'block') badge = 'badge-action-block';
    const actionLabel = isRu ? (r.action === 'proxy' ? 'ПРОКСИ' : (r.action === 'direct' ? 'НАПРЯМУЮ' : 'БЛОК')) : r.action.toUpperCase();

    return `<tr>
      <td>
        <input type="checkbox" class="toggle-rule-enabled" data-index="${idx}" ${r.enabled ? 'checked' : ''} style="margin: 0;" />
      </td>
      <td>
        <div style="display: flex; gap: 4px; align-items: center;">
          <button type="button" class="btn-reorder-up" data-index="${idx}" ${idx === 0 ? 'disabled' : ''} title="${isRu ? 'Выше' : 'Move Up'}">▲</button>
          <button type="button" class="btn-reorder-down" data-index="${idx}" ${idx === rules.length - 1 ? 'disabled' : ''} title="${isRu ? 'Ниже' : 'Move Down'}">▼</button>
        </div>
      </td>
      <td><strong>${esc(r.name)}</strong></td>
      <td><code>${esc(r.pattern)}</code></td>
      <td><span class="badge ${badge}">${esc(actionLabel)}</span></td>
      <td>
        <div style="display: flex; gap: 4px; align-items: center;">
          <button type="button" class="btn-secondary btn-edit-rule" data-index="${idx}" style="font-size: 11px; padding: 3px 8px;" title="${isRu ? 'Редактировать правило' : 'Edit rule'}">✏️ ${isRu ? 'Изменить' : 'Edit'}</button>
          <button type="button" class="btn-danger btn-remove-rule" data-index="${idx}" style="font-size: 11px; padding: 3px 8px;">${isRu ? 'Удалить' : 'Delete'}</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

export function moveRuleUp(index: number) {
  if (!state.currentProfile || !Array.isArray(state.currentProfile.rules)) return;
  if (index <= 0 || index >= state.currentProfile.rules.length) return;
  const temp = state.currentProfile.rules[index];
  state.currentProfile.rules[index] = state.currentProfile.rules[index - 1];
  state.currentProfile.rules[index - 1] = temp;
  setUnsavedRouting(true);
  renderRules(state.currentProfile.rules);
}

export function moveRuleDown(index: number) {
  if (!state.currentProfile || !Array.isArray(state.currentProfile.rules)) return;
  if (index < 0 || index >= state.currentProfile.rules.length - 1) return;
  const temp = state.currentProfile.rules[index];
  state.currentProfile.rules[index] = state.currentProfile.rules[index + 1];
  state.currentProfile.rules[index + 1] = temp;
  setUnsavedRouting(true);
  renderRules(state.currentProfile.rules);
}

export function toggleRuleEnabled(idx: number) {
  if (state.currentProfile && state.currentProfile.rules && state.currentProfile.rules[idx]) {
    state.currentProfile.rules[idx].enabled = !state.currentProfile.rules[idx].enabled;
    setUnsavedRouting(true);
    renderRules(state.currentProfile.rules);
  }
}

export function removeRule(idx: number) {
  if (state.currentProfile && state.currentProfile.rules && state.currentProfile.rules[idx]) {
    state.currentProfile.rules.splice(idx, 1);
    setUnsavedRouting(true);
    renderRules(state.currentProfile.rules);
    loadPresets();
  }
}

export function openEditRuleModal(idx: number) {
  if (!state.currentProfile || !Array.isArray(state.currentProfile.rules) || !state.currentProfile.rules[idx]) return;
  const rule = state.currentProfile.rules[idx];
  const idxEl = document.getElementById('editRuleIndex') as HTMLInputElement | null;
  const nameEl = document.getElementById('editRuleName') as HTMLInputElement | null;
  const patternEl = document.getElementById('editRulePattern') as HTMLInputElement | null;
  const actionEl = document.getElementById('editRuleAction') as HTMLSelectElement | null;
  const errEl = document.getElementById('editRuleError');

  if (idxEl) idxEl.value = String(idx);
  if (nameEl) nameEl.value = rule.name || '';
  if (patternEl) patternEl.value = rule.pattern || '';
  if (actionEl) actionEl.value = rule.action || 'proxy';
  if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }

  const modal = document.getElementById('modalEditRule');
  if (modal) modal.style.display = 'flex';
}

export function closeEditRuleModal() {
  const modal = document.getElementById('modalEditRule');
  if (modal) modal.style.display = 'none';
}

export function validatePatternToken(token: string): { valid: boolean; error?: string } {
  if (!token) return { valid: false, error: 'Пустой элемент шаблона' };
  if (token.includes('/')) {
    const parts = token.split('/');
    if (parts.length !== 2) return { valid: false, error: 'Неверный формат CIDR: ' + token };
    const ip = parts[0];
    const maskStr = parts[1];
    const mask = parseInt(maskStr, 10);
    if (isNaN(mask) || String(mask) !== maskStr) return { valid: false, error: 'Неверная маска CIDR: /' + maskStr };
    const octets = ip.split('.');
    if (octets.length === 4) {
      if (mask < 0 || mask > 32) return { valid: false, error: 'Маска IPv4 CIDR должна быть от 0 до 32' };
      for (const oct of octets) {
        if (!/^\d{1,3}$/.test(oct)) return { valid: false, error: 'Неверный октет IPv4: ' + oct };
        const n = Number(oct);
        if (n < 0 || n > 255) return { valid: false, error: 'Октет IPv4 должен быть от 0 до 255: ' + oct };
      }
      return { valid: true };
    }
    if (ip.includes(':')) {
      if (mask < 0 || mask > 128) return { valid: false, error: 'Маска IPv6 CIDR должна быть от 0 до 128' };
      if (!/^[0-9a-fA-F:]+$/.test(ip)) return { valid: false, error: 'Неверный адрес IPv6: ' + ip };
      return { valid: true };
    }
    return { valid: false, error: 'Неверный IP в CIDR: ' + token };
  }
  if (/[<>"'\\^`{}|\s]/.test(token)) {
    return { valid: false, error: 'Недопустимые символы в маске домена: ' + token };
  }
  return { valid: true };
}

export function saveEditedRule() {
  if (!state.currentProfile || !Array.isArray(state.currentProfile.rules)) return;
  const idxEl = document.getElementById('editRuleIndex') as HTMLInputElement | null;
  const nameEl = document.getElementById('editRuleName') as HTMLInputElement | null;
  const patternEl = document.getElementById('editRulePattern') as HTMLInputElement | null;
  const actionEl = document.getElementById('editRuleAction') as HTMLSelectElement | null;
  const errEl = document.getElementById('editRuleError');

  const idx = parseInt(idxEl ? idxEl.value : '-1', 10);
  if (isNaN(idx) || idx < 0 || idx >= state.currentProfile.rules.length) {
    if (errEl) { errEl.textContent = 'Invalid rule index'; errEl.style.display = 'block'; }
    return;
  }

  const name = nameEl ? nameEl.value.trim() : '';
  const pattern = patternEl ? patternEl.value.trim() : '';
  const action = actionEl ? actionEl.value : 'proxy';

  if (!pattern) {
    if (errEl) {
      errEl.textContent = state.currentLang === 'ru' ? 'Укажите шаблон правила' : 'Please specify a rule pattern';
      errEl.style.display = 'block';
    }
    return;
  }
  const tokens = pattern.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) {
    if (errEl) {
      errEl.textContent = state.currentLang === 'ru' ? 'Укажите шаблон правила' : 'Please specify a rule pattern';
      errEl.style.display = 'block';
    }
    return;
  }

  for (const tok of tokens) {
    const valRes = validatePatternToken(tok);
    if (!valRes.valid) {
      if (errEl) {
        errEl.textContent = (state.currentLang === 'ru' ? 'Ошибка валидации: ' : 'Validation error: ') + valRes.error;
        errEl.style.display = 'block';
      }
      return;
    }
  }

  const normalizedPattern = tokens.join(', ');

  const rule = state.currentProfile.rules[idx];
  rule.name = name || normalizedPattern;
  rule.pattern = normalizedPattern;
  rule.action = action;
  rule.targetType = tokens.some(t => t.includes('/')) ? 'cidr' : 'wildcard';

  closeEditRuleModal();
  setUnsavedRouting(true);
  renderRules(state.currentProfile.rules);
}

export function addPresetRule(presetId: string, presetName: string, action: string = 'proxy') {
  if (!state.currentProfile) return;
  if (!state.currentProfile.rules) state.currentProfile.rules = [];
  const isRu = state.currentLang === 'ru';

  const existingIdx = state.currentProfile.rules.findIndex((r: any) => r.targetType === 'preset' && r.pattern === presetId);
  if (existingIdx !== -1) {
    state.currentProfile.rules[existingIdx].action = action;
    state.currentProfile.rules[existingIdx].enabled = true;
    toast((isRu ? 'Пресет обновлен: ' : 'Preset updated: ') + presetName, 'info');
  } else {
    state.currentProfile.rules.push({
      id: 'r_' + Math.random().toString(36).substring(2, 8),
      name: presetName,
      targetType: 'preset',
      pattern: presetId,
      action: action,
      enabled: true
    });
    toast((isRu ? 'Пресет добавлен: ' : 'Preset added: ') + presetName, 'success');
  }
  setUnsavedRouting(true);
  renderRules(state.currentProfile.rules);
  loadPresets();
}

export function addCustomRule() {
  if (!state.currentProfile) return;
  const nameEl = document.getElementById('newRuleName') as HTMLInputElement | null;
  const patternEl = document.getElementById('newRulePattern') as HTMLInputElement | null;
  const actionEl = document.getElementById('newRuleAction') as HTMLSelectElement | null;

  const name = nameEl ? nameEl.value.trim() : '';
  const pattern = patternEl ? patternEl.value.trim() : '';
  const action = actionEl ? actionEl.value : 'proxy';

  if (!pattern) {
    toast(state.currentLang === 'ru' ? 'Укажите шаблон правила' : 'Please specify a rule pattern', 'error');
    return;
  }
  const tokens = pattern.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) {
    toast(state.currentLang === 'ru' ? 'Укажите шаблон правила' : 'Please specify a rule pattern', 'error');
    return;
  }

  for (const tok of tokens) {
    const valRes = validatePatternToken(tok);
    if (!valRes.valid) {
      toast((state.currentLang === 'ru' ? 'Ошибка шаблона: ' : 'Pattern error: ') + valRes.error, 'error');
      return;
    }
  }

  const normalizedPattern = tokens.join(', ');

  state.currentProfile.rules.push({
    id: 'r_' + Math.random().toString(36).substring(2, 8),
    name: name || normalizedPattern,
    targetType: tokens.some(t => t.includes('/')) ? 'cidr' : 'wildcard',
    pattern: normalizedPattern,
    action: action,
    enabled: true
  });

  if (nameEl) nameEl.value = '';
  if (patternEl) patternEl.value = '';
  setUnsavedRouting(true);
  renderRules(state.currentProfile.rules);
}

export async function saveCurrentProfile() {
  if (!state.currentProfile) return;
  const btn = document.querySelector('button[onclick="saveCurrentProfile()"]') as HTMLButtonElement | null;
  let origHtml = '';
  if (btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="loading-spinner"></span> ' + (btn.textContent || '').trim();
  }

  state.currentProfile.name = (document.getElementById('profName') as HTMLInputElement).value.trim();
  state.currentProfile.defaultPolicy = (document.getElementById('profDefaultPolicy') as HTMLSelectElement).value;
  state.currentProfile.targetScope = (document.getElementById('profTargetScope') as HTMLSelectElement).value;
  state.currentProfile.targetGroup = (document.getElementById('profTargetGroup') as HTMLInputElement).value.trim();
  state.currentProfile.failClosed = (document.getElementById('profFailClosed') as HTMLInputElement).checked;

  if (state.currentProfile.targetScope === 'instances') {
    const checkedBoxes = document.querySelectorAll('#profTargetInstancesList .prof-instance-checkbox:checked');
    state.currentProfile.targetInstanceIds = Array.from(checkedBoxes).map((cb: any) => cb.value);
  } else {
    state.currentProfile.targetInstanceIds = [];
  }

  try {
    const res = await adminFetch('/api/routing/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.currentProfile)
    });
    if (res.ok) {
      toast(state.currentLang === 'ru' ? 'Профиль маршрутизации сохранен! Применен к соответствующим устройствам.' : 'Routing profile saved! Deployed to matching devices.', 'success');
      setUnsavedRouting(false);
      loadProfiles();
    } else {
      if (res.status === 401) return;
      const data = await res.json().catch(() => ({}));
      toast(extractError(res, data, state.currentLang === 'ru' ? 'Ошибка сохранения профиля' : 'Failed to save profile'), 'error');
    }
  } catch (e) {
    toast('Error saving profile: ' + e, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      if (origHtml) btn.innerHTML = origHtml;
    }
  }
}

// ============================================================================
// GEO-PRESET-UX-2: Preset Constructor sub-page (full-width detail view inside
// the Routing tab). Replaces the geobase-inspector / preset-edit / import
// modals. All buttons are wired through the DELEGATED document-level click
// listener at the bottom of this module (telemetry.ts:771 pattern) — direct
// onclick attributes are forbidden for this UI (DIAG-GEO-UX-1 click-path).
// ============================================================================

const BUILDER_RENDER_LIMIT = 500;

let builderState: any = null;
let builderRenderedCount = BUILDER_RENDER_LIMIT;
const builderSelected = new Set<string>();

// GEO-BUILDER-UX-3: inline layer editors + add-source panels.
// Only one editor / one add-source panel is open at a time.
let builderLayerEditor: { idx: number; kind: "file" | "url" | "geo" | "manual" } | null = null;
let builderOpenSrcPanel: string | null = null; // geo | file | url | manual | json
let builderAvailableTags: Array<{ tag: string; count: number }> = [];
const builderTagSelection = new Set<string>();
let builderTagSearch = "";

// ============================================================================
// GEO-PRESET-UX-2 CARD-MENU: per-card «⋮» dropdown state.
// POPOVER-CLOSE discipline (observations @ 2026-11-17, 4th loss of the
// family): BOTH the outside-click close and the Escape close are ported as
// document-level listeners in this module scope, and the behavioral tests in
// test/presetCardMenu.test.ts cover open/outside/escape/switch paths.
// ============================================================================

function setPresetCardMenu(card: Element | null | undefined, open: boolean) {
  if (!card) return;
  const menu = card.querySelector('.preset-card-menu') as HTMLElement | null;
  const btn = card.querySelector('.btn-preset-menu') as HTMLElement | null;
  if (menu) menu.style.display = open ? 'flex' : 'none';
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/** Only one preset menu is open at a time; closes every rendered menu. */
function closePresetMenus() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('.preset-card').forEach((c) => {
    setPresetCardMenu(c, false);
  });
}

function togglePresetCardMenu(menuBtn: Element) {
  const card = (menuBtn as HTMLElement).closest('.preset-card');
  const menu = card ? (card.querySelector('.preset-card-menu') as HTMLElement | null) : null;
  const wasOpen = !!menu && menu.style.display === 'flex';
  closePresetMenus();
  if (!wasOpen) setPresetCardMenu(card, true);
}

function builderIsRu(): boolean { return state.currentLang === 'ru'; }

function findLoadedPreset(id: string): any | undefined {
  return (lastLoadedPresets || []).find((p: any) => p.id === id);
}

function showBuilderLayerStatus(msg: string) {
  const el = document.getElementById('builderLayerStatus');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function clearBuilderLayerStatus() {
  const el = document.getElementById('builderLayerStatus');
  if (el) { el.textContent = ''; el.style.display = 'none'; }
}

function showPresetBuilderPage() {
  const page = document.getElementById('presetBuilderPage');
  const main = document.getElementById('branchExtView');
  const switcher = document.getElementById('routingBranchSwitcher');
  if (page) page.style.display = 'block';
  if (main) main.style.display = 'none';
  if (switcher) switcher.style.display = 'none';
}

export function closePresetBuilder() {
  builderState = null;
  builderRenderedCount = BUILDER_RENDER_LIMIT;
  builderSelected.clear();
  builderLayerEditor = null;
  builderOpenSrcPanel = null;
  builderAvailableTags = [];
  builderTagSelection.clear();
  builderTagSearch = '';
  const page = document.getElementById('presetBuilderPage');
  const main = document.getElementById('branchExtView');
  const switcher = document.getElementById('routingBranchSwitcher');
  if (page) page.style.display = 'none';
  if (main) main.style.display = '';
  if (switcher) switcher.style.display = '';
}

/** Client-side union of all layer entries (dedup, layer order). */
export function builderEntriesUnion(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const layer of (builderState && builderState.sources) || []) {
    for (const e of builderLayerEntries(layer)) {
      const v = String(e || '').trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Entries of a single layer; geo-tag layers resolve against loaded builtin presets. */
function builderLayerEntries(layer: any): string[] {
  if (!layer) return [];
  if (Array.isArray(layer.entries)) return layer.entries;
  if (layer.kind === 'geo-tag' && layer.ref) {
    const geo = findLoadedPreset(layer.ref);
    if (geo) return geo.entries || geo.domains || [];
  }
  return [];
}

function builderLayerLabel(layer: any, isRu: boolean): string {
  if (!layer) return '';
  switch (layer.kind) {
    case 'geo-tag': {
      const geo = findLoadedPreset(layer.ref);
      return geo ? (geo.name || layer.ref) : (layer.ref || 'geo');
    }
    case 'url':
      return layer.url || 'url';
    case 'file':
      return (layer.name || 'file') + (layer.tag ? ` [${layer.tag}]` : '');
    case 'manual':
      return isRu ? 'Ручной список' : 'Manual list';
    default:
      return String(layer.kind || '');
  }
}

function builderLayerIcon(kind: string): string {
  switch (kind) {
    case 'geo-tag': return '🌍';
    case 'url': return '🔗';
    case 'file': return '📄';
    case 'manual': return '✍️';
    default: return '📄';
  }
}

/** GEO-BUILDER-UX-3: display name of the layer SOURCE (not the tags). */
function builderLayerSourceName(layer: any, isRu: boolean): string {
  switch (layer.kind) {
    case 'geo-tag': {
      const geo = findLoadedPreset(layer.ref);
      return geo ? (geo.name || layer.ref) : (layer.ref || 'geo');
    }
    case 'url': {
      try {
        return new URL(layer.url).hostname || layer.url;
      } catch {
        return layer.url || 'url';
      }
    }
    case 'file':
      return layer.fileName || layer.name || 'file';
    case 'manual':
      return isRu ? 'Ручной список' : 'Manual list';
    default:
      return String(layer.kind || '');
  }
}

/** GEO-BUILDER-UX-3: layer tags (canonical tags[], legacy single tag fallback). */
function builderLayerTags(layer: any): string[] {
  if (layer.kind === 'file') {
    if (Array.isArray(layer.tags) && layer.tags.length) return layer.tags;
    return layer.tag ? [layer.tag] : [];
  }
  if (layer.kind === 'url') {
    return layer.tag ? [layer.tag] : [];
  }
  return [];
}

/** GEO-BUILDER-UX-3: short unique origin badge label (see builderOriginMap). */
function builderLayerOriginShort(layer: any, isRu: boolean): string {
  switch (layer.kind) {
    case 'geo-tag': {
      const tail = String(layer.ref || '').split(':').pop() || layer.ref || 'geo';
      const short = tail.replace(/^(geosite|geoip)_/, '');
      return (isRu ? 'гео:' : 'geo:') + short;
    }
    case 'url': {
      let host = layer.url || 'url';
      try {
        host = new URL(layer.url).hostname;
      } catch {
        /* keep raw */
      }
      const tags = builderLayerTags(layer);
      return 'url:' + (tags.length ? tags[0].toLowerCase() : host);
    }
    case 'file': {
      const name = layer.fileName || layer.name || 'file';
      const tags = builderLayerTags(layer);
      return name + (tags.length ? ':' + tags[0].toLowerCase() : '');
    }
    case 'manual':
      return isRu ? 'вручную' : 'manual';
    default:
      return String(layer.kind || '');
  }
}

/** GEO-BUILDER-UX-3: full origin path for badge title attributes. */
function builderLayerOriginTitle(layer: any, isRu: boolean): string {
  switch (layer.kind) {
    case 'geo-tag':
      return String(layer.ref || 'geo');
    case 'url':
      return String(layer.url || 'url');
    case 'file': {
      const base = layer.fileId
        ? `data/geofiles/${layer.fileId}${layer.fileName ? ` (${layer.fileName})` : ''}`
        : `${layer.fileName || layer.name || 'file'} — ${isRu ? 'снапшот' : 'snapshot'}`;
      const tags = builderLayerTags(layer);
      return tags.length ? `${base} — tags: ${tags.join(', ')}` : base;
    }
    case 'manual':
      return isRu ? 'ручной слой' : 'manual layer';
    default:
      return String(layer.kind || '');
  }
}

/** Live/snapshot status label of a layer. */
function builderLayerStatus(layer: any, isRu: boolean): string {
  switch (layer.kind) {
    case 'file':
      return layer.fileId ? (isRu ? 'живой (файл)' : 'live (file)') : (isRu ? 'снапшот' : 'snapshot');
    case 'url':
      return isRu ? 'живой (url)' : 'live (url)';
    case 'geo-tag':
      return isRu ? 'геосписок' : 'geo list';
    case 'manual':
      return isRu ? 'вручную' : 'manual';
    default:
      return '';
  }
}

function layerIsLive(layer: any): boolean {
  if (layer.kind === 'file') return !!layer.fileId;
  if (layer.kind === 'url' || layer.kind === 'geo-tag') return true;
  return false;
}

/** entry -> owning layer info (first layer that contributes the entry wins). */
function builderOriginMap(): Map<
  string,
  { layerIdx: number; label: string; title: string; editable: boolean }
> {
  const map = new Map<string, { layerIdx: number; label: string; title: string; editable: boolean }>();
  const isRu = builderIsRu();
  const sources = (builderState && builderState.sources) || [];
  // GEO-BUILDER-UX-3: unique short origin label per layer (duplicates get a
  // numbered suffix), full path kept for the title attribute.
  const shortCounts = new Map<string, number>();
  const shortLabels = sources.map((layer: any) => {
    const base = builderLayerOriginShort(layer, isRu);
    const n = (shortCounts.get(base) || 0) + 1;
    shortCounts.set(base, n);
    return n > 1 ? `${base}·${n}` : base;
  });
  sources.forEach((layer: any, idx: number) => {
    // editable rows: manual + SNAPSHOT file layers; live layers are managed at the source
    const editable = layer.kind === 'manual' || (layer.kind === 'file' && !layer.fileId);
    for (const e of builderLayerEntries(layer)) {
      const v = String(e || '').trim();
      if (!v || map.has(v)) continue;
      map.set(v, {
        layerIdx: idx,
        label: shortLabels[idx],
        title: builderLayerOriginTitle(layer, isRu),
        editable,
      });
    }
  });
  return map;
}

export async function openPresetBuilder(presetId: string, opts: { readOnly?: boolean } = {}) {
  const isRu = builderIsRu();
  try {
    const res = await adminFetch('/api/routing/presets/' + encodeURIComponent(presetId));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const preset = await res.json();
    builderState = {
      id: preset.id,
      builtin: preset.source === 'builtin' || !!opts.readOnly,
      isNew: false,
      name: preset.name || '',
      description: preset.description || '',
      category: preset.category || 'custom',
      type: preset.type === 'cidr' ? 'cidr' : 'domain',
      // Deep-copy the layer list: builderState is a working copy that the
      // constructor mutates freely (add/remove layers and entries) and must
      // never alias the response object graph.
      sources: Array.isArray(preset.sources) && preset.sources.length
        ? JSON.parse(JSON.stringify(preset.sources))
        : [{ kind: 'manual', entries: preset.entries || preset.domains || [] }],
      search: '',
    };
    builderRenderedCount = BUILDER_RENDER_LIMIT;
    builderSelected.clear();
    builderLayerEditor = null;
    builderOpenSrcPanel = null;
    builderAvailableTags = [];
    builderTagSelection.clear();
    builderTagSearch = '';
    showPresetBuilderPage();
    renderPresetBuilder();
  } catch (e: any) {
    toast(e?.message || (isRu ? 'Не удалось открыть пресет' : 'Failed to open preset'), 'error');
  }
}

export function openPresetBuilderCreate() {
  const isRu = builderIsRu();
  builderState = {
    id: 'preset:' + Math.random().toString(16).slice(2, 10),
    builtin: false,
    isNew: true,
    name: isRu ? 'Новый пресет' : 'New Preset',
    description: '',
    category: 'custom',
    type: 'domain',
    sources: [],
    search: '',
  };
  builderRenderedCount = BUILDER_RENDER_LIMIT;
  builderSelected.clear();
  builderLayerEditor = null;
  builderOpenSrcPanel = null;
  builderAvailableTags = [];
  builderTagSelection.clear();
  builderTagSearch = '';
  showPresetBuilderPage();
  renderPresetBuilder();
}

function populateBuilderGeoSelect() {
  const sel = document.getElementById('builderGeoSelect') as HTMLSelectElement | null;
  if (!sel) return;
  const isRu = builderIsRu();
  const candidates = (lastLoadedPresets || []).filter((p: any) =>
    p.source === 'builtin' && (p.type === 'cidr' ? 'cidr' : 'domain') === (builderState ? builderState.type : 'domain')
  );
  if (!candidates.length) {
    sel.innerHTML = `<option value="">${isRu ? 'Нет доступных геосписков' : 'No geo lists available'}</option>`;
    return;
  }
  sel.innerHTML = candidates.map((p: any) =>
    `<option value="${esc(p.id)}">${esc(p.name)}</option>`
  ).join('');
}

export function renderPresetBuilder() {
  const page = document.getElementById('presetBuilderPage');
  if (!page || !builderState) return;
  const isRu = builderIsRu();
  const s = builderState;

  const nameEl = document.getElementById('builderNameInput') as HTMLInputElement | null;
  if (nameEl) {
    nameEl.value = s.name || '';
    nameEl.readOnly = s.builtin;
  }
  const descEl = document.getElementById('builderDescInput') as HTMLInputElement | null;
  if (descEl) {
    descEl.value = s.description || '';
    descEl.readOnly = s.builtin;
    descEl.placeholder = isRu ? 'Описание пресета' : 'Preset description';
  }
  const typeBadge = document.getElementById('builderTypeBadge');
  if (typeBadge) typeBadge.textContent = (s.type || 'domain').toUpperCase();
  const builtinBadge = document.getElementById('builderBuiltinBadge');
  if (builtinBadge) builtinBadge.style.display = s.builtin ? 'inline-flex' : 'none';
  const idEl = document.getElementById('builderPresetId');
  if (idEl) idEl.textContent = s.id || '';

  const exportLabel = document.getElementById('builderExportLabel');
  if (exportLabel) exportLabel.textContent = isRu ? 'Экспорт JSON' : 'Export JSON';
  const dupBtn = document.getElementById('builderDuplicateBtn');
  if (dupBtn) dupBtn.style.display = s.builtin ? 'inline-flex' : 'none';
  const dupLabel = document.getElementById('builderDuplicateLabel');
  if (dupLabel) dupLabel.textContent = isRu ? 'Дублировать в свой' : 'Duplicate to custom';

  const addBlock = document.getElementById('builderAddLayerBlock');
  if (addBlock) addBlock.style.display = s.builtin ? 'none' : 'block';
  const footer = document.getElementById('builderFooter');
  if (footer) footer.style.display = s.builtin ? 'none' : 'flex';
  const saveBtn = document.getElementById('btnBuilderSave');
  if (saveBtn) saveBtn.style.display = s.builtin ? 'none' : 'inline-flex';
  const saveLabel = document.getElementById('builderSaveLabel');
  if (saveLabel) saveLabel.textContent = isRu ? 'Сохранить' : 'Save';
  const cancelBtn = document.getElementById('btnBuilderCancel');
  if (cancelBtn) cancelBtn.textContent = isRu ? (s.builtin ? 'Закрыть' : 'Отмена') : (s.builtin ? 'Close' : 'Cancel');

  // GEO-BUILDER-UX-3: sectioned left column (layers count + add-source rows)
  const layersTitle = document.getElementById('builderLayersTitle');
  if (layersTitle) layersTitle.textContent = (isRu ? 'СЛОИ ПРЕСЕТА (' : 'PRESET LAYERS (') + ((s.sources || []).length) + ')';
  const entriesTitle = document.getElementById('builderEntriesTitle');
  if (entriesTitle) entriesTitle.textContent = isRu ? 'Состав' : 'Composition';
  const thEntry = document.getElementById('builderThEntry');
  if (thEntry) thEntry.textContent = isRu ? 'Запись' : 'Entry';
  const thOrigin = document.getElementById('builderThOrigin');
  if (thOrigin) thOrigin.textContent = isRu ? 'Слой' : 'Layer';
  const addSourceTitle = document.getElementById('builderAddSourceTitle');
  if (addSourceTitle) addSourceTitle.textContent = isRu ? 'Добавить источник' : 'Add source';
  const srcLabels: Record<string, [string, string]> = {
    geo: ['🌐 Из геосписка', '🌐 From geo list'],
    file: ['📄 Из файла (.dat / .txt)', '📄 From file (.dat / .txt)'],
    url: ['🔗 Из URL', '🔗 From URL'],
    manual: ['✏️ Вручную', '✏️ Manually'],
    json: ['📥 Импорт JSON', '📥 Import JSON'],
  };
  for (const key of Object.keys(srcLabels)) {
    const btn = document.getElementById('builderSrc' + key.charAt(0).toUpperCase() + key.slice(1) + 'Label');
    if (btn) btn.textContent = isRu ? srcLabels[key][0] : srcLabels[key][1];
  }
  const addConfirmLabel = isRu ? 'Добавить слой' : 'Add layer';
  ['builderAddGeoLabel', 'builderAddFileLabel', 'builderAddUrlLabel', 'builderAddManualLabel'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = addConfirmLabel;
  });
  const jsonHint = document.getElementById('builderImportJsonHint');
  if (jsonHint) jsonHint.textContent = isRu ? 'файл экспорта пресета (pec-preset JSON)' : 'preset export file (pec-preset JSON)';
  const fileTag = document.getElementById('builderFileTag') as HTMLInputElement | null;
  if (fileTag) fileTag.placeholder = isRu ? 'TAG (для .dat, напр. TELEGRAM)' : 'TAG (for .dat, e.g. TELEGRAM)';
  const urlTag = document.getElementById('builderUrlTag') as HTMLInputElement | null;
  if (urlTag) urlTag.placeholder = isRu ? 'TAG (для .dat, опционально)' : 'TAG (for .dat, optional)';
  const urlInput = document.getElementById('builderLayerUrl') as HTMLInputElement | null;
  if (urlInput) urlInput.placeholder = 'https://…/geosite.dat';
  const manualTa = document.getElementById('builderManualEntries') as HTMLTextAreaElement | null;
  if (manualTa) manualTa.placeholder = isRu ? 'По одному домену/CIDR на строку' : 'One domain/CIDR per line';
  // add-source panels: exactly one open at a time
  const panelIds: Record<string, string> = {
    geo: 'builderPanelGeo',
    file: 'builderPanelFile',
    url: 'builderPanelUrl',
    manual: 'builderPanelManual',
    json: 'builderPanelJson',
  };
  for (const key of Object.keys(panelIds)) {
    const panel = document.getElementById(panelIds[key]);
    if (panel) panel.style.display = builderOpenSrcPanel === key ? 'block' : 'none';
  }
  const selAllBtn = document.getElementById('btnBuilderSelectAll');
  if (selAllBtn) selAllBtn.textContent = isRu ? 'Выбрать все' : 'Select all';
  const delSelLabel = document.getElementById('builderDeleteSelectedLabel');
  if (delSelLabel) delSelLabel.textContent = isRu ? 'Удалить выбранные' : 'Delete selected';
  const domainHint = document.getElementById('builderAddDomainHint');
  if (domainHint) domainHint.textContent = isRu ? '→ в ручной слой' : '→ into a manual layer';
  const addDomain = document.getElementById('builderAddDomain') as HTMLInputElement | null;
  if (addDomain) addDomain.placeholder = isRu ? 'Домен + (Enter)' : 'Domain + (Enter)';
  const search = document.getElementById('builderEntrySearch') as HTMLInputElement | null;
  if (search) {
    search.placeholder = (isRu ? 'Поиск по всем ' : 'Search all ') + builderEntriesUnion().length + (isRu ? ' записям' : ' entries');
  }
  const showMore = document.getElementById('btnBuilderShowMore');
  if (showMore) showMore.textContent = isRu ? 'Показать ещё' : 'Show more';

  populateBuilderDomainTarget();
  populateBuilderGeoSelect();
  renderBuilderLayers();
  renderBuilderEntries();
}

/** GEO-BUILDER-UX-3: target manual layer selector for the «Домен +» footer input. */
function populateBuilderDomainTarget() {
  const sel = document.getElementById('builderDomainTarget') as HTMLSelectElement | null;
  if (!sel || !builderState) return;
  const isRu = builderIsRu();
  const manualIdxs: number[] = [];
  (builderState.sources || []).forEach((l: any, i: number) => {
    if (l.kind === 'manual') manualIdxs.push(i);
  });
  const prev = sel.value;
  let html = manualIdxs
    .map((i, k) => `<option value="${i}">${esc(isRu ? `Ручной слой #${k + 1}` : `Manual layer #${k + 1}`)}</option>`)
    .join('');
  html += `<option value="new">${esc(isRu ? '+ новый ручной слой' : '+ new manual layer')}</option>`;
  sel.innerHTML = html;
  const values = Array.from(sel.options).map((o) => o.value);
  sel.value = prev && values.indexOf(prev) !== -1 ? prev : String(manualIdxs.length ? manualIdxs[0] : 'new');
}

/**
 * GEO-BUILDER-UX-3: structured layer card — SOURCE name header, tag chips
 * with an inline tag editor, honest per-layer count + live/snapshot status.
 * The inline editor (builderLayerEditor) renders directly under its card.
 */
export function renderBuilderLayers() {
  const list = document.getElementById('builderLayersList');
  if (!list || !builderState) return;
  const isRu = builderIsRu();
  const sources = builderState.sources || [];
  if (!sources.length) {
    list.innerHTML = `<div style="font-size: 12px; color: var(--text-muted);">${isRu ? 'Слоёв пока нет — добавьте первый источник ниже.' : 'No layers yet — add a source below.'}</div>`;
    return;
  }
  list.innerHTML = sources.map((layer: any, idx: number) => {
    const count = builderLayerEntries(layer).length;
    const editable = !builderState.builtin;
    const live = layerIsLive(layer);
    const refreshable = editable && live && (layer.kind === 'url' || (layer.kind === 'file' && layer.fileId));
    const tags = builderLayerTags(layer);
    const isSnapshotFile = layer.kind === 'file' && !layer.fileId;

    const tagsRow = tags.length
      ? `<div style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-top: 3px;">
          <span style="font-size: 11px; color: var(--text-muted);">${isRu ? 'Теги:' : 'Tags:'}</span>
          ${tags.map((t) => `<span class="badge builder-layer-tag" style="font-size: 10px; background: rgba(255,255,255,0.06);">${esc(t)}</span>`).join('')}
        </div>`
      : '';

    const statusColor = live ? 'var(--success, #10b981)' : 'var(--warning, #f59e0b)';
    const statusRow = `<div style="display: flex; align-items: center; gap: 8px; margin-top: 3px; font-size: 11px; color: var(--text-muted);">
        <span class="builder-layer-count">${count} ${isRu ? 'записей' : 'entries'}</span>
        <span>·</span>
        <span class="builder-layer-status" style="color: ${statusColor};">${esc(builderLayerStatus(layer, isRu))}</span>
        ${isSnapshotFile && editable ? `<button type="button" class="btn-secondary btn-layer-rebind" data-index="${idx}" style="font-size: 10px; padding: 1px 6px; margin-left: auto;">${isRu ? 'Привязать файл заново' : 'Re-attach file'}</button>` : ''}
      </div>`;

    let html = `<div class="builder-layer-row" data-index="${idx}" style="padding: 7px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-card-subtle, rgba(255,255,255,0.02)); font-size: 12px;">
      <div style="display: flex; align-items: center; gap: 6px;">
        <span title="${esc(layer.kind)}">${builderLayerIcon(layer.kind)}</span>
        <span class="builder-layer-name" style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${esc(builderLayerOriginTitle(layer, isRu))}">${esc(builderLayerSourceName(layer, isRu))}</span>
        ${refreshable ? `<button type="button" class="btn-icon btn-layer-refresh" data-index="${idx}" title="${isRu ? 'Перечитать источник' : 'Re-read source'}" style="font-size: 11px; padding: 1px 4px;">↻</button>` : ''}
        ${editable ? `<button type="button" class="btn-icon btn-layer-edit" data-index="${idx}" title="${isRu ? 'Редактировать слой' : 'Edit layer'}" style="font-size: 11px; padding: 1px 4px;">✎</button>` : ''}
        ${editable ? `<button type="button" class="btn-icon btn-layer-remove" data-index="${idx}" title="${isRu ? 'Удалить слой' : 'Remove layer'}" style="font-size: 11px; padding: 1px 4px;">✕</button>` : ''}
      </div>
      ${tagsRow}
      ${statusRow}
    </div>`;

    if (builderLayerEditor && builderLayerEditor.idx === idx) {
      html += renderLayerEditor(layer, idx, isRu);
    }
    return html;
  }).join('');
}

/** Inline editor panel for one layer (rendered under the layer card). */
function rerenderTagChecklist() {
  const editor = document.querySelector('.builder-layer-editor');
  const listEl = editor ? editor.querySelector('.builder-tag-list') : null;
  if (!listEl) return;
  const isRu = builderIsRu();
  const q = builderTagSearch.trim().toLowerCase();
  const visibleTags = builderAvailableTags.filter((t) => !q || t.tag.toLowerCase().includes(q));
  (listEl as HTMLElement).innerHTML = visibleTags.length
    ? visibleTags
        .map(
          (t) => `<label style="display: flex; align-items: center; gap: 6px; padding: 3px 4px; font-size: 12px; cursor: pointer;">
              <input type="checkbox" class="builder-tag-check" data-tag="${esc(t.tag)}" ${builderTagSelection.has(t.tag) ? 'checked' : ''} style="margin: 0; width: 13px; height: 13px;" />
              <span style="flex: 1;">${esc(t.tag)}</span>
              <span style="color: var(--text-muted); font-size: 11px;">${t.count}</span>
            </label>`
        )
        .join('')
    : `<div style="color: var(--text-muted); font-size: 12px; padding: 4px;">${isRu ? 'Теги не найдены' : 'No tags found'}</div>`;
  updateTagEditorCounters();
}

function updateTagEditorCounters() {
  const editor = document.querySelector('.builder-layer-editor');
  const counter = editor ? editor.querySelector('.builder-tag-summary') : null;
  if (!counter) return;
  const isRu = builderIsRu();
  const totalTagged = builderAvailableTags.reduce((sum, t) => sum + t.count, 0);
  (counter as HTMLElement).textContent = isRu
    ? `Выбрано тегов: ${builderTagSelection.size} · записей в файле: ${totalTagged}`
    : `Tags selected: ${builderTagSelection.size} · entries in file: ${totalTagged}`;
}

/** Inline editor panel for one layer (rendered under the layer card). */
function renderLayerEditor(layer: any, idx: number, isRu: boolean): string {
  const panelStyle = 'padding: 8px; border: 1px solid var(--border); border-top: none; border-radius: 0 0 6px 6px; background: var(--bg-card-subtle, rgba(255,255,255,0.04)); font-size: 12px;';
  const footerBtns = `<div style="display: flex; gap: 6px; margin-top: 8px;">
      <button type="button" class="btn btn-editor-save" data-index="${idx}" style="font-size: 12px;">💾 ${isRu ? 'Сохранить' : 'Save'}</button>
      <button type="button" class="btn-secondary btn-editor-cancel" data-index="${idx}" style="font-size: 12px;">${isRu ? 'Отмена' : 'Cancel'}</button>
    </div>`;

  if (builderLayerEditor!.kind === 'file') {
    if (!layer.fileId) {
      // snapshot layer: the only meaningful edit is re-attaching a file
      return `<div class="builder-layer-editor" data-index="${idx}" style="${panelStyle}">
        <div style="margin-bottom: 6px; color: var(--text-muted);">${isRu ? 'Снапшот-слой: привяжите файл, чтобы сделать слой живым.' : 'Snapshot layer: attach a file to make this layer live.'}</div>
        <input type="file" class="builder-editor-file" data-index="${idx}" accept=".dat,.txt,.list" style="width: 100%; box-sizing: border-box; font-size: 12px; margin-bottom: 6px;" />
        ${footerBtns}
      </div>`;
    }
    const q = builderTagSearch.trim().toLowerCase();
    const visibleTags = builderAvailableTags.filter((t) => !q || t.tag.toLowerCase().includes(q));
    const totalTagged = builderAvailableTags.reduce((sum, t) => sum + t.count, 0);
    return `<div class="builder-layer-editor" data-index="${idx}" style="${panelStyle}">
      <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
        <span style="flex: 1; color: var(--text-muted);">${isRu ? 'Теги файла (мультивыбор):' : 'File tags (multi-select):'}</span>
        <input type="file" class="builder-editor-file" data-index="${idx}" accept=".dat,.txt,.list" title="${isRu ? 'Сменить файл' : 'Replace file'}" style="max-width: 170px; font-size: 10px;" />
      </div>
      <input type="text" id="builderTagSearch" placeholder="${isRu ? 'Поиск по тегам…' : 'Search tags…'}" value="${esc(builderTagSearch)}" style="margin-bottom: 6px; width: 100%; box-sizing: border-box; font-size: 12px;" />
      <div class="builder-tag-list" style="max-height: 180px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; padding: 4px;">
        ${visibleTags.length
          ? visibleTags.map((t) => `<label style="display: flex; align-items: center; gap: 6px; padding: 3px 4px; font-size: 12px; cursor: pointer;">
              <input type="checkbox" class="builder-tag-check" data-tag="${esc(t.tag)}" ${builderTagSelection.has(t.tag) ? 'checked' : ''} style="margin: 0; width: 13px; height: 13px;" />
              <span style="flex: 1;">${esc(t.tag)}</span>
              <span style="color: var(--text-muted); font-size: 11px;">${t.count}</span>
            </label>`).join('')
          : `<div style="color: var(--text-muted); font-size: 12px; padding: 4px;">${isRu ? 'Теги не найдены' : 'No tags found'}</div>`}
      </div>
      <div class="builder-tag-summary" style="margin-top: 4px; font-size: 11px; color: var(--text-muted);">${isRu ? `Выбрано тегов: ${builderTagSelection.size} · записей в файле: ${totalTagged}` : `Tags selected: ${builderTagSelection.size} · entries in file: ${totalTagged}`}</div>
      ${footerBtns}
    </div>`;
  }

  if (builderLayerEditor!.kind === 'url') {
    return `<div class="builder-layer-editor" data-index="${idx}" style="${panelStyle}">
      <label style="display: block; font-size: 11px; color: var(--text-muted); margin-bottom: 2px;">URL</label>
      <input type="text" id="builderEditorUrl" value="${esc(layer.url || '')}" style="margin-bottom: 6px; width: 100%; box-sizing: border-box; font-size: 12px;" />
      <label style="display: block; font-size: 11px; color: var(--text-muted); margin-bottom: 2px;">${isRu ? 'TAG (для .dat)' : 'TAG (for .dat)'}</label>
      <input type="text" id="builderEditorTag" value="${esc(layer.tag || '')}" style="margin-bottom: 2px; width: 100%; box-sizing: border-box; font-size: 12px;" />
      ${footerBtns}
    </div>`;
  }

  if (builderLayerEditor!.kind === 'geo') {
    const candidates = (lastLoadedPresets || []).filter((p: any) =>
      p.source === 'builtin' && (p.type === 'cidr' ? 'cidr' : 'domain') === (builderState ? builderState.type : 'domain')
    );
    return `<div class="builder-layer-editor" data-index="${idx}" style="${panelStyle}">
      <select id="builderEditorRef" style="margin-bottom: 2px; width: 100%; box-sizing: border-box; font-size: 12px;">
        ${candidates.map((p: any) => `<option value="${esc(p.id)}" ${p.id === layer.ref ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      ${footerBtns}
    </div>`;
  }

  // manual
  return `<div class="builder-layer-editor" data-index="${idx}" style="${panelStyle}">
    <textarea id="builderEditorManual" rows="6" style="width: 100%; box-sizing: border-box; font-family: var(--mono, monospace); font-size: 12px; margin-bottom: 2px;">${esc((layer.entries || []).join('\n'))}</textarea>
    ${footerBtns}
  </div>`;
}

function builderFilteredEntries(): string[] {
  const q = ((builderState && builderState.search) || '').trim().toLowerCase();
  const entries = builderEntriesUnion();
  if (!q) return entries;
  return entries.filter((e) => e.toLowerCase().includes(q));
}

export function renderBuilderEntries() {
  const tbody = document.getElementById('builderEntriesBody');
  if (!tbody || !builderState) return;
  const isRu = builderIsRu();
  const filtered = builderFilteredEntries();
  const origins = builderOriginMap();
  // GEO-BUILDER-UX-3: honest counters — per-layer sum vs deduped union.
  const union = builderEntriesUnion();
  const perLayerSum = ((builderState && builderState.sources) || []).reduce(
    (sum: number, layer: any) => sum + builderLayerEntries(layer).length,
    0
  );
  const duplicatesHidden = Math.max(0, perLayerSum - union.length);
  const totalEl = document.getElementById('builderEntriesTotal');
  if (totalEl) {
    let line = (isRu ? 'Всего по слоям: ' : 'Across layers: ') + perLayerSum +
      ' · ' + (isRu ? 'Уникальных: ' : 'Unique: ') + union.length;
    if (duplicatesHidden > 0) {
      line += ' · ' + (isRu ? 'дублей скрыто: ' : 'duplicates hidden: ') + duplicatesHidden;
    }
    if (filtered.length !== union.length) {
      line += ' · ' + (isRu ? 'найдено: ' : 'matched: ') + filtered.length;
    }
    totalEl.textContent = line;
  }

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">${isRu ? (builderEntriesUnion().length ? 'Нет совпадений' : 'Нет слоёв — добавьте слой слева') : (builderEntriesUnion().length ? 'No matches' : 'No layers — add one on the left')}</td></tr>`;
    const showMore = document.getElementById('btnBuilderShowMore') as HTMLButtonElement | null;
    if (showMore) showMore.style.display = 'none';
    updateBuilderCounters();
    return;
  }

  const visible = filtered.slice(0, builderRenderedCount);
  tbody.innerHTML = visible.map((entry) => {
    const origin = origins.get(entry);
    const editable = origin ? origin.editable : false;
    const checked = builderSelected.has(entry) ? 'checked' : '';
    const cellCheckbox = editable
      ? `<input type="checkbox" class="toggle-builder-entry" data-entry="${escapeHtml(entry)}" ${checked} style="margin: 0;" />`
      : '';
    const removeBtn = editable
      ? `<button type="button" class="btn-icon btn-entry-remove" data-entry="${escapeHtml(entry)}" title="${isRu ? 'Удалить запись' : 'Remove entry'}" style="font-size: 11px; padding: 1px 4px;">✕</button>`
      : `<span title="${isRu ? 'Живой слой: запись управляется в источнике' : 'Live layer: entries are managed at the source'}" style="color: var(--text-muted);">🔒</span>`;
    return `<tr class="builder-entry-row">
      <td style="width: 36px;">${cellCheckbox}</td>
      <td><code>${esc(entry)}</code></td>
      <td style="max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"><span class="badge builder-entry-origin" title="${esc(origin ? origin.title : '')}" style="font-size: 10px; background: rgba(255,255,255,0.06); cursor: help;">${esc(origin ? origin.label : '')}</span></td>
      <td style="width: 40px; text-align: right;">${removeBtn}</td>
    </tr>`;
  }).join('');

  const showMore = document.getElementById('btnBuilderShowMore') as HTMLButtonElement | null;
  if (showMore) {
    if (filtered.length > builderRenderedCount) {
      showMore.style.display = 'inline-flex';
      showMore.textContent = isRu
        ? `Показать ещё (${builderRenderedCount} из ${filtered.length})`
        : `Show more (${builderRenderedCount} of ${filtered.length})`;
    } else {
      showMore.style.display = 'none';
    }
  }

  updateBuilderCounters();
}

function updateBuilderCounters() {
  const isRu = builderIsRu();
  const selCount = document.getElementById('builderSelectedCount');
  if (selCount) selCount.textContent = (isRu ? 'Выбрано: ' : 'Selected: ') + builderSelected.size;
  const allBox = document.getElementById('builderSelectAllBox') as HTMLInputElement | null;
  if (allBox) {
    const origins = builderOriginMap();
    const visibleEditable = builderFilteredEntries().slice(0, builderRenderedCount).filter((e) => {
      const o = origins.get(e);
      return o && o.editable;
    });
    allBox.checked = visibleEditable.length > 0 && visibleEditable.every((e) => builderSelected.has(e));
  }
}

function toggleBuilderSelectAll(force?: boolean) {
  const origins = builderOriginMap();
  const editableEntries = builderFilteredEntries().filter((e) => {
    const o = origins.get(e);
    return o && o.editable;
  });
  const target = force !== undefined ? force : !editableEntries.every((e) => builderSelected.has(e)) || editableEntries.length === 0;
  if (target) {
    for (const e of editableEntries) builderSelected.add(e);
  } else {
    for (const e of editableEntries) builderSelected.delete(e);
  }
  renderBuilderEntries();
}

async function resolveBuilderLayer(rawSource: any): Promise<any | null> {
  const isRu = builderIsRu();
  clearBuilderLayerStatus();
  try {
    const res = await adminFetch('/api/routing/presets/resolve-layer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: rawSource, type: builderState ? builderState.type : 'domain' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'HTTP ' + res.status);
    }
    return data.source;
  } catch (e: any) {
    const msg = e?.message || 'resolve-layer failed';
    showBuilderLayerStatus(msg);
    toast(msg, 'error');
    return null;
  }
}

function fileToBase64(file: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        resolve(result.includes(',') ? result.split(',')[1] : result);
      } else {
        reject(new Error('Failed to read file'));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function addBuilderLayer(rawSource: any) {
  if (!builderState || builderState.builtin) return;
  const resolved = await resolveBuilderLayer(rawSource);
  if (!resolved) return;
  builderState.sources.push(resolved);
  builderRenderedCount = BUILDER_RENDER_LIMIT;
  renderPresetBuilder();
}

async function addGeoLayerFromSelect() {
  const sel = document.getElementById('builderGeoSelect') as HTMLSelectElement | null;
  const ref = sel ? sel.value : '';
  if (!ref) return;
  await addBuilderLayer({ kind: 'geo-tag', ref });
  builderOpenSrcPanel = null;
  renderPresetBuilder();
}

async function addUrlLayerFromInputs() {
  const urlEl = document.getElementById('builderLayerUrl') as HTMLInputElement | null;
  const tagEl = document.getElementById('builderUrlTag') as HTMLInputElement | null;
  const url = (urlEl ? urlEl.value : '').trim();
  if (!url) {
    toast(builderIsRu() ? 'Укажите URL слоя' : 'Layer URL is required', 'error');
    return;
  }
  const tag = (tagEl ? tagEl.value : '').trim();
  await addBuilderLayer({ kind: 'url', url, ...(tag ? { tag } : {}) });
  if (urlEl) urlEl.value = '';
  if (tagEl) tagEl.value = '';
  builderOpenSrcPanel = null;
  renderPresetBuilder();
}

async function addManualLayerFromTextarea() {
  const ta = document.getElementById('builderManualEntries') as HTMLTextAreaElement | null;
  const raw = ta ? ta.value : '';
  const entries = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!entries.length) {
    toast(builderIsRu() ? 'Список записей пуст' : 'Entries list is empty', 'error');
    return;
  }
  await addBuilderLayer({ kind: 'manual', entries });
  if (ta) ta.value = '';
  builderOpenSrcPanel = null;
  renderPresetBuilder();
}

async function addBuilderFileLayer(file: any) {
  if (!file) return;
  const isRu = builderIsRu();
  try {
    const base64 = await fileToBase64(file);
    const tagEl = document.getElementById('builderFileTag') as HTMLInputElement | null;
    const tag = (tagEl ? tagEl.value : '').trim();
    // .dat needs a tag; .txt/.list go without one (GEO-PRESET-UX-2 input table)
    await addBuilderLayer({ kind: 'file', name: file.name, ...(tag ? { tag } : {}), content: base64 });
    if (tagEl) tagEl.value = '';
    builderOpenSrcPanel = null;
    renderPresetBuilder();
  } catch (e: any) {
    toast(e?.message || (isRu ? 'Не удалось прочитать файл' : 'Failed to read file'), 'error');
  }
}

async function importPresetJsonFile(file: any) {
  if (!file) return;
  const isRu = builderIsRu();
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const res = await adminFetch('/api/routing/presets/import-preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed && parsed.preset ? parsed : { preset: parsed }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'HTTP ' + res.status);
    }
    toast((isRu ? 'Пресет импортирован: ' : 'Preset imported: ') + (data.preset ? data.preset.name : ''), 'success');
    const newId = data.preset ? data.preset.id : null;
    await loadPresets();
    if (newId) await openPresetBuilder(newId);
  } catch (e: any) {
    toast((isRu ? 'Ошибка импорта: ' : 'Import error: ') + (e?.message || e), 'error');
  }
}

async function refreshBuilderLayer(index: number) {
  if (!builderState || builderState.builtin) return;
  const layer = (builderState.sources || [])[index];
  if (!layer) return;
  const isRu = builderIsRu();
  let resolved: any = null;
  if (layer.kind === 'url') {
    resolved = await resolveBuilderLayer({ kind: 'url', url: layer.url, ...(layer.tag ? { tag: layer.tag } : {}) });
  } else if (layer.kind === 'file' && layer.fileId) {
    // GEO-BUILDER-UX-3: re-read the stored geofile by the layer tags
    resolved = await resolveBuilderLayer({ kind: 'file', fileId: layer.fileId, tags: builderLayerTags(layer) });
  } else {
    return;
  }
  if (!resolved) {
    toast(isRu ? 'Не удалось перечитать источник' : 'Failed to re-read the source', 'error');
    return;
  }
  builderState.sources[index] = resolved;
  builderRenderedCount = BUILDER_RENDER_LIMIT;
  renderPresetBuilder();
}

// ============================================================================
// GEO-BUILDER-UX-3: inline layer editors (✎) + add-source panels.
// ============================================================================

function closeLayerEditor() {
  builderLayerEditor = null;
  builderTagSelection.clear();
  builderTagSearch = '';
  renderBuilderLayers();
}

async function openLayerEditor(index: number) {
  if (!builderState || builderState.builtin) return;
  const layer = (builderState.sources || [])[index];
  if (!layer) return;
  if (layer.kind === 'manual') {
    builderLayerEditor = { idx: index, kind: 'manual' };
  } else if (layer.kind === 'url') {
    builderLayerEditor = { idx: index, kind: 'url' };
  } else if (layer.kind === 'geo-tag') {
    builderLayerEditor = { idx: index, kind: 'geo' };
  } else if (layer.kind === 'file') {
    builderLayerEditor = { idx: index, kind: 'file' };
    builderTagSelection.clear();
    for (const t of builderLayerTags(layer)) builderTagSelection.add(t);
    builderTagSearch = '';
    if (layer.fileId) {
      // fetch available tags (search + per-tag counts) for the checklist
      try {
        const res = await adminFetch('/api/routing/geofiles/' + encodeURIComponent(layer.fileId) + '/tags');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
        builderAvailableTags = Array.isArray(data.availableTags) ? data.availableTags : [];
      } catch (e: any) {
        builderAvailableTags = [];
        toast(e?.message || 'Failed to load file tags', 'error');
      }
    } else {
      builderAvailableTags = [];
    }
  } else {
    return;
  }
  builderOpenSrcPanel = null;
  renderBuilderLayers();
}

async function saveLayerEditor(index: number) {
  if (!builderState || !builderLayerEditor || builderLayerEditor.idx !== index) return;
  const layer = (builderState.sources || [])[index];
  if (!layer) return;
  const isRu = builderIsRu();

  if (builderLayerEditor.kind === 'manual') {
    const ta = document.getElementById('builderEditorManual') as HTMLTextAreaElement | null;
    const entries = (ta ? ta.value : '').split('\n').map((l) => l.trim()).filter(Boolean);
    for (const tok of entries) {
      const isCidrTok = tok.includes('/');
      if (builderState.type === 'domain' && isCidrTok) {
        toast(isRu ? 'CIDR-запись нельзя добавить в domain-пресет' : 'CIDR entries are not allowed in a domain preset', 'error');
        return;
      }
      if (builderState.type === 'cidr' && !isCidrTok) {
        toast(isRu ? 'Домен нельзя добавить в cidr-пресет' : 'Domain entries are not allowed in a cidr preset', 'error');
        return;
      }
    }
    if (!entries.length) {
      toast(isRu ? 'Список записей пуст' : 'Entries list is empty', 'error');
      return;
    }
    layer.entries = entries;
    closeLayerEditor();
    renderPresetBuilder();
    toast(isRu ? 'Слой обновлён' : 'Layer updated', 'success');
    return;
  }

  if (builderLayerEditor.kind === 'url') {
    const urlEl = document.getElementById('builderEditorUrl') as HTMLInputElement | null;
    const tagEl = document.getElementById('builderEditorTag') as HTMLInputElement | null;
    const url = (urlEl ? urlEl.value : '').trim();
    if (!url) {
      toast(isRu ? 'Укажите URL слоя' : 'Layer URL is required', 'error');
      return;
    }
    const tag = (tagEl ? tagEl.value : '').trim();
    const resolved = await resolveBuilderLayer({ kind: 'url', url, ...(tag ? { tag } : {}) });
    if (!resolved) return;
    builderState.sources[index] = resolved;
    closeLayerEditor();
    renderPresetBuilder();
    toast(isRu ? 'Слой обновлён' : 'Layer updated', 'success');
    return;
  }

  if (builderLayerEditor.kind === 'geo') {
    const refEl = document.getElementById('builderEditorRef') as HTMLSelectElement | null;
    const ref = refEl ? refEl.value : '';
    if (!ref) return;
    const resolved = await resolveBuilderLayer({ kind: 'geo-tag', ref });
    if (!resolved) return;
    builderState.sources[index] = resolved;
    closeLayerEditor();
    renderPresetBuilder();
    toast(isRu ? 'Слой обновлён' : 'Layer updated', 'success');
    return;
  }

  if (builderLayerEditor.kind === 'file') {
    if (!layer.fileId) {
      toast(isRu ? 'Привяжите файл, чтобы редактировать теги' : 'Attach a file to edit tags', 'error');
      return;
    }
    const tags = Array.from(builderTagSelection);
    const resolved = await resolveBuilderLayer({ kind: 'file', fileId: layer.fileId, tags });
    if (!resolved) return;
    builderState.sources[index] = resolved;
    closeLayerEditor();
    renderPresetBuilder();
    toast(isRu ? `Слой пересобран: ${builderLayerEntries(builderState.sources[index]).length} записей` : `Layer rebuilt: ${builderLayerEntries(builderState.sources[index]).length} entries`, 'success');
  }
}

/** «Сменить файл» / «Привязать файл заново»: upload a new .dat into the SAME layer. */
async function replaceLayerFile(index: number, file: any) {
  if (!builderState || !file) return;
  const isRu = builderIsRu();
  try {
    const base64 = await fileToBase64(file);
    const resolved = await resolveBuilderLayer({ kind: 'file', name: file.name, content: base64 });
    if (!resolved) return;
    builderState.sources[index] = resolved;
    builderRenderedCount = BUILDER_RENDER_LIMIT;
    // keep the editor open so the user can pick tags for the new file
    if (builderLayerEditor && builderLayerEditor.idx === index) {
      builderTagSelection.clear();
      builderAvailableTags = [];
      if (resolved.fileId) {
        try {
          const res = await adminFetch('/api/routing/geofiles/' + encodeURIComponent(resolved.fileId) + '/tags');
          const data = await res.json().catch(() => ({}));
          if (res.ok) builderAvailableTags = Array.isArray(data.availableTags) ? data.availableTags : [];
        } catch (_) {
          /* keep current list */
        }
      }
      renderBuilderLayers();
    } else {
      renderPresetBuilder();
    }
    toast(isRu ? `Файл заменён: ${builderLayerEntries(builderState.sources[index]).length} записей` : `File replaced: ${builderLayerEntries(builderState.sources[index]).length} entries`, 'success');
  } catch (e: any) {
    toast(e?.message || (isRu ? 'Не удалось прочитать файл' : 'Failed to read file'), 'error');
  }
}

async function removeBuilderLayer(index: number) {
  if (!builderState || builderState.builtin) return;
  const isRu = builderIsRu();
  const layer = (builderState.sources || [])[index];
  if (!layer) return;
  const ok = await pecConfirm({
    title: isRu ? 'Удалить слой?' : 'Remove layer?',
    message: (isRu ? 'Слой «' : 'Layer "') + builderLayerLabel(layer, isRu) + (isRu ? '" будет удалён из пресета.' : '" will be removed from the preset.'),
    isDanger: true,
    confirmText: isRu ? 'Удалить' : 'Remove',
  });
  if (!ok) return;
  builderState.sources.splice(index, 1);
  builderSelected.clear();
  builderRenderedCount = BUILDER_RENDER_LIMIT;
  renderPresetBuilder();
}

function removeBuilderEntry(entry: string) {
  if (!builderState || builderState.builtin) return;
  const origin = builderOriginMap().get(entry);
  if (!origin || !origin.editable) return;
  const layer = builderState.sources[origin.layerIdx];
  if (!layer || !Array.isArray(layer.entries)) return;
  const i = layer.entries.indexOf(entry);
  if (i >= 0) layer.entries.splice(i, 1);
  builderSelected.delete(entry);
  renderBuilderEntries();
  renderBuilderLayers();
}

async function deleteSelectedBuilderEntries() {
  if (!builderState || builderState.builtin) return;
  const isRu = builderIsRu();
  if (!builderSelected.size) {
    toast(isRu ? 'Не выбрано ни одной записи' : 'No entries selected', 'error');
    return;
  }
  // GEO-BUILDER-UX-3: bulk delete asks for confirmation above a single entry
  if (builderSelected.size > 1) {
    const ok = await pecConfirm({
      title: isRu ? 'Удалить выбранные записи?' : 'Delete selected entries?',
      message: isRu
        ? `Будет удалено записей: ${builderSelected.size}. Действие нельзя отменить без повторного сохранения источника.`
        : `${builderSelected.size} entries will be removed. This cannot be undone without re-saving the source.`,
      isDanger: true,
      confirmText: isRu ? 'Удалить' : 'Delete',
    });
    if (!ok) return;
  }
  const origins = builderOriginMap();
  let removed = 0;
  for (const entry of Array.from(builderSelected)) {
    const origin = origins.get(entry);
    if (!origin || !origin.editable) continue;
    const layer = builderState.sources[origin.layerIdx];
    if (!layer || !Array.isArray(layer.entries)) continue;
    const i = layer.entries.indexOf(entry);
    if (i >= 0) {
      layer.entries.splice(i, 1);
      removed++;
    }
  }
  builderSelected.clear();
  toast(isRu ? `Удалено записей: ${removed}` : `Removed ${removed} entries`, 'success');
  renderBuilderEntries();
  renderBuilderLayers();
}

export function addBuilderDomain() {
  if (!builderState || builderState.builtin) return;
  const isRu = builderIsRu();
  const input = document.getElementById('builderAddDomain') as HTMLInputElement | null;
  const raw = (input ? input.value : '').trim();
  if (!raw) return;
  const tokens = raw.split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean);
  for (const tok of tokens) {
    const isCidrTok = tok.includes('/');
    if (builderState.type === 'domain' && isCidrTok) {
      toast(isRu ? 'CIDR-запись нельзя добавить в domain-пресет' : 'CIDR entries are not allowed in a domain preset', 'error');
      return;
    }
    if (builderState.type === 'cidr' && !isCidrTok) {
      toast(isRu ? 'Домен нельзя добавить в cidr-пресет' : 'Domain entries are not allowed in a cidr preset', 'error');
      return;
    }
    const v = validatePatternToken(tok);
    if (!v.valid) {
      toast(v.error || 'Invalid entry', 'error');
      return;
    }
  }
  // GEO-BUILDER-UX-3: explicit target manual layer (default: first manual layer)
  const targetSel = document.getElementById('builderDomainTarget') as HTMLSelectElement | null;
  const target = targetSel ? targetSel.value : 'new';
  let layer: any;
  if (target === 'new') {
    layer = { kind: 'manual', entries: [] };
    builderState.sources.push(layer);
  } else {
    const idx = parseInt(target, 10);
    layer = builderState.sources[idx];
    if (!layer || layer.kind !== 'manual') {
      layer = { kind: 'manual', entries: [] };
      builderState.sources.push(layer);
    }
  }
  for (const tok of tokens) {
    if (!layer.entries.includes(tok)) layer.entries.push(tok);
  }
  if (input) input.value = '';
  builderRenderedCount = Math.max(builderRenderedCount, BUILDER_RENDER_LIMIT);
  renderPresetBuilder();
}

export async function savePresetBuilder() {
  if (!builderState || builderState.builtin) return;
  const isRu = builderIsRu();

  const nameEl = document.getElementById('builderNameInput') as HTMLInputElement | null;
  const descEl = document.getElementById('builderDescInput') as HTMLInputElement | null;
  const name = ((nameEl && nameEl.value) || builderState.name || '').trim();
  if (!name) {
    toast(isRu ? 'Укажите название пресета' : 'Preset name is required', 'error');
    return;
  }
  const description = ((descEl && descEl.value) || '').trim();
  const sources = builderState.sources || [];
  if (!sources.length) {
    toast(isRu ? 'Добавьте хотя бы один слой' : 'Add at least one layer', 'error');
    return;
  }
  const entries = builderEntriesUnion();
  if (!entries.length) {
    toast(isRu ? 'Пресет пуст: слои не дают записей' : 'Preset is empty: layers produce no entries', 'error');
    return;
  }

  // ⚠️ GEO-PRESET-EDIT-1 lesson: re-send the legacy source fields alongside
  // sources — the server derives them from layers now, but old flows expect
  // them in the payload (sources remain the authoritative shape).
  const urlLayer = sources.find((s: any) => s.kind === 'url');
  const fileTagLayer = sources.find((s: any) => s.kind === 'file' && s.tag);
  const payload: Record<string, any> = {
    id: builderState.id,
    name,
    description,
    type: builderState.type,
    sources,
    entries,
    domains: entries,
    source: urlLayer ? 'remote' : 'file',
  };
  if (urlLayer) {
    payload.sourceUrl = urlLayer.url;
    if (urlLayer.tag) payload.sourceTag = urlLayer.tag;
  } else if (fileTagLayer) {
    payload.sourceTag = fileTagLayer.tag;
  }

  try {
    const res = await adminFetch('/api/routing/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const msg = data.error || 'HTTP ' + res.status;
      showBuilderLayerStatus(msg);
      toast(msg, 'error');
      return;
    }
    toast(isRu ? 'Пресет сохранён' : 'Preset saved', 'success');
    await loadPresets();
    closePresetBuilder();
  } catch (e: any) {
    toast(e?.message || (isRu ? 'Ошибка сохранения' : 'Save failed'), 'error');
  }
}

export async function duplicateBuiltinPreset(presetId: string) {
  const isRu = builderIsRu();
  try {
    const res = await adminFetch('/api/routing/presets/' + encodeURIComponent(presetId));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const preset = await res.json();
    const dupRes = await adminFetch('/api/routing/presets/import-preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preset: {
          name: (preset.name || presetId) + (isRu ? ' (копия)' : ' (copy)'),
          description: preset.description || '',
          category: preset.category || 'custom',
          type: preset.type === 'cidr' ? 'cidr' : 'domain',
          sources: Array.isArray(preset.sources) && preset.sources.length
            ? preset.sources
            : [{ kind: 'manual', entries: preset.entries || preset.domains || [] }],
        },
      }),
    });
    const dupData = await dupRes.json().catch(() => ({}));
    if (!dupRes.ok || !dupData.ok) {
      throw new Error(dupData.error || 'HTTP ' + dupRes.status);
    }
    toast(isRu ? 'Создана копия пресета' : 'Preset duplicated', 'success');
    await loadPresets();
    if (dupData.preset && dupData.preset.id) {
      await openPresetBuilder(dupData.preset.id);
    }
  } catch (e: any) {
    toast(e?.message || (isRu ? 'Не удалось дублировать пресет' : 'Failed to duplicate preset'), 'error');
  }
}

export async function exportPresetJson(presetId: string) {
  const isRu = builderIsRu();
  try {
    const res = await adminFetch('/api/routing/presets/' + encodeURIComponent(presetId) + '/export');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(presetId).replace(/[^a-zA-Z0-9._-]/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(isRu ? 'Экспорт готов' : 'Export ready', 'success');
  } catch (e: any) {
    toast(e?.message || (isRu ? 'Ошибка экспорта' : 'Export failed'), 'error');
  }
}

export async function deletePresetWithConfirm(presetId: string) {
  const preset = findLoadedPreset(presetId);
  if (!preset) return;
  if (isBuiltinPreset(preset)) {
    toast(builderIsRu() ? 'Builtin-пресеты нельзя удалять' : 'Built-in presets cannot be deleted', 'error');
    return;
  }
  const isRu = state.currentLang === 'ru';
  const inProfiles = (state.allProfiles || []).filter((prof: any) =>
    Array.isArray(prof.rules) && prof.rules.some((r: any) => r.targetType === 'preset' && r.pattern === presetId)
  );
  const ok = await pecConfirm({
    title: isRu ? 'Удалить пресет?' : 'Delete preset?',
    message: (isRu ? 'Пресет «' : 'Preset "') + (preset.name || presetId) + (isRu ? '" будет удалён безвозвратно.' : '" will be deleted permanently.') +
      (inProfiles.length
        ? (isRu ? `\nИспользуется в профилях: ${inProfiles.map((p: any) => p.name).join(', ')}.` : `\nUsed by profiles: ${inProfiles.map((p: any) => p.name).join(', ')}.`)
        : ''),
    isDanger: true,
    confirmText: isRu ? 'Удалить' : 'Delete',
  });
  if (!ok) return;

  try {
    const res = await adminFetch('/api/routing/presets/' + encodeURIComponent(presetId), { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error || ('HTTP ' + res.status), 'error');
      return;
    }
    toast(isRu ? 'Пресет удалён' : 'Preset deleted', 'success');
    await loadPresets();
  } catch (e: any) {
    toast(e?.message || 'Delete failed', 'error');
  }
}

export async function refreshRemotePreset(presetId: string) {
  const preset = findLoadedPreset(presetId);
  if (!preset) return;
  const isRu = state.currentLang === 'ru';
  toast(isRu ? 'Обновление url-слоёв пресета...' : 'Refreshing preset url layers...', 'info');
  try {
    const res = await adminFetch('/api/routing/presets/' + encodeURIComponent(presetId) + '/refresh', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error || ('HTTP ' + res.status), 'error');
      return;
    }
    toast(isRu ? 'Пресет обновлён' : 'Preset refreshed', 'success');
    await loadPresets();
  } catch (e: any) {
    toast(e?.message || 'Refresh failed', 'error');
  }
}

// Modal closers
registerModalCloser('modalEditRule', closeEditRuleModal);

// ============================================================================
// GEO-PRESET-UX-2 click-path invariant (DIAG-GEO-UX-1): every constructor /
// preset-card button is handled by DELEGATED document-level listeners below
// (telemetry.ts:771 pattern). Tests must dispatchEvent(click) on the buttons.
// ============================================================================

if (typeof document !== 'undefined') {
  document.addEventListener('click', function(e: any) {
    const target = e.target;
    if (!target || typeof (target as any).closest !== 'function') return;

    // CARD-MENU: any click outside an open menu and outside the «⋮» button
    // closes it (outside-click dismiss; Escape handled by the keydown listener).
    const menuBtn = (target as any).closest('.btn-preset-menu');
    const insideMenu = (target as any).closest('.preset-card-menu');
    if (!menuBtn && !insideMenu) {
      closePresetMenus();
    }
    if (menuBtn) {
      togglePresetCardMenu(menuBtn);
      return;
    }

    // CARD-MENU item dispatch: close on selection, then run the action.
    const menuItem = (target as any).closest('.preset-menu-item');
    if (menuItem) {
      const id = menuItem.getAttribute('data-id');
      closePresetMenus();
      if (!id) return;
      if (menuItem.classList.contains('pm-edit')) {
        openPresetBuilder(id);
        return;
      }
      if (menuItem.classList.contains('pm-view')) {
        openPresetBuilder(id, { readOnly: true });
        return;
      }
      if (menuItem.classList.contains('pm-refresh')) {
        refreshRemotePreset(id);
        return;
      }
      if (menuItem.classList.contains('pm-export')) {
        exportPresetJson(id);
        return;
      }
      if (menuItem.classList.contains('pm-duplicate')) {
        duplicateBuiltinPreset(id);
        return;
      }
      if (menuItem.classList.contains('pm-delete')) {
        deletePresetWithConfirm(id);
        return;
      }
      return;
    }

    const dupBtn = (target as any).closest('.btn-preset-duplicate');
    if (dupBtn) {
      // card buttons carry data-id; the in-builder header button falls back to
      // the currently open preset
      const id = dupBtn.getAttribute('data-id') || (builderState && builderState.id);
      if (id) duplicateBuiltinPreset(id);
      return;
    }
    const exportBtn = (target as any).closest('.btn-preset-export');
    if (exportBtn) {
      if (builderState && builderState.id) exportPresetJson(builderState.id);
      return;
    }
    const backBtn = (target as any).closest('.btn-builder-back');
    if (backBtn) {
      closePresetBuilder();
      return;
    }
    const cancelBtn = (target as any).closest('.btn-builder-cancel');
    if (cancelBtn) {
      closePresetBuilder();
      return;
    }
    const saveBtn = (target as any).closest('.btn-builder-save');
    if (saveBtn) {
      savePresetBuilder();
      return;
    }
    // GEO-BUILDER-UX-3: add-source panel toggles (one open at a time)
    const srcBtn = (target as any).closest('.builder-src-btn');
    if (srcBtn) {
      const src = srcBtn.getAttribute('data-src');
      builderOpenSrcPanel = src && builderOpenSrcPanel !== src ? src : null;
      renderPresetBuilder();
      return;
    }
    const addGeoBtn = (target as any).closest('.btn-add-geo-confirm');
    if (addGeoBtn) {
      addGeoLayerFromSelect();
      return;
    }
    const addFileBtn = (target as any).closest('.btn-add-file-confirm');
    if (addFileBtn) {
      const fileInput = document.getElementById('builderLayerFileInput') as HTMLInputElement | null;
      const file = fileInput && fileInput.files ? fileInput.files[0] : null;
      if (!file) {
        toast(builderIsRu() ? 'Выберите файл для загрузки' : 'Select a file to upload', 'error');
        return;
      }
      addBuilderFileLayer(file);
      return;
    }
    const addUrlBtn = (target as any).closest('.btn-add-url-confirm');
    if (addUrlBtn) {
      addUrlLayerFromInputs();
      return;
    }
    const addManualBtn = (target as any).closest('.btn-add-manual-confirm');
    if (addManualBtn) {
      addManualLayerFromTextarea();
      return;
    }
    const layerEditBtn = (target as any).closest('.btn-layer-edit, .btn-layer-rebind');
    if (layerEditBtn) {
      const idx = layerEditBtn.getAttribute('data-index');
      if (idx !== null) openLayerEditor(parseInt(idx, 10));
      return;
    }
    const editorSaveBtn = (target as any).closest('.btn-editor-save');
    if (editorSaveBtn) {
      const idx = editorSaveBtn.getAttribute('data-index');
      if (idx !== null) saveLayerEditor(parseInt(idx, 10));
      return;
    }
    const editorCancelBtn = (target as any).closest('.btn-editor-cancel');
    if (editorCancelBtn) {
      closeLayerEditor();
      return;
    }
    const layerRefreshBtn = (target as any).closest('.btn-layer-refresh');
    if (layerRefreshBtn) {
      const idx = layerRefreshBtn.getAttribute('data-index');
      if (idx !== null) refreshBuilderLayer(parseInt(idx, 10));
      return;
    }
    const layerRemoveBtn = (target as any).closest('.btn-layer-remove');
    if (layerRemoveBtn) {
      const idx = layerRemoveBtn.getAttribute('data-index');
      if (idx !== null) removeBuilderLayer(parseInt(idx, 10));
      return;
    }
    const entryRemoveBtn = (target as any).closest('.btn-entry-remove');
    if (entryRemoveBtn) {
      const entry = entryRemoveBtn.getAttribute('data-entry');
      if (entry) removeBuilderEntry(entry);
      return;
    }
    const deleteSelectedBtn = (target as any).closest('.btn-builder-delete-selected');
    if (deleteSelectedBtn) {
      deleteSelectedBuilderEntries();
      return;
    }
    const showMoreBtn = (target as any).closest('.btn-builder-show-more');
    if (showMoreBtn) {
      builderRenderedCount += BUILDER_RENDER_LIMIT;
      renderBuilderEntries();
      return;
    }
    const selectAllBtn = (target as any).closest('#btnBuilderSelectAll');
    if (selectAllBtn) {
      toggleBuilderSelectAll();
      return;
    }
  });

  document.addEventListener('change', function(e: any) {
    const t = e.target;
    if (!t || typeof t.classList !== 'object') return;
    if (typeof t.classList.contains === 'function' && t.classList.contains('toggle-builder-entry')) {
      const entry = t.getAttribute('data-entry');
      if (!entry) return;
      if (t.checked) {
        builderSelected.add(entry);
      } else {
        builderSelected.delete(entry);
      }
      updateBuilderCounters();
      return;
    }
    if (t.id === 'builderSelectAllBox') {
      toggleBuilderSelectAll(!!t.checked);
      return;
    }
    if (t.id === 'builderLayerFileInput' && t.files && t.files[0]) {
      const f = t.files[0];
      t.value = '';
      addBuilderFileLayer(f);
      return;
    }
    if (t.id === 'builderImportJsonInput' && t.files && t.files[0]) {
      const f = t.files[0];
      t.value = '';
      importPresetJsonFile(f);
      return;
    }
    // GEO-BUILDER-UX-3: tag editor checklist + in-editor file replacement
    if (typeof t.classList.contains === 'function' && t.classList.contains('builder-tag-check')) {
      const tag = t.getAttribute('data-tag');
      if (!tag) return;
      if (t.checked) {
        builderTagSelection.add(tag);
      } else {
        builderTagSelection.delete(tag);
      }
      updateTagEditorCounters();
      return;
    }
    if (typeof t.classList.contains === 'function' && t.classList.contains('builder-editor-file')) {
      const idx = t.getAttribute('data-index');
      const f = t.files && t.files[0] ? t.files[0] : null;
      t.value = '';
      if (idx !== null && f) replaceLayerFile(parseInt(idx, 10), f);
      return;
    }
  });

  document.addEventListener('input', function(e: any) {
    const t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'builderEntrySearch' && builderState) {
      builderState.search = t.value || '';
      builderRenderedCount = BUILDER_RENDER_LIMIT;
      renderBuilderEntries();
      return;
    }
    if (t.id === 'builderTagSearch') {
      // GEO-BUILDER-UX-3: re-render only the checklist (keeps the input focus)
      builderTagSearch = t.value || '';
      rerenderTagChecklist();
      return;
    }
    if (t.id === 'builderNameInput' && builderState) {
      builderState.name = t.value || '';
      return;
    }
    if (t.id === 'builderDescInput' && builderState) {
      builderState.description = t.value || '';
      return;
    }
  });

  document.addEventListener('keydown', function(e: any) {
    if (e && e.key === 'Escape') {
      // CARD-MENU: Escape dismisses the open preset menu (POPOVER-CLOSE
      // discipline); the modal Escape closer in index.ts keeps working
      // alongside this listener.
      closePresetMenus();
    }
    if (e && e.key === 'Enter' && e.target && e.target.id === 'builderAddDomain') {
      e.preventDefault();
      addBuilderDomain();
    }
  });
}
