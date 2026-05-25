import { supabase } from './admin.supabase.js';
import { initPage } from './admin.auth.js';
import { esc, fmtShortDate } from './admin.shared.js';

let currentProfile = null;
let managedCatIds  = [];
let submissions    = [];
let filterCatId    = '';
let filterStatus   = '';

(async () => {
  currentProfile = await initPage({});
  if (!currentProfile) return;

  // Determine which categories this user manages
  await loadManagedCategories();

  if (!managedCatIds.length && !currentProfile.is_superadmin && !currentProfile.can_access_admin) {
    document.getElementById('reqmListWrap').innerHTML =
      '<p style="color:#9ca3af;">You are not assigned as a manager for any request forms.</p>';
    return;
  }

  document.getElementById('reqmFilters').style.display = '';
  await loadSubmissions();
  renderList();
  wireFilters();
  wireDrawer();
})();

async function loadManagedCategories() {
  const { data } = await supabase
    .from('request_category_managers')
    .select('category_id, request_categories ( id, name )')
    .eq('profile_id', currentProfile.id);

  managedCatIds = (data ?? []).map(r => r.category_id);

  // Populate category filter dropdown
  const sel = document.getElementById('reqmFilterCat');
  (data ?? []).forEach(r => {
    const cat = r.request_categories;
    if (!cat) return;
    const opt = new Option(cat.name, cat.id);
    sel.appendChild(opt);
  });
}

async function loadSubmissions() {
  let q = supabase
    .from('staff_requests')
    .select(`
      id, status, created_at, manager_notes,
      request_categories ( name ),
      profiles!staff_requests_submitted_by_fkey ( display_name, email )
    `)
    .eq('school_id', currentProfile.school_id)
    .order('created_at', { ascending: false });

  // Non-admins: scope to managed categories only
  if (!currentProfile.is_superadmin && !currentProfile.can_access_admin && managedCatIds.length) {
    q = q.in('category_id', managedCatIds);
  }

  if (filterCatId)  q = q.eq('category_id', filterCatId);
  if (filterStatus) q = q.eq('status', filterStatus);

  const { data } = await q;
  submissions = data ?? [];
}

function renderList() {
  const wrap = document.getElementById('reqmListWrap');
  if (!wrap) return;

  if (!submissions.length) {
    wrap.innerHTML = '<div style="color:#9ca3af;padding:16px 0;">No submissions found.</div>';
    return;
  }

  wrap.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Submitted By</th>
          <th>Form</th>
          <th>Date</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${submissions.map(s => {
          const name = s.profiles?.display_name ?? s.profiles?.email ?? 'Unknown';
          return `
            <tr class="reqm-row" data-id="${esc(s.id)}" style="cursor:pointer;">
              <td>${esc(name)}</td>
              <td>${esc(s.request_categories?.name ?? '—')}</td>
              <td>${fmtShortDate(s.created_at)}</td>
              <td><span class="req-status-badge ${statusBadgeClass(s.status)}">${statusLabel(s.status)}</span></td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  wrap.querySelectorAll('.reqm-row').forEach(row => {
    row.addEventListener('click', () => {
      const sub = submissions.find(s => s.id === row.dataset.id);
      if (sub) openDrawer(sub);
    });
  });
}

function wireFilters() {
  document.getElementById('reqmFilterCat').addEventListener('change', async (e) => {
    filterCatId = e.target.value;
    await loadSubmissions();
    renderList();
  });
  document.getElementById('reqmFilterStatus').addEventListener('change', async (e) => {
    filterStatus = e.target.value;
    await loadSubmissions();
    renderList();
  });
}

function wireDrawer() {
  document.getElementById('reqmDrawerClose').addEventListener('click', closeDrawer);
  document.getElementById('reqmOverlay').addEventListener('click', closeDrawer);
}

async function openDrawer(sub) {
  const titleEl = document.getElementById('reqmDrawerTitle');
  const bodyEl  = document.getElementById('reqmDrawerBody');
  titleEl.textContent = sub.request_categories?.name ?? 'Request';
  bodyEl.innerHTML = '<p style="color:#9ca3af;padding:16px;">Loading…</p>';

  document.getElementById('reqmDrawer').style.display  = '';
  document.getElementById('reqmOverlay').style.display = '';

  const { data: responses } = await supabase
    .from('staff_request_responses')
    .select('value, request_category_fields ( label, field_type, sort_order )')
    .eq('request_id', sub.id)
    .order('request_category_fields(sort_order)');

  const name = sub.profiles?.display_name ?? sub.profiles?.email ?? 'Unknown';

  bodyEl.innerHTML = `
    <div style="margin-bottom:16px;font-size:13px;color:#6b7280;">
      Submitted by <strong>${esc(name)}</strong> on ${fmtShortDate(sub.created_at)}
    </div>

    <div class="req-responses">
      ${(responses ?? []).map(r => `
        <div class="req-response-row">
          <div class="req-response-label">${esc(r.request_category_fields?.label ?? 'Field')}</div>
          <div class="req-response-value">${esc(formatVal(r.value, r.request_category_fields?.field_type))}</div>
        </div>`).join('') || '<p style="color:#9ca3af;">No responses recorded.</p>'}
    </div>

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />
    <div class="form-group">
      <label class="form-label">Status</label>
      <select id="reqmSubStatus" class="form-control" style="width:180px;">
        <option value="pending"   ${sub.status === 'pending'   ? 'selected' : ''}>Pending</option>
        <option value="in_review" ${sub.status === 'in_review' ? 'selected' : ''}>In Review</option>
        <option value="resolved"  ${sub.status === 'resolved'  ? 'selected' : ''}>Resolved</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Notes <span style="font-weight:400;color:#9ca3af;">(visible to submitter)</span></label>
      <textarea id="reqmSubNotes" class="form-control" rows="3" placeholder="Optional notes…">${esc(sub.manager_notes ?? '')}</textarea>
    </div>
    <div style="margin-top:16px;display:flex;gap:8px;">
      <button class="btn btn-primary" id="reqmSaveBtn">Save</button>
      <button class="btn btn-secondary" id="reqmCloseBtn">Close</button>
    </div>
    <p id="reqmSaveError" style="color:#dc2626;font-size:13px;margin-top:8px;display:none;"></p>
  `;

  document.getElementById('reqmSaveBtn').addEventListener('click', () => saveRequest(sub.id));
  document.getElementById('reqmCloseBtn').addEventListener('click', closeDrawer);
}

async function saveRequest(requestId) {
  const status = document.getElementById('reqmSubStatus')?.value;
  const notes  = document.getElementById('reqmSubNotes')?.value.trim();
  const errEl  = document.getElementById('reqmSaveError');
  const btn    = document.getElementById('reqmSaveBtn');

  btn.disabled = true;
  btn.textContent = 'Saving…';

  const { error } = await supabase
    .from('staff_requests')
    .update({ status, manager_notes: notes || null, updated_at: new Date().toISOString() })
    .eq('id', requestId);

  if (error) {
    if (errEl) { errEl.textContent = 'Save failed: ' + error.message; errEl.style.display = ''; }
    btn.disabled = false;
    btn.textContent = 'Save';
    return;
  }

  closeDrawer();
  await loadSubmissions();
  renderList();
}

function closeDrawer() {
  document.getElementById('reqmDrawer').style.display  = 'none';
  document.getElementById('reqmOverlay').style.display = 'none';
}

function formatVal(val, type) {
  if (!val) return '—';
  if (type === 'boolean') return val === 'true' ? 'Yes' : 'No';
  return val;
}
function statusLabel(s) {
  return { pending: 'Pending', in_review: 'In Review', resolved: 'Resolved' }[s] ?? s;
}
function statusBadgeClass(s) {
  return { pending: 'badge-amber', in_review: 'badge-blue', resolved: 'badge-green' }[s] ?? '';
}
