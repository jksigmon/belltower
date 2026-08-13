import { supabase } from './admin.supabase.js?v=2';
import { initPage } from './admin.auth.js?v=2';
import { esc, fmtShortDate } from './admin.shared.js?v=2';

let currentProfile = null;
let managedCatIds  = [];
let submissions    = [];
let filterCatId    = '';
let filterStatus   = '';

(async () => {
  currentProfile = await initPage({});
  if (!currentProfile) return;

  document.getElementById('signOut')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = '/login.html';
  });

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
    .select('category_id, request_categories ( id, name, resolved_label, allow_denial, denied_label )')
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
      request_categories ( name, resolved_label, allow_denial, denied_label ),
      profiles!staff_requests_submitted_by_fkey ( display_name, email ),
      staff_request_responses ( value, request_category_fields ( label, field_type, sort_order ) )
    `)
    .eq('school_id', currentProfile.school_id)
    .order('created_at', { ascending: false });

  // Non-admins: scope to managed categories, and within them only
  // submissions routed to me or unrouted (broadcast). Routing is a
  // workflow filter — admins still see everything.
  if (!currentProfile.is_superadmin && !currentProfile.can_access_admin && managedCatIds.length) {
    q = q.in('category_id', managedCatIds)
         .or(`assigned_manager_id.is.null,assigned_manager_id.eq.${currentProfile.id}`);
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
          <th style="width:160px;">Submitted By</th>
          <th style="width:140px;">Form</th>
          <th>Details</th>
          <th style="width:100px;">Date</th>
          <th style="width:110px;">Status</th>
        </tr>
      </thead>
      <tbody>
        ${submissions.map(s => {
          const name = s.profiles?.display_name ?? s.profiles?.email ?? 'Unknown';
          const preview = submissionPreview(s);
          return `
            <tr class="reqm-row" data-id="${esc(s.id)}" style="cursor:pointer;">
              <td>${esc(name)}</td>
              <td style="color:#6b7280;">${esc(s.request_categories?.name ?? '—')}</td>
              <td style="max-width:0;">${preview ? `<div class="req-sub-preview">${esc(preview)}</div>` : '<span style="color:#d1d5db;">—</span>'}</td>
              <td style="white-space:nowrap;">${fmtShortDate(s.created_at)}</td>
              <td><span class="req-status-badge ${statusBadgeClass(s.status)}">${statusLabel(s.status, s.request_categories)}</span></td>
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
  document.getElementById('reqmDrawerClose').addEventListener('click', handleCloseRequest);
  document.getElementById('reqmOverlay').addEventListener('click', handleCloseRequest);
  document.getElementById('reqmCloseBtn').addEventListener('click', handleCloseRequest);
  document.getElementById('reqmSaveBtn').addEventListener('click', () => saveRequest(currentRequestId));
}

// Snapshot of the notes textarea right after render, so a close can tell
// whether the manager typed something that never got saved.
let notesSnapshot = '';
let currentRequestId = null;

function handleCloseRequest() {
  const current = document.getElementById('reqmSubNotes')?.value.trim() ?? '';
  if (current !== notesSnapshot && !confirm('You have unsaved notes. Close without saving?')) return;
  closeDrawer();
}

async function openDrawer(sub) {
  const titleEl = document.getElementById('reqmDrawerTitle');
  const bodyEl  = document.getElementById('reqmDrawerBody');
  const errEl   = document.getElementById('reqmSaveError');
  currentRequestId = sub.id;
  titleEl.textContent = sub.request_categories?.name ?? 'Request';
  bodyEl.innerHTML = '<p style="color:#9ca3af;padding:16px;">Loading…</p>';
  errEl.style.display = 'none';

  document.getElementById('reqmDrawer').classList.add('open');
  document.getElementById('reqmOverlay').classList.add('open');

  const { data: responses } = await supabase
    .from('staff_request_responses')
    .select('value, request_category_fields ( label, field_type, sort_order )')
    .eq('request_id', sub.id)
    .order('request_category_fields(sort_order)');

  const name = sub.profiles?.display_name ?? sub.profiles?.email ?? 'Unknown';

  bodyEl.innerHTML = `
    <div class="reqm-meta">
      Submitted by <strong>${esc(name)}</strong> on ${fmtShortDate(sub.created_at)}
    </div>

    <div class="req-responses">
      ${(responses ?? []).map(r => `
        <div class="req-response-row">
          <div class="req-response-label">${esc(r.request_category_fields?.label ?? 'Field')}</div>
          <div class="req-response-value">${esc(formatVal(r.value, r.request_category_fields?.field_type))}</div>
        </div>`).join('') || '<p style="color:#9ca3af;">No responses recorded.</p>'}
    </div>

    <hr class="drawer-divider" />

    <div class="drawer-field">
      <label>Status</label>
      <select id="reqmSubStatus">
        <option value="pending"   ${sub.status === 'pending'   ? 'selected' : ''}>Pending</option>
        <option value="in_review" ${sub.status === 'in_review' ? 'selected' : ''}>In Review</option>
        <option value="resolved"  ${sub.status === 'resolved'  ? 'selected' : ''}>${esc(sub.request_categories?.resolved_label || 'Resolved')}</option>
        ${(sub.request_categories?.allow_denial || sub.status === 'denied')
          ? `<option value="denied" ${sub.status === 'denied' ? 'selected' : ''}>${esc(sub.request_categories?.denied_label || 'Denied')}</option>`
          : ''}
      </select>
    </div>
    <div class="drawer-field">
      <label>Notes <span style="text-transform:none;font-weight:400;letter-spacing:0;color:#9ca3af;">(visible to submitter)</span></label>
      <textarea id="reqmSubNotes" rows="3" placeholder="Optional notes…">${esc(sub.manager_notes ?? '')}</textarea>
    </div>
  `;

  notesSnapshot = sub.manager_notes?.trim() ?? '';
}

async function saveRequest(requestId) {
  const status = document.getElementById('reqmSubStatus')?.value;
  const notes  = document.getElementById('reqmSubNotes')?.value.trim();
  const errEl  = document.getElementById('reqmSaveError');
  const btn    = document.getElementById('reqmSaveBtn');

  btn.disabled = true;
  btn.textContent = 'Saving…';

  const { data, error } = await supabase
    .from('staff_requests')
    .update({ status, manager_notes: notes || null, updated_at: new Date().toISOString() })
    .eq('id', requestId)
    .select('id');

  // A denied RLS update matches zero rows without raising an error, so an
  // empty result has to be treated as a failure too — otherwise the drawer
  // closes as if the note saved when it silently didn't.
  if (error || !data?.length) {
    if (errEl) { errEl.textContent = 'Save failed: ' + (error?.message ?? 'you may not have permission to update this request.'); errEl.style.display = ''; }
    btn.disabled = false;
    btn.textContent = 'Save';
    return;
  }

  btn.disabled = false;
  btn.textContent = 'Save';
  notesSnapshot = notes;
  closeDrawer();
  await loadSubmissions();
  renderList();

  // Notify the submitter (fire and forget — don't block on email)
  supabase.functions.invoke('send_request_update_notification', { body: { request_id: requestId } })
    .catch(err => console.error('update notification failed', err));
}

function closeDrawer() {
  document.getElementById('reqmDrawer').classList.remove('open');
  document.getElementById('reqmOverlay').classList.remove('open');
}

function submissionPreview(sub) {
  const rows = (sub.staff_request_responses ?? [])
    .filter(r => r.request_category_fields?.field_type !== 'file' && r.value)
    .sort((a, b) => (a.request_category_fields?.sort_order ?? 0) - (b.request_category_fields?.sort_order ?? 0))
    .slice(0, 3);
  if (!rows.length) return '';
  return rows.map(r => {
    let val = r.request_category_fields?.field_type === 'boolean'
      ? (r.value === 'true' ? 'Yes' : 'No')
      : r.value;
    if (val.length > 48) val = val.slice(0, 48) + '…';
    const label = r.request_category_fields?.label;
    return label ? `${label}: ${val}` : val;
  }).join(' · ');
}

function formatVal(val, type) {
  if (!val) return '—';
  if (type === 'boolean') return val === 'true' ? 'Yes' : 'No';
  return val;
}
function statusLabel(s, cat) {
  if (s === 'resolved') return cat?.resolved_label || 'Resolved';
  if (s === 'denied')   return cat?.denied_label   || 'Denied';
  return { pending: 'Pending', in_review: 'In Review' }[s] ?? s;
}
function statusBadgeClass(s) {
  return { pending: 'badge-amber', in_review: 'badge-blue', resolved: 'badge-green', denied: 'badge-red' }[s] ?? '';
}
