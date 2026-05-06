
// admin.exports.js
import { supabase } from './admin.supabase.js';

let currentProfile;
let initialized = false;

/* ===============================
   ENTRY POINT
================================ */
export async function initExportsSection(profile) {
  currentProfile = profile;

  if (!currentProfile.can_export_data) {
    alert('You are not authorized to export data.');
    return;
  }

  if (!initialized) {
    wireExportEvents();
    initialized = true;
  }
}

/* ===============================
   EVENT WIRING
================================ */
function wireExportEvents() {
  document
    .getElementById('exportClassPlacement')
    ?.addEventListener('click', e =>
      runExport('class_placement', {}, e.currentTarget)
    );

  document
    .getElementById('exportTeacherRosters')
    ?.addEventListener('click', e =>
      runExport('teacher_rosters', {}, e.currentTarget)
    );

  document
    .getElementById('exportGradeRosters')
    ?.addEventListener('click', e =>
      runExport('grade_rosters', {}, e.currentTarget)
    );

  document
    .getElementById('exportBusAssignments')
    ?.addEventListener('click', e =>
      runExport('bus_assignments', {}, e.currentTarget)
    );

  document
    .getElementById('exportContactLists')
    ?.addEventListener('click', e => {
      const split =
        document.getElementById('contactSplitSelect')?.value;

      runExport(
        'contact_lists',
        { split: split || undefined },
        e.currentTarget
      );
    });
}


/* ===============================
   EXPORT HANDLER
================================ */

async function runExport(type, options = {}, buttonEl = null) {
  try {
    // ✅ UI feedback
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.dataset.originalText = buttonEl.textContent;
      buttonEl.textContent = 'Generating…';
      document.body.style.cursor = 'progress';
    }

    const { data, error } = await supabase.functions.invoke(
      'admin_export',
      {
        body: {
          type,
          ...options
        }
      }
    );

    if (error) {
      console.error(error);
      alert('Export failed.');
      return;
    }

    if (!data?.file_base64 || !data?.filename) {
      alert('Export returned no file.');
      return;
    }

    downloadBase64File(
      data.file_base64,
      data.filename,
      data.mime_type ||
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

  } catch (err) {
    console.error('Export error', err);
    alert('Export error.');
  } finally {
    // ✅ Always restore UI
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = buttonEl.dataset.originalText;
    }
    document.body.style.cursor = '';
  }
}


/* ===============================
   FILE DOWNLOAD
================================ */
function downloadBase64File(base64, filename, mime) {
  const link = document.createElement('a');
  link.href = `data:${mime};base64,${base64}`;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
