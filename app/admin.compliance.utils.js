
export const VOLUNTEER_BASE = `${window.location.origin}/volunteer.html?form=`;
export const PAGE_SIZE = 25;

export const DRAWERS = {
  bg:           { overlay: 'bgDrawerOverlay',    drawer: 'bgDrawer',           save: 'bgDrawerSave',     close: ['bgDrawerClose', 'bgDrawerCancel'] },
  tpl:          { overlay: 'tplDrawerOverlay',    drawer: 'tplDrawer',          save: 'tplDrawerSave',    close: ['tplDrawerClose', 'tplDrawerCancel'] },
  link:         { overlay: 'linkDrawerOverlay',   drawer: 'linkDrawer',         save: 'linkDrawerSave',   close: ['linkDrawerClose', 'linkDrawerCancel'] },
  linkGuardian: { overlay: 'linkGuardianOverlay', drawer: 'linkGuardianDrawer', save: 'linkGuardianSave', close: ['linkGuardianClose', 'linkGuardianCancel'] },
  grant:        { overlay: 'grantDrawerOverlay',  drawer: 'grantDrawer',        save: 'grantDrawerSave',  close: ['grantDrawerClose', 'grantDrawerCancel'] },
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
