import { supabase } from './admin.supabase.js?v=2';
import { initPage } from './admin.auth.js?v=2';
import { esc, fmtShortDate, showToast, fetchAllRows } from './admin.shared.js?v=3';
import { exportSubmissions, exportOneSubmission } from './requests.export.js?v=1';
import { renderPager, pageSlice, pageCount } from './requests.pager.js';

const OPEN_STATUSES = ['pending', 'in_review'];

let currentProfile = null;
let managedCatIds  = [];
let submissions    = [];
let filterCatId    = '';
// 'open' = pending + in_review. Default so finished work drops out of the
// queue on its own; '' (All Statuses) is one click away.
let filterStatus   = 'open';
let page           = 1;
// Approved addresses a manager can forward a request to (admin-maintained).
let forwardDestinations = [];

(async () => {
  currentProfile = await initPage({});
  if (!currentProfile) return;

  document.getElementById('signOut')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = '/login.html';
  });

  // Determine which categories this user manages
  await loadManagedCategories();

  if (!managedCatIds.length && !hasOversight()) {
    document.getElementById('reqmListWrap').innerHTML =
      '<p style="color:#9ca3af;">You are not assigned as a manager for any request forms.</p>';
    return;
  }

  document.getElementById('reqmFilters').style.display = '';
  await loadForwardDestinations();
  await loadSubmissions();
  renderList();
  wireFilters();
  wireDrawer();
})();

// School-wide submission oversight. Matches sr_select in
// 20260902000001_request_submission_visibility.sql. Note this is
// can_review_all_requests, NOT can_manage_requests — building forms and
// triaging what comes in are separate jobs. can_access_admin is deliberately
// absent; it's granted for unrelated reasons (carline, facilities, front
// desk). RLS is the real boundary; this just keeps the UI from showing an
// empty page to people who can't see anything.
function hasOversight() {
  return currentProfile.is_superadmin === true
      || currentProfile.can_review_all_requests === true;
}

async function loadManagedCategories() {
  const { data } = await supabase
    .from('request_category_managers')
    .select('category_id, request_categories ( id, name, resolved_label, allow_denial, denied_label, allow_completed )')
    .eq('profile_id', currentProfile.id);

  managedCatIds = (data ?? []).map(r => r.category_id);

  const sel = document.getElementById('reqmFilterCat');
  if (!sel) return;

  // A school-wide reviewer may manage no forms at all, which would leave
  // them filtering a full list by an empty dropdown. Offer every form
  // instead. (Confidential forms they don't manage still return nothing —
  // RLS decides, not this list.)
  if (hasOversight()) {
    sel.options[0].text = 'All Forms';
    const { data: allCats } = await supabase
      .from('request_categories')
      .select('id, name')
      .eq('school_id', currentProfile.school_id)
      .eq('is_active', true)
      .order('name');
    (allCats ?? []).forEach(cat => sel.appendChild(new Option(cat.name, cat.id)));
    return;
  }

  (data ?? []).forEach(r => {
    const cat = r.request_categories;
    if (!cat) return;
    sel.appendChild(new Option(cat.name, cat.id));
  });
}

async function loadForwardDestinations() {
  const { data, error } = await supabase
    .from('request_forward_destinations')
    .select('id, name')
    .eq('school_id', currentProfile.school_id)
    .eq('is_active', true)
    .order('name');
  if (error) console.error('loadForwardDestinations', error);
  forwardDestinations = data ?? [];
}

async function loadSubmissions() {
  // Paged: an unranged select stops at 1000 rows, which would silently drop
  // the oldest submissions from both the list and the CSV export.
  const { data, error } = await fetchAllRows(() => {
    let q = supabase
      .from('staff_requests')
      .select(`
        id, status, created_at, manager_notes,
        request_categories ( name, resolved_label, allow_denial, denied_label, allow_completed ),
        profiles!staff_requests_submitted_by_fkey ( display_name, email ),
        staff_request_responses ( value, request_category_fields ( label, field_type, sort_order ) )
      `)
      .eq('school_id', currentProfile.school_id)
      .order('created_at', { ascending: false });

    // Without oversight: scope to managed categories, and within them only
    // submissions routed to me or unrouted (broadcast). Routing is a
    // workflow filter — oversight holders still see everything RLS allows.
    if (!hasOversight() && managedCatIds.length) {
      q = q.in('category_id', managedCatIds)
           .or(`assigned_manager_id.is.null,assigned_manager_id.eq.${currentProfile.id}`);
    }

    if (filterCatId) q = q.eq('category_id', filterCatId);
    if (filterStatus === 'open') q = q.in('status', OPEN_STATUSES);
    else if (filterStatus)       q = q.eq('status', filterStatus);
    return q;
  });
  if (error) console.error('loadSubmissions', error);
  submissions = data ?? [];
}

function renderPagers() {
  const goTo = (target, scrollToTop) => {
    page = target;
    renderList();
    if (scrollToTop) document.querySelector('.reqm-main')?.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const opts = { page, total: submissions.length };
  for (const [id, scrollToTop] of [['reqmPagerTop', false], ['reqmPagerBottom', true]]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.display = submissions.length ? '' : 'none';
    renderPager(el, { ...opts, onPage: target => goTo(target, scrollToTop) });
  }
}

function renderList() {
  const wrap = document.getElementById('reqmListWrap');
  if (!wrap) return;

  // A save can shrink the filtered list (e.g. closing the last open item on
  // the final page), so keep the page in range.
  page = Math.min(page, pageCount(submissions.length));
  renderPagers();

  if (!submissions.length) {
    // Under the default "Open" filter an empty list means caught up, not
    // empty — say so, and point at where the finished ones went. Applies
    // whether or not a specific form is selected.
    wrap.innerHTML = filterStatus === 'open'
      ? `<div style="color:#9ca3af;padding:16px 0;">Nothing open ${filterCatId ? 'on this form' : 'right now'}. You're all caught up. Switch to <strong>All Statuses</strong> to see resolved, completed, and denied submissions.</div>`
      : '<div style="color:#9ca3af;padding:16px 0;">No submissions found.</div>';
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
        ${pageSlice(submissions, page).map(s => {
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
    page = 1;
    await loadSubmissions();
    renderList();
  });
  document.getElementById('reqmFilterStatus').addEventListener('change', async (e) => {
    filterStatus = e.target.value;
    page = 1;
    await loadSubmissions();
    renderList();
  });
  document.getElementById('reqmExportBtn').addEventListener('click', () => {
    // Exports exactly what's on screen — same RLS scope, same filters.
    const sel = document.getElementById('reqmFilterCat');
    const contextName = filterCatId
      ? (sel.options[sel.selectedIndex]?.text ?? 'Requests')
      : 'All Forms';
    const statusSel = document.getElementById('reqmFilterStatus');
    const statusName = filterStatus ? statusSel?.options[statusSel.selectedIndex]?.text : '';
    if (!exportSubmissions(submissions, contextName, statusName)) {
      showToast('Nothing to export with the current filters.', 'error');
    }
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
          <div class="req-response-value">${formatVal(r.value, r.request_category_fields?.field_type)}</div>
        </div>`).join('') || '<p style="color:#9ca3af;">No responses recorded.</p>'}
    </div>

    <hr class="drawer-divider" />

    <div class="drawer-field">
      <label>Status</label>
      <select id="reqmSubStatus">
        <option value="pending"   ${sub.status === 'pending'   ? 'selected' : ''}>Pending</option>
        <option value="in_review" ${sub.status === 'in_review' ? 'selected' : ''}>In Review</option>
        <option value="resolved"  ${sub.status === 'resolved'  ? 'selected' : ''}>${esc(sub.request_categories?.resolved_label || 'Resolved')}</option>
        ${(sub.status === 'completed' || (sub.request_categories?.allow_completed && sub.status === 'resolved'))
          ? `<option value="completed" ${sub.status === 'completed' ? 'selected' : ''}>Completed</option>`
          : ''}
        ${(sub.request_categories?.allow_denial || sub.status === 'denied')
          ? `<option value="denied" ${sub.status === 'denied' ? 'selected' : ''}>${esc(sub.request_categories?.denied_label || 'Denied')}</option>`
          : ''}
      </select>
    </div>
    <div class="drawer-field">
      <label>Notes <span style="text-transform:none;font-weight:400;letter-spacing:0;color:#9ca3af;">(visible to submitter)</span></label>
      <textarea id="reqmSubNotes" rows="3" placeholder="Optional notes…">${esc(sub.manager_notes ?? '')}</textarea>
    </div>

    <hr class="drawer-divider" />
    <div id="reqmForwardPanel"></div>
  `;

  notesSnapshot = sub.manager_notes?.trim() ?? '';
  renderForwardPanel(sub);

  // Rebound per open — the drawer is reused across submissions, so the
  // handler has to close over the one currently shown.
  const exportBtn = document.getElementById('reqmExportSubBtn');
  if (exportBtn) {
    exportBtn.onclick = () =>
      exportOneSubmission({ ...sub, staff_request_responses: responses ?? [] });
  }
}

// Forward section of the drawer: past forwards for this request, plus a form
// to send it to one of the admin-approved destinations.
async function renderForwardPanel(sub) {
  const panel = document.getElementById('reqmForwardPanel');
  if (!panel) return;

  const { data: forwards, error } = await supabase
    .from('request_forwards')
    .select('id, created_at, destination_name, note, profiles!request_forwards_forwarded_by_fkey ( display_name )')
    .eq('request_id', sub.id)
    .order('created_at', { ascending: false });
  if (error) console.error('load forwards', error);

  // The drawer is reused; ignore a slow response for a submission that's no
  // longer the one on screen.
  if (currentRequestId !== sub.id) return;

  const history = (forwards ?? []).map(f => `
    <div style="font-size:13px;color:#374151;margin-bottom:8px;">
      Forwarded to <strong>${esc(f.destination_name)}</strong>
      by ${esc(f.profiles?.display_name ?? 'a manager')} on ${fmtShortDate(f.created_at)}
      ${f.note ? `<div style="color:#6b7280;white-space:pre-wrap;margin-top:2px;">${esc(f.note)}</div>` : ''}
    </div>`).join('');

  const form = forwardDestinations.length ? `
    <div class="drawer-field">
      <label>Forward to</label>
      <select id="reqmFwdDest">
        <option value="">Choose a destination…</option>
        ${forwardDestinations.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}
      </select>
    </div>
    <div class="drawer-field">
      <label>Message <span style="text-transform:none;font-weight:400;letter-spacing:0;color:#9ca3af;">(optional, sent to the recipient only)</span></label>
      <textarea id="reqmFwdNote" rows="2" maxlength="1000" placeholder="e.g. This is a network issue, not facilities."></textarea>
    </div>
    <button class="btn" id="reqmFwdBtn">Forward request</button>
    <p id="reqmFwdError" style="color:#dc2626;font-size:13px;margin:8px 0 0;display:none;"></p>
    <p style="font-size:12px;color:#9ca3af;margin:8px 0 0;">Emails the full submission and adds a line to the notes above. The submitter sees the note, not the address.</p>`
    : (history ? '' : `<p style="font-size:13px;color:#9ca3af;">Forwarding isn't set up yet. An admin can add destinations under Requests, Forwarding.</p>`);

  panel.innerHTML = `
    <div class="drawer-field"><label>Forward</label></div>
    ${history}
    ${form}`;

  document.getElementById('reqmFwdBtn')?.addEventListener('click', () => forwardRequest(sub));
}

async function forwardRequest(sub) {
  const destSel = document.getElementById('reqmFwdDest');
  const noteEl  = document.getElementById('reqmFwdNote');
  const errEl   = document.getElementById('reqmFwdError');
  const btn     = document.getElementById('reqmFwdBtn');
  const showErr = msg => { errEl.textContent = msg; errEl.style.display = msg ? '' : 'none'; };
  showErr('');

  if (!destSel.value) return showErr('Choose a destination first.');

  // Forwarding appends a line to the notes on the server. Unsaved text in
  // the box would be overwritten by the next Save, so make them save first.
  const notesNow = document.getElementById('reqmSubNotes')?.value.trim() ?? '';
  if (notesNow !== notesSnapshot) return showErr('Save your notes first. Forwarding adds a line to them.');

  const destName = destSel.options[destSel.selectedIndex].text;
  if (!confirm(`Forward this request to ${destName}? The full submission will be emailed to them.`)) return;

  btn.disabled = true;
  btn.textContent = 'Forwarding…';

  const { data, error } = await supabase.functions.invoke('forward_request', {
    body: { request_id: sub.id, destination_id: destSel.value, note: noteEl.value.trim() },
  });

  btn.disabled = false;
  btn.textContent = 'Forward request';

  if (error || !data?.ok) {
    let msg = 'Forward failed. Nothing was sent.';
    try { msg = (await error.context.json()).error || msg; } catch { /* keep the generic message */ }
    return showErr(msg);
  }

  // Pull the note line the server added into the box and the local copy, so
  // the next Save doesn't undo it.
  const notesEl = document.getElementById('reqmSubNotes');
  if (notesEl && typeof data.manager_notes === 'string') {
    notesEl.value = data.manager_notes;
    notesSnapshot = data.manager_notes.trim();
    sub.manager_notes = data.manager_notes;
  }
  showToast(`Forwarded to ${destName}.`);
  await renderForwardPanel(sub);
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
  if (type === 'url') {
    // type="url" validity only requires a well-formed absolute URL, not a
    // safe scheme (javascript:... passes) -- only link http(s), otherwise
    // fall back to plain text so a crafted value can't become a clickable
    // javascript: href in a manager's browser.
    return /^https?:\/\//i.test(val)
      ? `<a href="${esc(val)}" target="_blank" rel="noopener noreferrer">${esc(val)}</a>`
      : esc(val);
  }
  if (type === 'file') {
    const url = esc(val);
    const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(val);
    if (isImage) return `<a href="${url}" target="_blank" rel="noopener noreferrer"><img src="${url}" alt="Attachment" style="max-width:220px;max-height:180px;border-radius:6px;display:block;margin-top:4px;cursor:pointer;" /></a>`;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">View Attachment</a>`;
  }
  return esc(val);
}
function statusLabel(s, cat) {
  if (s === 'resolved') return cat?.resolved_label || 'Resolved';
  if (s === 'denied')   return cat?.denied_label   || 'Denied';
  return { pending: 'Pending', in_review: 'In Review', completed: 'Completed' }[s] ?? s;
}
function statusBadgeClass(s) {
  return { pending: 'badge-amber', in_review: 'badge-blue', resolved: 'badge-green', denied: 'badge-red', completed: 'badge-purple' }[s] ?? '';
}
