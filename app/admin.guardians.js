
import { supabase } from './admin.supabase.js';
import { loadFamilyOptions } from './admin.shared.js';
import { createDirectory } from './admin.directory.js';

let currentProfile;
let initialized = false;
let guardiansDirectory;
let editingGuardianId = null;

/* ===============================
   ENTRY POINT
================================ */

export async function initGuardiansSection(profile) {
  currentProfile = profile;

  await loadFamilyOptions(['#guardianFamily'], currentProfile.school_id);

  if (!guardiansDirectory) {
    guardiansDirectory = createDirectory({
      table: 'guardians',
      schoolId: () => currentProfile.school_id,

      select: `
        id,
        first_name,
        last_name,
        email,
        phone,
        active,
        family_id,
        families!inner(carline_tag_number, family_name)
      `,

      searchFields: ['first_name', 'last_name', 'email', 'phone'],

      defaultSort: { column: 'last_name', ascending: true },

      columnCount: 5,
      tbodySelector: '#guardiansTable tbody',
      paginationContainer: '#guardiansPagination',
      renderRow: renderGuardianRow,

      augmentQuery(query, searchTerm) {
        if (!searchTerm) return query;
        const term = `%${searchTerm}%`;
        if (/^\d+$/.test(searchTerm)) {
          return {
            query: query.or(`carline_tag_number.ilike.${term}`, { foreignTable: 'families' }),
            skipBaseSearch: true
          };
        }
        return query;
      }
    });
  }

  if (!initialized) {
    wireGuardianEvents();
    initialized = true;
  }

  guardiansDirectory.load();
}

/* ===============================
   HELPERS
================================ */

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getAvatarColor(name) {
  const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function cloneSelectOptions(sourceId, target, selectedValue) {
  target.innerHTML = '';
  document.querySelectorAll(`${sourceId} option`).forEach(opt =>
    target.appendChild(opt.cloneNode(true))
  );
  target.value = selectedValue ?? '';
}

/* ===============================
   RENDER ROW
================================ */

function renderGuardianRow(g) {
  const initials = `${g.first_name?.[0] ?? ''}${g.last_name?.[0] ?? ''}`.toUpperCase();
  const color    = getAvatarColor((g.first_name ?? '') + (g.last_name ?? ''));
  const inactive = g.active ? '' : '<span class="staff-inactive-badge">Inactive</span>';

  const familyLabel = g.families
    ? `${g.families.carline_tag_number ? '#' + g.families.carline_tag_number + ' · ' : ''}${g.families.family_name ?? ''}`
    : '—';

  const tr = document.createElement('tr');
  tr.className = 'dir-row-link';
  tr.innerHTML = `
    <td>
      <div class="staff-name-cell">
        <div class="staff-avatar" style="background:${color}">${initials}</div>
        <div class="staff-name-group">
          <span class="staff-fullname">${esc(g.first_name)} ${esc(g.last_name)}</span>
          ${inactive}
        </div>
      </div>
    </td>
    <td class="staff-cell-muted">${esc(familyLabel)}</td>
    <td class="staff-cell-muted">${esc(g.email ?? '—')}</td>
    <td class="staff-cell-muted">${esc(g.phone ?? '—')}</td>
    <td class="staff-cell-chevron">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </td>
  `;

  tr.addEventListener('click', () => {
    if (!currentProfile?.can_manage_guardians) return;
    openEditGuardianDrawer(g);
  });
  return tr;
}

/* ===============================
   EDIT DRAWER
================================ */

function openEditGuardianDrawer(g) {
  editingGuardianId = g.id;

  const initials = `${g.first_name?.[0] ?? ''}${g.last_name?.[0] ?? ''}`.toUpperCase();
  const color    = getAvatarColor((g.first_name ?? '') + (g.last_name ?? ''));

  const avatar = document.getElementById('egAvatar');
  avatar.textContent      = initials;
  avatar.style.background = color;

  document.getElementById('egTitle').textContent    = `${g.first_name} ${g.last_name}`;
  document.getElementById('egSubtitle').textContent = g.families?.family_name ?? '';

  cloneSelectOptions('#guardianFamily', document.getElementById('egFamily'), g.family_id);
  document.getElementById('egFirst').value  = g.first_name ?? '';
  document.getElementById('egLast').value   = g.last_name ?? '';
  document.getElementById('egEmail').value  = g.email ?? '';
  document.getElementById('egPhone').value  = g.phone ?? '';
  document.getElementById('egActive').checked = !!g.active;

  const saveBtn = document.getElementById('egSaveBtn');
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  window.openDrawer?.('editGuardianDrawer');
}

async function saveEditGuardian() {
  if (!editingGuardianId) return;

  const first  = document.getElementById('egFirst').value.trim();
  const last   = document.getElementById('egLast').value.trim();
  const family = document.getElementById('egFamily').value;
  if (!first || !last || !family) { alert('First name, last name, and family are required.'); return; }

  const updated = {
    first_name: first,
    last_name:  last,
    family_id:  family,
    email:      document.getElementById('egEmail').value.trim() || null,
    phone:      document.getElementById('egPhone').value.trim() || null,
    active:     document.getElementById('egActive').checked,
  };

  const saveBtn = document.getElementById('egSaveBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase.from('guardians').update(updated).eq('id', editingGuardianId);

  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  if (error) { alert('Failed to save: ' + error.message); return; }
  window.closeDrawer?.('editGuardianDrawer');
  guardiansDirectory.load();
}

function confirmDeleteGuardian() {
  if (!editingGuardianId) return;
  const name = `${document.getElementById('egFirst').value} ${document.getElementById('egLast').value}`;
  document.getElementById('deleteGuardianMsg').textContent =
    `Are you sure you want to delete ${name}? This cannot be undone.`;
  document.getElementById('deleteGuardianModal').hidden = false;
}

async function executeDeleteGuardian() {
  if (!editingGuardianId) return;
  const { error } = await supabase.from('guardians').delete().eq('id', editingGuardianId);
  document.getElementById('deleteGuardianModal').hidden = true;
  if (error) { alert('Failed to delete: ' + error.message); return; }
  window.closeDrawer?.('editGuardianDrawer');
  editingGuardianId = null;
  guardiansDirectory.load();
}

/* ===============================
   CREATE
================================ */

async function createGuardian() {
  if (!currentProfile?.can_manage_guardians) {
    alert('You do not have permission to manage guardians.');
    return;
  }

  const guardian = {
    school_id:  currentProfile.school_id,
    family_id:  document.getElementById('guardianFamily').value,
    first_name: document.getElementById('guardianFirst').value.trim(),
    last_name:  document.getElementById('guardianLast').value.trim(),
    email:      document.getElementById('guardianEmail').value.trim() || null,
    phone:      document.getElementById('guardianPhone').value.trim() || null,
    active:     true
  };

  if (!guardian.first_name || !guardian.last_name || !guardian.family_id) {
    alert('First name, last name, and family are required.');
    return;
  }

  const { error } = await supabase.from('guardians').insert(guardian);
  if (error) { alert('Failed to add guardian'); return; }

  ['guardianFirst', 'guardianLast', 'guardianEmail', 'guardianPhone'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const fam = document.getElementById('guardianFamily'); if (fam) fam.value = '';

  window.closeDrawer?.('guardianDrawer');
  guardiansDirectory.load();
}

/* ===============================
   EVENTS
================================ */

function wireGuardianEvents() {
  document.getElementById('addGuardian')?.addEventListener('click', createGuardian);

  const searchInput = document.getElementById('guardianSearch');
  const sortSelect  = document.getElementById('guardianSort');

  if (searchInput) {
    let t;
    searchInput.addEventListener('input', e => {
      clearTimeout(t);
      t = setTimeout(() => guardiansDirectory.setSearch(e.target.value.trim()), 300);
    });
  }
  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      const [column, dir] = e.target.value.split('.');
      guardiansDirectory.setSort(column, dir === 'asc');
    });
  }

  document.getElementById('exportGuardiansCurrent')?.addEventListener('click', () => guardiansDirectory.exportFiltered());
  document.getElementById('exportGuardiansAll')?.addEventListener('click',     () => guardiansDirectory.exportAll());

  // Edit drawer (only wired if user has permission)
  if (currentProfile?.can_manage_guardians) {
    document.getElementById('egSaveBtn')?.addEventListener('click',   saveEditGuardian);
    document.getElementById('egCancelBtn')?.addEventListener('click', () => window.closeDrawer?.('editGuardianDrawer'));
    document.getElementById('egCloseBtn')?.addEventListener('click',  () => window.closeDrawer?.('editGuardianDrawer'));
    document.getElementById('egDeleteBtn')?.addEventListener('click', confirmDeleteGuardian);

    document.getElementById('deleteGuardianCancel')?.addEventListener('click',  () => { document.getElementById('deleteGuardianModal').hidden = true; });
    document.getElementById('deleteGuardianConfirm')?.addEventListener('click', executeDeleteGuardian);
  } else {
    // Still allow closing the drawer (shouldn't open, but defensive)
    document.getElementById('egCloseBtn')?.addEventListener('click', () => window.closeDrawer?.('editGuardianDrawer'));
  }
}
