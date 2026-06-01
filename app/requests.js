import { supabase } from './admin.supabase.js';
import { initPage } from './admin.auth.js';
import { esc, fmtShortDate, showToast } from './admin.shared.js';
import { initUserMenu } from './user-menu.js';

let currentProfile = null;
let categories     = [];
let selectedCat    = null;
let catFields      = [];

(async () => {
  currentProfile = await initPage({});
  if (!currentProfile) return;

  initUserMenu(currentProfile.display_name ?? currentProfile.email);

  await Promise.all([loadCategories(), loadMyRequests()]);
  renderCategories();
  renderHistory();
})();

async function loadCategories() {
  const { data } = await supabase
    .from('request_categories')
    .select('id, name, description')
    .eq('school_id', currentProfile.school_id)
    .eq('is_active', true)
    .order('name');
  categories = data ?? [];
}

async function loadMyRequests() {
  const { data } = await supabase
    .from('staff_requests')
    .select('id, status, created_at, manager_notes, request_categories ( name )')
    .eq('submitted_by', currentProfile.id)
    .order('created_at', { ascending: false })
    .limit(20);
  return data ?? [];
}

function renderCategories() {
  const wrap = document.getElementById('reqCategoriesWrap');
  if (!wrap) return;

  if (!categories.length) {
    wrap.innerHTML = '<p style="color:#9ca3af;">No request forms are currently available. Contact your administrator.</p>';
    return;
  }

  wrap.innerHTML = `
    <div class="req-cat-grid">
      ${categories.map(c => `
        <div class="req-cat-card" data-id="${esc(c.id)}">
          <div class="req-cat-card-name">${esc(c.name)}</div>
          ${c.description ? `<div class="req-cat-card-desc">${esc(c.description)}</div>` : ''}
        </div>
      `).join('')}
    </div>`;

  wrap.querySelectorAll('.req-cat-card').forEach(card => {
    card.addEventListener('click', async () => {
      wrap.querySelectorAll('.req-cat-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const cat = categories.find(c => c.id === card.dataset.id);
      if (cat) await selectCategory(cat);
    });
  });
}

async function selectCategory(cat) {
  selectedCat = cat;
  const formWrap = document.getElementById('reqFormWrap');
  if (!formWrap) return;

  formWrap.innerHTML = '<p style="color:#9ca3af;padding:16px 0;">Loading…</p>';

  const { data: fields } = await supabase
    .from('request_category_fields')
    .select('id, label, field_type, options, is_required, sort_order')
    .eq('category_id', cat.id)
    .order('sort_order');
  catFields = fields ?? [];

  formWrap.innerHTML = `
    <div class="req-form-wrap">
      <h2 class="req-form-heading">${esc(cat.name)}</h2>
      <form id="reqSubmitForm">
        ${catFields.map(f => renderFormField(f)).join('')}
        <div style="margin-top:20px;display:flex;gap:8px;align-items:center;">
          <button type="submit" class="btn btn-primary" style="height:36px;">Submit Request</button>
          <button type="button" class="btn" id="reqCancelFormBtn" style="height:36px;">Cancel</button>
        </div>
        <p id="reqFormError" style="color:#dc2626;font-size:13px;margin-top:8px;display:none;"></p>
      </form>
    </div>`;

  document.getElementById('reqSubmitForm').addEventListener('submit', handleSubmit);
  document.getElementById('reqCancelFormBtn').addEventListener('click', () => {
    document.getElementById('reqFormWrap').innerHTML = '';
    document.querySelectorAll('.req-cat-card').forEach(c => c.classList.remove('selected'));
    selectedCat = null;
  });

  formWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderFormField(field) {
  const labelHtml = `<label class="req-field-label" for="field_${esc(field.id)}">${esc(field.label)}${field.is_required ? '<span class="req-required">*</span>' : ''}</label>`;

  let inputHtml = '';
  switch (field.field_type) {
    case 'text':
      inputHtml = `<input id="field_${esc(field.id)}" class="form-control" type="text" ${field.is_required ? 'required' : ''} />`;
      break;
    case 'textarea':
      inputHtml = `<textarea id="field_${esc(field.id)}" class="form-control" rows="3" ${field.is_required ? 'required' : ''}></textarea>`;
      break;
    case 'select': {
      const opts = Array.isArray(field.options) ? field.options : [];
      inputHtml = `<select id="field_${esc(field.id)}" class="form-control" ${field.is_required ? 'required' : ''}>
        <option value="">— Select —</option>
        ${opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
      </select>`;
      break;
    }
    case 'date':
      inputHtml = `<input id="field_${esc(field.id)}" class="form-control" type="date" ${field.is_required ? 'required' : ''} />`;
      break;
    case 'boolean':
      inputHtml = `<div style="display:flex;gap:16px;align-items:center;padding:8px 0;">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="radio" name="field_${esc(field.id)}" value="true" ${field.is_required ? 'required' : ''} /> Yes
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="radio" name="field_${esc(field.id)}" value="false" /> No
        </label>
      </div>`;
      break;
    case 'file':
      inputHtml = `<input id="field_${esc(field.id)}" class="form-control" type="file" accept="image/*,.pdf,.doc,.docx" ${field.is_required ? 'required' : ''} style="padding:6px;" />`;
      break;
    default:
      inputHtml = `<input id="field_${esc(field.id)}" class="form-control" type="text" />`;
  }

  return `<div class="req-field-group">${labelHtml}${inputHtml}</div>`;
}

async function handleSubmit(e) {
  e.preventDefault();
  const errEl  = document.getElementById('reqFormError');
  const btn    = e.target.querySelector('button[type="submit"]');

  btn.disabled = true;
  btn.textContent = 'Submitting…';

  // Insert staff_request
  const { data: newReq, error: reqErr } = await supabase
    .from('staff_requests')
    .insert({
      school_id:    currentProfile.school_id,
      category_id:  selectedCat.id,
      submitted_by: currentProfile.id,
    })
    .select('id')
    .single();

  if (reqErr) {
    if (errEl) { errEl.textContent = 'Submission failed: ' + reqErr.message; errEl.style.display = ''; }
    btn.disabled = false;
    btn.textContent = 'Submit Request';
    return;
  }

  // Insert responses (file fields are uploaded first, then URL stored as value)
  const responseRows = [];
  let fileUploadFailed = false;
  for (const f of catFields) {
    let value = '';
    if (f.field_type === 'file') {
      const el   = document.getElementById(`field_${f.id}`);
      const file = el?.files?.[0];
      if (file) {
        const ext  = file.name.split('.').pop();
        const path = `${currentProfile.school_id}/${newReq.id}/${f.id}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('request-attachments')
          .upload(path, file, { upsert: true });
        if (upErr) {
          fileUploadFailed = true;
          showToast(`File upload failed: ${upErr.message}`, 'error', 7000);
        } else {
          const { data: urlData } = supabase.storage
            .from('request-attachments')
            .getPublicUrl(path);
          value = urlData?.publicUrl ?? '';
        }
      }
    } else if (f.field_type === 'boolean') {
      const checked = document.querySelector(`input[name="field_${f.id}"]:checked`);
      value = checked ? checked.value : '';
    } else {
      const el = document.getElementById(`field_${f.id}`);
      value = el ? el.value.trim() : '';
    }
    responseRows.push({ request_id: newReq.id, field_id: f.id, value: value || null });
  }

  if (fileUploadFailed) {
    // Roll back the request row so the user can try again cleanly
    await supabase.from('staff_requests').delete().eq('id', newReq.id);
    if (errEl) { errEl.textContent = 'One or more file uploads failed. Your request was not submitted. Please try again.'; errEl.style.display = ''; }
    btn.disabled = false;
    btn.textContent = 'Submit Request';
    return;
  }

  if (responseRows.length) {
    await supabase.from('staff_request_responses').insert(responseRows);
  }

  // Send notification (fire and forget — don't block on email)
  supabase.functions.invoke('send_request_notification', { body: { request_id: newReq.id } })
    .catch(err => console.error('notification failed', err));

  // Show success
  const formWrap = document.getElementById('reqFormWrap');
  formWrap.innerHTML = `
    <div class="req-success">
      <h3>Request Submitted!</h3>
      <p>Your <strong>${esc(selectedCat.name)}</strong> request has been received. You'll be notified when it's reviewed.</p>
      <button class="btn btn-secondary" id="reqAnotherBtn">Submit Another</button>
    </div>`;
  document.getElementById('reqAnotherBtn').addEventListener('click', () => {
    formWrap.innerHTML = '';
    document.querySelectorAll('.req-cat-card').forEach(c => c.classList.remove('selected'));
    selectedCat = null;
  });

  document.querySelectorAll('.req-cat-card').forEach(c => c.classList.remove('selected'));
  selectedCat = null;

  // Refresh history
  const myReqs = await loadMyRequests();
  renderHistory(myReqs);
}

async function renderHistory(data) {
  const wrap = document.getElementById('reqHistoryWrap');
  if (!wrap) return;

  const rows = data ?? await loadMyRequests();

  if (!rows.length) {
    wrap.innerHTML = '';
    return;
  }

  wrap.innerHTML = `
    <div class="req-history-section">
      <h2 class="req-history-title">My Requests</h2>
      <table class="data-table">
        <thead>
          <tr>
            <th>Form</th>
            <th>Submitted</th>
            <th>Status</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${esc(r.request_categories?.name ?? '—')}</td>
              <td>${fmtShortDate(r.created_at)}</td>
              <td><span class="req-status-badge ${statusBadgeClass(r.status)}">${statusLabel(r.status)}</span></td>
              <td style="color:#6b7280;">${r.manager_notes ? esc(r.manager_notes) : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function statusLabel(s) {
  return { pending: 'Pending', in_review: 'In Review', resolved: 'Resolved' }[s] ?? s;
}
function statusBadgeClass(s) {
  return { pending: 'badge-amber', in_review: 'badge-blue', resolved: 'badge-green' }[s] ?? '';
}
