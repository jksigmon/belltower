
import { supabase } from './admin.supabase.js';
import { createDirectory } from './admin.directory.js';
import { esc, getAvatarColor } from './admin.shared.js';

let currentProfile;
let initialized = false;
let familiesDirectory;
let editingFamilyId = null;

/* ===============================
   ENTRY POINT
================================ */

export async function initFamiliesSection(profile) {
  currentProfile = profile;

  if (!familiesDirectory) {
    familiesDirectory = createDirectory({
      table: 'families',
      schoolId: () => currentProfile.school_id,

      select: `
        id,
        carline_tag_number,
        family_name,
        active
      `,

      searchFields: ['carline_tag_number', 'family_name'],

      defaultSort: { column: 'carline_tag_number', ascending: true },

      tbodySelector: '#familiesTable tbody',
      paginationContainer: '#familiesPagination',
      renderRow: renderFamilyRow
    });
  }

  if (!initialized) {
    wireFamilyEvents();
    initialized = true;
  }

  familiesDirectory.load();
}

/* ===============================
   RENDER ROW
================================ */

function renderFamilyRow(f) {
  const initial = (f.family_name ?? '?')[0].toUpperCase();
  const color   = getAvatarColor(f.family_name ?? '');
  const inactive = f.active ? '' : '<span class="staff-inactive-badge">Inactive</span>';

  const tagBadge = f.carline_tag_number
    ? `<span class="carline-tag-badge">#${esc(f.carline_tag_number)}</span>`
    : '';

  const tr = document.createElement('tr');
  tr.className = 'dir-row-link';
  tr.innerHTML = `
    <td>
      <div class="staff-name-cell">
        <div class="staff-avatar" style="background:${color}">${initial}</div>
        <div class="staff-name-group">
          <span class="staff-fullname">${esc(f.family_name ?? '(Unnamed)')}</span>
          ${inactive}
        </div>
        ${tagBadge}
      </div>
    </td>
    <td class="staff-cell-chevron">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </td>
  `;

  tr.addEventListener('click', () => openEditFamilyDrawer(f));
  return tr;
}

/* ===============================
   EDIT DRAWER
================================ */

function openEditFamilyDrawer(f) {
  editingFamilyId = f.id;

  const initial = (f.family_name ?? '?')[0].toUpperCase();
  const color   = getAvatarColor(f.family_name ?? '');

  const avatar = document.getElementById('efAvatar');
  avatar.textContent      = initial;
  avatar.style.background = color;

  document.getElementById('efTitle').textContent    = f.family_name ?? '(Unnamed)';
  document.getElementById('efSubtitle').textContent = f.carline_tag_number ? `Tag #${f.carline_tag_number}` : '';

  document.getElementById('efTag').value    = f.carline_tag_number ?? '';
  document.getElementById('efName').value   = f.family_name ?? '';
  document.getElementById('efActive').checked = !!f.active;

  const saveBtn = document.getElementById('efSaveBtn');
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  window.openDrawer?.('editFamilyDrawer');
}

async function saveEditFamily() {
  if (!editingFamilyId) return;

  const tag  = document.getElementById('efTag').value.trim();
  const name = document.getElementById('efName').value.trim();
  if (!tag) { alert('Carline tag number is required.'); return; }

  const updated = {
    carline_tag_number: tag,
    family_name:        name || null,
    active:             document.getElementById('efActive').checked,
  };

  const saveBtn = document.getElementById('efSaveBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase.from('families').update(updated).eq('id', editingFamilyId);

  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  if (error) { alert('Failed to save: ' + error.message); return; }
  window.closeDrawer?.('editFamilyDrawer');
  familiesDirectory.load();
}

function confirmDeleteFamily() {
  if (!editingFamilyId) return;
  const name = document.getElementById('efName').value || '(Unnamed)';
  document.getElementById('deleteFamilyMsg').textContent =
    `Are you sure you want to delete ${name}? This cannot be undone.`;
  document.getElementById('deleteFamilyModal').hidden = false;
}

async function executeDeleteFamily() {
  if (!editingFamilyId) return;
  const { error } = await supabase.from('families').delete().eq('id', editingFamilyId);
  document.getElementById('deleteFamilyModal').hidden = true;
  if (error) { alert('Failed to delete: ' + error.message); return; }
  window.closeDrawer?.('editFamilyDrawer');
  editingFamilyId = null;
  familiesDirectory.load();
}

/* ===============================
   CREATE
================================ */

async function createFamily() {
  const tag  = document.getElementById('familyTag')?.value.trim();
  const name = document.getElementById('familyName')?.value.trim();

  if (!tag) { alert('Carline tag number is required.'); return; }

  const { error } = await supabase.from('families').insert({
    school_id:          currentProfile.school_id,
    carline_tag_number: tag,
    family_name:        name || null,
    active:             true
  });

  if (error) { alert('Failed to add family (duplicate tag?)'); return; }

  document.getElementById('familyTag').value  = '';
  document.getElementById('familyName').value = '';

  window.closeDrawer?.('familyDrawer');
  familiesDirectory.load();
}

/* ===============================
   EVENTS
================================ */

function wireFamilyEvents() {
  document.getElementById('addFamily')?.addEventListener('click', createFamily);

  const searchInput = document.getElementById('familySearch');
  const sortSelect  = document.getElementById('familySort');

  if (searchInput) {
    let t;
    searchInput.addEventListener('input', e => {
      clearTimeout(t);
      t = setTimeout(() => familiesDirectory.setSearch(e.target.value.trim()), 300);
    });
  }
  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      const [column, dir] = e.target.value.split('.');
      familiesDirectory.setSort(column, dir === 'asc');
    });
  }

  document.getElementById('exportFamiliesCurrent')?.addEventListener('click', () => familiesDirectory.exportFiltered());
  document.getElementById('exportFamiliesAll')?.addEventListener('click',     () => familiesDirectory.exportAll());

  // Edit drawer
  document.getElementById('efSaveBtn')?.addEventListener('click',   saveEditFamily);
  document.getElementById('efCancelBtn')?.addEventListener('click', () => window.closeDrawer?.('editFamilyDrawer'));
  document.getElementById('efCloseBtn')?.addEventListener('click',  () => window.closeDrawer?.('editFamilyDrawer'));
  document.getElementById('efDeleteBtn')?.addEventListener('click', confirmDeleteFamily);

  // Delete modal
  document.getElementById('deleteFamilyCancel')?.addEventListener('click',  () => { document.getElementById('deleteFamilyModal').hidden = true; });
  document.getElementById('deleteFamilyConfirm')?.addEventListener('click', executeDeleteFamily);
}
