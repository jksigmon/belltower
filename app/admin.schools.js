
import { supabase } from './admin.supabase.js';
import { esc } from './admin.shared.js';

let currentProfile;
let initialized = false;

const MODULES = [
  { key: 'pto',         label: 'PTO Management' },
  { key: 'substitutes', label: 'Substitute Assignment' },
  { key: 'carline',     label: 'Carline Dismissal' },
  { key: 'licensure',   label: 'Licensure Tracking' },
  { key: 'compliance',  label: 'Volunteer Compliance' },
  { key: 'field_trips', label: 'Field Trip Planning' },
];

/* ===============================
   ENTRY POINT
================================ */

export async function initSchoolsSection(profile) {
  if (!profile.is_superadmin) return;
  currentProfile = profile;

  if (!initialized) {
    wireSchoolEvents();
    initialized = true;
  }

  await loadSchools();
}

/* ===============================
   LOAD LIST
================================ */

async function loadSchools() {
  const tbody = document.querySelector('#schoolsTable tbody');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="4" class="muted" style="padding:16px;">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from('schools')
    .select('id, name, short_name, email_domain, phone, address, city, state, zip, timezone, weather_lat, weather_lon, school_modules(module, enabled)')
    .order('name');

  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">Failed to load schools.</td></tr>`;
    return;
  }

  if (!data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted" style="padding:16px;">No schools yet. Add one to get started.</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  data.forEach(school => tbody.appendChild(renderSchoolRow(school)));
}

/* ===============================
   RENDER ROW
================================ */

function renderSchoolRow(school) {
  const enabledKeys = (school.school_modules || []).filter(m => m.enabled).map(m => m.module);
  const pills = MODULES.filter(m => enabledKeys.includes(m.key))
    .map(m => `<span class="module-pill">${esc(m.label)}</span>`)
    .join('');

  const tr = document.createElement('tr');
  tr.className = 'dir-row-link';
  tr.innerHTML = `
    <td>
      <div class="staff-name-group">
        <span class="staff-fullname">${esc(school.name)}</span>
        ${school.short_name ? `<span class="muted" style="font-size:12px;">${esc(school.short_name)}</span>` : ''}
      </div>
    </td>
    <td class="staff-cell-muted">${esc(school.email_domain ?? '—')}</td>
    <td><div class="module-pills">${pills || '<span class="staff-cell-muted">None enabled</span>'}</div></td>
    <td class="staff-cell-chevron">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </td>
  `;
  tr.addEventListener('click', () => openEditSchoolDrawer(school));
  return tr;
}

/* ===============================
   CREATE
================================ */

async function createSchool() {
  const name     = document.getElementById('schoolNameInput').value.trim();
  const short    = document.getElementById('schoolShortInput').value.trim();
  const domain   = document.getElementById('schoolDomainInput').value.trim().toLowerCase();
  const phone    = document.getElementById('schoolPhoneInput').value.trim();
  const address  = document.getElementById('schoolAddressInput').value.trim();
  const city     = document.getElementById('schoolCityInput').value.trim();
  const state    = document.getElementById('schoolStateInput').value.trim().toUpperCase();
  const zip      = document.getElementById('schoolZipInput').value.trim();
  const timezone = document.getElementById('schoolTimezoneInput').value;
  const lat      = parseFloat(document.getElementById('schoolLatInput').value) || null;
  const lon      = parseFloat(document.getElementById('schoolLonInput').value) || null;

  if (!name || !domain) { alert('School name and email domain are required.'); return; }

  const saveBtn = document.getElementById('addSchoolBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Creating…';

  const { data: school, error } = await supabase
    .from('schools')
    .insert({ name, short_name: short || null, email_domain: domain, phone: phone || null, address: address || null, city: city || null, state: state || null, zip: zip || null, timezone, weather_lat: lat, weather_lon: lon })
    .select('id')
    .single();

  if (error) {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Create School';
    alert('Failed to create school: ' + error.message);
    return;
  }

  const moduleRows = MODULES.map(m => ({
    school_id: school.id,
    module:    m.key,
    enabled:   !!document.getElementById(`addMod_${m.key}`)?.checked,
  }));

  const { error: modErr } = await supabase.from('school_modules').insert(moduleRows);

  saveBtn.disabled = false;
  saveBtn.textContent = 'Create School';

  if (modErr) { alert('School created but module settings failed to save: ' + modErr.message); }

  ['schoolNameInput', 'schoolShortInput', 'schoolDomainInput', 'schoolPhoneInput', 'schoolAddressInput', 'schoolCityInput', 'schoolStateInput', 'schoolZipInput', 'schoolLatInput', 'schoolLonInput'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const tzEl = document.getElementById('schoolTimezoneInput');
  if (tzEl) tzEl.value = 'America/New_York';
  MODULES.forEach(m => { const cb = document.getElementById(`addMod_${m.key}`); if (cb) cb.checked = false; });

  window.closeDrawer?.('schoolDrawer');
  await loadSchools();
}

/* ===============================
   EDIT
================================ */

let editingSchoolId = null;

function openEditSchoolDrawer(school) {
  editingSchoolId = school.id;

  document.getElementById('esSchoolTitle').textContent  = school.name;
  document.getElementById('esSchoolName').value         = school.name;
  document.getElementById('esSchoolShort').value        = school.short_name ?? '';
  document.getElementById('esSchoolDomain').value       = school.email_domain ?? '';
  document.getElementById('esSchoolPhone').value        = school.phone ?? '';
  document.getElementById('esSchoolAddress').value      = school.address ?? '';
  document.getElementById('esSchoolCity').value         = school.city ?? '';
  document.getElementById('esSchoolState').value        = school.state ?? '';
  document.getElementById('esSchoolZip').value          = school.zip ?? '';
  document.getElementById('esSchoolTimezone').value     = school.timezone ?? 'America/New_York';
  document.getElementById('esSchoolLat').value          = school.weather_lat ?? '';
  document.getElementById('esSchoolLon').value          = school.weather_lon ?? '';

  const enabledMap = {};
  (school.school_modules || []).forEach(m => { enabledMap[m.module] = m.enabled; });
  MODULES.forEach(m => {
    const cb = document.getElementById(`editMod_${m.key}`);
    if (cb) cb.checked = !!enabledMap[m.key];
  });

  const saveBtn = document.getElementById('esSchoolSaveBtn');
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  window.openDrawer?.('editSchoolDrawer');
}

async function saveEditSchool() {
  if (!editingSchoolId) return;

  const name     = document.getElementById('esSchoolName').value.trim();
  const short    = document.getElementById('esSchoolShort').value.trim();
  const domain   = document.getElementById('esSchoolDomain').value.trim().toLowerCase();
  const phone    = document.getElementById('esSchoolPhone').value.trim();
  const address  = document.getElementById('esSchoolAddress').value.trim();
  const city     = document.getElementById('esSchoolCity').value.trim();
  const state    = document.getElementById('esSchoolState').value.trim().toUpperCase();
  const zip      = document.getElementById('esSchoolZip').value.trim();
  const timezone = document.getElementById('esSchoolTimezone').value;
  const lat      = parseFloat(document.getElementById('esSchoolLat').value) || null;
  const lon      = parseFloat(document.getElementById('esSchoolLon').value) || null;

  if (!name || !domain) { alert('School name and email domain are required.'); return; }

  const saveBtn = document.getElementById('esSchoolSaveBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase
    .from('schools')
    .update({ name, short_name: short || null, email_domain: domain, phone: phone || null, address: address || null, city: city || null, state: state || null, zip: zip || null, timezone, weather_lat: lat, weather_lon: lon })
    .eq('id', editingSchoolId);

  if (error) {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save Changes';
    alert('Failed to save: ' + error.message);
    return;
  }

  const moduleRows = MODULES.map(m => ({
    school_id: editingSchoolId,
    module:    m.key,
    enabled:   !!document.getElementById(`editMod_${m.key}`)?.checked,
  }));

  await supabase.from('school_modules')
    .upsert(moduleRows, { onConflict: 'school_id,module' });

  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  window.closeDrawer?.('editSchoolDrawer');
  await loadSchools();
}

/* ===============================
   EVENTS
================================ */

function wireSchoolEvents() {
  document.getElementById('addSchoolBtn')?.addEventListener('click',    createSchool);
  document.getElementById('esSchoolSaveBtn')?.addEventListener('click', saveEditSchool);
  document.getElementById('esSchoolCancelBtn')?.addEventListener('click', () => window.closeDrawer?.('editSchoolDrawer'));
  document.getElementById('esSchoolCloseBtn')?.addEventListener('click',  () => window.closeDrawer?.('editSchoolDrawer'));
}
