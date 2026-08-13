
export const VOLUNTEER_BASE = `${window.location.origin}/volunteer.html?form=`;
export const PAGE_SIZE = 25;

export const DRAWERS = {
  bg:           { overlay: 'bgDrawerOverlay',    drawer: 'bgDrawer',           save: 'bgDrawerSave',     close: ['bgDrawerClose', 'bgDrawerCancel'] },
  tpl:          { overlay: 'tplDrawerOverlay',    drawer: 'tplDrawer',          save: 'tplDrawerSave',    close: ['tplDrawerClose', 'tplDrawerCancel'] },
  link:         { overlay: 'linkDrawerOverlay',   drawer: 'linkDrawer',         save: 'linkDrawerSave',   close: ['linkDrawerClose', 'linkDrawerCancel'] },
  linkGuardian: { overlay: 'linkGuardianOverlay', drawer: 'linkGuardianDrawer', save: 'linkGuardianSave', close: ['linkGuardianClose', 'linkGuardianCancel'] },
  grant:        { overlay: 'grantDrawerOverlay',  drawer: 'grantDrawer',        save: 'grantDrawerSave',  close: ['grantDrawerClose', 'grantDrawerCancel'] },
  resolve:      { overlay: 'resolveDrawerOverlay', drawer: 'resolveDrawer',     save: 'resolveDrawerSave', close: ['resolveDrawerClose', 'resolveDrawerCancel'] },
  attRenew:     { overlay: 'attRenewOverlay',      drawer: 'attRenewDrawer',    save: 'attRenewSave',      close: ['attRenewClose', 'attRenewCancel'] },
  reqAdd:       { overlay: 'reqAddDrawerOverlay',  drawer: 'reqAddDrawer',      save: 'reqAddDrawerSave',  close: ['reqAddDrawerClose', 'reqAddDrawerCancel'] },
  reviewData:   { overlay: 'reviewDataOverlay',   drawer: 'reviewDataDrawer',   save: null,               close: ['reviewDataClose'] },
};

export function openDrawer(key) {
  const { overlay, drawer } = DRAWERS[key];
  const ol = document.getElementById(overlay);
  const dr = document.getElementById(drawer);
  ol.style.display = ''; dr.style.display = '';
  ol.removeAttribute('aria-hidden');
  requestAnimationFrame(() => { ol.classList.add('open'); dr.classList.add('open'); });
  dr.querySelector('input, select, textarea, button')?.focus();
}

export function closeDrawer(key) {
  const { overlay, drawer } = DRAWERS[key];
  const ol = document.getElementById(overlay);
  const dr = document.getElementById(drawer);
  ol.classList.remove('open'); dr.classList.remove('open');
  ol.setAttribute('aria-hidden', 'true');
  setTimeout(() => { ol.style.display = 'none'; dr.style.display = 'none'; }, 250);
}

export function renderPagination(containerId, currentPage, totalItems, onPageChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const totalPages = Math.ceil(totalItems / PAGE_SIZE);
  const from = Math.min((currentPage - 1) * PAGE_SIZE + 1, totalItems);
  const to   = Math.min(currentPage * PAGE_SIZE, totalItems);

  const info = document.createElement('span');
  info.className = 'pagination-info';
  info.textContent = totalItems === 0
    ? 'No results'
    : totalPages <= 1
      ? `${totalItems} record${totalItems !== 1 ? 's' : ''}`
      : `${from}–${to} of ${totalItems}`;
  container.appendChild(info);
  container.style.display = '';

  if (totalPages <= 1) return;

  const controls = document.createElement('div');
  controls.className = 'pagination-controls';

  function makeBtn(label, targetPage, disabled) {
    const btn = document.createElement('button');
    btn.innerHTML = label;
    btn.className = 'pagination-btn' + (targetPage === currentPage ? ' pagination-active' : '');
    btn.disabled = disabled;
    if (!disabled && targetPage !== currentPage) btn.onclick = () => onPageChange(targetPage);
    return btn;
  }

  controls.appendChild(makeBtn('&#8249;', currentPage - 1, currentPage === 1));

  const delta = 2;
  let pages = new Set([1, totalPages]);
  for (let i = Math.max(2, currentPage - delta); i <= Math.min(totalPages - 1, currentPage + delta); i++) pages.add(i);
  pages = [...pages].sort((a, b) => a - b);

  let prev = 0;
  pages.forEach(p => {
    if (p - prev > 1) {
      const e = document.createElement('span');
      e.className = 'pagination-ellipsis';
      e.textContent = '…';
      controls.appendChild(e);
    }
    controls.appendChild(makeBtn(p, p, false));
    prev = p;
  });

  controls.appendChild(makeBtn('&#8250;', currentPage + 1, currentPage === totalPages));
  container.appendChild(controls);
}

// Shared multi-select mechanics for any list that supports bulk actions.
// Selection lives in a Set keyed by row id, so `checked` state is re-derived
// on every render and survives pagination, filtering and re-sorts.
export function createBulkSelection({ barId, countId, label = 'selected' }) {
  const selected = new Set();

  const sel = {
    selected,
    has:  id => selected.has(id),
    ids:  ()  => [...selected],
    size: ()  => selected.size,

    set(id, on) {
      if (on) selected.add(id); else selected.delete(id);
      sel.updateBar();
    },

    clear() {
      selected.clear();
      sel.updateBar();
    },

    // Rows the admin can no longer see (filter/search changed underneath them)
    // must not stay selected -- a bulk action would silently hit invisible rows.
    prune(visibleIds) {
      for (const id of selected) if (!visibleIds.has(id)) selected.delete(id);
    },

    updateBar() {
      const bar   = document.getElementById(barId);
      const count = document.getElementById(countId);
      if (!bar || !count) return;
      if (selected.size === 0) { bar.style.display = 'none'; return; }
      bar.style.display = 'flex';
      count.textContent = `${selected.size} ${label}`;
    },

    // Reassigned (not addEventListener) on every render so repeated renders
    // can't stack duplicate listeners.
    wireSelectAll(checkboxId, selectableIds, onChange) {
      const box = document.getElementById(checkboxId);
      if (!box) return;
      box.checked = selectableIds.length > 0 && selectableIds.every(id => selected.has(id));
      box.indeterminate = !box.checked && selectableIds.some(id => selected.has(id));
      box.onchange = () => {
        selectableIds.forEach(id => { if (box.checked) selected.add(id); else selected.delete(id); });
        onChange();
      };
    },
  };

  return sel;
}

// Shared filter predicate for compliance_volunteer_status, applied
// identically by the Volunteers directory and the Needs Attention view
// (they differ only in which `status` values they default to). Kept
// here rather than duplicated so a filter added to one doesn't quietly
// diverge from the other.
export function applyVolunteerStatusFilters(query, { search, role, status, credential, showArchived } = {}) {
  query = showArchived ? query.not('archived_at', 'is', null) : query.is('archived_at', null);

  if (search) {
    const term = `%${search}%`;
    query = query.or(`first_name.ilike.${term},last_name.ilike.${term},email.ilike.${term}`);
  }
  if (role) query = query.contains('volunteer_roles', [role]);
  if (status) query = query.eq('worst_status', status);

  if (credential === 'bg')        query = query.or('bg_expired.eq.true,bg_cleared_at.is.null');
  if (credential === 'mvr')       query = query.eq('mvr_expired', true);
  if (credential === 'dl')        query = query.eq('dl_expired', true);
  if (credential === 'insurance') query = query.eq('insurance_expired', true);

  return query;
}

export function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 250);
  }, 3000);
}
