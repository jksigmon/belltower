// admin.resource-docs.js
import { supabase } from './admin.supabase.js';
import { esc, dbError, fmtShortDate } from './admin.shared.js';

const BUCKET = 'resource-docs';
const MAX_BYTES = 15 * 1024 * 1024; // 15MB
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];

// Only PDFs and images can be shown in the print-only viewer (browsers have
// no built-in in-page viewer for Word/Excel/etc.); everything else gets a
// plain, clearly-labeled download instead of a false "protected" promise.
function fileKind(filename) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  return 'other';
}

function fileExt(filename) {
  const parts = (filename || '').toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : 'bin';
}

let profile = null;
let docs = [];

/* ===============================
   ENTRY POINT
================================ */
export async function initResourceDocsSection(p) {
  profile = p;

  if (!profile.is_superadmin && profile.role !== 'admin' && !profile.can_manage_resource_docs) {
    document.getElementById('resourceDocsRoot').innerHTML =
      '<p class="muted" style="padding:40px;">You are not authorized to manage resource documents.</p>';
    return;
  }

  wireUploadForm();
  await loadDocs();
}

/* ===============================
   LOAD + RENDER LIST
================================ */
async function loadDocs() {
  const { data, error } = await supabase
    .from('resource_documents')
    .select('id, title, file_path, original_filename, uploaded_by_name, created_at, updated_at')
    .eq('school_id', profile.school_id)
    .order('sort_order')
    .order('title');

  if (error) { console.error('loadDocs', error); return; }
  docs = data ?? [];
  renderList();
}

const FILE_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

function renderList() {
  const wrap = document.getElementById('rdListWrap');
  if (!wrap) return;

  if (!docs.length) {
    wrap.innerHTML = `
      <div class="rd-doc-empty">
        <div class="rd-doc-empty-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        </div>
        <p class="rd-doc-empty-title">No documents uploaded yet</p>
        <p class="rd-doc-empty-desc">Upload a file above — handbooks, forms, or procedures — and it'll appear here, plus under Resources in the staff portal.</p>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="rd-doc-grid">
      ${docs.map(d => {
        const uploader = d.uploaded_by_name || 'Unknown';
        const kind = fileKind(d.original_filename);
        const kindBadge = kind === 'other'
          ? '<span class="rd-doc-badge rd-doc-badge--dl" title="No in-browser viewer exists for this file type — staff get a plain download link">Downloadable</span>'
          : '<span class="rd-doc-badge rd-doc-badge--view" title="Staff can view and print this, but not download it">Print-only</span>';
        return `
          <div class="rd-doc-card" data-id="${esc(d.id)}">
            <div class="rd-doc-icon">${FILE_ICON}</div>
            <div class="rd-doc-info">
              <div class="rd-doc-title">${esc(d.title)}</div>
              <div class="rd-doc-meta">${esc(d.original_filename ?? 'file')} · Uploaded ${fmtShortDate(d.created_at)} by ${esc(uploader)} · ${kindBadge}</div>
            </div>
            <div class="rd-doc-actions">
              <button class="btn btn-sm rd-rename-btn" data-id="${esc(d.id)}">Rename</button>
              <button class="btn btn-sm rd-replace-btn" data-id="${esc(d.id)}">Replace File</button>
              <button class="btn btn-sm rd-delete-btn" data-id="${esc(d.id)}" style="color:#dc2626;border-color:#fca5a5;">Delete</button>
              <input type="file" class="rd-replace-input" data-id="${esc(d.id)}" hidden />
            </div>
          </div>`;
      }).join('')}
    </div>`;

  wrap.querySelectorAll('.rd-rename-btn').forEach(btn =>
    btn.addEventListener('click', () => renameDoc(btn.dataset.id)));

  wrap.querySelectorAll('.rd-replace-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      wrap.querySelector(`.rd-replace-input[data-id="${btn.dataset.id}"]`)?.click();
    }));

  wrap.querySelectorAll('.rd-replace-input').forEach(input =>
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) replaceDocFile(input.dataset.id, file);
      input.value = '';
    }));

  wrap.querySelectorAll('.rd-delete-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteDoc(btn.dataset.id)));
}

/* ===============================
   UPLOAD
================================ */
function wireUploadForm() {
  document.getElementById('rdUploadBtn')?.addEventListener('click', uploadDoc);

  const fileInput  = document.getElementById('rdUploadFile');
  const triggerBtn = document.getElementById('rdFileTriggerBtn');
  const dropzone   = document.getElementById('rdDropzone');

  triggerBtn?.addEventListener('click', e => { e.stopPropagation(); fileInput?.click(); });
  dropzone?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => updateFileNameDisplay(fileInput.files?.[0]));

  // Drag & drop
  if (dropzone) {
    ['dragenter', 'dragover'].forEach(evt =>
      dropzone.addEventListener(evt, e => {
        e.preventDefault();
        dropzone.classList.add('rd-dropzone--drag');
      }));
    ['dragleave', 'drop'].forEach(evt =>
      dropzone.addEventListener(evt, e => {
        e.preventDefault();
        dropzone.classList.remove('rd-dropzone--drag');
      }));
    dropzone.addEventListener('drop', e => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      // DataTransfer can't be assigned to an <input> directly in all
      // browsers; use DataTransfer to build a FileList the input accepts.
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      updateFileNameDisplay(file);
    });
  }
}

function updateFileNameDisplay(file) {
  const nameEl = document.getElementById('rdFileName');
  const zone   = document.getElementById('rdDropzone');
  if (!nameEl) return;
  nameEl.textContent = file ? `Selected: ${file.name}` : '';
  zone?.classList.toggle('rd-dropzone--filled', !!file);
}

function validateFile(file) {
  if (!file) return 'Choose a file.';
  if (file.size > MAX_BYTES) return 'File is too large (15MB max).';
  return null;
}

function showUploadError(msg) {
  const el = document.getElementById('rdUploadError');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
}

async function uploadDoc() {
  const titleInput = document.getElementById('rdUploadTitle');
  const fileInput  = document.getElementById('rdUploadFile');
  const btn        = document.getElementById('rdUploadBtn');

  const title = titleInput?.value.trim();
  const file  = fileInput?.files?.[0];

  showUploadError('');
  if (!title) { showUploadError('Title is required.'); return; }
  const fileErr = validateFile(file);
  if (fileErr) { showUploadError(fileErr); return; }

  btn.disabled = true;
  btn.textContent = 'Uploading…';

  const docId = crypto.randomUUID();
  const path  = `${profile.school_id}/${docId}.${fileExt(file.name)}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });

  if (upErr) {
    showUploadError('Upload failed: ' + upErr.message);
    btn.disabled = false;
    btn.textContent = 'Upload';
    return;
  }

  const uploaderName = [profile.first_name, profile.last_name].filter(Boolean).join(' ')
    || profile.display_name || profile.email || 'Unknown';

  const { error: insErr } = await supabase.from('resource_documents').insert({
    id: docId,
    school_id: profile.school_id,
    title,
    file_path: path,
    original_filename: file.name,
    uploaded_by: profile.id,
    uploaded_by_name: uploaderName,
  });

  btn.disabled = false;
  btn.textContent = 'Upload';

  if (insErr) {
    // Roll back the orphaned storage object so it doesn't linger with no DB row
    await supabase.storage.from(BUCKET).remove([path]);
    dbError(insErr, 'Failed to save document record');
    showUploadError('Failed to save document record: ' + insErr.message);
    return;
  }

  titleInput.value = '';
  fileInput.value = '';
  updateFileNameDisplay(null);
  await loadDocs();
}

/* ===============================
   RENAME
================================ */
async function renameDoc(id) {
  const doc = docs.find(d => d.id === id);
  if (!doc) return;
  const newTitle = prompt('Document title:', doc.title);
  if (newTitle === null) return;
  const trimmed = newTitle.trim();
  if (!trimmed) return;

  const { error } = await supabase
    .from('resource_documents')
    .update({ title: trimmed, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) { alert('Rename failed: ' + error.message); return; }
  await loadDocs();
}

/* ===============================
   REPLACE FILE
   Normally overwrites the same storage path in place — this is what
   keeps the file staff view always current, rather than accumulating
   versions. If the replacement has a different extension (e.g. a PDF
   replaced with a DOCX), the path must change to match, so we upload
   to the new path, remove the old object, then update the DB row.
================================ */
async function replaceDocFile(id, file) {
  const doc = docs.find(d => d.id === id);
  if (!doc) return;

  const err = validateFile(file);
  if (err) { alert(err); return; }

  const newExt  = fileExt(file.name);
  const newPath = `${profile.school_id}/${id}.${newExt}`;
  const pathChanged = newPath !== doc.file_path;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(newPath, file, { contentType: file.type || 'application/octet-stream', upsert: true });

  if (upErr) { alert('Replace failed: ' + upErr.message); return; }

  if (pathChanged) {
    const { error: rmErr } = await supabase.storage.from(BUCKET).remove([doc.file_path]);
    if (rmErr) console.error('replaceDocFile old-path cleanup', rmErr);
  }

  const { error: updErr } = await supabase
    .from('resource_documents')
    .update({ file_path: newPath, original_filename: file.name, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (updErr) console.error('replaceDocFile metadata update', updErr);
  await loadDocs();
}

/* ===============================
   DELETE
================================ */
async function deleteDoc(id) {
  const doc = docs.find(d => d.id === id);
  if (!doc) return;
  if (!confirm(`Delete "${doc.title}"? Staff will no longer be able to view it. This cannot be undone.`)) return;

  const { error: delErr } = await supabase.from('resource_documents').delete().eq('id', id);
  if (delErr) { alert('Delete failed: ' + delErr.message); return; }

  const { error: rmErr } = await supabase.storage.from(BUCKET).remove([doc.file_path]);
  if (rmErr) console.error('deleteDoc storage remove', rmErr);

  await loadDocs();
}
