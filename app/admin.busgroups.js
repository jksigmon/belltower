
import { supabase } from './admin.supabase.js';
import { createDirectory } from './admin.directory.js';

let currentProfile;
let initialized = false;
let busGroupsDirectory;
let editingBusGroupId = null;

/* ===============================
   ENTRY POINT
================================ */

export async function initBusGroupsSection(profile) {
  currentProfile = profile;

  if (!busGroupsDirectory) {
    busGroupsDirectory = createDirectory({
      table: 'bus_groups',
      schoolId: () => currentProfile.school_id,

      select: `
        id,
        name,
        route_number
      `,

      searchFields: ['name', 'route_number'],
      defaultSort: { column: 'name', ascending: true },

      tbodySelector: '#busTable tbody',
      renderRow: renderBusGroupRow
    });
  }

  if (!initialized) {
    wireBusGroupEvents();
    initialized = true;
  }

  busGroupsDirectory.load();
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

/* ===============================
   RENDER ROW
================================ */

function renderBusGroupRow(bg) {
  const initial = (bg.name ?? '?')[0].toUpperCase();
  const color   = getAvatarColor(bg.name ?? '');

  const routeBadge = bg.route_number
    ? `<span class="route-badge">${esc(bg.route_number)}</span>`
    : '';

  const tr = document.createElement('tr');
  tr.className = 'dir-row-link';
  tr.innerHTML = `
    <td>
      <div class="staff-name-cell">
        <div class="staff-avatar" style="background:${color}">${initial}</div>
        <div class="staff-name-group">
          <span class="staff-fullname">${esc(bg.name)}</span>
        </div>
        ${routeBadge}
      </div>
    </td>
    <td class="staff-cell-chevron">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </td>
  `;

  tr.addEventListener('click', () => openEditBusGroupDrawer(bg));
  return tr;
}

/* ===============================
   EDIT DRAWER
================================ */

function openEditBusGroupDrawer(bg) {
  editingBusGroupId = bg.id;

  const initial = (bg.name ?? '?')[0].toUpperCase();
  const color   = getAvatarColor(bg.name ?? '');

  const avatar = document.getElementById('ebgAvatar');
  avatar.textContent      = initial;
  avatar.style.background = color;

  document.getElementById('ebgTitle').textContent    = bg.name;
  document.getElementById('ebgSubtitle').textContent = bg.route_number ? `Route ${bg.route_number}` : '';

  document.getElementById('ebgName').value  = bg.name ?? '';
  document.getElementById('ebgRoute').value = bg.route_number ?? '';

  const saveBtn = document.getElementById('ebgSaveBtn');
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  window.openDrawer?.('editBusGroupDrawer');
}

async function saveEditBusGroup() {
  if (!editingBusGroupId) return;

  const name = document.getElementById('ebgName').value.trim();
  if (!name) { alert('Bus group name is required.'); return; }

  const updated = {
    name,
    route_number: document.getElementById('ebgRoute').value.trim() || null,
  };

  const saveBtn = document.getElementById('ebgSaveBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase.from('bus_groups').update(updated).eq('id', editingBusGroupId);

  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  if (error) { alert('Failed to save: ' + error.message); return; }
  window.closeDrawer?.('editBusGroupDrawer');
  busGroupsDirectory.load();
}

function confirmDeleteBusGroup() {
  if (!editingBusGroupId) return;
  const name = document.getElementById('ebgName').value;
  document.getElementById('deleteBusGroupMsg').textContent =
    `Are you sure you want to delete "${name}"? This cannot be undone.`;
  document.getElementById('deleteBusGroupModal').hidden = false;
}

async function executeDeleteBusGroup() {
  if (!editingBusGroupId) return;
  const { error } = await supabase.from('bus_groups').delete().eq('id', editingBusGroupId);
  document.getElementById('deleteBusGroupModal').hidden = true;
  if (error) { alert('Failed to delete: ' + error.message); return; }
  window.closeDrawer?.('editBusGroupDrawer');
  editingBusGroupId = null;
  busGroupsDirectory.load();
}

/* ===============================
   CREATE
================================ */

async function createBusGroup() {
  const name  = document.getElementById('busName')?.value.trim();
  const route = document.getElementById('busRoute')?.value.trim();

  if (!name) { alert('Please enter a bus group name.'); return; }

  const { error } = await supabase.from('bus_groups').insert({
    school_id:    currentProfile.school_id,
    name,
    route_number: route || null
  });

  if (error) { alert('Failed to create bus group'); return; }

  document.getElementById('busName').value  = '';
  document.getElementById('busRoute').value = '';

  window.closeDrawer?.('busGroupDrawer');
  busGroupsDirectory.load();
}

/* ===============================
   EVENTS
================================ */

function wireBusGroupEvents() {
  document.getElementById('addBusGroup')?.addEventListener('click', createBusGroup);

  const searchInput = document.getElementById('busSearch');
  const sortSelect  = document.getElementById('busSort');

  if (searchInput) {
    let t;
    searchInput.addEventListener('input', e => {
      clearTimeout(t);
      t = setTimeout(() => busGroupsDirectory.setSearch(e.target.value.trim()), 300);
    });
  }
  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      const [column, dir] = e.target.value.split('.');
      busGroupsDirectory.setSort(column, dir === 'asc');
    });
  }

  document.getElementById('exportBusGroupsCurrent')?.addEventListener('click', () => busGroupsDirectory.exportFiltered());
  document.getElementById('exportBusGroupsAll')?.addEventListener('click',     () => busGroupsDirectory.exportAll());

  // Edit drawer
  document.getElementById('ebgSaveBtn')?.addEventListener('click',   saveEditBusGroup);
  document.getElementById('ebgCancelBtn')?.addEventListener('click', () => window.closeDrawer?.('editBusGroupDrawer'));
  document.getElementById('ebgCloseBtn')?.addEventListener('click',  () => window.closeDrawer?.('editBusGroupDrawer'));
  document.getElementById('ebgDeleteBtn')?.addEventListener('click', confirmDeleteBusGroup);

  // Delete modal
  document.getElementById('deleteBusGroupCancel')?.addEventListener('click',  () => { document.getElementById('deleteBusGroupModal').hidden = true; });
  document.getElementById('deleteBusGroupConfirm')?.addEventListener('click', executeDeleteBusGroup);
}
