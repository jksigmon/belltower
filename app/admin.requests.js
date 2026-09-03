import { supabase } from './admin.supabase.js?v=2';
import { esc, debounce, getAvatarColor, fmtShortDate, showToast, fetchAllRows } from './admin.shared.js?v=3';
import { exportSubmissions, exportOneSubmission } from './requests.export.js?v=1';

let currentProfile = null;
let currentView = 'forms'; // 'forms' | 'submissions'
let categories   = [];
let editingCat   = null;   // category being edited in drawer
let draftFields  = [];     // field rows in open drawer
let dragSrcIdx   = null;   // index of field row being dragged
let draftManagers = [];    // manager chips in open drawer
let draftVisibility = [];  // "visible to" chips in open drawer (when restricted)
let submissions  = [];
let filterCatId  = '';
// 'open' = pending + in_review. Default so finished work drops out of the
// queue on its own; '' (All Statuses) is one click away.
let filterStatus = 'open';
const OPEN_STATUSES = ['pending', 'in_review'];
let mgSearchTimeout = null;
let visSearchTimeout = null;

/* ═══════════════════════════════════════════════════════════
   ENTRY POINT
═══════════════════════════════════════════════════════════ */
export async function initRequestsSection(profile) {
  currentProfile = profile;

  if (!canBuildForms() && !canReviewAll()) {
    document.getElementById('requestsSectionRoot').innerHTML =
      '<p class="muted" style="padding:40px;">You are not authorized to manage request forms.</p>';
    return;
  }

  // Someone who only reviews submissions lands on that tab; the Forms tab
  // isn't rendered for them at all.
  if (!canBuildForms()) currentView = 'submissions';

  await loadCategories();
  renderRoot();
  await renderInitialView();
  document.getElementById('reqCatDrawerClose')?.addEventListener('click', closeCatDrawer);
  document.getElementById('reqCatOverlay')?.addEventListener('click', closeCatDrawer);
  document.getElementById('reqSubDrawerClose')?.addEventListener('click', handleCloseSubRequest);
  document.getElementById('reqSubOverlay')?.addEventListener('click', handleCloseSubRequest);
  document.getElementById('reqDeactivateCancel')?.addEventListener('click', () => {
    document.getElementById('reqDeactivateModal').hidden = true;
  });
  document.getElementById('reqDeactivateConfirm')?.addEventListener('click', async () => {
    document.getElementById('reqDeactivateModal').hidden = true;
    await toggleCatActive();
  });
  document.getElementById('reqDeleteCancel')?.addEventListener('click', () => {
    document.getElementById('reqDeleteModal').hidden = true;
  });
  document.getElementById('reqDeleteConfirm')?.addEventListener('click', async () => {
    document.getElementById('reqDeleteModal').hidden = true;
    await deleteCategory();
  });
}

/* ═══════════════════════════════════════════════════════════
   DATA
═══════════════════════════════════════════════════════════ */
async function loadCategories() {
  const { data, error } = await supabase
    .from('request_categories')
    .select('id, name, description, is_active, is_restricted, is_confidential, notify_managers, resolved_label, allow_denial, denied_label, allow_completed, created_at, request_category_fields(count), request_category_managers(count), staff_requests(count)')
    .eq('school_id', currentProfile.school_id)
    .order('name');
  if (error) console.error('loadCategories', error);
  categories = data ?? [];
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

    if (filterCatId) q = q.eq('category_id', filterCatId);
    if (filterStatus === 'open') q = q.in('status', OPEN_STATUSES);
    else if (filterStatus)       q = q.eq('status', filterStatus);
    return q;
  });
  if (error) console.error('loadSubmissions', error);
  submissions = data ?? [];
}

async function loadCategoryDetail(catId) {
  const [fieldsRes, managersRes, visibilityRes] = await Promise.all([
    supabase
      .from('request_category_fields')
      .select('id, label, field_type, options, is_required, sort_order')
      .eq('category_id', catId)
      .order('sort_order'),
    supabase
      .from('request_category_managers')
      .select('profile_id, profiles!request_category_managers_profile_id_fkey ( display_name, email )')
      .eq('category_id', catId),
    supabase
      .from('request_category_visibility')
      .select('profile_id, profiles!request_category_visibility_profile_id_fkey ( display_name, email )')
      .eq('category_id', catId),
  ]);
  if (fieldsRes.error)     console.error('loadCategoryDetail fields',     fieldsRes.error);
  if (managersRes.error)   console.error('loadCategoryDetail managers',   managersRes.error);
  if (visibilityRes.error) console.error('loadCategoryDetail visibility', visibilityRes.error);
  return {
    fields:     fieldsRes.data     ?? [],
    managers:   managersRes.data   ?? [],
    visibility: visibilityRes.data ?? [],
  };
}

/* ═══════════════════════════════════════════════════════════
   ROOT RENDER
═══════════════════════════════════════════════════════════ */
// Building forms and reviewing what comes in are independent permissions —
// see 20260902000001_request_submission_visibility.sql.
function canBuildForms() {
  return currentProfile.is_superadmin === true
      || currentProfile.can_manage_requests === true;
}

function canReviewAll() {
  return currentProfile.is_superadmin === true
      || currentProfile.can_review_all_requests === true;
}

function renderRoot() {
  const root = document.getElementById('requestsSectionRoot');
  if (!root) return;

  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;">
      <h2 style="margin:0;font-size:20px;font-weight:700;">Staff Requests</h2>
      ${currentView === 'forms' && canBuildForms() ? `
        <button class="btn btn-primary" id="reqNewFormBtn" style="white-space:nowrap;flex-shrink:0;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Form
        </button>` : ''}
    </div>
    <div class="req-tabs" style="margin-bottom:16px;">
      ${canBuildForms() ? `<button class="req-tab${currentView === 'forms' ? ' active' : ''}" data-view="forms">Request Forms</button>` : ''}
      ${canReviewAll() ? `<button class="req-tab${currentView === 'submissions' ? ' active' : ''}" data-view="submissions">Submissions</button>` : ''}
    </div>
    <div id="reqViewContainer"></div>
  `;

  root.querySelectorAll('.req-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      currentView = btn.dataset.view;
      renderRoot();
      if (currentView === 'submissions') {
        await loadSubmissions();
        renderSubmissionsView();
      } else {
        renderFormsView();
      }
    });
  });

  document.getElementById('reqNewFormBtn')?.addEventListener('click', () => openCatDrawer(null));

  if (currentView === 'forms') renderFormsView();
}

// Initial paint for a reviewer who has no Forms tab — the tab handler above
// only fires on click, so the submissions view needs kicking off once.
async function renderInitialView() {
  if (currentView !== 'submissions') return;
  await loadSubmissions();
  renderSubmissionsView();
}

/* ═══════════════════════════════════════════════════════════
   FORMS VIEW
═══════════════════════════════════════════════════════════ */
function renderFormsView() {
  const container = document.getElementById('reqViewContainer');
  if (!container) return;

  if (!categories.length) {
    container.innerHTML = `
      <div style="text-align:center;padding:64px 16px;">
        <div style="width:52px;height:52px;background:#f3f4f6;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        </div>
        <p style="font-size:16px;font-weight:600;color:#374151;margin:0 0 6px;">No request forms yet</p>
        <p style="font-size:13px;color:#9ca3af;margin:0 auto 24px;max-width:360px;line-height:1.6;">Create a form so staff can submit requests for IT support, facilities work, supply orders, or anything else your school needs to track.</p>
        <button class="btn btn-primary" id="reqEmptyNewBtn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Create First Form
        </button>
      </div>`;
    document.getElementById('reqEmptyNewBtn')?.addEventListener('click', () => openCatDrawer(null));
    return;
  }

  container.innerHTML = `
    <p style="font-size:13px;color:#6b7280;margin:0 0 16px;">${categories.length} form${categories.length === 1 ? '' : 's'}. Click a card to edit fields and managers.</p>
    <div class="req-cat-grid">
      ${categories.map(c => {
        const fieldCount = c.request_category_fields?.[0]?.count ?? 0;
        const mgrCount   = c.request_category_managers?.[0]?.count ?? 0;
        return `
        <div class="req-cat-card${c.is_active ? '' : ' req-cat-card--inactive'}" data-id="${esc(c.id)}" role="button" tabindex="0">
          <div class="req-cat-card-header">
            <span class="req-cat-name">${esc(c.name)}</span>
            <span style="display:flex;gap:6px;flex-shrink:0;">
              ${c.is_restricted ? `<span class="status-badge badge-amber" title="Only specific people can see and submit this form">Restricted</span>` : ''}
              ${c.is_confidential ? `<span class="status-badge badge-red" title="Only this form's managers can read submissions">Confidential</span>` : ''}
              <span class="status-badge ${c.is_active ? 'badge-green' : 'badge-gray'}">${c.is_active ? 'Active' : 'Inactive'}</span>
            </span>
          </div>
          ${c.description ? `<p class="req-cat-desc">${esc(c.description)}</p>` : ''}
          <div class="req-cat-meta">
            <span>${fieldCount} field${fieldCount === 1 ? '' : 's'}</span>
            <span class="req-cat-meta-dot">·</span>
            ${mgrCount > 0
              ? `<span>${mgrCount} manager${mgrCount === 1 ? '' : 's'}</span>`
              : `<span class="req-cat-meta-warn" title="Submissions to this form have no one assigned to review them">No managers assigned</span>`}
          </div>
          <div class="req-cat-actions">
            <button class="btn btn-sm btn-secondary req-edit-btn" data-id="${esc(c.id)}">Edit Form</button>
          </div>
        </div>`;
      }).join('')}
    </div>`;

  // Whole card opens the editor (the helper text promises this);
  // the Edit button stays as the explicit affordance.
  container.querySelectorAll('.req-cat-card').forEach(card => {
    const open = async () => {
      const cat = categories.find(c => c.id === card.dataset.id);
      if (cat) await openCatDrawer(cat);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
}

/* ═══════════════════════════════════════════════════════════
   CATEGORY DRAWER
═══════════════════════════════════════════════════════════ */
async function openCatDrawer(cat) {
  editingCat = cat;
  const titleEl = document.getElementById('reqCatDrawerTitle');
  const bodyEl  = document.getElementById('reqCatDrawerBody');
  if (!titleEl || !bodyEl) return;

  titleEl.textContent = cat ? `Edit: ${cat.name}` : 'New Request Form';
  bodyEl.innerHTML = '<p style="color:#9ca3af;padding:16px;">Loading…</p>';

  document.getElementById('reqCatDrawer').classList.add('open');
  document.getElementById('reqCatOverlay').classList.add('open');

  if (cat) {
    // True count, not the RLS-filtered embed from loadCategories — otherwise
    // a confidential form the current user can't review looks empty and the
    // Delete button appears on a form that actually has submissions.
    const { data: trueCount } = await supabase
      .rpc('request_category_submission_count', { p_category_id: cat.id });
    if (typeof trueCount === 'number') cat.staff_requests = [{ count: trueCount }];

    const { fields, managers, visibility } = await loadCategoryDetail(cat.id);
    draftFields   = fields.map(f => ({ ...f }));
    draftManagers = managers.map(m => ({
      profile_id:   m.profile_id,
      display_name: m.profiles?.display_name ?? m.profiles?.email ?? 'Unknown',
      email:        m.profiles?.email ?? '',
    }));
    draftVisibility = visibility.map(v => ({
      profile_id:   v.profile_id,
      display_name: v.profiles?.display_name ?? v.profiles?.email ?? 'Unknown',
      email:        v.profiles?.email ?? '',
    }));
  } else {
    draftFields     = [];
    draftManagers   = [];
    draftVisibility = [];
  }

  renderCatDrawerBody(cat);
}

function renderCatDrawerBody(cat) {
  const bodyEl = document.getElementById('reqCatDrawerBody');
  if (!bodyEl) return;

  const submissionCount = cat?.staff_requests?.[0]?.count ?? 0;

  const resolvedIsCustom = !!(cat && cat.resolved_label && !['Resolved','Approved','Completed','Closed'].includes(cat.resolved_label));
  const deniedIsCustom   = !!(cat && cat.denied_label && !['Denied','Rejected','Declined'].includes(cat.denied_label));

  bodyEl.innerHTML = `
    <div class="req-drawer-section">
      <div class="form-group">
        <label class="form-label">Form Name *</label>
        <input id="reqCatName" class="form-control" type="text" value="${cat ? esc(cat.name) : ''}" placeholder="e.g. Facilities Request, IT Support" />
      </div>
      <div class="form-group">
        <label class="form-label">Description</label>
        <textarea id="reqCatDesc" class="form-control" rows="2" placeholder="Brief description staff will see">${cat ? esc(cat.description ?? '') : ''}</textarea>
      </div>
      <div class="req-toggle-row">
        <input id="reqCatActive" type="checkbox" ${(!cat || cat.is_active) ? 'checked' : ''} />
        <div class="req-toggle-row-text">
          <span class="req-toggle-row-title">Active</span>
          <span class="req-toggle-row-desc">Staff can see and submit this form.</span>
        </div>
      </div>
      <div class="req-toggle-row">
        <input id="reqCatNotify" type="checkbox" ${(!cat || cat.notify_managers !== false) ? 'checked' : ''} />
        <div class="req-toggle-row-text">
          <span class="req-toggle-row-title">Email managers</span>
          <span class="req-toggle-row-desc">Email managers when a request is submitted. Submitters always get a confirmation.</span>
        </div>
      </div>
    </div>

    <div class="req-drawer-section">
      <div class="req-drawer-section-header"><strong>Status Wording</strong></div>
      <div class="form-group">
        <label class="form-label">Label for completed status</label>
        <select id="reqCatResolvedLabel" class="form-control" style="width:220px;">
          ${['Resolved', 'Approved', 'Completed', 'Closed'].map(opt =>
            `<option value="${esc(opt)}" ${cat && cat.resolved_label === opt ? 'selected' : ''}>${esc(opt)}</option>`
          ).join('')}
          <option value="__custom" ${resolvedIsCustom ? 'selected' : ''}>Custom…</option>
        </select>
        <input id="reqCatResolvedLabelCustom" class="form-control" type="text" style="width:220px;margin-top:6px;${resolvedIsCustom ? '' : 'display:none;'}"
          placeholder="Custom word" value="${resolvedIsCustom ? esc(cat.resolved_label) : ''}" />
        <p style="font-size:12px;color:#9ca3af;margin-top:4px;">Shown to both managers and staff once a request reaches this status.</p>
      </div>
      <div class="req-toggle-row">
        <input id="reqCatAllowCompleted" type="checkbox" ${cat?.allow_completed ? 'checked' : ''} />
        <div class="req-toggle-row-text">
          <span class="req-toggle-row-title">Track a Completed status</span>
          <span class="req-toggle-row-desc">Adds a Completed option once a request reaches the status above, for forms that need a follow-up step (e.g. ordered/paid).</span>
        </div>
      </div>
      <div class="req-toggle-row">
        <input id="reqCatAllowDenial" type="checkbox" ${cat?.allow_denial ? 'checked' : ''} />
        <div class="req-toggle-row-text">
          <span class="req-toggle-row-title">This form can be denied</span>
          <span class="req-toggle-row-desc">Adds a Deny option alongside the completed status (for approval-style forms).</span>
        </div>
      </div>
      <div class="req-drawer-subfield" id="reqCatDeniedLabelWrap" style="${cat?.allow_denial ? '' : 'display:none;'}">
        <div class="form-group">
          <label class="form-label">Label for denied status</label>
          <select id="reqCatDeniedLabel" class="form-control" style="width:220px;">
            ${['Denied', 'Rejected', 'Declined'].map(opt =>
              `<option value="${esc(opt)}" ${cat && cat.denied_label === opt ? 'selected' : ''}>${esc(opt)}</option>`
            ).join('')}
            <option value="__custom" ${deniedIsCustom ? 'selected' : ''}>Custom…</option>
          </select>
          <input id="reqCatDeniedLabelCustom" class="form-control" type="text" style="width:220px;margin-top:6px;${deniedIsCustom ? '' : 'display:none;'}"
            placeholder="Custom word" value="${deniedIsCustom ? esc(cat.denied_label) : ''}" />
        </div>
      </div>
    </div>

    <div class="req-drawer-section">
      <div class="req-drawer-section-header">
        <strong>Form Fields</strong>
        <button class="btn btn-sm btn-secondary" id="reqAddFieldBtn">+ Add Field</button>
      </div>
      <div id="reqFieldsList"></div>
    </div>

    <div class="req-drawer-section">
      <div class="req-drawer-section-header"><strong>Managers</strong></div>
      <p style="font-size:13px;color:#6b7280;margin:0 0 10px;">Managers receive notifications and can update submission status.</p>
      <div id="reqManagerChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;"></div>
      <div style="position:relative;">
        <input id="reqMgrSearch" class="form-control" type="text" placeholder="Search staff by name or email…" autocomplete="off" />
        <div id="reqMgrDropdown" class="req-mgr-dropdown" style="display:none;"></div>
      </div>
    </div>

    <div class="req-drawer-section">
      <div class="req-drawer-section-header"><strong>Visibility</strong></div>
      <div class="req-toggle-row">
        <input id="reqCatRestricted" type="checkbox" ${cat?.is_restricted ? 'checked' : ''} />
        <div class="req-toggle-row-text">
          <span class="req-toggle-row-title">Restrict to specific people</span>
          <span class="req-toggle-row-desc">Only the people picked below, plus this form's managers, can see and submit this form. It won't appear on anyone else's Submit a Request page. Off = everyone at the school.</span>
        </div>
      </div>
      <div id="reqVisibilityPicker" style="${cat?.is_restricted ? '' : 'display:none;'}margin-top:10px;">
        <div id="reqVisibilityChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;"></div>
        <div style="position:relative;">
          <input id="reqVisSearch" class="form-control" type="text" placeholder="Search staff by name or email…" autocomplete="off" />
          <div id="reqVisDropdown" class="req-mgr-dropdown" style="display:none;"></div>
        </div>
      </div>

      <div class="req-toggle-row" style="margin-top:14px;">
        <input id="reqCatConfidential" type="checkbox" ${cat?.is_confidential ? 'checked' : ''} />
        <div class="req-toggle-row-text">
          <span class="req-toggle-row-title">Confidential submissions</span>
          <span class="req-toggle-row-desc">Only this form's managers can read submissions. Other admins and request managers are locked out. Use for sensitive records like office referrals.</span>
        </div>
      </div>
    </div>

    <div style="margin-top:24px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <button class="btn btn-primary" id="reqSaveCatBtn" style="height:36px;">${cat ? 'Save Changes' : 'Create Form'}</button>
      ${cat ? `<button class="btn" id="reqToggleActiveBtn" style="height:36px;">${cat.is_active ? 'Deactivate Form' : 'Activate Form'}</button>` : ''}
      ${cat && submissionCount === 0 ? `<button class="btn danger" id="reqDeleteCatBtn" style="height:36px;">Delete Form</button>` : ''}
      <button class="btn" id="reqCancelCatBtn" style="height:36px;">Cancel</button>
    </div>
    ${cat && submissionCount > 0 ? `<p style="font-size:12px;color:#9ca3af;margin-top:6px;">This form has ${submissionCount} submission${submissionCount === 1 ? '' : 's'}, so it can't be deleted. Deactivate it instead.</p>` : ''}
    <p id="reqCatError" style="color:#dc2626;font-size:13px;margin-top:8px;display:none;"></p>
  `;

  renderFieldsList();
  renderManagerChips();
  renderVisibilityChips();

  document.getElementById('reqCatRestricted').addEventListener('change', (e) => {
    document.getElementById('reqVisibilityPicker').style.display = e.target.checked ? '' : 'none';
  });

  document.getElementById('reqAddFieldBtn').addEventListener('click', addField);
  document.getElementById('reqSaveCatBtn').addEventListener('click', saveCategoryDrawer);
  document.getElementById('reqCancelCatBtn').addEventListener('click', closeCatDrawer);
  document.getElementById('reqToggleActiveBtn')?.addEventListener('click', () => {
    if (editingCat?.is_active) {
      document.getElementById('reqDeactivateModal').hidden = false;
    } else {
      toggleCatActive();
    }
  });
  document.getElementById('reqDeleteCatBtn')?.addEventListener('click', () => {
    document.getElementById('reqDeleteModalMsg').textContent =
      `This permanently deletes "${editingCat.name}", including its fields and manager list. This cannot be undone.`;
    document.getElementById('reqDeleteModal').hidden = false;
  });

  document.getElementById('reqCatResolvedLabel').addEventListener('change', (e) => {
    document.getElementById('reqCatResolvedLabelCustom').style.display = e.target.value === '__custom' ? '' : 'none';
  });
  document.getElementById('reqCatDeniedLabel').addEventListener('change', (e) => {
    document.getElementById('reqCatDeniedLabelCustom').style.display = e.target.value === '__custom' ? '' : 'none';
  });
  document.getElementById('reqCatAllowDenial').addEventListener('change', (e) => {
    document.getElementById('reqCatDeniedLabelWrap').style.display = e.target.checked ? '' : 'none';
  });

  const mgrSearch = document.getElementById('reqMgrSearch');
  mgrSearch.addEventListener('input', () => {
    clearTimeout(mgSearchTimeout);
    mgSearchTimeout = setTimeout(() => searchManagers(mgrSearch.value.trim()), 220);
  });
  mgrSearch.addEventListener('blur', () => {
    setTimeout(() => { document.getElementById('reqMgrDropdown').style.display = 'none'; }, 150);
  });

  const visSearch = document.getElementById('reqVisSearch');
  visSearch.addEventListener('input', () => {
    clearTimeout(visSearchTimeout);
    visSearchTimeout = setTimeout(() => searchVisibility(visSearch.value.trim()), 220);
  });
  visSearch.addEventListener('blur', () => {
    setTimeout(() => { document.getElementById('reqVisDropdown').style.display = 'none'; }, 150);
  });
}

function renderFieldsList() {
  const list = document.getElementById('reqFieldsList');
  if (!list) return;

  if (!draftFields.length) {
    list.innerHTML = `
      <p style="font-size:13px;color:#9ca3af;margin-bottom:10px;">No fields yet.</p>
      <button class="btn btn-sm btn-secondary" id="reqAddFieldBtnBottom">+ Add Field</button>`;
    document.getElementById('reqAddFieldBtnBottom').addEventListener('click', addField);
    return;
  }

  // At most one routing field per form: hide the type option elsewhere
  const routingIdx = draftFields.findIndex(f => f.field_type === 'routing');

  list.innerHTML = draftFields.map((f, i) => {
    const types = ['text','textarea','select','date','date_range','time','phone','currency','boolean','url','file'];
    if (routingIdx === -1 || routingIdx === i) types.push('routing');
    return `
    <div class="req-field-row" data-idx="${i}" draggable="true">
      <div class="req-field-main">
        <span class="req-field-drag" title="Drag to reorder">⠿</span>
        <input class="form-control req-field-label" type="text" placeholder="Field label *" value="${esc(f.label)}" style="flex:1;" />
        <select class="form-control req-field-type" style="width:170px;">
          ${types.map(t =>
            `<option value="${t}" ${f.field_type === t ? 'selected' : ''}>${fieldTypeLabel(t)}</option>`
          ).join('')}
        </select>
        <label class="req-field-required-wrap" title="Required">
          <input type="checkbox" class="req-field-required" ${f.is_required ? 'checked' : ''} />
          <span style="font-size:12px;color:#6b7280;">Req.</span>
        </label>
        <button class="btn btn-sm req-field-remove" data-idx="${i}" title="Remove field">&times;</button>
      </div>
      ${f.field_type === 'select' ? `
        <div style="margin-top:6px;">
          <input class="form-control req-field-options" type="text"
            placeholder="Options, comma-separated (e.g. Low, Medium, High)"
            value="${esc(Array.isArray(f.options) ? f.options.join(', ') : '')}"
          />
        </div>` : ''}
      ${f.field_type === 'routing' ? renderRoutingEditor(f, i) : ''}
    </div>`;
  }).join('') + `<div style="margin-top:12px;"><button class="btn btn-sm btn-secondary" id="reqAddFieldBtnBottom">+ Add Field</button></div>`;

  list.querySelectorAll('.req-field-label').forEach((inp, i) => {
    inp.addEventListener('input', () => { draftFields[i].label = inp.value; });
  });
  list.querySelectorAll('.req-field-type').forEach((sel, i) => {
    sel.addEventListener('change', () => {
      draftFields[i].field_type = sel.value;
      if (sel.value === 'routing') {
        // Seed one option per current manager; admin renames labels
        draftFields[i].options = draftManagers.map(m => ({
          label: m.display_name, manager_id: m.profile_id,
        }));
      } else if (sel.value !== 'select') {
        draftFields[i].options = null;
      }
      renderFieldsList();
    });
  });
  list.querySelectorAll('.req-field-required').forEach((cb, i) => {
    cb.addEventListener('change', () => { draftFields[i].is_required = cb.checked; });
  });
  list.querySelectorAll('.req-field-options').forEach((inp) => {
    const idx = parseInt(inp.closest('.req-field-row').dataset.idx);
    inp.addEventListener('input', () => {
      draftFields[idx].options = inp.value.split(',').map(s => s.trim()).filter(Boolean);
    });
  });

  // Routing option editors: [label input][manager select][remove] rows
  list.querySelectorAll('.req-routing-label').forEach(inp => {
    const fIdx = parseInt(inp.dataset.field), oIdx = parseInt(inp.dataset.opt);
    inp.addEventListener('input', () => { draftFields[fIdx].options[oIdx].label = inp.value; });
  });
  list.querySelectorAll('.req-routing-mgr').forEach(sel => {
    const fIdx = parseInt(sel.dataset.field), oIdx = parseInt(sel.dataset.opt);
    sel.addEventListener('change', () => {
      draftFields[fIdx].options[oIdx].manager_id = sel.value;
      renderFieldsList();   // re-evaluate orphan flags
    });
  });
  list.querySelectorAll('.req-routing-remove').forEach(btn => {
    const fIdx = parseInt(btn.dataset.field), oIdx = parseInt(btn.dataset.opt);
    btn.addEventListener('click', () => {
      draftFields[fIdx].options.splice(oIdx, 1);
      renderFieldsList();
    });
  });
  list.querySelectorAll('.req-routing-add').forEach(btn => {
    const fIdx = parseInt(btn.dataset.field);
    btn.addEventListener('click', () => {
      const opts = draftFields[fIdx].options ?? (draftFields[fIdx].options = []);
      const unused = draftManagers.find(m => !opts.some(o => o.manager_id === m.profile_id));
      opts.push({ label: unused?.display_name ?? '', manager_id: unused?.profile_id ?? '' });
      renderFieldsList();
    });
  });
  list.querySelectorAll('.req-field-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      draftFields.splice(parseInt(btn.dataset.idx), 1);
      renderFieldsList();
    });
  });

  list.querySelectorAll('.req-field-row').forEach((row, i) => {
    row.addEventListener('dragstart', (e) => {
      dragSrcIdx = i;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      if (dragSrcIdx === null || dragSrcIdx === i) return;
      const [moved] = draftFields.splice(dragSrcIdx, 1);
      draftFields.splice(i, 0, moved);
      renderFieldsList();
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      list.querySelectorAll('.req-field-row').forEach(r => r.classList.remove('drag-over'));
      dragSrcIdx = null;
    });
  });

  document.getElementById('reqAddFieldBtnBottom').addEventListener('click', addField);
}

function addField() {
  draftFields.push({ label: '', field_type: 'text', is_required: false, options: null, sort_order: draftFields.length });
  renderFieldsList();
  const inputs = document.querySelectorAll('.req-field-label');
  const last = inputs[inputs.length - 1];
  last?.focus();
  last?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function fieldTypeLabel(t) {
  return {
    text: 'Short Text', textarea: 'Paragraph', select: 'Dropdown', date: 'Date',
    date_range: 'Date Range', time: 'Time', phone: 'Phone Number', currency: 'Currency',
    boolean: 'Yes / No', url: 'Link (URL)', file: 'File Upload', routing: 'Routes to a manager',
  }[t] ?? t;
}

/* Routing option editor: each option maps a submitter-facing label to
   one of the form's managers. Submissions with that option selected go
   only to that manager's queue and inbox. */
function renderRoutingEditor(f, fieldIdx) {
  const opts = Array.isArray(f.options) ? f.options : [];
  const mgrIds = new Set(draftManagers.map(m => m.profile_id));

  const rows = opts.map((o, oIdx) => {
    const orphaned = o.manager_id && !mgrIds.has(o.manager_id);
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-top:6px;${orphaned ? 'padding:6px;border:1.5px solid #fca5a5;border-radius:8px;background:#fef2f2;' : ''}">
        <input class="form-control req-routing-label" data-field="${fieldIdx}" data-opt="${oIdx}"
          type="text" placeholder="Option label (what staff see)" value="${esc(o.label ?? '')}" style="flex:1;" />
        <span style="font-size:12px;color:#9ca3af;flex-shrink:0;">routes to</span>
        <select class="form-control req-routing-mgr" data-field="${fieldIdx}" data-opt="${oIdx}" style="width:180px;">
          <option value="">Select manager…</option>
          ${draftManagers.map(m =>
            `<option value="${esc(m.profile_id)}" ${o.manager_id === m.profile_id ? 'selected' : ''}>${esc(m.display_name)}</option>`
          ).join('')}
          ${orphaned ? `<option value="${esc(o.manager_id)}" selected>(removed manager)</option>` : ''}
        </select>
        <button class="btn btn-sm req-field-remove req-routing-remove" data-field="${fieldIdx}" data-opt="${oIdx}" title="Remove option">&times;</button>
      </div>
      ${orphaned ? '<div style="font-size:12px;color:#b91c1c;margin-top:3px;">This option points at someone no longer on this form. Pick a current manager or it will be removed on save.</div>' : ''}`;
  }).join('');

  return `
    <div style="margin-top:8px;padding:10px 12px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;">
      <div style="font-size:12px;font-weight:600;color:#5b21b6;margin-bottom:2px;">Routing options</div>
      <div style="font-size:12px;color:#6b7280;">Each option sends the submission to one manager. ${draftManagers.length ? '' : 'Add managers to this form first.'}</div>
      ${rows}
      ${draftManagers.length ? `<button class="btn btn-sm btn-secondary req-routing-add" data-field="${fieldIdx}" style="margin-top:8px;">+ Add option</button>` : ''}
    </div>`;
}

/* Manager search + chips */
async function searchManagers(term) {
  const dropdown = document.getElementById('reqMgrDropdown');
  if (!term || term.length < 2) { dropdown.style.display = 'none'; return; }

  const { data } = await supabase
    .from('profiles')
    .select('id, display_name, email')
    .eq('school_id', currentProfile.school_id)
    .or(`display_name.ilike.%${term}%,email.ilike.%${term}%`)
    .limit(8);

  const already = new Set(draftManagers.map(m => m.profile_id));
  const results = (data ?? []).filter(p => !already.has(p.id));

  if (!results.length) { dropdown.style.display = 'none'; return; }

  dropdown.innerHTML = results.map(p => `
    <div class="req-mgr-option" data-id="${esc(p.id)}" data-name="${esc(p.display_name ?? p.email)}" data-email="${esc(p.email ?? '')}">
      <span class="req-mgr-avatar" style="background:${getAvatarColor(p.display_name ?? p.email)};">${(p.display_name ?? p.email ?? '?')[0].toUpperCase()}</span>
      <span>${esc(p.display_name ?? p.email)}</span>
      ${p.display_name ? `<span style="color:#9ca3af;font-size:12px;">${esc(p.email ?? '')}</span>` : ''}
    </div>
  `).join('');
  dropdown.style.display = '';

  dropdown.querySelectorAll('.req-mgr-option').forEach(opt => {
    opt.addEventListener('mousedown', () => {
      draftManagers.push({ profile_id: opt.dataset.id, display_name: opt.dataset.name, email: opt.dataset.email });
      document.getElementById('reqMgrSearch').value = '';
      dropdown.style.display = 'none';
      renderManagerChips();
      renderFieldsList();   // routing editors list managers — keep in sync
    });
  });
}

function renderManagerChips() {
  const chips = document.getElementById('reqManagerChips');
  if (!chips) return;
  chips.innerHTML = draftManagers.map((m, i) => `
    <span class="req-mgr-chip">
      <span class="req-mgr-avatar" style="background:${getAvatarColor(m.display_name)};width:20px;height:20px;font-size:11px;">${m.display_name[0].toUpperCase()}</span>
      ${esc(m.display_name)}
      <button class="req-mgr-chip-remove" data-idx="${i}">&times;</button>
    </span>
  `).join('');
  chips.querySelectorAll('.req-mgr-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      draftManagers.splice(parseInt(btn.dataset.idx), 1);
      renderManagerChips();
      renderFieldsList();   // flag routing options that now point at removed managers
    });
  });
}

/* Visibility search + chips (same pattern as managers, separate list) */
async function searchVisibility(term) {
  const dropdown = document.getElementById('reqVisDropdown');
  if (!term || term.length < 2) { dropdown.style.display = 'none'; return; }

  const { data } = await supabase
    .from('profiles')
    .select('id, display_name, email')
    .eq('school_id', currentProfile.school_id)
    .or(`display_name.ilike.%${term}%,email.ilike.%${term}%`)
    .limit(8);

  const already = new Set(draftVisibility.map(m => m.profile_id));
  const results = (data ?? []).filter(p => !already.has(p.id));

  if (!results.length) { dropdown.style.display = 'none'; return; }

  dropdown.innerHTML = results.map(p => `
    <div class="req-mgr-option" data-id="${esc(p.id)}" data-name="${esc(p.display_name ?? p.email)}" data-email="${esc(p.email ?? '')}">
      <span class="req-mgr-avatar" style="background:${getAvatarColor(p.display_name ?? p.email)};">${(p.display_name ?? p.email ?? '?')[0].toUpperCase()}</span>
      <span>${esc(p.display_name ?? p.email)}</span>
      ${p.display_name ? `<span style="color:#9ca3af;font-size:12px;">${esc(p.email ?? '')}</span>` : ''}
    </div>
  `).join('');
  dropdown.style.display = '';

  dropdown.querySelectorAll('.req-mgr-option').forEach(opt => {
    opt.addEventListener('mousedown', () => {
      draftVisibility.push({ profile_id: opt.dataset.id, display_name: opt.dataset.name, email: opt.dataset.email });
      document.getElementById('reqVisSearch').value = '';
      dropdown.style.display = 'none';
      renderVisibilityChips();
    });
  });
}

function renderVisibilityChips() {
  const chips = document.getElementById('reqVisibilityChips');
  if (!chips) return;
  chips.innerHTML = draftVisibility.map((m, i) => `
    <span class="req-mgr-chip">
      <span class="req-mgr-avatar" style="background:${getAvatarColor(m.display_name)};width:20px;height:20px;font-size:11px;">${m.display_name[0].toUpperCase()}</span>
      ${esc(m.display_name)}
      <button class="req-mgr-chip-remove" data-idx="${i}">&times;</button>
    </span>
  `).join('');
  chips.querySelectorAll('.req-mgr-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      draftVisibility.splice(parseInt(btn.dataset.idx), 1);
      renderVisibilityChips();
    });
  });
}

/* Save category + fields + managers */
async function saveCategoryDrawer() {
  const name    = document.getElementById('reqCatName')?.value.trim();
  const desc    = document.getElementById('reqCatDesc')?.value.trim();
  const active  = document.getElementById('reqCatActive')?.checked;
  const notify  = document.getElementById('reqCatNotify')?.checked ?? true;
  const restricted = document.getElementById('reqCatRestricted')?.checked ?? false;
  const errEl   = document.getElementById('reqCatError');
  const saveBtn = document.getElementById('reqSaveCatBtn');

  const resolvedSel    = document.getElementById('reqCatResolvedLabel')?.value;
  const resolvedLabel  = resolvedSel === '__custom'
    ? document.getElementById('reqCatResolvedLabelCustom')?.value.trim()
    : resolvedSel;
  const allowDenial    = document.getElementById('reqCatAllowDenial')?.checked ?? false;
  const allowCompleted = document.getElementById('reqCatAllowCompleted')?.checked ?? false;
  const confidential   = document.getElementById('reqCatConfidential')?.checked ?? false;
  const deniedSel      = document.getElementById('reqCatDeniedLabel')?.value;
  const deniedLabel    = deniedSel === '__custom'
    ? document.getElementById('reqCatDeniedLabelCustom')?.value.trim()
    : deniedSel;

  if (!name) { showCatError('Form name is required.'); return; }
  if (resolvedSel === '__custom' && !resolvedLabel) { showCatError('Enter a custom label for the completed status, or pick a preset.'); return; }
  if (allowDenial && deniedSel === '__custom' && !deniedLabel) { showCatError('Enter a custom label for the denied status, or pick a preset.'); return; }
  const invalidFields = draftFields.some(f => !f.label.trim());
  if (invalidFields) { showCatError('All fields must have a label.'); return; }
  if (restricted && !draftVisibility.length) {
    showCatError('Add at least one person this restricted form should be visible to (this form\'s managers always have access).');
    return;
  }

  // Routing field: re-validate options against the current manager list.
  // Options pointing at removed managers are pruned (the builder flags
  // them before save); labels must be present and unique.
  const mgrIds = new Set(draftManagers.map(m => m.profile_id));
  for (const f of draftFields) {
    if (f.field_type !== 'routing') continue;
    f.options = (Array.isArray(f.options) ? f.options : [])
      .filter(o => o.manager_id && mgrIds.has(o.manager_id))
      .map(o => ({ label: String(o.label ?? '').trim(), manager_id: o.manager_id }));
    if (!f.options.length) {
      showCatError(`"${f.label}" needs at least one routing option mapped to a current manager.`);
      return;
    }
    if (f.options.some(o => !o.label)) {
      showCatError(`Every routing option in "${f.label}" needs a label.`);
      return;
    }
    const labels = f.options.map(o => o.label.toLowerCase());
    if (new Set(labels).size !== labels.length) {
      showCatError(`Routing options in "${f.label}" must have unique labels.`);
      return;
    }
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  let catId = editingCat?.id;

  if (catId) {
    const { error } = await supabase
      .from('request_categories')
      .update({
        name, description: desc || null, is_active: active, notify_managers: notify,
        is_restricted:  restricted,
        is_confidential: confidential,
        resolved_label: resolvedLabel || null,
        allow_denial:   allowDenial,
        denied_label:   allowDenial ? (deniedLabel || null) : null,
        allow_completed: allowCompleted,
      })
      .eq('id', catId);
    if (error) { showToast('Save failed: ' + error.message, 'error'); saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; return; }
  } else {
    const { data, error } = await supabase
      .from('request_categories')
      .insert({
        school_id: currentProfile.school_id, name, description: desc || null, is_active: active, notify_managers: notify,
        is_restricted:  restricted,
        is_confidential: confidential,
        resolved_label: resolvedLabel || null,
        allow_denial:   allowDenial,
        denied_label:   allowDenial ? (deniedLabel || null) : null,
        allow_completed: allowCompleted,
        created_by: currentProfile.id,
      })
      .select('id')
      .single();
    if (error) { showToast('Create failed: ' + error.message, 'error'); saveBtn.disabled = false; saveBtn.textContent = 'Create Form'; return; }
    catId = data.id;
  }

  // Smart field sync — preserve existing field IDs so historical responses stay linked.
  // Only delete fields the admin explicitly removed; update the rest in place.
  const fieldErrReset = () => {
    saveBtn.disabled = false;
    saveBtn.textContent = editingCat ? 'Save Changes' : 'Create Form';
  };

  const { data: existingFields, error: existErr } = await supabase
    .from('request_category_fields')
    .select('id')
    .eq('category_id', catId);
  if (existErr) { showToast('Failed to load fields: ' + existErr.message, 'error'); fieldErrReset(); return; }

  const keptIds  = new Set(draftFields.filter(f => f.id).map(f => f.id));
  const toDelete = (existingFields ?? []).map(f => f.id).filter(id => !keptIds.has(id));

  if (toDelete.length) {
    const { error: delErr } = await supabase
      .from('request_category_fields')
      .delete()
      .in('id', toDelete);
    if (delErr) { showToast('Failed to save fields: ' + delErr.message, 'error'); fieldErrReset(); return; }
  }

  // Update existing fields in place (preserves foreign keys from old responses)
  const toUpdate = draftFields
    .filter(f => f.id)
    .map(f => ({
      id:          f.id,
      category_id: catId,
      label:       f.label.trim(),
      field_type:  f.field_type,
      options:     (f.field_type === 'select' || f.field_type === 'routing') ? (f.options ?? []) : null,
      is_required: f.is_required,
      sort_order:  draftFields.indexOf(f),
    }));
  if (toUpdate.length) {
    const { error: upErr } = await supabase
      .from('request_category_fields')
      .upsert(toUpdate, { onConflict: 'id' });
    if (upErr) { showToast('Failed to save fields: ' + upErr.message, 'error'); fieldErrReset(); return; }
  }

  // Insert genuinely new fields (no ID yet)
  const toInsert = draftFields
    .filter(f => !f.id)
    .map(f => ({
      category_id: catId,
      label:       f.label.trim(),
      field_type:  f.field_type,
      options:     (f.field_type === 'select' || f.field_type === 'routing') ? (f.options ?? []) : null,
      is_required: f.is_required,
      sort_order:  draftFields.indexOf(f),
    }));
  if (toInsert.length) {
    const { error: insErr } = await supabase.from('request_category_fields').insert(toInsert);
    if (insErr) { showToast('Failed to save fields: ' + insErr.message, 'error'); fieldErrReset(); return; }
  }

  // Sync managers: delete all, re-insert
  const { error: mgDelErr } = await supabase.from('request_category_managers').delete().eq('category_id', catId);
  if (mgDelErr) { showToast('Failed to save managers: ' + mgDelErr.message, 'error'); fieldErrReset(); return; }

  if (draftManagers.length) {
    const mgRows = draftManagers.map(m => ({
      category_id: catId,
      profile_id:  m.profile_id,
      added_by:    currentProfile.id,
    }));
    const { error: mgInsErr } = await supabase.from('request_category_managers').insert(mgRows);
    if (mgInsErr) { showToast('Failed to save managers: ' + mgInsErr.message, 'error'); fieldErrReset(); return; }
  }

  // Sync visibility list: delete all, re-insert (irrelevant when not restricted, but
  // clearing it keeps stale rows from lingering if the admin toggles restriction off/on)
  const { error: visDelErr } = await supabase.from('request_category_visibility').delete().eq('category_id', catId);
  if (visDelErr) { showToast('Failed to save visibility list: ' + visDelErr.message, 'error'); fieldErrReset(); return; }

  if (restricted && draftVisibility.length) {
    const visRows = draftVisibility.map(v => ({
      category_id: catId,
      profile_id:  v.profile_id,
      added_by:    currentProfile.id,
    }));
    const { error: visInsErr } = await supabase.from('request_category_visibility').insert(visRows);
    if (visInsErr) { showToast('Failed to save visibility list: ' + visInsErr.message, 'error'); fieldErrReset(); return; }
  }

  closeCatDrawer();
  await loadCategories();
  renderRoot();
  renderFormsView();
}

async function toggleCatActive() {
  if (!editingCat) return;
  const newActive = !editingCat.is_active;
  await supabase.from('request_categories').update({ is_active: newActive }).eq('id', editingCat.id);
  closeCatDrawer();
  await loadCategories();
  renderRoot();
  renderFormsView();
}

async function deleteCategory() {
  if (!editingCat) return;

  // Authoritative count — an RLS-filtered count reads 0 on a confidential
  // form the current user can't review, which would offer a delete the FK
  // then refuses. See 20260902000001_request_submission_visibility.sql.
  const { data: count, error: countError } = await supabase
    .rpc('request_category_submission_count', { p_category_id: editingCat.id });
  if (countError) {
    showToast('Failed to delete form: ' + countError.message, 'error');
    return;
  }
  if (count > 0) {
    showToast('This form now has submissions and can\'t be deleted. Deactivate it instead.', 'error');
    closeCatDrawer();
    await loadCategories();
    renderRoot();
    renderFormsView();
    return;
  }

  const { error } = await supabase.from('request_categories').delete().eq('id', editingCat.id);
  if (error) {
    showToast('Failed to delete form: ' + error.message, 'error');
    return;
  }
  closeCatDrawer();
  await loadCategories();
  renderRoot();
  renderFormsView();
}

function showCatError(msg) {
  const el = document.getElementById('reqCatError');
  if (el) { el.textContent = msg; el.style.display = ''; }
  const saveBtn = document.getElementById('reqSaveCatBtn');
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = editingCat ? 'Save Changes' : 'Create Form'; }
}

function closeCatDrawer() {
  document.getElementById('reqCatDrawer').classList.remove('open');
  document.getElementById('reqCatOverlay').classList.remove('open');
  editingCat      = null;
  draftFields     = [];
  draftManagers   = [];
  draftVisibility = [];
}

/* ═══════════════════════════════════════════════════════════
   SUBMISSIONS VIEW
═══════════════════════════════════════════════════════════ */
function renderSubmissionsView() {
  const container = document.getElementById('reqViewContainer');
  if (!container) return;

  const catOptions = categories.map(c =>
    `<option value="${esc(c.id)}" ${filterCatId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
  ).join('');

  container.innerHTML = `
    <div class="req-filters">
      <select id="reqFilterCat" class="form-control" style="width:200px;">
        <option value="">All Forms</option>
        ${catOptions}
      </select>
      <select id="reqFilterStatus" class="form-control" style="width:auto;min-width:160px;" title="Open = Pending and In Review. Resolved, Completed, and Denied are hidden.">
        <option value="open"      ${filterStatus === 'open'      ? 'selected' : ''}>Open</option>
        <option value=""          ${filterStatus === ''          ? 'selected' : ''}>All Statuses</option>
        <option value="pending"   ${filterStatus === 'pending'   ? 'selected' : ''}>Pending</option>
        <option value="in_review" ${filterStatus === 'in_review' ? 'selected' : ''}>In Review</option>
        <option value="resolved"  ${filterStatus === 'resolved'  ? 'selected' : ''}>Resolved</option>
        <option value="completed" ${filterStatus === 'completed' ? 'selected' : ''}>Completed</option>
        <option value="denied"    ${filterStatus === 'denied'    ? 'selected' : ''}>Denied</option>
      </select>
      <button class="btn" id="reqExportBtn" style="margin-left:auto;white-space:nowrap;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Export CSV
      </button>
    </div>
    <div id="reqSubList" style="margin-top:16px;"></div>
  `;

  renderSubmissionsList();

  document.getElementById('reqExportBtn').addEventListener('click', () => {
    // Exports exactly what the current filters show, not the whole table.
    const contextName = filterCatId
      ? (categories.find(c => c.id === filterCatId)?.name ?? 'Requests')
      : 'All Forms';
    const statusSel = document.getElementById('reqFilterStatus');
    const statusName = filterStatus ? statusSel?.options[statusSel.selectedIndex]?.text : '';
    if (!exportSubmissions(submissions, contextName, statusName)) {
      showToast('Nothing to export with the current filters.', 'error');
    }
  });

  document.getElementById('reqFilterCat').addEventListener('change', async (e) => {
    filterCatId = e.target.value;
    await loadSubmissions();
    renderSubmissionsList();
  });
  document.getElementById('reqFilterStatus').addEventListener('change', async (e) => {
    filterStatus = e.target.value;
    await loadSubmissions();
    renderSubmissionsList();
  });
}

function renderSubmissionsList() {
  const list = document.getElementById('reqSubList');
  if (!list) return;

  if (!submissions.length) {
    // Under the default "Open" filter an empty list means caught up, not
    // empty — say so, and point at where the finished ones went. Applies
    // whether or not a specific form is selected.
    list.innerHTML = filterStatus === 'open'
      ? `<div class="empty-state"><p>Nothing open ${filterCatId ? 'on this form' : 'right now'}. You're all caught up.<br>Switch to <strong>All Statuses</strong> to see resolved, completed, and denied submissions.</p></div>`
      : '<div class="empty-state"><p>No submissions found.</p></div>';
    return;
  }

  list.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th style="width:160px;">Submitted By</th>
          <th style="width:160px;">Form</th>
          <th>Details</th>
          <th style="width:110px;">Date</th>
          <th style="width:100px;">Status</th>
        </tr>
      </thead>
      <tbody>
        ${submissions.map(s => {
          const submitter = s.profiles;
          const name    = submitter?.display_name ?? submitter?.email ?? 'Unknown';
          const cat     = s.request_categories?.name ?? '—';
          const preview = submissionPreview(s);
          return `
            <tr class="req-sub-row" data-id="${esc(s.id)}" style="cursor:pointer;">
              <td>${esc(name)}</td>
              <td style="color:#6b7280;">${esc(cat)}</td>
              <td style="color:#374151;max-width:0;">${preview ? `<div class="req-sub-preview">${esc(preview)}</div>` : '<span style="color:#d1d5db;">—</span>'}</td>
              <td style="white-space:nowrap;">${fmtShortDate(s.created_at)}</td>
              <td><span class="status-badge ${statusBadgeClass(s.status)}">${statusLabel(s.status, s.request_categories)}</span></td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  list.querySelectorAll('.req-sub-row').forEach(row => {
    row.addEventListener('click', () => {
      const sub = submissions.find(s => s.id === row.dataset.id);
      if (sub) openSubDrawer(sub);
    });
  });
}

/* ═══════════════════════════════════════════════════════════
   SUBMISSION DETAIL DRAWER
═══════════════════════════════════════════════════════════ */

// Snapshot of the notes textarea right after render, so a close can tell
// whether the admin typed something that never got saved.
let subNotesSnapshot = '';

function handleCloseSubRequest() {
  const current = document.getElementById('reqSubNotes')?.value.trim() ?? '';
  if (current !== subNotesSnapshot && !confirm('You have unsaved notes. Close without saving?')) return;
  closeSubDrawer();
}

async function openSubDrawer(sub) {
  const titleEl = document.getElementById('reqSubDrawerTitle');
  const bodyEl  = document.getElementById('reqSubDrawerBody');
  if (!titleEl || !bodyEl) return;

  const catName = sub.request_categories?.name ?? 'Request';
  titleEl.textContent = catName;
  bodyEl.innerHTML = '<p style="color:#9ca3af;padding:16px;">Loading…</p>';

  document.getElementById('reqSubDrawer').classList.add('open');
  document.getElementById('reqSubOverlay').classList.add('open');

  // Load responses with field labels
  const { data: responses } = await supabase
    .from('staff_request_responses')
    .select('value, request_category_fields ( label, field_type, sort_order )')
    .eq('request_id', sub.id)
    .order('request_category_fields(sort_order)');

  const submitter = sub.profiles;
  const name      = submitter?.display_name ?? submitter?.email ?? 'Unknown';

  bodyEl.innerHTML = `
    <div style="margin-bottom:16px;">
      <div style="font-size:13px;color:#6b7280;">Submitted by <strong>${esc(name)}</strong> on ${fmtShortDate(sub.created_at)}</div>
    </div>

    <div class="req-responses">
      ${(responses ?? []).map(r => {
        const label = r.request_category_fields?.label ?? 'Field';
        const val   = formatResponseValue(r.value, r.request_category_fields?.field_type);
        return `
          <div class="req-response-row">
            <div class="req-response-label">${esc(label)}</div>
            <div class="req-response-value">${val}</div>
          </div>`;
      }).join('') || '<p style="color:#9ca3af;">No responses recorded.</p>'}
    </div>

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />
    <div class="form-group">
      <label class="form-label">Status</label>
      <select id="reqSubStatus" class="form-control" style="width:180px;">
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
    <div class="form-group">
      <label class="form-label">Manager Notes <span style="font-weight:400;color:#9ca3af;">(visible to submitter)</span></label>
      <textarea id="reqSubNotes" class="form-control" rows="3" placeholder="Optional notes…">${esc(sub.manager_notes ?? '')}</textarea>
    </div>
    <div style="margin-top:16px;display:flex;gap:8px;align-items:center;">
      <button class="btn btn-primary" id="reqSaveSubBtn" style="height:36px;">Save</button>
      <button class="btn" id="reqExportSubBtn" style="height:36px;">Export CSV</button>
      <button class="btn" id="reqCancelSubBtn" style="height:36px;">Close</button>
    </div>
    <p id="reqSubError" style="color:#dc2626;font-size:13px;margin-top:8px;display:none;"></p>
  `;

  subNotesSnapshot = sub.manager_notes?.trim() ?? '';

  document.getElementById('reqSaveSubBtn').addEventListener('click', () => saveSubmission(sub.id));
  document.getElementById('reqCancelSubBtn').addEventListener('click', handleCloseSubRequest);
  document.getElementById('reqExportSubBtn').addEventListener('click', () => {
    // The drawer fetches responses separately; the list row may predate any
    // edits, so export the freshly loaded ones.
    exportOneSubmission({ ...sub, staff_request_responses: responses ?? [] });
  });
}

async function saveSubmission(requestId) {
  const status = document.getElementById('reqSubStatus')?.value;
  const notes  = document.getElementById('reqSubNotes')?.value.trim();
  const errEl  = document.getElementById('reqSubError');
  const btn    = document.getElementById('reqSaveSubBtn');

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

  subNotesSnapshot = notes;
  closeSubDrawer();
  await loadSubmissions();
  renderSubmissionsList();

  // Notify the submitter (fire and forget — don't block on email)
  supabase.functions.invoke('send_request_update_notification', { body: { request_id: requestId } })
    .catch(err => console.error('update notification failed', err));
}

function closeSubDrawer() {
  document.getElementById('reqSubDrawer').classList.remove('open');
  document.getElementById('reqSubOverlay').classList.remove('open');
}

/* ═══════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════ */
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

function statusLabel(s, cat) {
  if (s === 'resolved') return cat?.resolved_label || 'Resolved';
  if (s === 'denied')   return cat?.denied_label   || 'Denied';
  return { pending: 'Pending', in_review: 'In Review', completed: 'Completed' }[s] ?? s;
}

function statusBadgeClass(s) {
  return { pending: 'badge-amber', in_review: 'badge-blue', resolved: 'badge-green', denied: 'badge-red', completed: 'badge-purple' }[s] ?? '';
}

function formatResponseValue(val, type) {
  if (!val) return '—';
  if (type === 'boolean') return val === 'true' ? 'Yes' : 'No';
  if (type === 'url') {
    // type="url" validity only requires a well-formed absolute URL, not a
    // safe scheme (javascript:... passes) -- only link http(s), otherwise
    // fall back to plain text so a crafted value can't become a clickable
    // javascript: href in an admin's browser.
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
