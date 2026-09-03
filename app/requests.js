import { supabase } from './admin.supabase.js?v=2';
import { initPage } from './admin.auth.js?v=2';
import { esc, fmtShortDate, fmtTime, showToast } from './admin.shared.js?v=3';

let currentProfile = null;
let categories     = [];
let selectedCat    = null;
let catFields      = [];
let myRequests     = [];

(async () => {
  currentProfile = await initPage({});
  if (!currentProfile) return;

  await Promise.all([loadCategories(), loadMyRequests()]);
  renderCategories();
  renderHistory();
  await preselectCategoryFromUrl();

  document.getElementById('reqDetailDrawerClose')?.addEventListener('click', closeDetailDrawer);
  document.getElementById('reqDetailOverlay')?.addEventListener('click', closeDetailDrawer);
})();

// Lets nav links / dropdown shortcuts (e.g. "Feedback") jump straight to a
// category's form instead of making staff pick it from the grid.
async function preselectCategoryFromUrl() {
  const slug = new URLSearchParams(window.location.search).get('cat');
  if (!slug) return;
  const cat = categories.find(c => c.name.toLowerCase().includes(slug.toLowerCase()));
  if (!cat) return;
  const card = document.querySelector(`.req-cat-card[data-id="${cat.id}"]`);
  card?.classList.add('selected');
  await selectCategory(cat);
}

async function loadCategories() {
  // RPC, not a table select: a restricted form must be hidden here even from
  // admins who can edit it in the admin panel, and request_categories' own
  // policy has to stay permissive enough for that editing to work. See
  // 20260903000001_restricted_form_visibility.sql.
  const { data, error } = await supabase.rpc('get_submittable_request_categories');
  if (error) console.error('loadCategories', error);
  categories = data ?? [];
}

async function loadMyRequests() {
  const { data } = await supabase
    .from('staff_requests')
    .select(`
      id, status, created_at, manager_notes,
      request_categories ( name, resolved_label, denied_label ),
      staff_request_responses ( value, request_category_fields ( label, field_type, sort_order ) )
    `)
    .eq('submitted_by', currentProfile.id)
    .order('updated_at', { ascending: false })
    .limit(20);
  return data ?? [];
}

// Best-effort icon per category, keyed off its name — categories are
// school-defined text with no icon field of their own, so this just
// gives common request types (field trips, maintenance, etc.) a
// recognizable glyph instead of every card looking identical.
function categoryIcon(name) {
  const n = (name || '').toLowerCase();
  if (/field trip/.test(n))                              return 'map';
  if (/maintenance|facilit|repair|damage/.test(n))        return 'wrench';
  if (/feedback|bug/.test(n))                             return 'message-circle';
  if (/access|key/.test(n))                               return 'key';
  if (/reservation|room|book/.test(n))                    return 'calendar-clock';
  if (/inventory|supply|supplies|equipment/.test(n))      return 'package';
  if (/purchase|budget|expense|reimburse/.test(n))        return 'credit-card';
  if (/leave|time off|pto/.test(n))                       return 'calendar';
  if (/tech|it |computer|device|laptop/.test(n))          return 'laptop';
  if (/transport|transfer|bus/.test(n))                   return 'truck';
  return 'file-text';
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
          <div class="req-cat-card-icon"><i data-lucide="${categoryIcon(c.name)}"></i></div>
          <div class="req-cat-card-arrow"><i data-lucide="arrow-right"></i></div>
          <div class="req-cat-card-name">${esc(c.name)}</div>
          ${c.description ? `<div class="req-cat-card-desc">${esc(c.description)}</div>` : ''}
        </div>
      `).join('')}
    </div>`;

  if (window.lucide) lucide.createIcons({ el: wrap });

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
          <button type="submit" class="btn btn-primary" style="height:36px;">Submit</button>
          <button type="button" class="btn" id="reqCancelFormBtn" style="height:36px;">Cancel</button>
        </div>
        <p id="reqFormError" style="color:#dc2626;font-size:13px;margin-top:8px;display:none;"></p>
      </form>
    </div>`;

  document.getElementById('reqSubmitForm').addEventListener('submit', handleSubmit);
  wireSpecialInputs();
  document.getElementById('reqCancelFormBtn').addEventListener('click', () => {
    document.getElementById('reqFormWrap').innerHTML = '';
    document.querySelectorAll('.req-cat-card').forEach(c => c.classList.remove('selected'));
    selectedCat = null;
  });

  formWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Fixed times, 15-minute increments, full 24-hour range (departure and
// return times for a trip can fall anywhere in the day). Labels always
// show AM/PM via fmtTime — see the 'time' case in renderFormField.
function timeOptionsHtml() {
  const opts = ['<option value="">Select…</option>'];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      opts.push(`<option value="${value}">${esc(fmtTime(value))}</option>`);
    }
  }
  return opts.join('');
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
        <option value="">Select…</option>
        ${opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
      </select>`;
      break;
    }
    case 'routing': {
      // Options are {label, manager_id} mappings; staff see only labels.
      // The value is the label (stored as a normal response); the manager
      // resolution happens at submit time.
      const opts = Array.isArray(field.options) ? field.options : [];
      inputHtml = `<select id="field_${esc(field.id)}" class="form-control" ${field.is_required ? 'required' : ''}>
        <option value="">Select…</option>
        ${opts.map(o => `<option value="${esc(o.label ?? '')}">${esc(o.label ?? '')}</option>`).join('')}
      </select>`;
      break;
    }
    case 'date':
      inputHtml = `<input id="field_${esc(field.id)}" class="form-control" type="date" ${field.is_required ? 'required' : ''} />`;
      break;
    case 'date_range':
      // Two plain date inputs — simpler and more reliable than a custom
      // range picker, and native on every device. Single day = leave End
      // blank or matching Start.
      inputHtml = `<div class="req-date-range">
        <div class="req-date-range-col">
          <span class="req-date-range-sub">Start</span>
          <input id="field_${esc(field.id)}_start" class="form-control" type="date" ${field.is_required ? 'required' : ''} />
        </div>
        <div class="req-date-range-col">
          <span class="req-date-range-sub">End (optional for a single day)</span>
          <input id="field_${esc(field.id)}_end" class="form-control" type="date" />
        </div>
      </div>`;
      break;
    case 'time':
      // A dropdown of fixed times (not <input type="time">) so AM/PM is
      // always explicit in the label — the native time input follows the
      // OS/browser clock-format setting, so on a device set to 24-hour
      // time it would show no AM/PM at all. Useful for things like a
      // field trip's departure/return time.
      inputHtml = `<select id="field_${esc(field.id)}" class="form-control" ${field.is_required ? 'required' : ''}>
        ${timeOptionsHtml()}
      </select>`;
      break;
    case 'phone':
      inputHtml = `<input id="field_${esc(field.id)}" class="form-control req-phone-input" type="tel" inputmode="tel" placeholder="(555) 123-4567" ${field.is_required ? 'required' : ''} />`;
      break;
    case 'url':
      inputHtml = `<input id="field_${esc(field.id)}" class="form-control" type="url" placeholder="https://…" ${field.is_required ? 'required' : ''} />`;
      break;
    case 'currency':
      inputHtml = `<div class="req-currency-wrap">
        <span class="req-currency-sign">$</span>
        <input id="field_${esc(field.id)}" class="form-control req-currency-input" type="text" inputmode="decimal" placeholder="0.00" ${field.is_required ? 'required' : ''} />
      </div>`;
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
      inputHtml = `
        <input id="field_${esc(field.id)}" class="form-control req-file-input" type="file" accept="image/*,.pdf,.doc,.docx" ${field.is_required ? 'required' : ''} style="padding:6px;" />
        <div class="req-file-preview" id="field_${esc(field.id)}_preview" hidden style="display:flex;align-items:center;gap:10px;margin-top:8px;">
          <img class="req-file-thumb" hidden style="width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;" />
          <span class="req-file-preview-name" style="font-size:13px;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;"></span>
          <button type="button" class="btn btn-sm req-file-remove">Remove</button>
        </div>`;
      break;
    default:
      inputHtml = `<input id="field_${esc(field.id)}" class="form-control" type="text" />`;
  }

  return `<div class="req-field-group">${labelHtml}${inputHtml}</div>`;
}

// Live-format phone and currency inputs as the submitter types, so what
// they see while filling the form matches what gets stored and emailed.
function wireSpecialInputs() {
  document.querySelectorAll('.req-phone-input').forEach(el => {
    el.addEventListener('input', () => {
      const digits = el.value.replace(/\D/g, '').slice(0, 10);
      if (digits.length > 6)      el.value = `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
      else if (digits.length > 3) el.value = `(${digits.slice(0,3)}) ${digits.slice(3)}`;
      else if (digits.length > 0) el.value = `(${digits}`;
      else                        el.value = '';
    });
  });

  document.querySelectorAll('.req-currency-input').forEach(el => {
    el.addEventListener('blur', () => {
      if (!el.value.trim()) return;
      const num = parseFloat(el.value.replace(/[^0-9.]/g, ''));
      el.value = isNaN(num) ? '' : num.toFixed(2);
    });
  });

  document.querySelectorAll('.req-file-input').forEach(input => {
    const preview  = document.getElementById(`${input.id}_preview`);
    if (!preview) return;
    const thumb    = preview.querySelector('.req-file-thumb');
    const nameEl   = preview.querySelector('.req-file-preview-name');
    const removeBtn = preview.querySelector('.req-file-remove');

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      thumb.removeAttribute('src');
      if (!file) { preview.hidden = true; return; }

      nameEl.textContent = file.name;
      if (file.type.startsWith('image/')) {
        // The CSP's img-src allows data: but not blob:, so use FileReader
        // rather than URL.createObjectURL (which the browser silently
        // blocks under that policy).
        const reader = new FileReader();
        reader.onload = () => { thumb.src = reader.result; };
        reader.readAsDataURL(file);
        thumb.hidden = false;
      } else {
        thumb.hidden = true;
      }
      preview.hidden = false;
    });

    removeBtn.addEventListener('click', () => {
      thumb.removeAttribute('src');
      input.value = '';
      preview.hidden = true;
    });
  });
}

async function handleSubmit(e) {
  e.preventDefault();
  const errEl  = document.getElementById('reqFormError');
  const btn    = e.target.querySelector('button[type="submit"]');

  // Currency is a free-text input (needed for the "$" prefix layout), so
  // the browser's native required/pattern validation won't catch a
  // non-numeric entry. Catch it here before anything is inserted.
  for (const f of catFields) {
    if (f.field_type !== 'currency') continue;
    const el = document.getElementById(`field_${f.id}`);
    const raw = el?.value.trim() ?? '';
    if (!raw) continue;
    if (isNaN(parseFloat(raw.replace(/[^0-9.]/g, '')))) {
      if (errEl) { errEl.textContent = `"${f.label}" needs a valid amount, e.g. 25.00.`; errEl.style.display = ''; }
      el.focus();
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = 'Submitting…';

  // Resolve the routing field (if any) to a manager. Fail soft: an
  // unanswered optional field or an unresolvable label leaves the
  // request unassigned, which broadcasts to all managers.
  let assignedManagerId = null;
  const routingField = catFields.find(f => f.field_type === 'routing');
  if (routingField) {
    const selectedLabel = document.getElementById(`field_${routingField.id}`)?.value ?? '';
    const opts = Array.isArray(routingField.options) ? routingField.options : [];
    const match = opts.find(o => o.label === selectedLabel);
    if (match?.manager_id) assignedManagerId = match.manager_id;
  }

  // Insert staff_request
  const { data: newReq, error: reqErr } = await supabase
    .from('staff_requests')
    .insert({
      school_id:           currentProfile.school_id,
      category_id:         selectedCat.id,
      submitted_by:        currentProfile.id,
      assigned_manager_id: assignedManagerId,
    })
    .select('id')
    .single();

  if (reqErr) {
    if (errEl) { errEl.textContent = 'Submission failed: ' + reqErr.message; errEl.style.display = ''; }
    btn.disabled = false;
    btn.textContent = 'Submit';
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
    } else if (f.field_type === 'date_range') {
      // Store the final human-readable string, same as every other
      // field type — nothing downstream needs to know this was a range.
      const start = document.getElementById(`field_${f.id}_start`)?.value || '';
      const end   = document.getElementById(`field_${f.id}_end`)?.value || '';
      if (!start) value = '';
      else if (!end || end === start) value = fmtShortDate(start);
      else value = `${fmtShortDate(start)} – ${fmtShortDate(end)}`;
    } else if (f.field_type === 'time') {
      const el = document.getElementById(`field_${f.id}`);
      value = el?.value ? fmtTime(el.value) : '';
    } else if (f.field_type === 'currency') {
      const el = document.getElementById(`field_${f.id}`);
      const num = el?.value ? parseFloat(el.value.replace(/[^0-9.]/g, '')) : NaN;
      value = isNaN(num) ? '' : `$${num.toFixed(2)}`;
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
    btn.textContent = 'Submit';
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
      <div class="req-success-icon"><i data-lucide="check"></i></div>
      <h3>Request Submitted!</h3>
      <p>Your <strong>${esc(selectedCat.name)}</strong> request has been received. You'll be notified when it's reviewed.</p>
      <button class="btn btn-secondary" id="reqAnotherBtn">Submit Another</button>
    </div>`;
  if (window.lucide) lucide.createIcons({ el: formWrap });
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
  myRequests = rows;

  if (!rows.length) {
    wrap.innerHTML = `
      <div class="req-section-head dash-section-head">
        <span class="dash-section-eyebrow">My Requests</span>
        <span class="dash-section-rule"></span>
      </div>
      <div class="req-empty">
        <div class="req-empty-icon"><i data-lucide="inbox"></i></div>
        <strong>No requests yet</strong>
        <span>Submit one below to get started.</span>
      </div>`;
    if (window.lucide) lucide.createIcons({ el: wrap });
    return;
  }

  wrap.innerHTML = `
    <div class="req-history-section">
      <div class="req-section-head dash-section-head">
        <span class="dash-section-eyebrow">My Requests</span>
        <span class="dash-section-rule"></span>
      </div>
      <div class="req-history-shell">
        <div class="req-history-scroll" id="reqHistoryScroll">
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
                <tr class="req-history-row" data-id="${esc(r.id)}" style="cursor:pointer;">
                  <td>${esc(r.request_categories?.name ?? '—')}</td>
                  <td>${fmtShortDate(r.created_at)}</td>
                  <td><span class="req-status-badge ${statusBadgeClass(r.status)}">${statusLabel(r.status, r.request_categories)}</span></td>
                  <td style="color:#6b7280;">${r.manager_notes ? esc(r.manager_notes) : '—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="req-scroll-fade-bottom" id="reqHistoryFade"></div>
      </div>
    </div>`;

  wireHistoryScrollFade();

  wrap.querySelectorAll('.req-history-row').forEach(row => {
    row.addEventListener('click', () => {
      const r = myRequests.find(x => x.id === row.dataset.id);
      if (r) openDetailDrawer(r);
    });
  });
}

function openDetailDrawer(r) {
  const titleEl = document.getElementById('reqDetailDrawerTitle');
  const bodyEl  = document.getElementById('reqDetailDrawerBody');
  if (!titleEl || !bodyEl) return;

  titleEl.textContent = r.request_categories?.name ?? 'Request';

  const responses = (r.staff_request_responses ?? [])
    .slice()
    .sort((a, b) => (a.request_category_fields?.sort_order ?? 0) - (b.request_category_fields?.sort_order ?? 0));

  bodyEl.innerHTML = `
    <div style="margin-bottom:16px;">
      <div style="font-size:13px;color:#6b7280;">Submitted on ${fmtShortDate(r.created_at)}</div>
    </div>

    <div class="req-responses">
      ${responses.map(resp => {
        const label = resp.request_category_fields?.label ?? 'Field';
        const val   = formatResponseValue(resp.value, resp.request_category_fields?.field_type);
        return `
          <div class="req-response-row">
            <div class="req-response-label">${esc(label)}</div>
            <div class="req-response-value">${val}</div>
          </div>`;
      }).join('') || '<p style="color:#9ca3af;">No details recorded.</p>'}
    </div>

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />
    <div class="form-group">
      <label class="form-label">Status</label>
      <div><span class="req-status-badge ${statusBadgeClass(r.status)}">${statusLabel(r.status, r.request_categories)}</span></div>
    </div>
    ${r.manager_notes ? `
      <div class="form-group" style="margin-top:14px;">
        <label class="form-label">Manager Notes</label>
        <div style="font-size:14px;color:#111827;">${esc(r.manager_notes)}</div>
      </div>` : ''}
  `;

  document.getElementById('reqDetailDrawer').classList.add('open');
  document.getElementById('reqDetailOverlay').classList.add('open');
}

function closeDetailDrawer() {
  document.getElementById('reqDetailDrawer').classList.remove('open');
  document.getElementById('reqDetailOverlay').classList.remove('open');
}

function formatResponseValue(val, type) {
  if (!val) return '—';
  if (type === 'boolean') return val === 'true' ? 'Yes' : 'No';
  if (type === 'url') {
    // type="url" validity only requires a well-formed absolute URL, not a
    // safe scheme (javascript:... passes) -- only link http(s), otherwise
    // fall back to plain text so a crafted value can't become a clickable
    // javascript: href.
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

// Shows a bottom fade over the history table whenever there's more to
// scroll, hiding it once the last row is in view — the box has no
// visible scrollbar on most trackpads/OSes otherwise, so nothing else
// hints that it's scrollable.
function wireHistoryScrollFade() {
  const scrollEl = document.getElementById('reqHistoryScroll');
  const fadeEl   = document.getElementById('reqHistoryFade');
  if (!scrollEl || !fadeEl) return;

  const update = () => {
    const canScrollMore = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight > 1;
    fadeEl.classList.toggle('visible', canScrollMore);
  };

  scrollEl.addEventListener('scroll', update);
  update();
}

function statusLabel(s, cat) {
  if (s === 'resolved') return cat?.resolved_label || 'Resolved';
  if (s === 'denied')   return cat?.denied_label   || 'Denied';
  return { pending: 'Pending', in_review: 'In Review', completed: 'Completed' }[s] ?? s;
}
function statusBadgeClass(s) {
  return { pending: 'badge-amber', in_review: 'badge-blue', resolved: 'badge-green', denied: 'badge-red', completed: 'badge-purple' }[s] ?? '';
}
