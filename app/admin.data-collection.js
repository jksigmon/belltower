// admin.data-collection.js
import { supabase } from './admin.supabase.js';
import { esc } from './admin.shared.js';

let profile = null;
let campaigns = [];
let currentCampaign = null;
let submissions = [];
let selectedIds = new Set();
let activeFilter = 'all';

const FORM_BASE = `${location.origin}/app/guardian-intake.html`;

/* ===============================
   ENTRY POINT
================================ */
export async function initDataCollectionSection(p) {
  profile = p;

  if (!profile.can_manage_guardians && !profile.can_manage_families && !profile.is_superadmin) {
    document.getElementById('dataCollectionRoot').innerHTML =
      '<p class="muted" style="padding:40px;">You are not authorized to manage data collection.</p>';
    return;
  }

  wireEvents();
  await loadCampaigns();
}

/* ===============================
   CAMPAIGNS
================================ */
async function loadCampaigns() {
  const { data, error } = await supabase
    .from('guardian_intake_campaigns')
    .select('id, name, status, token, created_at, closed_at')
    .eq('school_id', profile.school_id)
    .order('created_at', { ascending: false });

  if (error) { console.error('loadCampaigns', error); return; }
  campaigns = data ?? [];
  renderCampaigns();
}

function renderCampaigns() {
  const tbody = document.getElementById('dcCampaignTable');
  if (!tbody) return;

  if (!campaigns.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted" style="padding:24px;text-align:center;">No campaigns yet — create one to get started.</td></tr>';
    return;
  }

  tbody.innerHTML = campaigns.map(c => {
    const statusBadge = {
      active:   '<span class="comp-chip comp-chip-green">Active</span>',
      closed:   '<span class="comp-chip" style="background:#f1f5f9;color:#475569;">Closed</span>',
      archived: '<span class="comp-chip" style="background:#f1f5f9;color:#9ca3af;">Archived</span>',
    }[c.status] ?? '';

    const date = new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const link = `${FORM_BASE}?token=${c.token}`;

    const copyBtn = c.status === 'active'
      ? `<button class="btn btn-sm" onclick="window.__dcCopyLink('${c.token}')" title="Copy shareable link">Copy Link</button>`
      : `<span style="font-size:12px;color:#9ca3af;">—</span>`;

    const actionBtns = c.status === 'active'
      ? `<button class="btn btn-sm" onclick="window.__dcCloseCapaign('${c.id}')">Close</button>`
      : c.status === 'closed'
      ? `<button class="btn btn-sm" onclick="window.__dcArchiveCampaign('${c.id}')">Archive</button>`
      : `<button class="btn btn-sm" style="color:#b91c1c;border-color:#fecaca;" onclick="window.__dcDeleteCampaign('${c.id}', '${esc(c.name)}')">Delete</button>`;

    return `<tr>
      <td><strong>${esc(c.name)}</strong></td>
      <td>${statusBadge}</td>
      <td style="font-size:12px;color:#6b7280;">${date}</td>
      <td>${copyBtn}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="window.__dcViewSubmissions('${c.id}')">Review (${c._count ?? '…'})</button>
        ${actionBtns}
      </td>
    </tr>`;
  }).join('');

  // Load submission counts async
  loadCampaignCounts();
}

async function loadCampaignCounts() {
  if (!campaigns.length) return;
  const ids = campaigns.map(c => c.id);
  const { data } = await supabase
    .from('guardian_intake_submissions')
    .select('campaign_id', { count: 'exact' })
    .in('campaign_id', ids);

  // Count per campaign
  const counts = {};
  if (data) data.forEach(r => { counts[r.campaign_id] = (counts[r.campaign_id] ?? 0) + 1; });

  // Re-render only the count cells rather than full re-render
  campaigns.forEach(c => {
    c._count = counts[c.id] ?? 0;
  });

  // Update Review button text
  document.querySelectorAll('#dcCampaignTable tr').forEach((tr, i) => {
    const btn = tr.querySelector('.btn-primary');
    if (btn && campaigns[i]) btn.textContent = `Review (${campaigns[i]._count ?? 0})`;
  });
}

/* ===============================
   CLIPBOARD HELPER
================================ */
function copyText(text, onSuccess) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(onSuccess).catch(() => fallbackCopy(text, onSuccess));
  } else {
    fallbackCopy(text, onSuccess);
  }
}

function fallbackCopy(text, onSuccess) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); onSuccess(); } catch { prompt('Copy this link:', text); }
  document.body.removeChild(ta);
}

/* ===============================
   CAMPAIGN ACTIONS
================================ */
window.__dcCopyLink = function(token) {
  const link = `${FORM_BASE}?token=${token}`;
  copyText(link, () => showToast('Link copied to clipboard'));
};

window.__dcCloseCapaign = async function(id) {
  if (!confirm('Close this campaign? Parents will no longer be able to submit.')) return;
  const { error } = await supabase
    .from('guardian_intake_campaigns')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('id', id);
  if (error) { alert('Failed to close campaign.'); return; }
  await loadCampaigns();
};

window.__dcArchiveCampaign = async function(id) {
  if (!confirm('Archive this campaign?')) return;
  const { error } = await supabase
    .from('guardian_intake_campaigns')
    .update({ status: 'archived' })
    .eq('id', id);
  if (error) { alert('Failed to archive campaign.'); return; }
  await loadCampaigns();
};

window.__dcDeleteCampaign = async function(id, name) {
  if (!confirm(`Permanently delete "${name}"? This will also delete all submissions for this campaign and cannot be undone.`)) return;
  const { error } = await supabase
    .from('guardian_intake_campaigns')
    .delete()
    .eq('id', id);
  if (error) { alert('Failed to delete campaign: ' + error.message); return; }
  await loadCampaigns();
};

window.__dcViewSubmissions = async function(id) {
  currentCampaign = campaigns.find(c => c.id === id) ?? null;
  if (!currentCampaign) return;
  document.getElementById('dcCampaignView').style.display = 'none';
  document.getElementById('dcReviewView').style.display = '';
  document.getElementById('dcReviewCampaignName').textContent = currentCampaign.name;
  activeFilter = 'all';
  await loadSubmissions();
};

/* ===============================
   NEW CAMPAIGN MODAL
================================ */
function openNewCampaignModal() {
  document.getElementById('dcNewCampaignName').value = '';
  document.getElementById('dcNewCampaignModal').style.display = 'flex';
  document.getElementById('dcNewCampaignName').focus();
}

function closeNewCampaignModal() {
  document.getElementById('dcNewCampaignModal').style.display = 'none';
}

async function saveNewCampaign() {
  const name = document.getElementById('dcNewCampaignName').value.trim();
  if (!name) { document.getElementById('dcNewCampaignName').focus(); return; }

  const btn = document.getElementById('dcSaveCampaignBtn');
  btn.disabled = true;

  const { data, error } = await supabase
    .from('guardian_intake_campaigns')
    .insert({ school_id: profile.school_id, name, created_by: profile.id })
    .select('id, name, token')
    .single();

  btn.disabled = false;

  if (error) { alert('Failed to create campaign.'); console.error(error); return; }

  closeNewCampaignModal();
  await loadCampaigns();

  // Immediately show the share link
  const link = `${FORM_BASE}?token=${data.token}`;
  showShareLinkModal(data.name, link);
}

function showShareLinkModal(name, link) {
  document.getElementById('dcShareLinkName').textContent = name;
  document.getElementById('dcShareLinkInput').value = link;
  document.getElementById('dcShareLinkModal').style.display = 'flex';
}

/* ===============================
   SUBMISSIONS
================================ */
async function loadSubmissions() {
  if (!currentCampaign) return;

  const wrap = document.getElementById('dcReviewList');
  wrap.innerHTML = '<p class="muted" style="padding:24px;text-align:center;">Loading…</p>';
  selectedIds.clear();
  updateBulkBar();

  let query = supabase
    .from('guardian_intake_submissions')
    .select('id, submitted_at, first_name, last_name, email, phone_cell, relationship, students, match_confidence, match_candidates, review_status, matched_guardian_id')
    .eq('campaign_id', currentCampaign.id)
    .order('submitted_at', { ascending: false });

  if (activeFilter !== 'all') {
    if (['pending','accepted','partial','discarded','merged'].includes(activeFilter)) {
      query = query.eq('review_status', activeFilter);
    } else if (['high','medium','none'].includes(activeFilter)) {
      query = query.eq('match_confidence', activeFilter);
    }
  }

  const { data, error } = await query;
  if (error) { wrap.innerHTML = '<p class="muted" style="padding:24px;text-align:center;">Failed to load submissions.</p>'; return; }

  submissions = data ?? [];
  renderSubmissionList();
  renderFilterCounts();
}

function renderSubmissionList() {
  const wrap = document.getElementById('dcReviewList');

  if (!submissions.length) {
    wrap.innerHTML = '<p class="muted" style="padding:24px;text-align:center;">No submissions match this filter.</p>';
    return;
  }

  wrap.innerHTML = submissions.map(s => {
    const conf = s.match_confidence ?? 'none';
    const confBadge = {
      high:   '<span class="comp-chip comp-chip-green" title="High confidence match">High</span>',
      medium: '<span class="comp-chip" style="background:#fef3c7;color:#92400e;" title="Medium confidence match">Medium</span>',
      none:   '<span class="comp-chip" style="background:#f1f5f9;color:#6b7280;" title="No match found">No match</span>',
    }[conf] ?? '';

    const statusBadge = {
      pending:   '<span class="comp-chip" style="background:#eff6ff;color:#1d4ed8;">Pending</span>',
      accepted:  '<span class="comp-chip comp-chip-green">Accepted</span>',
      partial:   '<span class="comp-chip" style="background:#f0fdf4;color:#15803d;">Partial</span>',
      discarded: '<span class="comp-chip" style="background:#f1f5f9;color:#9ca3af;">Discarded</span>',
      merged:    '<span class="comp-chip" style="background:#f5f3ff;color:#6d28d9;">Merged</span>',
    }[s.review_status] ?? '';

    const date = new Date(s.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const stuCount = Array.isArray(s.students) ? s.students.length : 0;

    return `<div class="dc-submission-row" data-id="${s.id}">
      <input type="checkbox" class="dc-row-check" data-id="${s.id}" />
      <div class="dc-row-name">
        <strong>${esc(s.first_name)} ${esc(s.last_name)}</strong>
        ${s.email ? `<span class="dc-row-sub">${esc(s.email)}</span>` : ''}
      </div>
      <div class="dc-row-meta">
        ${stuCount ? `<span class="dc-row-sub">${stuCount} student${stuCount !== 1 ? 's' : ''}</span>` : ''}
        <span class="dc-row-sub">${date}</span>
      </div>
      <div class="dc-row-badges">${confBadge}${statusBadge}</div>
      <button class="btn btn-sm dc-row-review-btn" data-id="${s.id}">Review</button>
    </div>`;
  }).join('');

  wrap.querySelectorAll('.dc-row-check').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedIds.add(cb.dataset.id);
      else selectedIds.delete(cb.dataset.id);
      updateBulkBar();
    });
  });

  wrap.querySelectorAll('.dc-row-review-btn').forEach(btn => {
    btn.addEventListener('click', () => openReviewDrawer(btn.dataset.id));
  });
}

function renderFilterCounts() {
  const counts = { all: submissions.length };
  submissions.forEach(s => {
    counts[s.review_status] = (counts[s.review_status] ?? 0) + 1;
    counts[s.match_confidence] = (counts[s.match_confidence] ?? 0) + 1;
  });

  document.querySelectorAll('#dcFilterBar button[data-filter]').forEach(btn => {
    const f = btn.dataset.filter;
    const n = counts[f] ?? 0;
    btn.querySelector('.dc-filter-count').textContent = n;
    btn.classList.toggle('active', f === activeFilter);
  });
}

/* ===============================
   FILTER BAR
================================ */
function onFilterChange(filter) {
  activeFilter = filter;
  loadSubmissions();
}

/* ===============================
   BULK ACTIONS
================================ */
function updateBulkBar() {
  const bar = document.getElementById('dcBulkBar');
  const count = selectedIds.size;
  if (count === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  document.getElementById('dcBulkCount').textContent = `${count} selected`;

  // Only show bulk-accept if all selected are high confidence + pending
  const selected = submissions.filter(s => selectedIds.has(s.id));
  const allHighPending = selected.every(s => s.match_confidence === 'high' && s.review_status === 'pending');
  document.getElementById('dcBulkAcceptBtn').style.display = allHighPending ? '' : 'none';
}

async function bulkDiscard() {
  if (!selectedIds.size) return;
  if (!confirm(`Discard ${selectedIds.size} submission(s)?`)) return;
  const { error } = await supabase
    .from('guardian_intake_submissions')
    .update({ review_status: 'discarded', reviewed_by: profile.id, reviewed_at: new Date().toISOString() })
    .in('id', Array.from(selectedIds));
  if (error) { alert('Failed to discard submissions.'); return; }
  selectedIds.clear();
  await loadSubmissions();
}

async function bulkAccept() {
  if (!selectedIds.size) return;
  const selected = submissions.filter(s => selectedIds.has(s.id));
  if (!confirm(`Accept and apply ${selected.length} high-confidence submission(s)?`)) return;

  for (const s of selected) {
    await applyAccept(s, false);
  }
  selectedIds.clear();
  await loadSubmissions();
}

async function mergeDuplicates() {
  if (selectedIds.size < 2) { alert('Select at least 2 submissions to merge.'); return; }
  const selected = submissions.filter(s => selectedIds.has(s.id));
  openMergeModal(selected);
}

/* ===============================
   REVIEW DRAWER
================================ */
let drawerSubmission = null;
let existingGuardian = null;
let fieldAcceptState = {};

async function openReviewDrawer(id) {
  drawerSubmission = submissions.find(s => s.id === id) ?? null;
  if (!drawerSubmission) return;
  existingGuardian = null;
  fieldAcceptState = {};

  document.getElementById('dcDrawerOverlay').style.display = 'block';
  document.getElementById('dcReviewDrawer').classList.add('open');

  renderDrawer();

  if (drawerSubmission.match_candidates?.length || drawerSubmission.matched_guardian_id) {
    await loadExistingGuardian();
  }
  renderDrawerComparison();
}

function closeReviewDrawer() {
  document.getElementById('dcDrawerOverlay').style.display = 'none';
  document.getElementById('dcReviewDrawer').classList.remove('open');
  drawerSubmission = null;
  existingGuardian = null;
}

function renderDrawer() {
  if (!drawerSubmission) return;
  const s = drawerSubmission;
  const conf = s.match_confidence ?? 'none';
  const confLabel = { high: 'High confidence match', medium: 'Medium confidence match', none: 'No match found' }[conf];

  const students = Array.isArray(s.students) ? s.students : [];

  document.getElementById('dcDrawerTitle').textContent = `${s.first_name} ${s.last_name}`;
  document.getElementById('dcDrawerContent').innerHTML = `
    <div class="dc-drawer-meta">
      <span class="comp-chip ${{ high: 'comp-chip-green', medium: '', none: '' }[conf] ?? ''}"
            style="${conf === 'medium' ? 'background:#fef3c7;color:#92400e;' : conf === 'none' ? 'background:#f1f5f9;color:#6b7280;' : ''}">
        ${confLabel}
      </span>
      <span style="font-size:12px;color:#9ca3af;">
        Submitted ${new Date(s.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
      </span>
    </div>

    <div id="dcComparisonArea">
      <p class="muted" style="font-size:13px;">Loading match details…</p>
    </div>

    ${students.length ? `
    <div class="dc-drawer-section-title">Students Listed</div>
    <div class="dc-students-list">
      ${students.map(st => `
        <div class="dc-student-item">
          <span>${esc(st.first_name ?? '')} ${esc(st.last_name ?? '')}</span>
          ${st.grade ? `<span class="comp-chip" style="background:#f1f5f9;color:#374151;">${esc(st.grade)}</span>` : ''}
        </div>`).join('')}
    </div>` : ''}

    ${s.relationship ? `<p style="font-size:13px;color:#6b7280;margin-top:12px;">Relationship: <strong>${esc(s.relationship)}</strong></p>` : ''}
    ${s.ok_to_text ? `<p style="font-size:13px;color:#6b7280;margin:4px 0 0;">OK to text: <strong>Yes</strong></p>` : ''}
  `;

  renderDrawerActions();
}

async function loadExistingGuardian() {
  const s = drawerSubmission;

  // Use already-matched guardian id, or top match candidate
  let guardianId = s.matched_guardian_id;
  if (!guardianId && s.match_candidates?.length) {
    guardianId = s.match_candidates[0].guardian_id;
  }
  if (!guardianId) return;

  const { data } = await supabase
    .from('guardians')
    .select('id, first_name, last_name, email, phone, active, family_id, families(family_name, carline_tag_number)')
    .eq('id', guardianId)
    .single();

  existingGuardian = data ?? null;
}

function renderDrawerComparison() {
  const area = document.getElementById('dcComparisonArea');
  if (!area) return;
  const s = drawerSubmission;

  const g   = existingGuardian;
  const fam = g?.families ?? {};

  const fields = [
    { key: 'first_name', label: 'First Name', submitted: s.first_name,  existing: g?.first_name  },
    { key: 'last_name',  label: 'Last Name',  submitted: s.last_name,   existing: g?.last_name   },
    { key: 'email',      label: 'Email',      submitted: s.email,       existing: g?.email       },
    { key: 'phone',      label: 'Phone',      submitted: s.phone_cell,  existing: g?.phone       },
  ];

  if (!g) {
    // No match — just show what was submitted
    area.innerHTML = `
      <div class="dc-drawer-section-title">Submitted Information</div>
      <table class="dc-compare-table">
        <tbody>
          ${fields.map(f => `<tr>
            <td class="dc-compare-label">${f.label}</td>
            <td class="dc-compare-submitted">${f.submitted ? esc(f.submitted) : '<span style="color:#9ca3af;">—</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    `;
    return;
  }

  // Match found — show side-by-side comparison with checkboxes
  fields.forEach(f => {
    const diff = (f.submitted ?? '') !== (f.existing ?? '');
    const hasNew = !!f.submitted;
    if (!(f.key in fieldAcceptState)) {
      fieldAcceptState[f.key] = diff && hasNew;
    }
  });

  area.innerHTML = `
    <div class="dc-drawer-section-title">Comparison</div>
    <div class="dc-comparison-hint">Check fields you want to apply to the existing record.</div>
    ${g.families ? `<p style="font-size:12px;color:#9ca3af;margin:0 0 10px;">Family: ${esc(fam.family_name ?? '')} · Tag #${esc(fam.carline_tag_number ?? '')}</p>` : ''}
    <table class="dc-compare-table">
      <thead><tr><th></th><th>Field</th><th>Submitted</th><th>On File</th></tr></thead>
      <tbody>
        ${fields.map(f => {
          const diff    = (f.submitted ?? '') !== (f.existing ?? '');
          const checked = fieldAcceptState[f.key] ? 'checked' : '';
          const rowCls  = diff && f.submitted ? 'dc-row-diff' : '';
          return `<tr class="${rowCls}">
            <td><input type="checkbox" class="dc-field-check" data-field="${f.key}" ${checked} ${!f.submitted ? 'disabled' : ''} /></td>
            <td class="dc-compare-label">${f.label}</td>
            <td class="dc-compare-submitted">${f.submitted ? esc(f.submitted) : '<span class="muted">—</span>'}</td>
            <td class="dc-compare-existing">${f.existing ? esc(f.existing) : '<span style="color:#9ca3af;">not set</span>'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;

  area.querySelectorAll('.dc-field-check').forEach(cb => {
    cb.addEventListener('change', () => {
      fieldAcceptState[cb.dataset.field] = cb.checked;
    });
  });
}

function renderDrawerActions() {
  const s = drawerSubmission;
  const isPending = s.review_status === 'pending';
  const actionsEl = document.getElementById('dcDrawerActions');

  if (!isPending) {
    const statusLabel = { accepted: 'Accepted', partial: 'Partially accepted', discarded: 'Discarded', merged: 'Merged' }[s.review_status] ?? s.review_status;
    actionsEl.innerHTML = `
      <span style="font-size:13px;color:#6b7280;align-self:center;">Status: <strong>${statusLabel}</strong></span>
      <button class="btn btn-sm" id="dcDrawerReopenBtn" style="height:30px;">Re-open</button>
    `;
    document.getElementById('dcDrawerReopenBtn')?.addEventListener('click', () => reopenSubmission(s.id));
    return;
  }

  const hasMatch = existingGuardian || s.match_confidence !== 'none';

  actionsEl.innerHTML = `
    ${hasMatch ? `<button class="btn btn-primary btn-sm" id="dcAcceptUpdateBtn">Accept &amp; Update</button>` : ''}
    <button class="btn btn-primary btn-sm" id="dcCreateNewBtn" style="${hasMatch ? 'background:#6d28d9;border-color:#6d28d9;' : ''}">
      ${hasMatch ? 'Create New Instead' : 'Create New Guardian'}
    </button>
    <button class="btn btn-sm" id="dcDiscardBtn">Discard</button>
  `;

  document.getElementById('dcAcceptUpdateBtn')?.addEventListener('click', () => acceptAndUpdate());
  document.getElementById('dcCreateNewBtn')?.addEventListener('click', () => createNewGuardian());
  document.getElementById('dcDiscardBtn')?.addEventListener('click', () => discardSubmission());
}

/* ── Accept & Update ─────────────────────────────────────── */
async function acceptAndUpdate() {
  if (!drawerSubmission || !existingGuardian) return;

  const update = {};
  Object.entries(fieldAcceptState).forEach(([key, accepted]) => {
    if (!accepted) return;
    const map = { first_name: 'first_name', last_name: 'last_name', email: 'email', phone: 'phone_cell' };
    const subField = key === 'phone' ? 'phone_cell' : key;
    if (drawerSubmission[subField] !== undefined) {
      update[key] = drawerSubmission[subField];
    }
  });

  const anyUpdate = Object.keys(update).length > 0;
  const status = anyUpdate ? 'accepted' : 'partial';

  if (anyUpdate) {
    const { error } = await supabase
      .from('guardians')
      .update(update)
      .eq('id', existingGuardian.id);
    if (error) { alert('Failed to update guardian record.'); console.error(error); return; }
  }

  await applyAccept(drawerSubmission, true, status, existingGuardian.id);
  closeReviewDrawer();
  await loadSubmissions();
}

async function applyAccept(sub, silent = false, status = 'accepted', guardianId = null) {
  const { error } = await supabase
    .from('guardian_intake_submissions')
    .update({
      review_status: status,
      matched_guardian_id: guardianId ?? sub.matched_guardian_id,
      reviewed_by: profile.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', sub.id);
  if (error && !silent) { alert('Failed to save review status.'); console.error(error); }
}

/* ── Create New Guardian — Family Picker ────────────────── */
let _familyPickerSelected = null; // { id, family_name, carline_tag_number }
let _allFamilies = [];

async function createNewGuardian() {
  if (!drawerSubmission) return;
  const s = drawerSubmission;

  _familyPickerSelected = null;
  document.getElementById('dcFamilyPickerSubtitle').textContent =
    `Creating guardian: ${s.first_name} ${s.last_name}`;
  document.getElementById('dcFamilySearchInput').value = '';
  document.getElementById('dcNewFamilyNameInput').value = `${s.last_name} Family`;
  document.getElementById('dcFamilyPickerModal').style.display = 'flex';

  // Load families for this school
  const { data } = await supabase
    .from('families')
    .select('id, family_name, carline_tag_number')
    .eq('school_id', profile.school_id)
    .eq('active', true)
    .order('family_name');
  _allFamilies = data ?? [];
  renderFamilyResults('');
}

function renderFamilyResults(query) {
  const list = document.getElementById('dcFamilySearchResults');
  const q = query.toLowerCase().trim();
  const matches = q
    ? _allFamilies.filter(f => f.family_name?.toLowerCase().includes(q))
    : _allFamilies;

  if (!matches.length) {
    list.innerHTML = `<p style="padding:12px 14px;font-size:13px;color:#9ca3af;margin:0;">No families found</p>`;
    return;
  }

  list.innerHTML = matches.map(f => `
    <div class="dc-family-option${_familyPickerSelected?.id === f.id ? ' selected' : ''}"
         data-id="${f.id}"
         style="padding:10px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid #f3f4f6;display:flex;justify-content:space-between;align-items:center;">
      <strong>${esc(f.family_name ?? '')}</strong>
      <span style="color:#9ca3af;font-size:12px;">Tag #${esc(f.carline_tag_number ?? '')}</span>
    </div>`).join('');

  list.querySelectorAll('.dc-family-option').forEach(el => {
    if (_familyPickerSelected?.id === el.dataset.id) {
      el.style.background = '#eff6ff';
      el.style.fontWeight = '600';
    }
    el.addEventListener('click', () => {
      _familyPickerSelected = _allFamilies.find(f => f.id === el.dataset.id) ?? null;
      document.getElementById('dcNewFamilyNameInput').value = '';
      renderFamilyResults(document.getElementById('dcFamilySearchInput').value);
    });
  });
}

async function confirmFamilyPicker() {
  if (!drawerSubmission) return;
  const s = drawerSubmission;
  const newFamilyName = document.getElementById('dcNewFamilyNameInput').value.trim();

  let familyId;

  if (_familyPickerSelected) {
    familyId = _familyPickerSelected.id;
  } else if (newFamilyName) {
    // Generate a placeholder tag so the unique constraint is satisfied
    const placeholder = 'TBD-' + Math.random().toString(36).substr(2, 6).toUpperCase();
    const { data: fam, error: famErr } = await supabase
      .from('families')
      .insert({ school_id: profile.school_id, family_name: newFamilyName, carline_tag_number: placeholder })
      .select('id')
      .single();
    if (famErr) { alert('Failed to create family: ' + famErr.message); return; }
    familyId = fam.id;
  } else {
    alert('Select an existing family or enter a new family name.');
    return;
  }

  const { data: gData, error: gErr } = await supabase
    .from('guardians')
    .insert({
      school_id:  profile.school_id,
      family_id:  familyId,
      first_name: s.first_name,
      last_name:  s.last_name,
      email:      s.email ?? null,
      phone:      s.phone_cell ?? null,
    })
    .select('id')
    .single();

  if (gErr) { alert('Failed to create guardian: ' + gErr.message); return; }

  document.getElementById('dcFamilyPickerModal').style.display = 'none';
  await applyAccept(s, false, 'accepted', gData.id);
  closeReviewDrawer();
  await loadSubmissions();
  showToast(_familyPickerSelected ? 'Guardian added to existing family.' : 'New guardian and family created.');
}

/* ── Discard ─────────────────────────────────────────────── */
async function discardSubmission() {
  if (!drawerSubmission) return;
  if (!confirm('Discard this submission? No changes will be made.')) return;
  await applyAccept(drawerSubmission, false, 'discarded');
  closeReviewDrawer();
  await loadSubmissions();
}

/* ── Re-open ─────────────────────────────────────────────── */
async function reopenSubmission(id) {
  const { error } = await supabase
    .from('guardian_intake_submissions')
    .update({ review_status: 'pending', reviewed_by: null, reviewed_at: null })
    .eq('id', id);
  if (error) { alert('Failed to re-open submission.'); return; }
  await loadSubmissions();
  closeReviewDrawer();
}

/* ===============================
   MERGE MODAL
================================ */
function openMergeModal(selected) {
  const list = document.getElementById('dcMergeList');
  list.innerHTML = selected.map(s => `
    <label class="dc-merge-option">
      <input type="radio" name="dcMergePrimary" value="${s.id}" ${selected[0].id === s.id ? 'checked' : ''} />
      <div>
        <strong>${esc(s.first_name)} ${esc(s.last_name)}</strong>
        <span style="font-size:12px;color:#9ca3af;margin-left:8px;">${s.email ? esc(s.email) : ''}</span>
      </div>
    </label>
  `).join('');

  document.getElementById('dcMergeModal').style.display = 'flex';
}

async function confirmMerge() {
  const primary = document.querySelector('input[name="dcMergePrimary"]:checked')?.value;
  if (!primary) return;

  const others = Array.from(selectedIds).filter(id => id !== primary);
  if (!others.length) return;

  const { error } = await supabase
    .from('guardian_intake_submissions')
    .update({ review_status: 'merged', merged_into_id: primary, reviewed_by: profile.id, reviewed_at: new Date().toISOString() })
    .in('id', others);

  if (error) { alert('Failed to merge submissions.'); return; }
  document.getElementById('dcMergeModal').style.display = 'none';
  selectedIds.clear();
  await loadSubmissions();
  showToast(`${others.length} submission(s) merged.`);
}

/* ===============================
   TOAST
================================ */
function showToast(msg) {
  let toast = document.getElementById('dcToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'dcToast';
    toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:500;z-index:9999;opacity:0;transition:opacity 0.2s;';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 2800);
}

/* ===============================
   WIRE EVENTS
================================ */
function wireEvents() {
  // New campaign
  document.getElementById('dcNewCampaignBtn')?.addEventListener('click', openNewCampaignModal);
  document.getElementById('dcCancelCampaignBtn')?.addEventListener('click', closeNewCampaignModal);
  document.getElementById('dcSaveCampaignBtn')?.addEventListener('click', saveNewCampaign);
  document.getElementById('dcNewCampaignName')?.addEventListener('keydown', e => { if (e.key === 'Enter') saveNewCampaign(); });

  // Share link modal
  document.getElementById('dcShareLinkClose')?.addEventListener('click', () => { document.getElementById('dcShareLinkModal').style.display = 'none'; });
  document.getElementById('dcShareLinkCopyBtn')?.addEventListener('click', () => {
    const val = document.getElementById('dcShareLinkInput').value;
    copyText(val, () => showToast('Link copied!'));
  });

  // Back to campaigns
  document.getElementById('dcBackToCampaigns')?.addEventListener('click', () => {
    document.getElementById('dcReviewView').style.display = 'none';
    document.getElementById('dcCampaignView').style.display = '';
    currentCampaign = null;
    submissions = [];
    selectedIds.clear();
  });

  // Filter bar
  document.querySelectorAll('#dcFilterBar button[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => onFilterChange(btn.dataset.filter));
  });

  // Select all checkbox
  document.getElementById('dcSelectAll')?.addEventListener('change', e => {
    const checked = e.target.checked;
    document.querySelectorAll('.dc-row-check').forEach(cb => {
      cb.checked = checked;
      if (checked) selectedIds.add(cb.dataset.id);
      else selectedIds.delete(cb.dataset.id);
    });
    updateBulkBar();
  });

  // Bulk actions
  document.getElementById('dcBulkDiscardBtn')?.addEventListener('click', bulkDiscard);
  document.getElementById('dcBulkAcceptBtn')?.addEventListener('click', bulkAccept);
  document.getElementById('dcBulkMergeBtn')?.addEventListener('click', mergeDuplicates);

  // Drawer close
  document.getElementById('dcDrawerClose')?.addEventListener('click', closeReviewDrawer);
  document.getElementById('dcDrawerOverlay')?.addEventListener('click', closeReviewDrawer);

  // Merge modal
  document.getElementById('dcMergeConfirmBtn')?.addEventListener('click', confirmMerge);
  document.getElementById('dcMergeCancelBtn')?.addEventListener('click', () => {
    document.getElementById('dcMergeModal').style.display = 'none';
  });

  // Family picker modal
  document.getElementById('dcFamilyPickerConfirmBtn')?.addEventListener('click', confirmFamilyPicker);
  document.getElementById('dcFamilyPickerCancelBtn')?.addEventListener('click', () => {
    document.getElementById('dcFamilyPickerModal').style.display = 'none';
  });
  document.getElementById('dcFamilySearchInput')?.addEventListener('input', e => {
    _familyPickerSelected = null;
    renderFamilyResults(e.target.value);
  });
  document.getElementById('dcNewFamilyNameInput')?.addEventListener('input', () => {
    _familyPickerSelected = null;
    renderFamilyResults(document.getElementById('dcFamilySearchInput').value);
  });
}
