
import { supabase } from './admin.supabase.js';
import { createDirectory } from './admin.directory.js';

let currentProfile;
let initialized    = false;
let carpoolsDir;
let editingId      = null;
let allFamilies    = [];
let editingMembers = []; // family_ids currently in the open carpool

/* ===============================
   ENTRY POINT
================================ */

export async function initCarpoolsSection(profile) {
  currentProfile = profile;

  if (!carpoolsDir) {
    carpoolsDir = createDirectory({
      table:        'carpools',
      schoolId:     () => currentProfile.school_id,
      select:       `id, tag_number, label, active,
                     carline_tags ( id, family_id,
                       families ( family_name, carline_tag_number ) )`,
      searchFields: ['tag_number', 'label'],
      defaultSort:  { column: 'tag_number', ascending: true },
      tbodySelector: '#carpoolsTable tbody',
      renderRow:    renderCarpoolRow,
    });
  }

  // Always refresh so the inherit dropdown is current
  await loadAllFamilies();

  if (!initialized) {
    wireCarpoolEvents();
    initialized = true;
  }

  carpoolsDir.load();
}

/* ===============================
   HELPERS
================================ */

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function avatarColor(seed) {
  const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = seed.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
}

async function loadAllFamilies() {
  const { data, error } = await supabase
    .from('families')
    .select('id, family_name, carline_tag_number')
    .eq('school_id', currentProfile.school_id)
    .order('family_name');
  if (error) {
    console.error('[Carpools] Failed to load families:', error.message);
    return;
  }
  allFamilies = data || [];
  populateInheritDropdown();
}

function populateInheritDropdown() {
  const sel = document.getElementById('carpoolInheritTag');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Or inherit a family\'s tag number —</option>';
  allFamilies.forEach(f => {
    const opt = document.createElement('option');
    opt.value       = f.carline_tag_number ?? '';
    opt.textContent = `${f.family_name ?? '(Unnamed)'} — #${f.carline_tag_number ?? '?'}`;
    sel.appendChild(opt);
  });
}

/* ===============================
   RENDER ROW
================================ */

function renderCarpoolRow(cp) {
  const members     = cp.carline_tags || [];
  const count       = members.length;
  const color       = avatarColor(cp.tag_number ?? '');
  const inactive    = cp.active ? '' : '<span class="staff-inactive-badge">Inactive</span>';
  const familyNames = members.map(ct => ct.families?.family_name ?? '?').join(', ');
  const displayName = cp.label || `Carpool #${cp.tag_number}`;

  const tr = document.createElement('tr');
  tr.className = 'dir-row-link';
  tr.innerHTML = `
    <td>
      <div class="staff-name-cell">
        <div class="staff-avatar carpool-avatar" style="background:${color}">#</div>
        <div class="staff-name-group">
          <span class="staff-fullname">${esc(displayName)}</span>
          ${inactive}
          <span class="staff-meta muted" style="font-size:12px;">${esc(familyNames) || 'No families assigned'}</span>
        </div>
        <span class="carline-tag-badge">#${esc(cp.tag_number)} &middot; ${count} famil${count === 1 ? 'y' : 'ies'}</span>
      </div>
    </td>
    <td class="staff-cell-chevron">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </td>
  `;
  tr.addEventListener('click', () => openEditDrawer(cp));
  return tr;
}

/* ===============================
   EDIT DRAWER
================================ */

function openEditDrawer(cp) {
  editingId      = cp.id;
  editingMembers = (cp.carline_tags || []).map(ct => ct.family_id);

  const color  = avatarColor(cp.tag_number ?? '');
  const avatar = document.getElementById('ecpAvatar');
  avatar.textContent      = '#';
  avatar.style.background = color;

  document.getElementById('ecpTitle').textContent    = cp.label || `Carpool #${cp.tag_number}`;
  document.getElementById('ecpSubtitle').textContent = `Tag #${cp.tag_number}`;

  document.getElementById('ecpTag').value      = cp.tag_number ?? '';
  document.getElementById('ecpLabel').value    = cp.label ?? '';
  document.getElementById('ecpActive').checked = !!cp.active;

  document.getElementById('ecpAddFamilyPicker').hidden = true;
  renderMemberList(cp.carline_tags || []);

  const saveBtn = document.getElementById('ecpSaveBtn');
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  window.openDrawer?.('editCarpoolDrawer');
}

function renderMemberList(tags) {
  const container = document.getElementById('ecpMemberList');
  container.innerHTML = '';

  if (!tags.length) {
    container.innerHTML = '<div class="muted" style="font-size:13px;padding:4px 0;">No families assigned yet.</div>';
    return;
  }

  tags.forEach(ct => {
    const f     = ct.families;
    const name  = f?.family_name ?? '(Unnamed)';
    const tag   = f?.carline_tag_number;
    const color = avatarColor(name);

    const row = document.createElement('div');
    row.className = 'carpool-member-row';
    row.innerHTML = `
      <div class="staff-avatar" style="background:${color};width:28px;height:28px;min-width:28px;font-size:12px;border-radius:50%;">${esc(name[0]?.toUpperCase() ?? '?')}</div>
      <div style="flex:1;min-width:0;">
        <span style="font-size:13px;font-weight:600;">${esc(name)}</span>
        ${tag ? `<span class="carline-tag-badge" style="margin-left:6px;">#${esc(tag)}</span>` : ''}
      </div>
      <button class="btn danger" style="padding:3px 10px;font-size:12px;" data-id="${ct.id}" data-fid="${ct.family_id}">Remove</button>
    `;
    row.querySelector('button').addEventListener('click', () => removeMember(ct.family_id, ct.id));
    container.appendChild(row);
  });
}

async function removeMember(familyId, tagRowId) {
  const { error } = await supabase.from('carline_tags').delete().eq('id', tagRowId);
  if (error) { alert('Failed to remove family: ' + error.message); return; }
  editingMembers = editingMembers.filter(id => id !== familyId);
  await refreshMemberList();
}

async function refreshMemberList() {
  const { data } = await supabase
    .from('carpools')
    .select('carline_tags ( id, family_id, families ( family_name, carline_tag_number ) )')
    .eq('id', editingId)
    .single();
  if (!data) return;
  const tags = data.carline_tags || [];
  editingMembers = tags.map(ct => ct.family_id);
  renderMemberList(tags);
}

/* ── Add-family picker ── */

function toggleAddFamilyPicker() {
  const picker = document.getElementById('ecpAddFamilyPicker');
  picker.hidden = !picker.hidden;
  if (!picker.hidden) {
    document.getElementById('ecpFamilySearch').value = '';
    renderFamilyOptions('');
    document.getElementById('ecpFamilySearch').focus();
  }
}

function renderFamilyOptions(search) {
  const list = document.getElementById('ecpFamilyOptions');
  const term = search.toLowerCase();
  const available = allFamilies.filter(f =>
    !editingMembers.includes(f.id) &&
    (!term ||
      (f.family_name ?? '').toLowerCase().includes(term) ||
      (f.carline_tag_number ?? '').includes(term))
  );

  list.innerHTML = '';
  if (!available.length) {
    list.innerHTML = '<div class="muted" style="font-size:13px;padding:6px 8px;">No families available</div>';
    return;
  }
  available.forEach(f => {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'carpool-family-option';
    btn.innerHTML = `
      <span>${esc(f.family_name ?? '(Unnamed)')}</span>
      ${f.carline_tag_number ? `<span class="carline-tag-badge">#${esc(f.carline_tag_number)}</span>` : ''}
    `;
    btn.addEventListener('click', () => addMember(f.id));
    list.appendChild(btn);
  });
}

async function addMember(familyId) {
  const { error } = await supabase.from('carline_tags').insert({
    carpool_id: editingId,
    family_id:  familyId,
  });
  if (error) { alert('Failed to add family: ' + error.message); return; }
  document.getElementById('ecpAddFamilyPicker').hidden = true;
  await refreshMemberList();
}

/* ── Save / Delete ── */

async function saveEditCarpool() {
  if (!editingId) return;
  const tag   = document.getElementById('ecpTag').value.trim();
  const label = document.getElementById('ecpLabel').value.trim();
  if (!tag) { alert('Tag number is required.'); return; }

  const saveBtn = document.getElementById('ecpSaveBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase.from('carpools').update({
    tag_number: tag,
    label:      label || null,
    active:     document.getElementById('ecpActive').checked,
  }).eq('id', editingId);

  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  if (error) { alert('Failed to save: ' + error.message); return; }
  window.closeDrawer?.('editCarpoolDrawer');
  carpoolsDir.load();
}

function confirmDelete() {
  if (!editingId) return;
  const tag   = document.getElementById('ecpTag').value;
  const label = document.getElementById('ecpLabel').value;
  document.getElementById('deleteCarpoolMsg').textContent =
    `Are you sure you want to delete "${label || `Carpool #${tag}`}"? All family assignments will also be removed. This cannot be undone.`;
  document.getElementById('deleteCarpoolModal').hidden = false;
}

async function executeDelete() {
  if (!editingId) return;
  const { error } = await supabase.from('carpools').delete().eq('id', editingId);
  document.getElementById('deleteCarpoolModal').hidden = true;
  if (error) { alert('Failed to delete: ' + error.message); return; }
  window.closeDrawer?.('editCarpoolDrawer');
  editingId = null;
  carpoolsDir.load();
}

/* ===============================
   CREATE
================================ */

async function createCarpool() {
  const tag   = document.getElementById('carpoolTag')?.value.trim();
  const label = document.getElementById('carpoolLabel')?.value.trim();
  if (!tag) { alert('Carpool tag number is required.'); return; }

  const { error } = await supabase.from('carpools').insert({
    school_id:  currentProfile.school_id,
    tag_number: tag,
    label:      label || null,
    active:     true,
  });

  if (error) { alert('Failed to create carpool (duplicate tag number?): ' + error.message); return; }

  document.getElementById('carpoolTag').value        = '';
  document.getElementById('carpoolLabel').value      = '';
  document.getElementById('carpoolInheritTag').value = '';

  window.closeDrawer?.('carpoolDrawer');
  carpoolsDir.load();
}

/* ===============================
   WIRE EVENTS
================================ */

function wireCarpoolEvents() {
  document.getElementById('addCarpool')?.addEventListener('click', createCarpool);

  document.getElementById('carpoolInheritTag')?.addEventListener('change', e => {
    if (e.target.value) document.getElementById('carpoolTag').value = e.target.value;
  });

  const searchInput = document.getElementById('carpoolSearch');
  const sortSelect  = document.getElementById('carpoolSort');

  if (searchInput) {
    let t;
    searchInput.addEventListener('input', e => {
      clearTimeout(t);
      t = setTimeout(() => carpoolsDir.setSearch(e.target.value.trim()), 300);
    });
  }
  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      const [col, dir] = e.target.value.split('.');
      carpoolsDir.setSort(col, dir === 'asc');
    });
  }

  // Edit drawer
  document.getElementById('ecpSaveBtn')?.addEventListener('click',      saveEditCarpool);
  document.getElementById('ecpCancelBtn')?.addEventListener('click',    () => window.closeDrawer?.('editCarpoolDrawer'));
  document.getElementById('ecpCloseBtn')?.addEventListener('click',     () => window.closeDrawer?.('editCarpoolDrawer'));
  document.getElementById('ecpDeleteBtn')?.addEventListener('click',    confirmDelete);
  document.getElementById('ecpAddFamilyBtn')?.addEventListener('click', toggleAddFamilyPicker);

  document.getElementById('ecpFamilySearch')?.addEventListener('input', e => {
    renderFamilyOptions(e.target.value);
  });

  // Delete modal
  document.getElementById('deleteCarpoolCancel')?.addEventListener('click',  () => { document.getElementById('deleteCarpoolModal').hidden = true; });
  document.getElementById('deleteCarpoolConfirm')?.addEventListener('click', executeDelete);
}
