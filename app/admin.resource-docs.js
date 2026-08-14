// admin.resource-docs.js
import { supabase } from './admin.supabase.js?v=2';
import { esc, dbError, fmtShortDate, debounce, categoryChipStyle, CATEGORY_COLOR_KEYS } from './admin.shared.js?v=3';
import { fileKind, tileIconSvg, getThumbnailUrl, withThumbnailConcurrency } from './resource-doc-thumbnails.js?v=2';

const BUCKET = 'resource-docs';
const MAX_BYTES = 15 * 1024 * 1024; // 15MB
const VIEW_MODE_KEY = 'rdViewMode';

const STARTER_CATEGORIES = ['Schedules', 'Policies', 'Maps', 'Staff Resources', 'General'];

function fileExt(filename) {
  const parts = (filename || '').toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : 'bin';
}

let profile = null;
let docs = [];
let categories = [];
let searchTerm = '';
let categoryFilter = '';
let viewMode = localStorage.getItem(VIEW_MODE_KEY) === 'grid' ? 'grid' : 'list';

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
  wireHeaderControls();
  wireCategoryModal();
  wireEditModal();
  await loadCategories();
  await loadDocs();
}

function wireHeaderControls() {
  document.getElementById('rdSearch')?.addEventListener('input', debounce(e => {
    searchTerm = e.target.value.trim().toLowerCase();
    renderList();
  }, 200));

  document.getElementById('rdCategoryFilter')?.addEventListener('change', e => {
    categoryFilter = e.target.value;
    renderList();
  });

  document.getElementById('rdManageCatsBtn')?.addEventListener('click', openCategoryModal);

  document.getElementById('rdViewToggle')?.addEventListener('click', e => {
    const btn = e.target.closest('.rd-view-btn');
    if (!btn) return;
    viewMode = btn.dataset.view === 'grid' ? 'grid' : 'list';
    localStorage.setItem(VIEW_MODE_KEY, viewMode);
    updateViewToggleButtons();
    renderList();
  });

  updateViewToggleButtons();
}

function updateViewToggleButtons() {
  document.querySelectorAll('#rdViewToggle .rd-view-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.view === viewMode));
}

/* ===============================
   LOAD + RENDER LIST
================================ */
async function loadDocs() {
  const { data, error } = await supabase
    .from('resource_documents')
    .select('id, title, file_path, original_filename, uploaded_by_name, created_at, updated_at, category_id')
    .eq('school_id', profile.school_id)
    .order('sort_order')
    .order('title');

  if (error) { console.error('loadDocs', error); return; }
  docs = data ?? [];
  renderList();
}

/* ===============================
   CATEGORIES
================================ */
async function loadCategories() {
  const { data, error } = await supabase
    .from('resource_document_categories')
    .select('id, name, color, sort_order')
    .eq('school_id', profile.school_id)
    .order('sort_order')
    .order('name');

  if (error) { console.error('loadCategories', error); categories = []; }
  else categories = data ?? [];

  syncCategorySelects();
}

function categoryById(id) {
  return categories.find(c => c.id === id) || null;
}

// Rebuilds every category <select> and the filter dropdown from the
// current list, preserving each one's selection where it still exists.
function syncCategorySelects() {
  const opts = categories.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');

  [
    ['rdCategoryFilter', 'All categories', ''],
    ['rdUploadCategory', 'Uncategorized', ''],
    ['rdEditCategory', 'Uncategorized', ''],
  ].forEach(([id, blankLabel]) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = `<option value="">${blankLabel}</option>` + opts;
    // Only restore if that category still exists — otherwise fall back to
    // the blank option rather than silently keeping a stale id selected.
    sel.value = categories.some(c => c.id === prev) ? prev : '';
  });

  // A filter pointing at a just-deleted category would hide everything.
  if (categoryFilter && !categories.some(c => c.id === categoryFilter)) categoryFilter = '';
}

function categoryChipHtml(categoryId) {
  const cat = categoryById(categoryId);
  if (!cat) return '';
  const { bg, fg } = categoryChipStyle(cat.color, cat.id);
  return `<span class="rd-cat-chip" style="background:${bg};color:${fg};">${esc(cat.name)}</span>`;
}

const FILE_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

function filteredDocs() {
  return docs.filter(d => {
    if (categoryFilter && d.category_id !== categoryFilter) return false;
    if (!searchTerm) return true;
    return (d.title ?? '').toLowerCase().includes(searchTerm) ||
           (d.original_filename ?? '').toLowerCase().includes(searchTerm);
  });
}

function renderCard(d) {
  const uploader = d.uploaded_by_name || 'Unknown';
  const kind = fileKind(d.original_filename);
  const kindBadge = kind === 'other'
    ? '<span class="rd-doc-badge rd-doc-badge--dl" title="No in-browser viewer exists for this file type — staff get a plain download link">Downloadable</span>'
    : '<span class="rd-doc-badge rd-doc-badge--view" title="Staff can view and print this, but not download it">Print-only</span>';
  return `
    <div class="rd-doc-card" data-id="${esc(d.id)}">
      <div class="rd-doc-icon">${FILE_ICON}</div>
      <div class="rd-doc-info">
        <div class="rd-doc-title">${esc(d.title)} ${categoryChipHtml(d.category_id)}</div>
        <div class="rd-doc-meta">${esc(d.original_filename ?? 'file')} · Uploaded ${fmtShortDate(d.created_at)} by ${esc(uploader)} · ${kindBadge}</div>
      </div>
      <div class="rd-doc-actions">
        <button class="btn btn-sm btn-primary rd-open-btn" data-id="${esc(d.id)}">Open</button>
        <button class="btn btn-sm rd-edit-btn" data-id="${esc(d.id)}">Edit</button>
        <button class="btn btn-sm rd-replace-btn" data-id="${esc(d.id)}">Replace File</button>
        <button class="btn btn-sm rd-delete-btn" data-id="${esc(d.id)}" style="color:#dc2626;border-color:#fca5a5;">Delete</button>
        <input type="file" class="rd-replace-input" data-id="${esc(d.id)}" hidden />
      </div>
    </div>`;
}

function renderTile(d) {
  const kind = fileKind(d.original_filename);
  return `
    <div class="rd-doc-tile" data-id="${esc(d.id)}">
      <div class="rd-doc-tile-icon rd-doc-tile-icon--${kind}" data-thumb-icon="${esc(d.id)}">${tileIconSvg(kind)}</div>
      <div class="rd-doc-tile-title">${esc(d.title)}</div>
      <div class="rd-doc-tile-meta">${categoryChipHtml(d.category_id) || esc(d.original_filename ?? 'file')}</div>
      <div class="rd-doc-tile-actions">
        <button class="btn btn-sm btn-primary rd-open-btn" data-id="${esc(d.id)}">Open</button>
        <button class="btn btn-sm rd-edit-btn" data-id="${esc(d.id)}">Edit</button>
        <button class="btn btn-sm rd-replace-btn" data-id="${esc(d.id)}">Replace</button>
        <button class="btn btn-sm rd-delete-btn" data-id="${esc(d.id)}" style="color:#dc2626;border-color:#fca5a5;">Delete</button>
        <input type="file" class="rd-replace-input" data-id="${esc(d.id)}" hidden />
      </div>
    </div>`;
}

async function loadGridThumbnails(list) {
  const candidates = list.filter(d => fileKind(d.original_filename) !== 'other');
  if (!candidates.length) return;

  await withThumbnailConcurrency(candidates, 3, async d => {
    const url = await getThumbnailUrl(supabase, BUCKET, d);
    if (!url) return;
    const iconEl = document.querySelector(`.rd-doc-tile-icon[data-thumb-icon="${CSS.escape(d.id)}"]`);
    if (!iconEl) return;
    iconEl.innerHTML = `<img src="${esc(url)}" alt="" />`;
  });
}

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

  const visible = filteredDocs();

  if (!visible.length) {
    wrap.innerHTML = `
      <div class="rd-doc-empty">
        <div class="rd-doc-empty-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </div>
        <p class="rd-doc-empty-title">No documents match "${esc(document.getElementById('rdSearch')?.value ?? '')}"</p>
        <p class="rd-doc-empty-desc">Try a different title or file name.</p>
      </div>`;
    return;
  }

  wrap.innerHTML = viewMode === 'grid'
    ? `<div class="rd-doc-tiles">${visible.map(renderTile).join('')}</div>`
    : `<div class="rd-doc-grid">${visible.map(renderCard).join('')}</div>`;

  if (viewMode === 'grid') loadGridThumbnails(visible);

  wrap.querySelectorAll('.rd-open-btn').forEach(btn =>
    btn.addEventListener('click', () => openResourceDoc(btn.dataset.id)));

  wrap.querySelectorAll('.rd-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openEditModal(btn.dataset.id)));

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
    category_id: document.getElementById('rdUploadCategory')?.value || null,
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
  // Category is deliberately NOT reset — uploading a batch of documents
  // into one category is the common case, so keeping the selection saves
  // re-picking it on every file.
  updateFileNameDisplay(null);
  await loadDocs();
}

/* ===============================
   OPEN
================================ */
async function openResourceDoc(id) {
  const doc = docs.find(d => d.id === id);
  if (!doc) return;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(doc.file_path, 300);

  if (error || !data?.signedUrl) { dbError(error, 'Failed to open document'); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
}

/* ===============================
   EDIT (title + category)
================================ */
let editingDocId = null;

function wireEditModal() {
  document.getElementById('rdEditCancel')?.addEventListener('click', closeEditModal);
  document.getElementById('rdEditSave')?.addEventListener('click', saveEditModal);
}

function openEditModal(id) {
  const doc = docs.find(d => d.id === id);
  if (!doc) return;
  editingDocId = id;

  syncCategorySelects();
  document.getElementById('rdEditTitle').value = doc.title ?? '';
  document.getElementById('rdEditCategory').value = doc.category_id ?? '';
  showEditError('');
  document.getElementById('rdEditModal').hidden = false;
  document.getElementById('rdEditTitle').focus();
}

function closeEditModal() {
  document.getElementById('rdEditModal').hidden = true;
  editingDocId = null;
}

function showEditError(msg) {
  const el = document.getElementById('rdEditError');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
}

async function saveEditModal() {
  if (!editingDocId) return;
  const title = document.getElementById('rdEditTitle').value.trim();
  if (!title) { showEditError('Title is required.'); return; }

  const btn = document.getElementById('rdEditSave');
  btn.disabled = true;

  // Note: updated_at is deliberately NOT bumped here. It drives the staff
  // "Recently Updated" list, which should mean "the document changed" —
  // correcting a typo in a title shouldn't push a year-old handbook back
  // to the top of everyone's list. Replacing the file does bump it.
  const { error } = await supabase
    .from('resource_documents')
    .update({ title, category_id: document.getElementById('rdEditCategory').value || null })
    .eq('id', editingDocId);

  btn.disabled = false;
  if (error) { showEditError('Save failed: ' + error.message); return; }

  closeEditModal();
  await loadDocs();
}

/* ===============================
   MANAGE CATEGORIES
================================ */
function wireCategoryModal() {
  document.getElementById('rdCatsClose')?.addEventListener('click', () => {
    document.getElementById('rdCatsModal').hidden = true;
  });
  document.getElementById('rdCatAddBtn')?.addEventListener('click', addCategory);
  document.getElementById('rdCatNewName')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addCategory(); }
  });
  document.getElementById('rdCatSeedBtn')?.addEventListener('click', seedStarterCategories);
}

function openCategoryModal() {
  showCategoryError('');
  document.getElementById('rdCatNewName').value = '';
  document.getElementById('rdCatsModal').hidden = false;
  renderCategoryList();
}

function showCategoryError(msg) {
  const el = document.getElementById('rdCatsError');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
}

function renderCategoryList() {
  const wrap = document.getElementById('rdCatsList');
  if (!wrap) return;

  // Offered only on a genuinely empty list, so it can't be used to
  // re-add duplicates of categories the school already renamed.
  const seedBtn = document.getElementById('rdCatSeedBtn');
  if (seedBtn) seedBtn.style.display = categories.length ? 'none' : '';

  if (!categories.length) {
    wrap.innerHTML = '<div class="rd-cats-empty">No categories yet. Add one below.</div>';
    return;
  }

  wrap.innerHTML = categories.map(c => {
    const { bg, fg } = categoryChipStyle(c.color, c.id);
    const count = docs.filter(d => d.category_id === c.id).length;
    return `
      <div class="rd-cat-row" data-id="${esc(c.id)}">
        <button class="rd-cat-swatch" data-cat-color="${esc(c.id)}"
                style="background:${bg};" title="Change color"></button>
        <span class="rd-cat-row-name">${esc(c.name)}</span>
        <span class="rd-cat-row-count">${count} doc${count === 1 ? '' : 's'}</span>
        <button class="btn btn-sm" data-cat-rename="${esc(c.id)}">Rename</button>
        <button class="btn btn-sm" data-cat-delete="${esc(c.id)}"
                style="color:#dc2626;border-color:#fca5a5;">Delete</button>
      </div>`;
  }).join('');

  wrap.querySelectorAll('[data-cat-color]').forEach(btn =>
    btn.addEventListener('click', () => cycleCategoryColor(btn.dataset.catColor)));
  wrap.querySelectorAll('[data-cat-rename]').forEach(btn =>
    btn.addEventListener('click', () => renameCategory(btn.dataset.catRename)));
  wrap.querySelectorAll('[data-cat-delete]').forEach(btn =>
    btn.addEventListener('click', () => deleteCategory(btn.dataset.catDelete)));
}

async function refreshAfterCategoryChange() {
  await loadCategories();
  renderCategoryList();
  renderList();
}

async function addCategory() {
  const input = document.getElementById('rdCatNewName');
  const name = input.value.trim();
  if (!name) return;

  showCategoryError('');
  const { error } = await supabase.from('resource_document_categories').insert({
    school_id: profile.school_id,
    name,
    sort_order: categories.length,
    created_by: profile.id,
  });

  if (error) {
    // 23505 is the (school_id, lower(name)) unique index doing its job.
    showCategoryError(error.code === '23505'
      ? `A category named "${name}" already exists.`
      : 'Could not add category: ' + error.message);
    return;
  }

  input.value = '';
  await refreshAfterCategoryChange();
}

async function renameCategory(id) {
  const cat = categories.find(c => c.id === id);
  if (!cat) return;
  const next = prompt('Category name:', cat.name);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === cat.name) return;

  const { error } = await supabase
    .from('resource_document_categories')
    .update({ name: trimmed })
    .eq('id', id);

  if (error) {
    showCategoryError(error.code === '23505'
      ? `A category named "${trimmed}" already exists.`
      : 'Could not rename category: ' + error.message);
    return;
  }
  await refreshAfterCategoryChange();
}

// Colors come from a fixed readable palette, so "change color" is a click
// through the options rather than a color picker that could produce an
// unreadable chip.
async function cycleCategoryColor(id) {
  const cat = categories.find(c => c.id === id);
  if (!cat) return;
  const idx = CATEGORY_COLOR_KEYS.indexOf(cat.color);
  const next = CATEGORY_COLOR_KEYS[(idx + 1) % CATEGORY_COLOR_KEYS.length];

  const { error } = await supabase
    .from('resource_document_categories')
    .update({ color: next })
    .eq('id', id);

  if (error) { showCategoryError('Could not change color: ' + error.message); return; }
  await refreshAfterCategoryChange();
}

async function deleteCategory(id) {
  const cat = categories.find(c => c.id === id);
  if (!cat) return;
  const count = docs.filter(d => d.category_id === id).length;

  const msg = count
    ? `Delete "${cat.name}"? ${count} document${count === 1 ? '' : 's'} will become Uncategorized. `
      + `No documents or files are deleted.`
    : `Delete "${cat.name}"?`;
  if (!confirm(msg)) return;

  // The FK is ON DELETE SET NULL, so affected documents survive and simply
  // lose their category — no manual reassignment needed here.
  const { error } = await supabase
    .from('resource_document_categories')
    .delete()
    .eq('id', id);

  if (error) { showCategoryError('Could not delete category: ' + error.message); return; }
  await loadDocs();
  await refreshAfterCategoryChange();
}

async function seedStarterCategories() {
  showCategoryError('');
  const { error } = await supabase.from('resource_document_categories').insert(
    STARTER_CATEGORIES.map((name, i) => ({
      school_id: profile.school_id,
      name,
      sort_order: i,
      color: CATEGORY_COLOR_KEYS[i % CATEGORY_COLOR_KEYS.length],
      created_by: profile.id,
    })));

  if (error) { showCategoryError('Could not add starter categories: ' + error.message); return; }
  await refreshAfterCategoryChange();
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
