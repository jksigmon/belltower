
import { supabase } from './admin.supabase.js';
import { createDirectory } from './admin.directory.js';
import { esc, getAvatarColor } from './admin.shared.js';

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
        route_number,
        route_type,
        driver,
        monitor,
        capacity
      `,

      searchFields: ['name', 'route_number', 'driver'],
      defaultSort: { column: 'name', ascending: true },
      columnCount: 5,

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
   RENDER ROW
================================ */

function renderBusGroupRow(bg) {
  const initial = (bg.name ?? '?')[0].toUpperCase();
  const color   = getAvatarColor(bg.name ?? '');

  const routeTypeBadge = bg.route_type
    ? `<span class="route-type-badge route-type-${bg.route_type.replace('/', '')}">${esc(bg.route_type)}</span>`
    : '<span class="staff-cell-muted">—</span>';

  const tr = document.createElement('tr');
  tr.className = 'dir-row-link';
  tr.innerHTML = `
    <td>
      <div class="staff-name-cell">
        <div class="staff-avatar" style="background:${color}">${initial}</div>
        <div class="staff-name-group">
          <span class="staff-fullname">${esc(bg.name)}</span>
          ${bg.route_number ? `<span class="muted" style="font-size:12px;">Route ${esc(bg.route_number)}</span>` : ''}
        </div>
      </div>
    </td>
    <td>${routeTypeBadge}</td>
    <td class="staff-cell-muted">${bg.driver ? esc(bg.driver) : '—'}</td>
    <td class="staff-cell-muted">${bg.capacity != null ? bg.capacity : '—'}</td>
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

  document.getElementById('ebgTitle').textContent = bg.name;

  const subtitleParts = [];
  if (bg.route_number) subtitleParts.push(`Route ${bg.route_number}`);
  if (bg.route_type)   subtitleParts.push(bg.route_type);
  document.getElementById('ebgSubtitle').textContent = subtitleParts.join(' · ');

  document.getElementById('ebgName').value      = bg.name ?? '';
  document.getElementById('ebgRoute').value     = bg.route_number ?? '';
  document.getElementById('ebgRouteType').value = bg.route_type ?? '';
  document.getElementById('ebgDriver').value    = bg.driver ?? '';
  document.getElementById('ebgMonitor').value   = bg.monitor ?? '';
  document.getElementById('ebgCapacity').value  = bg.capacity ?? '';

  const saveBtn = document.getElementById('ebgSaveBtn');
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  loadDrawerStudents(bg.id);
  window.openDrawer?.('editBusGroupDrawer');
}

async function saveEditBusGroup() {
  if (!editingBusGroupId) return;

  const name = document.getElementById('ebgName').value.trim();
  if (!name) { alert('Bus group name is required.'); return; }

  const capacityVal = document.getElementById('ebgCapacity').value.trim();

  const updated = {
    name,
    route_number: document.getElementById('ebgRoute').value.trim() || null,
    route_type:   document.getElementById('ebgRouteType').value || null,
    driver:       document.getElementById('ebgDriver').value.trim() || null,
    monitor:      document.getElementById('ebgMonitor').value.trim() || null,
    capacity:     capacityVal ? parseInt(capacityVal, 10) : null,
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

/* ===============================
   STUDENTS ON ROUTE
================================ */

async function loadDrawerStudents(busGroupId) {
  const container = document.getElementById('ebgStudentsList');
  if (!container) return;
  container.innerHTML = '<span class="muted" style="font-size:13px;">Loading…</span>';

  const { data, error } = await supabase
    .from('students')
    .select('id, first_name, last_name, grade_level')
    .eq('bus_group_id', busGroupId)
    .eq('active', true)
    .order('last_name', { ascending: true });

  if (error) {
    container.innerHTML = '<span class="muted" style="font-size:13px;">Failed to load.</span>';
    return;
  }

  if (!data?.length) {
    container.innerHTML = '<span class="muted" style="font-size:13px;">No active students on this route.</span>';
    return;
  }

  container.innerHTML = data.map(s => `
    <div class="bus-student-chip">
      <span class="bus-student-name">${esc(s.last_name)}, ${esc(s.first_name)}</span>
      ${s.grade_level ? `<span class="bus-student-grade">${esc(s.grade_level)}</span>` : ''}
    </div>
  `).join('');
}

/* ===============================
   DELETE
================================ */

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
  const name      = document.getElementById('busName')?.value.trim();
  const route     = document.getElementById('busRoute')?.value.trim();
  const routeType = document.getElementById('busRouteType')?.value;
  const driver    = document.getElementById('busDriver')?.value.trim();
  const monitor   = document.getElementById('busMonitor')?.value.trim();
  const capacity  = document.getElementById('busCapacity')?.value.trim();

  if (!name) { alert('Please enter a bus group name.'); return; }

  const { error } = await supabase.from('bus_groups').insert({
    school_id:    currentProfile.school_id,
    name,
    route_number: route || null,
    route_type:   routeType || null,
    driver:       driver || null,
    monitor:      monitor || null,
    capacity:     capacity ? parseInt(capacity, 10) : null,
  });

  if (error) { alert('Failed to create bus group: ' + error.message); return; }

  ['busName', 'busRoute', 'busDriver', 'busMonitor', 'busCapacity'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const rt = document.getElementById('busRouteType'); if (rt) rt.value = '';

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
