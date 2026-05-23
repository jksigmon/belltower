
import { supabase } from './admin.supabase.js';
import { esc } from './admin.shared.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { VOLUNTEER_BASE, openDrawer, closeDrawer, showToast, renderPagination, PAGE_SIZE } from './admin.compliance.utils.js';

let _profile = null;

// ── Template state ──
let templateCache    = [];
let activeTemplateId = null;
let templateLinks    = {};
let activeLinkTemplateId = null;

// ── Agreement state ──
let agreementCache               = [];
let agrPage                      = 1;
let lastAgreementTemplateFilter  = null;
let lastAgreementLinkFilter      = null;

// ── Guardian link state ──
let activeLinkAgreementId  = null;
let selectedGuardianForLink = null;
let guardianSearchTimer    = null;

// ── Review data state ──
let activeReviewAgreementId = null;

// ═══════════════════════════════════════════════════════════════════════
// FORM TEMPLATES
// ═══════════════════════════════════════════════════════════════════════

export async function loadTemplates(profile) {
  if (profile) _profile = profile;
  const container = document.getElementById('templateListWrap');
  if (!container) return;
  container.innerHTML = '<p class="muted" style="padding:20px 0;">Loading…</p>';

  const { data, error } = await supabase
    .from('compliance_form_templates')
    .select('id, title, description, body_html, active, required_for_chaperones, content_hash, created_at')
    .eq('school_id', _profile.school_id)
    .order('created_at', { ascending: false });

  if (error) {
    container.innerHTML = `<p class="status-danger">Failed to load: ${esc(error.message)}</p>`;
    return;
  }

  templateCache = data ?? [];

  if (!templateCache.length) {
    container.innerHTML = `
      <div style="text-align:center;padding:40px 0;">
        <p class="muted">No form templates yet.</p>
        <button class="btn btn-primary" id="newTemplateBtn2" style="margin-top:12px;">Create your first template</button>
      </div>`;
    document.getElementById('newTemplateBtn2')?.addEventListener('click', () => openTemplateDrawer(null));
    return;
  }

  container.innerHTML = templateCache.map(t => `
    <div class="template-card" data-id="${esc(t.id)}">
      <div class="template-card-header">
        <strong>${esc(t.title)}</strong>
        <span class="badge ${t.active ? 'badge-active' : 'badge-suspended'}">${t.active ? 'Active' : 'Inactive'}</span>
        ${t.required_for_chaperones ? `<span class="badge" style="background:#eff6ff;color:#1d4ed8;">Field trips</span>` : ''}
      </div>
      ${t.description ? `<p class="muted" style="font-size:13px;margin:4px 0 0;">${esc(t.description)}</p>` : ''}
      <div class="template-card-actions">
        <button class="btn" data-action="edit" data-id="${esc(t.id)}" style="font-size:12px;padding:4px 12px;">Edit template</button>
        <button class="btn" data-action="links" data-id="${esc(t.id)}" style="font-size:12px;padding:4px 12px;">Manage links</button>
      </div>
      <div class="template-links-wrap" id="links-${esc(t.id)}" style="display:none;"></div>
    </div>
  `).join('');

  container.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => openTemplateDrawer(btn.dataset.id));
  });
  container.querySelectorAll('[data-action="links"]').forEach(btn => {
    btn.addEventListener('click', () => toggleTemplateLinks(btn.dataset.id));
  });
}

export function openTemplateDrawer(id) {
  activeTemplateId = id;
  const t = id ? templateCache.find(x => x.id === id) : null;

  document.getElementById('tplDrawerTitle').textContent = t ? 'Edit Template' : 'New Template';
  document.getElementById('tplTitle').value       = t?.title ?? '';
  document.getElementById('tplDescription').value = t?.description ?? '';
  document.getElementById('tplBodyHtml').value    = t?.body_html ?? '';
  document.getElementById('tplActive').checked                = t ? t.active : true;
  document.getElementById('tplRequiredForChaperones').checked = t?.required_for_chaperones ?? false;
  document.getElementById('tplDrawerMsg').textContent = '';

  document.getElementById('tplDeleteWrap').style.display = id ? '' : 'none';

  openDrawer('tpl');
}

export async function saveTemplate() {
  const title       = document.getElementById('tplTitle').value.trim();
  const description = document.getElementById('tplDescription').value.trim() || null;
  const bodyHtml    = document.getElementById('tplBodyHtml').value;
  const active      = document.getElementById('tplActive').checked;
  const msgEl       = document.getElementById('tplDrawerMsg');

  if (!title) { msgEl.textContent = 'Title is required.'; return; }

  const saveBtn = document.getElementById('tplDrawerSave');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  const encoder = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(bodyHtml));
  const contentHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

  const requiredForChaperones = document.getElementById('tplRequiredForChaperones').checked;
  const payload = { title, description, body_html: bodyHtml, active, required_for_chaperones: requiredForChaperones, content_hash: contentHash };

  let error;
  if (activeTemplateId) {
    ({ error } = await supabase
      .from('compliance_form_templates')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', activeTemplateId)
      .eq('school_id', _profile.school_id));
  } else {
    ({ error } = await supabase
      .from('compliance_form_templates')
      .insert({ ...payload, school_id: _profile.school_id, created_by: _profile.id }));
  }

  saveBtn.disabled = false; saveBtn.textContent = 'Save Template';

  if (error) { msgEl.textContent = `Save failed: ${esc(error.message)}`; return; }

  closeDrawer('tpl');
  showToast(activeTemplateId ? 'Template updated' : 'Template created');
  await loadTemplates();
}

export async function deleteTemplate() {
  if (!activeTemplateId) return;
  if (!confirm('Delete this template? Any existing form links and agreements will remain in the database, but the template will no longer be usable.')) return;

  const { error } = await supabase
    .from('compliance_form_templates')
    .update({ active: false })
    .eq('id', activeTemplateId)
    .eq('school_id', _profile.school_id);

  if (error) { alert(`Failed: ${error.message}`); return; }

  closeDrawer('tpl');
  showToast('Template deactivated');
  await loadTemplates();
}

async function toggleTemplateLinks(templateId) {
  const wrap = document.getElementById(`links-${templateId}`);
  if (!wrap) return;

  if (wrap.style.display !== 'none') { wrap.style.display = 'none'; return; }

  wrap.style.display = '';
  wrap.innerHTML = '<p class="muted" style="font-size:13px;padding:8px 0;">Loading links…</p>';

  const { data, error } = await supabase
    .from('compliance_form_links')
    .select('id, token, label, expires_at, active, created_at')
    .eq('template_id', templateId)
    .order('created_at', { ascending: false });

  if (error) {
    wrap.innerHTML = `<p class="status-danger" style="font-size:13px;">Failed: ${esc(error.message)}</p>`;
    return;
  }

  templateLinks[templateId] = data ?? [];

  wrap.innerHTML = `
    <div style="padding:12px 0 4px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <strong style="font-size:13px;">Form Links</strong>
        <button class="btn btn-primary btn-sm" data-action="new-link" data-tid="${esc(templateId)}">+ New link</button>
      </div>
      ${!data?.length ? '<p class="muted" style="font-size:13px;">No links yet. Create one to start sharing the form.</p>' :
        data.map(link => `
          <div class="link-row" data-lid="${esc(link.id)}">
            <div style="flex:1;min-width:0;">
              <span style="font-size:13px;font-weight:600;">${esc(link.label || 'Untitled link')}</span>
              <span class="badge ${link.active ? 'badge-active' : 'badge-suspended'}" style="margin-left:6px;">${link.active ? 'Active' : 'Inactive'}</span>
              ${link.expires_at ? `<span class="muted" style="font-size:11px;margin-left:6px;">Expires ${link.expires_at}</span>` : ''}
            </div>
            <button class="btn btn-sm" data-action="copy-link" data-token="${esc(link.token)}">Copy URL</button>
            <button class="btn btn-sm" data-action="deactivate-link" data-lid="${esc(link.id)}" data-active="${link.active}">${link.active ? 'Deactivate' : 'Activate'}</button>
          </div>
        `).join('')
      }
    </div>
  `;

  wrap.querySelector('[data-action="new-link"]')?.addEventListener('click', () => openNewLinkDrawer(templateId));

  wrap.querySelectorAll('[data-action="copy-link"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = `${VOLUNTEER_BASE}${btn.dataset.token}`;
      navigator.clipboard.writeText(url).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy URL'; }, 2000);
      });
    });
  });

  wrap.querySelectorAll('[data-action="deactivate-link"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newActive = btn.dataset.active === 'true' ? false : true;
      const { error } = await supabase
        .from('compliance_form_links')
        .update({ active: newActive })
        .eq('id', btn.dataset.lid);
      if (error) { alert(error.message); return; }
      wrap.style.display = 'none';
      await toggleTemplateLinks(templateId);
    });
  });
}

function openNewLinkDrawer(templateId) {
  activeLinkTemplateId = templateId;
  document.getElementById('linkLabel').value     = '';
  document.getElementById('linkExpiresAt').value = '';
  document.getElementById('linkDrawerMsg').textContent = '';
  openDrawer('link');
}

export async function createLink() {
  const label     = document.getElementById('linkLabel').value.trim() || null;
  const expiresAt = document.getElementById('linkExpiresAt').value || null;
  const msgEl     = document.getElementById('linkDrawerMsg');

  const saveBtn = document.getElementById('linkDrawerSave');
  saveBtn.disabled = true; saveBtn.textContent = 'Creating…';

  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes).map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 32);

  const { error } = await supabase
    .from('compliance_form_links')
    .insert({
      school_id:   _profile.school_id,
      template_id: activeLinkTemplateId,
      token,
      label,
      expires_at:  expiresAt || null,
      active:      true,
      created_by:  _profile.id,
    });

  saveBtn.disabled = false; saveBtn.textContent = 'Create Link';

  if (error) { msgEl.textContent = `Failed: ${esc(error.message)}`; return; }

  const url = `${VOLUNTEER_BASE}${token}`;
  navigator.clipboard.writeText(url).then(() => showToast(`URL copied: ${url}`)).catch(() => {});

  await toggleTemplateLinks(activeLinkTemplateId);
}

// ═══════════════════════════════════════════════════════════════════════
// AGREEMENTS
// ═══════════════════════════════════════════════════════════════════════

export function resetAgreementCache() {
  agreementCache = [];
  agrPage = 1;
  lastAgreementTemplateFilter = null;
  lastAgreementLinkFilter = null;
  const sel = document.getElementById('agreementTemplateFilter');
  if (sel) { sel.dataset.populated = ''; sel.querySelectorAll('option:not([value=""])').forEach(o => o.remove()); }
}

export async function loadAgreements(profile) {
  if (profile) _profile = profile;
  const tbody = document.getElementById('agreementTableBody');
  if (!tbody) return;

  const searchVal    = document.getElementById('agreementSearch')?.value.trim().toLowerCase();
  const templateVal  = document.getElementById('agreementTemplateFilter')?.value ?? '';
  const linkVal      = document.getElementById('agreementLinkFilter')?.value ?? '';
  const showArchived = document.getElementById('agrShowArchived')?.checked ?? false;

  const filtersChanged = templateVal !== lastAgreementTemplateFilter || linkVal !== lastAgreementLinkFilter;

  if (!agreementCache.length || filtersChanged) {
    tbody.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center;padding:32px 0;">Loading…</td></tr>';

    let query = supabase
      .from('compliance_agreements')
      .select(`
        id, signer_name, signer_email, signature_type, signed_at, expires_at, voided_at, content_hash,
        guardian_id, family_id, link_status, student_name_hint, carline_tag_hint, submitted_phone, submitted_relationship,
        submitted_data_reviewed, archived_at,
        compliance_form_templates!inner ( id, title )
      `)
      .eq('school_id', _profile.school_id)
      .order('signed_at', { ascending: false });

    if (templateVal) query = query.eq('template_id', templateVal);
    if (linkVal)     query = query.eq('link_status', linkVal);

    const { data, error } = await query;
    if (error) {
      tbody.innerHTML = `<tr><td colspan="9" class="status-danger" style="text-align:center;padding:32px 0;">Failed: ${esc(error.message)}</td></tr>`;
      return;
    }

    agreementCache = data ?? [];
    lastAgreementTemplateFilter = templateVal;
    lastAgreementLinkFilter = linkVal;
  }

  const filtered = agreementCache.filter(row => {
    if (!showArchived && row.archived_at) return false;
    if (showArchived && !row.archived_at) return false;
    if (searchVal && !row.signer_name.toLowerCase().includes(searchVal) && !row.signer_email.toLowerCase().includes(searchVal)) return false;
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted" style="text-align:center;padding:32px 0;">${showArchived ? 'No archived agreements.' : 'No agreements found.'}</td></tr>`;
    document.getElementById('agrPagination').style.display = 'none';
    return;
  }

  populateTemplateFilter(agreementCache.filter(r => !r.archived_at));

  const pageItems = filtered.slice((agrPage - 1) * PAGE_SIZE, agrPage * PAGE_SIZE);

  tbody.innerHTML = '';
  pageItems.forEach(row => {
    const template  = row.compliance_form_templates;
    const today     = new Date().toISOString().slice(0, 10);
    const isVoided  = !!row.voided_at;
    const isExpired = row.expires_at && row.expires_at < today && !isVoided;

    const statusBadge = isVoided
      ? '<span class="badge badge-revoked">Voided</span>'
      : isExpired
        ? '<span class="badge badge-expired">Expired</span>'
        : '<span class="badge badge-active">Valid</span>';

    const linkBadge = row.link_status === 'auto_linked'
      ? '<span class="badge" style="background:#eff6ff;color:#1d4ed8;">Linked</span>'
      : row.link_status === 'manual_linked'
        ? '<span class="badge" style="background:#f0fdf4;color:#15803d;">Linked</span>'
        : '<span class="badge" style="background:#fef3c7;color:#92400e;">Unresolved</span>';

    const tr = document.createElement('tr');
    if (row.archived_at) tr.style.opacity = '0.5';
    const fmtAgrDate = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '<span class="muted">—</span>';
    const hasUnreviewedData = (row.submitted_phone || row.submitted_relationship) && !row.submitted_data_reviewed;
    const dataBadge = hasUnreviewedData
      ? '<span class="badge" style="background:#fef3c7;color:#92400e;cursor:pointer;" title="Unreviewed submitted data">Review</span>'
      : row.submitted_data_reviewed
        ? '<span class="badge" style="background:#f1f5f9;color:#64748b;">Reviewed</span>'
        : '<span class="muted">—</span>';

    tr.innerHTML = `
      <td>${esc(row.signer_name)}${row.archived_at ? ' <span class="bg-status-pill" style="background:#f1f5f9;color:#64748b;">Archived</span>' : ''}</td>
      <td>${esc(row.signer_email)}</td>
      <td>${esc(template?.title ?? '—')}</td>
      <td>${fmtAgrDate(row.signed_at)}</td>
      <td>${fmtAgrDate(row.expires_at)}</td>
      <td>${statusBadge}</td>
      <td>${linkBadge}</td>
      <td data-action="${hasUnreviewedData ? 'review-data' : ''}" data-id="${esc(row.id)}" style="cursor:${hasUnreviewedData ? 'pointer' : 'default'}">${dataBadge}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm" data-action="pdf" data-id="${esc(row.id)}">PDF</button>
        ${row.link_status === 'unresolved' && !row.archived_at ? `<button class="btn btn-sm" data-action="link-guardian" data-id="${esc(row.id)}" style="margin-left:4px;">Link</button>` : ''}
        ${!isVoided && !row.archived_at ? `<button class="btn btn-sm" data-action="void" data-id="${esc(row.id)}" style="margin-left:4px;color:var(--danger);">Void</button>` : ''}
        <button class="btn btn-sm" data-action="archive" data-id="${esc(row.id)}" style="margin-left:4px;color:var(--text-muted,#9ca3af);font-size:11px;">${row.archived_at ? 'Unarchive' : 'Archive'}</button>
      </td>
    `;

    tr.querySelector('[data-action="pdf"]').addEventListener('click', () => downloadAgreementPdf(row.id));
    tr.querySelector('[data-action="link-guardian"]')?.addEventListener('click', () => openLinkGuardianDrawer(row.id));
    tr.querySelector('[data-action="void"]')?.addEventListener('click', () => voidAgreement(row.id));
    tr.querySelector('[data-action="archive"]').addEventListener('click', () => archiveAgreement(row.id, !row.archived_at));
    if (hasUnreviewedData) {
      tr.querySelector('[data-action="review-data"]')?.addEventListener('click', () => openReviewDataDrawer(row.id));
    }

    tbody.appendChild(tr);
  });

  renderPagination('agrPagination', agrPage, filtered.length, p => { agrPage = p; loadAgreements(); });
}

function populateTemplateFilter(agreements) {
  const sel = document.getElementById('agreementTemplateFilter');
  if (!sel || sel.dataset.populated) return;

  const seen = new Map();
  agreements.forEach(a => {
    const t = a.compliance_form_templates;
    if (t && !seen.has(t.id)) seen.set(t.id, t.title);
  });

  seen.forEach((title, id) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = title;
    sel.appendChild(opt);
  });
  sel.dataset.populated = 'true';
}

async function downloadAgreementPdf(agreementId) {
  const btn = document.querySelector(`[data-action="pdf"][data-id="${agreementId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  try {
    const { data: { session } } = await supabase.auth.getSession();

    const res = await fetch(`${SUPABASE_URL}/functions/v1/compliance_form_pdf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ agreement_id: agreementId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      alert(`PDF generation failed: ${err.error}`);
      return;
    }

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    const row = agreementCache.find(r => r.id === agreementId);
    a.download = row
      ? `${row.signer_name.replace(/\s+/g, '_')}_${row.signed_at.slice(0, 10)}.pdf`
      : `agreement_${agreementId}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'PDF'; }
  }
}

async function voidAgreement(agreementId) {
  if (!confirm('Void this agreement? This cannot be undone. The signature record will remain for audit purposes.')) return;

  const { error } = await supabase
    .from('compliance_agreements')
    .update({ voided_at: new Date().toISOString(), voided_by: _profile.id })
    .eq('id', agreementId)
    .eq('school_id', _profile.school_id);

  if (error) { alert(`Failed: ${error.message}`); return; }
  showToast('Agreement voided');
  resetAgreementCache();
  await loadAgreements();
}

async function archiveAgreement(id, archive) {
  const { error } = await supabase
    .from('compliance_agreements')
    .update({ archived_at: archive ? new Date().toISOString() : null })
    .eq('id', id)
    .eq('school_id', _profile.school_id);
  if (error) { alert('Failed: ' + error.message); return; }
  showToast(archive ? 'Agreement archived' : 'Agreement unarchived');
  resetAgreementCache();
  await loadAgreements();
}

export function wireFormFilters() {
  const resetAgr = () => { agrPage = 1; resetAgreementCache(); loadAgreements(); };
  document.getElementById('agreementSearch')?.addEventListener('input', resetAgr);
  document.getElementById('agreementTemplateFilter')?.addEventListener('change', resetAgr);
  document.getElementById('agreementLinkFilter')?.addEventListener('change', resetAgr);
  document.getElementById('agrShowArchived')?.addEventListener('change', resetAgr);
}

// ═══════════════════════════════════════════════════════════════════════
// MANUAL GUARDIAN LINK DRAWER
// ═══════════════════════════════════════════════════════════════════════

export function openLinkGuardianDrawer(agreementId) {
  const row = agreementCache.find(r => r.id === agreementId);
  if (!row) return;
  activeLinkAgreementId   = agreementId;
  selectedGuardianForLink = null;

  document.getElementById('linkGuardianAgreementInfo').innerHTML = `
    <strong>${esc(row.signer_name)}</strong> &mdash; ${esc(row.signer_email)}<br>
    <span style="color:var(--text-muted);">Signed ${new Date(row.signed_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
  `;

  const hintsEl = document.getElementById('linkGuardianHints');
  const hints = [
    row.student_name_hint    && `Student: <strong>${esc(row.student_name_hint)}</strong>`,
    row.carline_tag_hint     && `Car tag: <strong>${esc(row.carline_tag_hint)}</strong>`,
    row.submitted_phone      && `Phone: <strong>${esc(row.submitted_phone)}</strong>`,
    row.submitted_relationship && `Relationship: <strong>${esc(row.submitted_relationship)}</strong>`,
  ].filter(Boolean);

  if (hints.length) {
    hintsEl.innerHTML = `<span style="font-weight:600;color:#92400e;">Submitted by signer:</span> ${hints.join(' &nbsp;·&nbsp; ')}`;
    hintsEl.style.display = '';
  } else {
    hintsEl.style.display = 'none';
  }

  document.getElementById('linkGuardianSearch').value = '';
  document.getElementById('linkGuardianResults').innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">Type a name or email to search guardians.</div>';
  document.getElementById('linkGuardianMsg').textContent = '';
  document.getElementById('linkGuardianSave').disabled = true;

  openDrawer('linkGuardian');
}

export function onGuardianSearchInput() {
  clearTimeout(guardianSearchTimer);
  guardianSearchTimer = setTimeout(searchGuardians, 280);
}

async function searchGuardians() {
  const term = document.getElementById('linkGuardianSearch')?.value.trim();
  const resultsEl = document.getElementById('linkGuardianResults');

  if (!term || term.length < 2) {
    resultsEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">Type a name or email to search guardians.</div>';
    return;
  }

  resultsEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">Searching…</div>';

  const { data, error } = await supabase
    .from('guardians')
    .select('id, first_name, last_name, email, phone, family_id, families!inner(family_name, carline_tag_number)')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%`)
    .limit(20);

  if (error) {
    resultsEl.innerHTML = `<div style="padding:16px;color:var(--danger);font-size:13px;">Search failed: ${esc(error.message)}</div>`;
    return;
  }

  if (!data?.length) {
    resultsEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">No guardians found.</div>';
    return;
  }

  resultsEl.innerHTML = '';
  data.forEach(g => {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-bottom:1px solid var(--border);';
    div.innerHTML = `
      <div>
        <div style="font-size:14px;font-weight:600;">${esc(g.first_name)} ${esc(g.last_name)}</div>
        <div style="font-size:12px;color:var(--text-muted);">${esc(g.families?.family_name ?? '')}${g.families?.carline_tag_number ? ' · #' + g.families.carline_tag_number : ''}</div>
      </div>
      <button class="btn btn-sm" data-gid="${esc(g.id)}">Select</button>
    `;
    div.querySelector('button').addEventListener('click', () => selectGuardianForLink(g));
    resultsEl.appendChild(div);
  });
}

function selectGuardianForLink(g) {
  selectedGuardianForLink = g.id;

  resultsEl_selectHighlight(g.id);

  const msg = document.getElementById('linkGuardianMsg');
  msg.textContent = `Selected: ${g.first_name} ${g.last_name}`;
  msg.style.color = 'var(--success, #15803d)';
  document.getElementById('linkGuardianSave').disabled = false;
}

function resultsEl_selectHighlight(guardianId) {
  document.querySelectorAll('#linkGuardianResults button[data-gid]').forEach(btn => {
    btn.textContent = btn.dataset.gid === guardianId ? '✓ Selected' : 'Select';
    btn.style.background  = btn.dataset.gid === guardianId ? 'var(--primary)' : '';
    btn.style.color       = btn.dataset.gid === guardianId ? '#fff' : '';
    btn.style.borderColor = btn.dataset.gid === guardianId ? 'var(--primary)' : '';
  });
}

export async function saveLinkGuardian() {
  if (!activeLinkAgreementId || !selectedGuardianForLink) return;

  const saveBtn = document.getElementById('linkGuardianSave');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  const { error } = await supabase
    .from('compliance_agreements')
    .update({ guardian_id: selectedGuardianForLink, link_status: 'manual_linked' })
    .eq('id', activeLinkAgreementId)
    .eq('school_id', _profile.school_id);

  saveBtn.disabled = false; saveBtn.textContent = 'Link Guardian';

  if (error) {
    document.getElementById('linkGuardianMsg').textContent = `Failed: ${esc(error.message)}`;
    document.getElementById('linkGuardianMsg').style.color = 'var(--danger)';
    return;
  }

  closeDrawer('linkGuardian');
  showToast('Guardian linked');
  resetAgreementCache();
  await loadAgreements();
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE C — REVIEW SUBMITTED DATA
// ═══════════════════════════════════════════════════════════════════════

function openReviewDataDrawer(agreementId) {
  const row = agreementCache.find(r => r.id === agreementId);
  if (!row) return;
  activeReviewAgreementId = agreementId;

  document.getElementById('reviewDataAgreementInfo').innerHTML = `
    <strong>${esc(row.signer_name)}</strong> &mdash; ${esc(row.signer_email)}<br>
    <span style="color:var(--text-muted);">Signed ${new Date(row.signed_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
    ${row.guardian_id ? '' : '<br><span style="font-size:12px;color:#92400e;">Not linked to a guardian record — apply will be skipped.</span>'}
  `;

  const fields = [];
  if (row.submitted_phone) {
    fields.push(`
      <div class="bg-detail-field">
        <span class="bg-detail-label">Submitted phone</span>
        <span class="bg-detail-value">${esc(row.submitted_phone)}</span>
      </div>
    `);
  }
  if (row.submitted_relationship) {
    fields.push(`
      <div class="bg-detail-field">
        <span class="bg-detail-label">Submitted relationship</span>
        <span class="bg-detail-value">${esc(row.submitted_relationship)}</span>
      </div>
    `);
  }

  document.getElementById('reviewDataFields').innerHTML = fields.join('') ||
    '<p class="muted" style="font-size:13px;">No additional data to review.</p>';

  const applyBtn = document.getElementById('reviewDataApply');
  applyBtn.disabled = !row.guardian_id;
  applyBtn.title    = row.guardian_id ? '' : 'Guardian must be linked before applying data';

  document.getElementById('reviewDataMsg').textContent = '';
  openDrawer('reviewData');
}

export async function applySubmittedData() {
  if (!activeReviewAgreementId) return;
  const row = agreementCache.find(r => r.id === activeReviewAgreementId);
  if (!row?.guardian_id) return;

  const applyBtn   = document.getElementById('reviewDataApply');
  const dismissBtn = document.getElementById('reviewDataDismiss');
  applyBtn.disabled = true; applyBtn.textContent = 'Applying…';
  dismissBtn.disabled = true;

  const update = {};
  if (row.submitted_phone) update.phone = row.submitted_phone;

  if (!Object.keys(update).length) {
    await dismissSubmittedData();
    return;
  }

  const { error: guardianErr } = await supabase
    .from('guardians')
    .update(update)
    .eq('id', row.guardian_id)
    .eq('school_id', _profile.school_id);

  if (guardianErr) {
    document.getElementById('reviewDataMsg').textContent = `Failed to update guardian: ${esc(guardianErr.message)}`;
    applyBtn.disabled = false; applyBtn.textContent = 'Apply to guardian record';
    dismissBtn.disabled = false;
    return;
  }

  await supabase
    .from('compliance_agreements')
    .update({ submitted_data_reviewed: true })
    .eq('id', activeReviewAgreementId)
    .eq('school_id', _profile.school_id);

  closeDrawer('reviewData');
  showToast('Guardian record updated');
  resetAgreementCache();
  await loadAgreements();
}

export async function dismissSubmittedData() {
  if (!activeReviewAgreementId) return;

  const { error } = await supabase
    .from('compliance_agreements')
    .update({ submitted_data_reviewed: true })
    .eq('id', activeReviewAgreementId)
    .eq('school_id', _profile.school_id);

  if (error) { alert(`Failed: ${error.message}`); return; }

  closeDrawer('reviewData');
  showToast('Marked as reviewed');
  resetAgreementCache();
  await loadAgreements();
}
