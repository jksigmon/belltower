import { supabase } from './admin.supabase.js?v=2';
import { esc, debounce, showToast, dbError, todayISO } from './admin.shared.js?v=3';
import { VOLUNTEER_ROLES } from './compliance.roles.js?v=3';

let rows = new Map(); // id -> row, current result set

const CHECK_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></svg>';

export async function initChaperoneCredentials() {
  document.getElementById('ccSearch')?.addEventListener('input', debounce(load, 250));
  await load();
}

async function load() {
  const tbody = document.getElementById('ccTableBody');
  const term = document.getElementById('ccSearch')?.value.trim() || null;
  tbody.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:32px 0;">Loading…</td></tr>';

  const { data, error } = await supabase.rpc('list_chaperone_credentials', { p_search: term });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="status-danger" style="text-align:center;padding:32px 0;">Failed to load: ${esc(error.message)}</td></tr>`;
    return;
  }

  const data_ = data ?? [];
  rows = new Map(data_.map(r => [r.id, r]));
  document.getElementById('ccTruncatedNote').style.display = data_.length >= 200 ? 'block' : 'none';

  if (!data_.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:32px 0;">${term ? 'No matches.' : 'No volunteers on the roster yet.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  data_.forEach(row => {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;
    const name = `${row.first_name} ${row.last_name}`;
    tr.innerHTML = `
      <td><strong>${esc(name)}</strong></td>
      <td>${row.email ? esc(row.email) : '<span class="muted">—</span>'}</td>
      <td style="max-width:160px;white-space:normal;">${roleChipsHTML(row.volunteer_roles)}</td>
      <td>${dateFieldHTML('dl', row.dl_expires_at)}</td>
      <td>${dateFieldHTML('insurance', row.insurance_expires_at)}</td>
      <td><button class="btn btn-sm" data-save>Save</button></td>
    `;
    tr.querySelector('[data-save]').addEventListener('click', () => saveRow(row.id, tr));
    tr.querySelectorAll('input[type="date"]').forEach(input => {
      input.addEventListener('input', () => updateNotExpiredCheck(input));
    });
    tbody.appendChild(tr);
  });
}

function dateFieldHTML(field, value) {
  return `
    <div style="display:flex;align-items:center;gap:6px;">
      <input type="date" class="admin-input" data-field="${field}" value="${value ?? ''}" style="width:150px;">
      <span class="cc-not-expired-check" title="On file and not expired" style="display:${isNotExpired(value) ? 'inline-flex' : 'none'};color:#15803d;">${CHECK_ICON}</span>
    </div>
  `;
}

// A future-dated value counts as "not expired" even before it's saved, so
// typing a new date updates the check immediately instead of only after
// Save round-trips to the server.
function isNotExpired(dateStr) {
  return !!dateStr && dateStr >= todayISO();
}

function updateNotExpiredCheck(input) {
  const check = input.nextElementSibling;
  if (check) check.style.display = isNotExpired(input.value) ? 'inline-flex' : 'none';
}

function roleChipsHTML(roleKeys) {
  if (!roleKeys?.length) return '<span class="muted">—</span>';
  return roleKeys.map(r => {
    const label = VOLUNTEER_ROLES[r]?.label ?? r;
    return `<span style="background:#eff6ff;color:#1d4ed8;border-radius:999px;font-size:10px;font-weight:700;padding:2px 7px;display:inline-block;margin:1px;">${esc(label)}</span>`;
  }).join('');
}

async function saveRow(id, tr) {
  const btn = tr.querySelector('[data-save]');
  const dlVal  = tr.querySelector('[data-field="dl"]').value || null;
  const insVal = tr.querySelector('[data-field="insurance"]').value || null;

  btn.disabled = true;
  btn.textContent = 'Saving…';

  const { error } = await supabase.rpc('update_chaperone_credentials', {
    p_volunteer_id: id,
    p_dl_expires_at: dlVal,
    p_insurance_expires_at: insVal,
  });

  btn.disabled = false;
  btn.textContent = 'Save';

  if (error) { dbError(error, 'Save failed'); return; }

  const row = rows.get(id);
  if (row) { row.dl_expires_at = dlVal; row.insurance_expires_at = insVal; }

  showToast('Credentials updated');
  tr.classList.remove('cc-row-saved');
  void tr.offsetWidth; // restart the animation if the row was just saved again
  tr.classList.add('cc-row-saved');
}
