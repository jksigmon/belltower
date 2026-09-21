// Page-number pagination for the Request Manager list. Submissions are
// already fully loaded and filtered in memory, so this only slices them.
// Renders a count plus page buttons into a container and reuses the shared
// .pagination styles from admin-ui.css.

export const PAGE_SIZE = 25;

function pageRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, '…', total];
  if (current >= total - 3) return [1, '…', total - 4, total - 3, total - 2, total - 1, total];
  return [1, '…', current - 1, current, current + 1, '…', total];
}

export function pageCount(total, pageSize = PAGE_SIZE) {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function pageSlice(items, page, pageSize = PAGE_SIZE) {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function renderPager(container, { page, total, pageSize = PAGE_SIZE, onPage }) {
  if (!container) return;
  container.innerHTML = '';

  const totalPages = pageCount(total, pageSize);
  const from = Math.min((page - 1) * pageSize + 1, total);
  const to   = Math.min(page * pageSize, total);

  const info = document.createElement('span');
  info.className = 'pagination-info';
  info.textContent = total === 0
    ? 'No requests'
    : totalPages <= 1
      ? `${total} request${total !== 1 ? 's' : ''}`
      : `Showing ${from} to ${to} of ${total} requests`;
  container.appendChild(info);

  if (totalPages <= 1) return;

  const controls = document.createElement('div');
  controls.className = 'pagination-controls';

  const makeBtn = (label, target, disabled = false, ariaLabel = '') => {
    const btn = document.createElement('button');
    btn.innerHTML = label;
    btn.className = 'pagination-btn' + (target === page ? ' pagination-active' : '');
    btn.disabled = disabled;
    if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
    if (!disabled && target !== page) btn.onclick = () => onPage(target);
    return btn;
  };

  controls.appendChild(makeBtn('&#8249;', page - 1, page === 1, 'Previous page'));
  pageRange(page, totalPages).forEach(p => {
    if (p === '…') {
      const el = document.createElement('span');
      el.className = 'pagination-ellipsis';
      el.textContent = '…';
      controls.appendChild(el);
    } else {
      controls.appendChild(makeBtn(p, p));
    }
  });
  controls.appendChild(makeBtn('&#8250;', page + 1, page === totalPages, 'Next page'));
  container.appendChild(controls);
}
