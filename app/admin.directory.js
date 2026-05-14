
import { supabase } from './admin.supabase.js';

export function createDirectory(config) {
  const {
    table,
    schoolId,
    select,
    searchFields = [],
    filters = {},
    defaultSort,
    pageSize = 25,
    tbodySelector,
    paginationContainer,
    renderRow
  } = config;

  const state = {
    page: 1,
    search: '',
    sort: { ...defaultSort },
    filters: {},
    loadSeq: 0
  };

  function buildQuery({ paged = true, all = false } = {}) {
    let query = supabase
      .from(table)
      .select(select, { count: paged ? 'exact' : null })
      .eq('school_id', schoolId());

const searchTerm = state.search;

// ✅ allow augmentQuery to control search
let skipBaseSearch = false;

if (typeof config.augmentQuery === 'function') {
  const result = config.augmentQuery(query, searchTerm);
  if (result?.query) {
    query = result.query;
    skipBaseSearch = result.skipBaseSearch === true;
  } else {
    query = result || query;
  }
}

// Base-table search ONLY if not skipped
if (!all && searchTerm && searchFields.length && !skipBaseSearch) {
  const term = `%${searchTerm}%`;
  const orExpr = searchFields
    .map(f => `${f}.ilike.${term}`)
    .join(',');
  query = query.or(orExpr);
}

    // Filters
    if (!all) {
      Object.entries(filters).forEach(([key, resolver]) => {
        const result = resolver(state.filters[key]);
        if (result) {
          query = query[result.op](
            result.column,
            result.value
          );
        }
      });
    }

    // Sorting
    const sort = all ? defaultSort : state.sort;
    if (sort?.column) {
      query = query.order(sort.column, {
        ascending: sort.ascending
      });
    }

    // Pagination
    if (paged && !all) {
      const from = (state.page - 1) * pageSize;
      const to = from + pageSize - 1;
      query = query.range(from, to);
    }

    return query;
  }

  async function load() {
    const loadId = ++state.loadSeq;
    const tbody = document.querySelector(tbodySelector);
    if (!tbody) return;

    tbody.innerHTML = '';

    const { data, error, count } = await buildQuery();

    if (loadId !== state.loadSeq) return;

    if (error) {
      console.error(`Load failed for ${table}`, error);
      return;
    }

    tbody.innerHTML = '';
    data.forEach(row => {
      tbody.appendChild(renderRow(row));
    });

    renderPagination(count);
  }

  function renderPagination(totalCount) {
    if (!paginationContainer) return;
    const container = document.querySelector(paginationContainer);
    if (!container) return;
    container.innerHTML = '';

    const totalPages = Math.ceil(totalCount / pageSize);

    // Record count label (always shown)
    const from = Math.min((state.page - 1) * pageSize + 1, totalCount);
    const to   = Math.min(state.page * pageSize, totalCount);
    const info = document.createElement('span');
    info.className = 'pagination-info';
    info.textContent = totalCount === 0
      ? 'No results'
      : totalPages <= 1
        ? `${totalCount} record${totalCount !== 1 ? 's' : ''}`
        : `${from}–${to} of ${totalCount}`;
    container.appendChild(info);

    if (totalPages <= 1) return;

    const controls = document.createElement('div');
    controls.className = 'pagination-controls';

    function makeBtn(label, page, disabled = false) {
      const btn = document.createElement('button');
      btn.innerHTML = label;
      btn.className = 'pagination-btn' + (page === state.page ? ' pagination-active' : '');
      btn.disabled = disabled;
      if (!disabled && page !== state.page) {
        btn.onclick = () => { state.page = page; load(); };
      }
      return btn;
    }

    // Prev
    controls.appendChild(makeBtn('&#8249;', state.page - 1, state.page === 1));

    // Page numbers with ellipsis
    getPageRange(state.page, totalPages).forEach(p => {
      if (p === '…') {
        const el = document.createElement('span');
        el.className = 'pagination-ellipsis';
        el.textContent = '…';
        controls.appendChild(el);
      } else {
        controls.appendChild(makeBtn(p, p));
      }
    });

    // Next
    controls.appendChild(makeBtn('&#8250;', state.page + 1, state.page === totalPages));

    container.appendChild(controls);
  }

  function getPageRange(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    if (current <= 4) return [1, 2, 3, 4, 5, '…', total];
    if (current >= total - 3) return [1, '…', total - 4, total - 3, total - 2, total - 1, total];
    return [1, '…', current - 1, current, current + 1, '…', total];
  }

  async function exportXlsx({ all = false, filename }) {
    const { data, error } = await buildQuery({
      paged: false,
      all
    });

    if (error) {
      console.error('Export failed', error);
      alert('Export failed');
      return;
    }

    if (!data?.length) {
      alert('No rows to export');
      return;
    }

    const rows = data.map(r =>
      typeof config.exportRow === 'function' ? config.exportRow(r) : flattenRow(r)
    );
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Export');

    XLSX.writeFile(
      workbook,
      filename || `${table}-${all ? 'all' : 'filtered'}.xlsx`
    );
  }

  function flattenRow(obj, prefix = '', out = {}) {
    Object.entries(obj).forEach(([key, val]) => {
      const name = prefix ? `${prefix}.${key}` : key;
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        flattenRow(val, name, out);
      } else {
        out[name] = val;
      }
    });
    return out;
  }

  return {
    load,
    setSearch(value) {
      state.search = value;
      state.page = 1;
      load();
    },
    setFilter(key, value) {
      state.filters[key] = value;
      state.page = 1;
      load();
    },
    setSort(column, ascending) {
      state.sort = { column, ascending };
      load();
    },
    exportFiltered() {
      return exportXlsx({ all: false });
    },
    exportAll() {
      return exportXlsx({ all: true });
    }
  };
}
