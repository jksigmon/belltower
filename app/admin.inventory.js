// admin.inventory.js
// Oversight view: any list in the school, for admins / can_manage_inventory
// holders. Reuses the same grid renderer staff.html uses for "My Lists" so
// viewing/editing a list behaves identically regardless of entry point.
import { supabase } from './admin.supabase.js';
import { esc, fmtShortDate } from './admin.shared.js';
import { renderInventoryGrid, buildAssignmentMap, nextStatus, updateCellStatus, keyOf } from './inventory-grid.js';

let profile = null;
let lists = [];
let currentList = null;
let currentItems = [];
let currentStudents = [];
let currentAssignmentMap = {};

/* ===============================
   ENTRY POINT
================================ */
export async function initInventorySection(p) {
  profile = p;

  if (!profile.is_superadmin && profile.role !== 'admin' && !profile.can_manage_inventory) {
    document.getElementById('inventoryRoot').innerHTML =
      '<p class="muted" style="padding:40px;">You are not authorized to view inventory oversight.</p>';
    return;
  }

  wireEvents();
  showListView();
  await loadLists();
}

/* ===============================
   LIST OVERSIGHT VIEW
================================ */
async function loadLists() {
  const { data: listRows, error } = await supabase
    .from('inventory_lists')
    .select('id, name, owner_name, archived_at, created_at')
    .eq('school_id', profile.school_id)
    .order('archived_at', { ascending: true, nullsFirst: true })
    .order('name');

  if (error) { console.error('loadLists', error); return; }
  const listIds = (listRows || []).map(l => l.id);

  // Bulk queries (not one per list) to compute per-list counts and item labels.
  const [{ data: memberRows }, { data: assignmentRows }, { data: itemRows }] = await Promise.all([
    listIds.length
      ? supabase.from('inventory_list_members').select('list_id').in('list_id', listIds)
      : Promise.resolve({ data: [] }),
    listIds.length
      ? supabase.from('inventory_assignments').select('list_id, status').in('list_id', listIds)
      : Promise.resolve({ data: [] }),
    listIds.length
      ? supabase.from('inventory_list_items').select('list_id, label, sort_order').in('list_id', listIds).order('sort_order')
      : Promise.resolve({ data: [] }),
  ]);

  const memberCounts = {};
  (memberRows || []).forEach(m => { memberCounts[m.list_id] = (memberCounts[m.list_id] || 0) + 1; });

  const checkedOutCounts = {};
  (assignmentRows || []).forEach(a => {
    if (a.status === 'checked_out') checkedOutCounts[a.list_id] = (checkedOutCounts[a.list_id] || 0) + 1;
  });

  const itemsByList = {};
  (itemRows || []).forEach(it => {
    (itemsByList[it.list_id] ||= []).push(it.label);
  });

  lists = (listRows || []).map(l => ({
    ...l,
    studentCount: memberCounts[l.id] || 0,
    checkedOutCount: checkedOutCounts[l.id] || 0,
    items: itemsByList[l.id] || [],
  }));

  renderLists();
}

function renderLists() {
  const tbody = document.querySelector('#inventoryListsTable tbody');
  if (!tbody) return;

  if (!lists.length) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="admin-empty-state">
          <div class="admin-empty-state-icon"><i data-lucide="package"></i></div>
          <p class="admin-empty-state-title">No inventory lists yet</p>
          <p class="admin-empty-state-desc">Once a teacher creates a checkout list from the staff portal, it'll show up here for oversight.</p>
        </div>
      </td></tr>`;
    if (window.lucide) lucide.createIcons({ el: tbody });
    return;
  }

  tbody.innerHTML = lists.map(l => {
    const itemsHtml = l.items.length
      ? `<div class="inv-items-cell">${l.items.map(label => `<span class="inv-item-chip">${esc(label)}</span>`).join('')}</div>`
      : '<span class="muted" style="font-size:12px;">No items yet</span>';

    // Denominator is students × items — the max possible checkouts — so the
    // count reads as a completion ratio instead of a bare, contextless number.
    const maxPossible = l.studentCount * l.items.length;
    const checkedOutHtml = maxPossible
      ? `${l.checkedOutCount} / ${maxPossible}`
      : '<span class="muted">—</span>';

    return `
    <tr>
      <td>${esc(l.name)}</td>
      <td class="staff-cell-muted">${esc(l.owner_name)}</td>
      <td>${itemsHtml}</td>
      <td>${l.studentCount}</td>
      <td>${checkedOutHtml}</td>
      <td>${l.archived_at ? `<span class="staff-cell-muted">Archived ${fmtShortDate(l.archived_at)}</span>` : '<span class="module-pill">Active</span>'}</td>
      <td><button class="btn btn-sm inv-open-btn" data-id="${esc(l.id)}">Open</button></td>
    </tr>
  `;
  }).join('');

  tbody.querySelectorAll('.inv-open-btn').forEach(btn =>
    btn.addEventListener('click', () => openList(btn.dataset.id)));
}

/* ===============================
   LIST DETAIL (shared grid)
================================ */
async function openList(listId) {
  const list = lists.find(l => l.id === listId);
  if (!list) return;
  currentList = list;

  document.getElementById('inventoryDetailTitle').textContent = `${list.name} — ${list.owner_name}`;
  showDetailView();
  await loadListDetail(listId);
}

async function loadListDetail(listId) {
  const [{ data: items, error: itemsErr }, { data: members, error: membersErr }, { data: assignments, error: assignErr }] = await Promise.all([
    supabase.from('inventory_list_items').select('id, label, sort_order').eq('list_id', listId).order('sort_order'),
    supabase.from('inventory_list_members').select('student_id, students(id, first_name, last_name)').eq('list_id', listId),
    supabase.from('inventory_assignments').select('student_id, item_id, identifier, status').eq('list_id', listId),
  ]);

  if (itemsErr || membersErr || assignErr) {
    document.getElementById('inventoryGridContainer').innerHTML = '<p class="muted" style="padding:16px;">Failed to load list.</p>';
    return;
  }

  currentItems = items || [];
  currentStudents = (members || [])
    .map(m => m.students)
    .filter(Boolean)
    .sort((a, b) => a.last_name.localeCompare(b.last_name));
  currentAssignmentMap = buildAssignmentMap(assignments || []);

  renderGrid();
}

function renderGrid() {
  renderInventoryGrid(document.getElementById('inventoryGridContainer'), {
    students: currentStudents,
    items: currentItems,
    assignmentMap: currentAssignmentMap,
    canEdit: true,
    onIdentifierChange: updateIdentifier,
    onStatusCycle: cycleStatus,
    onBulkAction: bulkSetStatus,
  });
}

async function updateIdentifier(studentId, itemId, identifier) {
  const key = keyOf(studentId, itemId);
  const existing = currentAssignmentMap[key];

  const { error } = await supabase
    .from('inventory_assignments')
    .upsert({
      list_id: currentList.id,
      student_id: studentId,
      item_id: itemId,
      identifier: identifier || null,
      status: existing?.status ?? 'not_assigned',
    }, { onConflict: 'list_id,student_id,item_id', ignoreDuplicates: false });

  if (error) { alert('Failed to save identifier: ' + error.message); return; }

  // Update local state only — no reload/re-render. A full re-render here
  // would recreate every input in the grid, stealing focus from whatever
  // the user clicks or types next (the "click twice" / vanishing-text bug).
  currentAssignmentMap[key] = { ...existing, student_id: studentId, item_id: itemId, identifier: identifier || null };
}

async function cycleStatus(studentId, itemId, currentStatus) {
  const status = nextStatus(currentStatus);
  const now = new Date().toISOString();
  const key = keyOf(studentId, itemId);
  const existing = currentAssignmentMap[key];

  const { error } = await supabase
    .from('inventory_assignments')
    .upsert({
      list_id: currentList.id,
      student_id: studentId,
      item_id: itemId,
      identifier: existing?.identifier ?? null,
      status,
      checked_out_at: status === 'checked_out' ? now : (existing?.checked_out_at ?? null),
      returned_at: status === 'returned' ? now : (existing?.returned_at ?? null),
    }, { onConflict: 'list_id,student_id,item_id' });

  if (error) { alert('Failed to update status: ' + error.message); return; }

  currentAssignmentMap[key] = {
    ...existing,
    student_id: studentId,
    item_id: itemId,
    status,
    checked_out_at: status === 'checked_out' ? now : (existing?.checked_out_at ?? null),
    returned_at: status === 'returned' ? now : (existing?.returned_at ?? null),
  };
  updateCellStatus(document.getElementById('inventoryGridContainer'), studentId, itemId, status);
}

async function bulkSetStatus(itemId, status) {
  const now = new Date().toISOString();
  const rows = currentStudents.map(s => {
    const existing = currentAssignmentMap[keyOf(s.id, itemId)];
    return {
      list_id: currentList.id,
      student_id: s.id,
      item_id: itemId,
      identifier: existing?.identifier ?? null,
      status,
      checked_out_at: status === 'checked_out' ? now : (existing?.checked_out_at ?? null),
      returned_at: status === 'returned' ? now : (existing?.returned_at ?? null),
    };
  });

  const { error } = await supabase
    .from('inventory_assignments')
    .upsert(rows, { onConflict: 'list_id,student_id,item_id' });

  if (error) { alert('Bulk update failed: ' + error.message); return; }

  const gridEl = document.getElementById('inventoryGridContainer');
  rows.forEach(r => {
    const key = keyOf(r.student_id, r.item_id);
    currentAssignmentMap[key] = { ...currentAssignmentMap[key], ...r };
    updateCellStatus(gridEl, r.student_id, r.item_id, status);
  });

  await loadLists();
}

/* ===============================
   VIEW SWITCHING
================================ */
function showListView() {
  document.getElementById('inventoryListView').style.display = '';
  document.getElementById('inventoryDetailView').style.display = 'none';
}

function showDetailView() {
  document.getElementById('inventoryListView').style.display = 'none';
  document.getElementById('inventoryDetailView').style.display = '';
}

function wireEvents() {
  document.getElementById('inventoryBackBtn')?.addEventListener('click', async () => {
    showListView();
    await loadLists();
  });
}
