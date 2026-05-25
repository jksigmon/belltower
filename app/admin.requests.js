import { supabase } from './admin.supabase.js';
import { esc, debounce, getAvatarColor, fmtShortDate } from './admin.shared.js';

let currentProfile = null;
let currentView = 'forms'; // 'forms' | 'submissions'
let categories   = [];
let editingCat   = null;   // category being edited in drawer
let draftFields  = [];     // field rows in open drawer
let draftManagers = [];    // manager chips in open drawer
let submissions  = [];
let filterCatId  = '';
let filterStatus = '';
let mgSearchTimeout = null;

/* ═══════════════════════════════════════════════════════════
   ENTRY POINT
═══════════════════════════════════════════════════════════ */
export async function initRequestsSection(profile) {
  currentProfile = profile;
  await loadCategories();
  renderRoot();
}

/* ═══════════════════════════════════════════════════════════
   DATA
═══════════════════════════════════════════════════════════ */
async function loadCategories() {
  const { data, error } = await supabase
    .from('request_categories')
    .select('id, name, description, is_active, created_at')
    .eq('school_id', currentProfile.school_id)
    .order('name');
  if (error) console.error('loadCategories', error);
  categories = data ?? [];
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

  if (filterCatId)  q = q.eq('category_id', filterCatId);
  if (filterStatus) q = q.eq('status', filterStatus);

  const { data, error } = await q;
  if (error) console.error('loadSubmissions', error);
  submissions = data ?? [];
}

async function loadCategoryDetail(catId) {
  const [fieldsRes, managersRes] = await Promise.all([
    supabase
      .from('request_category_fields')
      .select('id, label, field_type, options, is_required, sort_order')
      .eq('category_id', catId)
      .order('sort_order'),
    supabase
      .from('request_category_managers')
      .select('profile_id, profiles ( display_name, email )')
      .eq('category_id', catId),
  ]);
  return {
    fields:   fieldsRes.data   ?? [],
    managers: managersRes.data ?? [],
  };
}

/* ═══════════════════════════════════════════════════════════
   ROOT RENDER
═══════════════════════════════════════════════════════════ */
function renderRoot() {
  const root = document.getElementById('requestsSectionRoot');
  if (!root) return;

  root.innerHTML = `
    <div class="section-header" style="flex-wrap:wrap;gap:8px;">
      <div>
        <h2 style="margin:0 0 10px;">Staff Requests</h2>
        <div class="req-tabs">
          <button class="req-tab${currentView === 'forms' ? ' active' : ''}" data-view="forms">Request Forms</button>
          <button class="req-tab${currentView === 'submissions' ? ' active' : ''}" data-view="submissions">Submissions</button>
        </div>
      </div>
      ${currentView === 'forms' ? `<button class="btn btn-primary" id="reqNewFormBtn">+ New Form</button>` : ''}
    </div>
    <div id="reqViewContainer" style="margin-top:16px;"></div>

    <!-- Category editor drawer -->
    <div id="reqCatDrawer" class="drawer" style="display:none;">
      <div class="drawer-header">
        <span id="reqCatDrawerTitle">New Request Form</span>
        <button class="drawer-close" id="reqCatDrawerClose">&times;</button>
      </div>
      <div class="drawer-body" id="reqCatDrawerBody"></div>
    </div>
    <div id="reqCatOverlay" class="drawer-overlay" style="display:none;"></div>

    <!-- Submission detail drawer -->
    <div id="reqSubDrawer" class="drawer" style="display:none;">
      <div class="drawer-header">
        <span id="reqSubDrawerTitle">Request Detail</span>
        <button class="drawer-close" id="reqSubDrawerClose">&times;</button>
      </div>
      <div class="drawer-body" id="reqSubDrawerBody"></div>
    </div>
    <div id="reqSubOverlay" class="drawer-overlay" style="display:none;"></div>
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
  document.getElementById('reqCatDrawerClose')?.addEventListener('click', closeCatDrawer);
  document.getElementById('reqCatOverlay')?.addEventListener('click', closeCatDrawer);
  document.getElementById('reqSubDrawerClose')?.addEventListener('click', closeSubDrawer);
  document.getElementById('reqSubOverlay')?.addEventListener('click', closeSubDrawer);

  if (currentView === 'forms') renderFormsView();
}

/* ═══════════════════════════════════════════════════════════
   FORMS VIEW
═══════════════════════════════════════════════════════════ */
function renderFormsView() {
  const container = document.getElementById('reqViewContainer');
  if (!container) return;

  if (!categories.length) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No request forms yet. Create one to let staff submit requests.</p>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="req-cat-grid">
      ${categories.map(c => `
        <div class="req-cat-card${c.is_active ? '' : ' req-cat-card--inactive'}" data-id="${esc(c.id)}">
          <div class="req-cat-card-header">
            <span class="req-cat-name">${esc(c.name)}</span>
            <span class="status-badge ${c.is_active ? 'badge-green' : 'badge-gray'}">${c.is_active ? 'Active' : 'Inactive'}</span>
          </div>
          ${c.description ? `<p class="req-cat-desc">${esc(c.description)}</p>` : ''}
          <div class="req-cat-actions">
            <button class="btn btn-sm btn-secondary req-edit-btn" data-id="${esc(c.id)}">Edit Form</button>
          </div>
        </div>
      `).join('')}
    </div>`;

  container.querySelectorAll('.req-edit-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cat = categories.find(c => c.id === btn.dataset.id);
      if (cat) await openCatDrawer(cat);
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

  document.getElementById('reqCatDrawer').style.display  = '';
  document.getElementById('reqCatOverlay').style.display = '';

  if (cat) {
    const { fields, managers } = await loadCategoryDetail(cat.id);
    draftFields   = fields.map(f => ({ ...f }));
    draftManagers = managers.map(m => ({
      profile_id:   m.profile_id,
      display_name: m.profiles?.display_name ?? m.profiles?.email ?? 'Unknown',
      email:        m.profiles?.email ?? '',
    }));
  } else {
    draftFields   = [];
    draftManagers = [];
  }

  renderCatDrawerBody(cat);
}

function renderCatDrawerBody(cat) {
  const bodyEl = document.getElementById('reqCatDrawerBody');
  if (!bodyEl) return;

  bodyEl.innerHTML = `
    <div class="form-group">
      <label class="form-label">Form Name *</label>
      <input id="reqCatName" class="form-control" type="text" value="${cat ? esc(cat.name) : ''}" placeholder="e.g. Facilities Request, IT Support" />
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <textarea id="reqCatDesc" class="form-control" rows="2" placeholder="Brief description staff will see">${cat ? esc(cat.description ?? '') : ''}</textarea>
    </div>
    <div class="form-group form-row" style="align-items:center;gap:10px;">
      <label class="form-label" style="margin:0;">Active</label>
      <input id="reqCatActive" type="checkbox" ${(!cat || cat.is_active) ? 'checked' : ''} />
      <span style="font-size:13px;color:#6b7280;">Staff can see and submit this form</span>
    </div>

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />
    <div class="req-drawer-section-header">
      <strong>Form Fields</strong>
      <button class="btn btn-sm btn-secondary" id="reqAddFieldBtn">+ Add Field</button>
    </div>
    <div id="reqFieldsList" style="margin-top:12px;"></div>

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />
    <div class="req-drawer-section-header">
      <strong>Managers</strong>
    </div>
    <p style="font-size:13px;color:#6b7280;margin:4px 0 10px;">Managers receive notifications and can update submission status.</p>
    <div id="reqManagerChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;"></div>
    <div style="position:relative;">
      <input id="reqMgrSearch" class="form-control" type="text" placeholder="Search staff by name or email…" autocomplete="off" />
      <div id="reqMgrDropdown" class="req-mgr-dropdown" style="display:none;"></div>
    </div>

    <div style="margin-top:24px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-primary" id="reqSaveCatBtn">${cat ? 'Save Changes' : 'Create Form'}</button>
      ${cat ? `<button class="btn btn-danger-outline" id="reqToggleActiveBtn">${cat.is_active ? 'Deactivate' : 'Activate'} Form</button>` : ''}
      <button class="btn btn-secondary" id="reqCancelCatBtn">Cancel</button>
    </div>
    <p id="reqCatError" style="color:#dc2626;font-size:13px;margin-top:8px;display:none;"></p>
  `;

  renderFieldsList();
  renderManagerChips();

  document.getElementById('reqAddFieldBtn').addEventListener('click', addField);
  document.getElementById('reqSaveCatBtn').addEventListener('click', saveCategoryDrawer);
  document.getElementById('reqCancelCatBtn').addEventListener('click', closeCatDrawer);
  document.getElementById('reqToggleActiveBtn')?.addEventListener('click', toggleCatActive);

  const mgrSearch = document.getElementById('reqMgrSearch');
  mgrSearch.addEventListener('input', () => {
    clearTimeout(mgSearchTimeout);
    mgSearchTimeout = setTimeout(() => searchManagers(mgrSearch.value.trim()), 220);
  });
  mgrSearch.addEventListener('blur', () => {
    setTimeout(() => { document.getElementById('reqMgrDropdown').style.display = 'none'; }, 150);
  });
}

function renderFieldsList() {
  const list = document.getElementById('reqFieldsList');
  if (!list) return;

  if (!draftFields.length) {
    list.innerHTML = '<p style="font-size:13px;color:#9ca3af;">No fields yet. Add a field above.</p>';
    return;
  }

  list.innerHTML = draftFields.map((f, i) => `
    <div class="req-field-row" data-idx="${i}">
      <div class="req-field-main">
        <input class="form-control req-field-label" type="text" placeholder="Field label *" value="${esc(f.label)}" style="flex:1;" />
        <select class="form-control req-field-type" style="width:140px;">
          ${['text','textarea','select','date','boolean'].map(t =>
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
    </div>
  `).join('');

  list.querySelectorAll('.req-field-label').forEach((inp, i) => {
    inp.addEventListener('input', () => { draftFields[i].label = inp.value; });
  });
  list.querySelectorAll('.req-field-type').forEach((sel, i) => {
    sel.addEventListener('change', () => {
      draftFields[i].field_type = sel.value;
      if (sel.value !== 'select') draftFields[i].options = null;
      renderFieldsList();
    });
  });
  list.querySelectorAll('.req-field-required').forEach((cb, i) => {
    cb.addEventListener('change', () => { draftFields[i].is_required = cb.checked; });
  });
  list.querySelectorAll('.req-field-options').forEach((inp, i) => {
    inp.addEventListener('input', () => {
      draftFields[i].options = inp.value.split(',').map(s => s.trim()).filter(Boolean);
    });
  });
  list.querySelectorAll('.req-field-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      draftFields.splice(parseInt(btn.dataset.idx), 1);
      renderFieldsList();
    });
  });
}

function addField() {
  draftFields.push({ label: '', field_type: 'text', is_required: false, options: null, sort_order: draftFields.length });
  renderFieldsList();
  // focus the new label input
  const inputs = document.querySelectorAll('.req-field-label');
  inputs[inputs.length - 1]?.focus();
}

function fieldTypeLabel(t) {
  return { text: 'Short Text', textarea: 'Paragraph', select: 'Dropdown', date: 'Date', boolean: 'Yes / No' }[t] ?? t;
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
    });
  });
}

/* Save category + fields + managers */
async function saveCategoryDrawer() {
  const name    = document.getElementById('reqCatName')?.value.trim();
  const desc    = document.getElementById('reqCatDesc')?.value.trim();
  const active  = document.getElementById('reqCatActive')?.checked;
  const errEl   = document.getElementById('reqCatError');
  const saveBtn = document.getElementById('reqSaveCatBtn');

  if (!name) { showCatError('Form name is required.'); return; }
  const invalidFields = draftFields.some(f => !f.label.trim());
  if (invalidFields) { showCatError('All fields must have a label.'); return; }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  let catId = editingCat?.id;

  if (catId) {
    const { error } = await supabase
      .from('request_categories')
      .update({ name, description: desc || null, is_active: active })
      .eq('id', catId);
    if (error) { showCatError('Save failed: ' + error.message); saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; return; }
  } else {
    const { data, error } = await supabase
      .from('request_categories')
      .insert({ school_id: currentProfile.school_id, name, description: desc || null, is_active: active, created_by: currentProfile.id })
      .select('id')
      .single();
    if (error) { showCatError('Create failed: ' + error.message); saveBtn.disabled = false; saveBtn.textContent = 'Create Form'; return; }
    catId = data.id;
  }

  // Replace all fields
  await supabase.from('request_category_fields').delete().eq('category_id', catId);
  if (draftFields.length) {
    const fieldRows = draftFields.map((f, i) => ({
      category_id: catId,
      label:       f.label.trim(),
      field_type:  f.field_type,
      options:     f.field_type === 'select' ? (f.options ?? []) : null,
      is_required: f.is_required,
      sort_order:  i,
    }));
    const { error } = await supabase.from('request_category_fields').insert(fieldRows);
    if (error) console.error('field insert', error);
  }

  // Sync managers: delete all, re-insert
  await supabase.from('request_category_managers').delete().eq('category_id', catId);
  if (draftManagers.length) {
    const mgRows = draftManagers.map(m => ({
      category_id: catId,
      profile_id:  m.profile_id,
      added_by:    currentProfile.id,
    }));
    const { error } = await supabase.from('request_category_managers').insert(mgRows);
    if (error) console.error('manager insert', error);
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

function showCatError(msg) {
  const el = document.getElementById('reqCatError');
  if (el) { el.textContent = msg; el.style.display = ''; }
  const saveBtn = document.getElementById('reqSaveCatBtn');
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = editingCat ? 'Save Changes' : 'Create Form'; }
}

function closeCatDrawer() {
  document.getElementById('reqCatDrawer').style.display  = 'none';
  document.getElementById('reqCatOverlay').style.display = 'none';
  editingCat    = null;
  draftFields   = [];
  draftManagers = [];
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
      <select id="reqFilterStatus" class="form-control" style="width:160px;">
        <option value="">All Statuses</option>
        <option value="pending"   ${filterStatus === 'pending'   ? 'selected' : ''}>Pending</option>
        <option value="in_review" ${filterStatus === 'in_review' ? 'selected' : ''}>In Review</option>
        <option value="resolved"  ${filterStatus === 'resolved'  ? 'selected' : ''}>Resolved</option>
      </select>
    </div>
    <div id="reqSubList" style="margin-top:16px;"></div>
  `;

  renderSubmissionsList();

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
    list.innerHTML = '<div class="empty-state"><p>No submissions found.</p></div>';
    return;
  }

  list.innerHTML = `
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
          const submitter = s.profiles;
          const name = submitter?.display_name ?? submitter?.email ?? 'Unknown';
          const cat  = s.request_categories?.name ?? '—';
          return `
            <tr class="req-sub-row" data-id="${esc(s.id)}" style="cursor:pointer;">
              <td>${esc(name)}</td>
              <td>${esc(cat)}</td>
              <td>${fmtShortDate(s.created_at)}</td>
              <td><span class="status-badge ${statusBadgeClass(s.status)}">${statusLabel(s.status)}</span></td>
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
async function openSubDrawer(sub) {
  const titleEl = document.getElementById('reqSubDrawerTitle');
  const bodyEl  = document.getElementById('reqSubDrawerBody');
  if (!titleEl || !bodyEl) return;

  const catName = sub.request_categories?.name ?? 'Request';
  titleEl.textContent = catName;
  bodyEl.innerHTML = '<p style="color:#9ca3af;padding:16px;">Loading…</p>';

  document.getElementById('reqSubDrawer').style.display  = '';
  document.getElementById('reqSubOverlay').style.display = '';

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
            <div class="req-response-value">${esc(val)}</div>
          </div>`;
      }).join('') || '<p style="color:#9ca3af;">No responses recorded.</p>'}
    </div>

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />
    <div class="form-group">
      <label class="form-label">Status</label>
      <select id="reqSubStatus" class="form-control" style="width:180px;">
        <option value="pending"   ${sub.status === 'pending'   ? 'selected' : ''}>Pending</option>
        <option value="in_review" ${sub.status === 'in_review' ? 'selected' : ''}>In Review</option>
        <option value="resolved"  ${sub.status === 'resolved'  ? 'selected' : ''}>Resolved</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Manager Notes <span style="font-weight:400;color:#9ca3af;">(visible to submitter)</span></label>
      <textarea id="reqSubNotes" class="form-control" rows="3" placeholder="Optional notes…">${esc(sub.manager_notes ?? '')}</textarea>
    </div>
    <div style="margin-top:16px;display:flex;gap:8px;">
      <button class="btn btn-primary" id="reqSaveSubBtn">Save</button>
      <button class="btn btn-secondary" id="reqCancelSubBtn">Close</button>
    </div>
    <p id="reqSubError" style="color:#dc2626;font-size:13px;margin-top:8px;display:none;"></p>
  `;

  document.getElementById('reqSaveSubBtn').addEventListener('click', () => saveSubmission(sub.id));
  document.getElementById('reqCancelSubBtn').addEventListener('click', closeSubDrawer);
}

async function saveSubmission(requestId) {
  const status = document.getElementById('reqSubStatus')?.value;
  const notes  = document.getElementById('reqSubNotes')?.value.trim();
  const errEl  = document.getElementById('reqSubError');
  const btn    = document.getElementById('reqSaveSubBtn');

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

  closeSubDrawer();
  await loadSubmissions();
  renderSubmissionsList();
}

function closeSubDrawer() {
  document.getElementById('reqSubDrawer').style.display  = 'none';
  document.getElementById('reqSubOverlay').style.display = 'none';
}

/* ═══════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════ */
function statusLabel(s) {
  return { pending: 'Pending', in_review: 'In Review', resolved: 'Resolved' }[s] ?? s;
}

function statusBadgeClass(s) {
  return { pending: 'badge-amber', in_review: 'badge-blue', resolved: 'badge-green' }[s] ?? '';
}

function formatResponseValue(val, type) {
  if (!val) return '—';
  if (type === 'boolean') return val === 'true' ? 'Yes' : 'No';
  return val;
}
