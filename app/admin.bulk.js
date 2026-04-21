
// admin.bulk.js
import { supabase } from './admin.supabase.js';

let initialized = false;
let uploadedFileBase64 = null;

const BULK_SUPPORTED_SHEETS = [
  'Families',
  'Guardians',
  'Students',
  'Staff',
  'Bus Groups'
];

/* ===============================
   ENTRY POINT
================================ */
export async function initBulkSection() {
  if (!initialized) {
    wireBulkEvents();
    initialized = true;
  }
}

/* ===============================
   EVENT WIRING
================================ */
function wireBulkEvents() {
  const fileInput = document.getElementById('bulkUploadFile');
  const dropzone = document.getElementById('bulkUploadDropzone');
  const previewBtn = document.getElementById('bulkPreviewBtn');
  const commitBtn = document.getElementById('bulkCommitBtn');
  const rollbackBtn = document.getElementById('bulkRollbackBtn');

  if (fileInput) {
    fileInput.addEventListener('change', handleFileSelect);
  }

  if (dropzone && fileInput) {
    wireDropzone(dropzone, fileInput);
  }

  previewBtn?.addEventListener('click', previewBulkUpload);
  commitBtn?.addEventListener('click', commitBulkUpload);
  rollbackBtn?.addEventListener('click', rollbackBulkUpload);
}

/* ===============================
   FILE HANDLING
================================ */
function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    uploadedFileBase64 = reader.result.split(',')[1];
    parseWorkbookSheets(uploadedFileBase64);
  };
  reader.readAsDataURL(file);
}

function wireDropzone(dropzone, fileInput) {
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt =>
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      e.stopPropagation();
    })
  );

  ['dragenter', 'dragover'].forEach(evt =>
    dropzone.addEventListener(evt, () =>
      dropzone.classList.add('drag-active')
    )
  );

  ['dragleave', 'drop'].forEach(evt =>
    dropzone.addEventListener(evt, () =>
      dropzone.classList.remove('drag-active')
    )
  );

  dropzone.addEventListener('drop', e => {
    if (!e.dataTransfer.files.length) return;
    fileInput.files = e.dataTransfer.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/* ===============================
   XLSX PARSING
================================ */
function parseWorkbookSheets(base64) {
  const workbook = XLSX.read(
    Uint8Array.from(atob(base64), c => c.charCodeAt(0)),
    { type: 'array' }
  );

  const container = document.getElementById('bulkSheetCheckboxes');
  const section = document.getElementById('bulkUploadSheets');
  const previewBtn = document.getElementById('bulkPreviewBtn');

  container.innerHTML = '';
  let found = false;

  workbook.SheetNames.forEach(name => {
    if (!BULK_SUPPORTED_SHEETS.includes(name)) return;
    found = true;

    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = true;

    label.appendChild(cb);
    label.append(` ${name}`);
    container.appendChild(label);
  });

  section.style.display = found ? 'block' : 'none';
  previewBtn.disabled = !found;
}

/* ===============================
   PREVIEW
================================ */
async function previewBulkUpload() {
  if (!uploadedFileBase64) {
    alert('Please select a file first.');
    return;
  }

  const selectedSheets = Array.from(
    document.querySelectorAll('#bulkSheetCheckboxes input:checked')
  ).map(cb => cb.value);

  const allowUpdates =
    document.getElementById('allowUpdatesToggle')?.checked === true;

  if (!selectedSheets.length) {
    alert('Select at least one sheet.');
    return;
  }

  const { data, error } = await supabase.functions.invoke(
    'bulk_upload_preview',
    {
      body: {
        file_base64: uploadedFileBase64,
        selected_sheets: selectedSheets,
        allow_updates: allowUpdates
      }
    }
  );

  if (error) {
    console.error(error);
    alert('Preview failed.');
    return;
  }

  renderPreview(data);
  window.lastBulkPreviewResult = data;
}

/* ===============================
   COMMIT / ROLLBACK
================================ */
async function commitBulkUpload() {
  const commitBtn = document.getElementById('bulkCommitBtn');
  if (!window.lastBulkPreviewResult) return;

  commitBtn.disabled = true;
  commitBtn.textContent = 'Committing…';

  const { error } = await supabase.functions.invoke(
    'bulk_upload_commit',
    {
      body: {
        preview_result: window.lastBulkPreviewResult
      }
    }
  );

  commitBtn.disabled = false;
  commitBtn.textContent = 'Commit Bulk Upload';

  if (error) {
    console.error(error);
    alert('Commit failed.');
    return;
  }

  resetBulkUI(true);
}

async function rollbackBulkUpload() {
  if (!confirm('Undo the last bulk upload?')) return;

  const { data, error } = await supabase.functions.invoke(
    'bulk_upload_rollback'
  );

  if (error) {
    alert(error.message || 'Rollback failed');
    return;
  }

  renderRollback(data.summary);
}

/* ===============================
   RENDERING
================================ */
function renderPreview(result) {
  const container = document.getElementById('bulkUploadPreview');
  container.innerHTML = '';

  Object.entries(result.summary).forEach(([sheet, counts]) => {
    const div = document.createElement('div');
    div.innerHTML = `
      <strong>${sheet}</strong><br>
      Insert: ${counts.insert ?? 0},
      Update: ${counts.update ?? 0},
      Skip: ${counts.skip ?? 0},
      Error: ${counts.error ?? 0}
    `;
    container.appendChild(div);
  });

  document.getElementById('bulkUploadCommit').style.display =
    result.blockingErrors ? 'none' : 'block';
}

function renderRollback(summary) {
  const container = document.getElementById('bulkUploadPreview');
  container.innerHTML = '<h3>Rollback Complete</h3>';

  Object.entries(summary).forEach(([sheet, counts]) => {
    if (!counts.reverted_updates && !counts.removed_inserts) return;

    const div = document.createElement('div');
    div.innerHTML = `
      <strong>${sheet}</strong> —
      Reverted updates: ${counts.reverted_updates},
      Removed inserts: ${counts.removed_inserts}
    `;
    container.appendChild(div);
  });
}

/* ===============================
   RESET
================================ */
function resetBulkUI(showNotice = false) {
  uploadedFileBase64 = null;
  document.getElementById('bulkUploadFile').value = '';
  document.getElementById('bulkUploadSheets').style.display = 'none';
  document.getElementById('bulkUploadPreview').innerHTML = '';
  document.getElementById('bulkUploadCommit').style.display = 'none';

  if (showNotice) {
    const msg = document.createElement('div');
    msg.className = 'notice success';
    msg.textContent = '✅ Bulk upload completed.';
    document
      .querySelector('#bulk-upload .panel-action')
      ?.appendChild(msg);
    setTimeout(() => msg.remove(), 4000);
  }
}
