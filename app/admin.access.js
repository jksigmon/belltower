// admin.access.js
import { supabase } from './admin.supabase.js';

let currentProfile;
let initialized = false;

/* ===============================
   ROLE PRESETS
================================ */
const ACCESS_ROLE_PRESETS = {
  teacher: {
    can_login: true,
    can_access_admin: false,
    can_manage_access: false,
    can_manage_staff: false,
    can_manage_students: false,
    can_manage_families: false,
    can_manage_guardians: false,
    can_manage_bus_groups: false,
    can_manage_substitutes: false,
    can_view_pto_calendar: false,
    can_review_pto: false,
    can_approve_pto: false,
    can_adjust_pto: false,
    can_generate_pto_reports: false,
    can_view_carline: false,
    can_bulk_upload: false
  },
  office: {
    can_login: true,
    can_access_admin: true,
    can_manage_access: false,
    can_manage_students: true,
    can_manage_families: true,
    can_manage_guardians: true,
    can_manage_bus_groups: true,
    can_manage_substitutes: true,
    can_view_pto_calendar: true,
    can_review_pto: false,
    can_approve_pto: false,
    can_adjust_pto: false,
    can_generate_pto_reports: false,
    can_view_carline: true,
    can_bulk_upload: false
  },
  admin: {
    can_login: true,
    can_access_admin: true,
    can_manage_access: true,
    can_manage_staff: true,
    can_manage_students: true,
    can_manage_families: true,
    can_manage_guardians: true,
    can_manage_bus_groups: true,
    can_manage_substitutes: true,
    can_view_pto_calendar: true,
    can_review_pto: true,
    can_approve_pto: true,
    can_adjust_pto: true,
    can_generate_pto_reports: true,
    can_view_carline: true,
    can_bulk_upload: true
  }
};

/* ===============================
   ENTRY POINT
================================ */
export async function initAccessSection(profile) {
  currentProfile = profile;

  if (!currentProfile.can_manage_access && !currentProfile.is_superadmin) {
    alert('You are not authorized to manage user access.');
    return;
  }

  if (!initialized) {
    wireAccessEvents();
    initialized = true;
  }

  await loadAccessUserOptions();
  await loadPendingUsers();
}

/* ===============================
   LOAD USERS
================================ */
async function loadAccessUserOptions() {
  const select = document.getElementById('accessUserSelect');
  if (!select) return;

  select.innerHTML = '<option value="">Select staff member…</option>';

  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, display_name, email')
    .eq('school_id', currentProfile.school_id)
    .order('display_name');

  if (error) {
    console.error('Failed to load access users', error);
    return;
  }

  data.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.user_id;
    opt.textContent = `${p.display_name ?? '—'} — ${p.email}`;
    select.appendChild(opt);
  });
}

/* ===============================
   LOAD PROFILE
================================ */
async function loadAccessProfile(userId) {
  if (!userId) return;

  const { data: p, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error) {
    console.error('Failed to load access profile', error);
    return;
  }

  document.getElementById('accessUserMeta').innerHTML = `
    <strong>${p.display_name ?? '—'}</strong><br>${p.email}
  `;

  document
    .querySelectorAll('#accessPermissions input[type="checkbox"]')
    .forEach(cb => {
      const field = cb.dataset.field;
      cb.checked = p[field] === true;
      cb.disabled =
        p.is_superadmin ||
        (p.user_id === currentProfile.user_id &&
          field === 'can_manage_access');

      cb.dataset.user = p.user_id;
    });

  const statusSelect = document.getElementById('accessStatusSelect');
  statusSelect.value = p.status;
  statusSelect.dataset.user = p.user_id;

  document.getElementById('accountStatusPanel').style.display = 'block';
  document.getElementById('accessPermissions').style.display = 'block';
}

/* ===============================
   PERMISSIONS
================================ */
async function toggleAccessPermission(cb) {
  const userId = cb.dataset.user;
  const field = cb.dataset.field;

  // self‑lockout protection
  if (
    field === 'can_manage_access' &&
    userId === currentProfile.user_id &&
    cb.checked === false
  ) {
    alert('You cannot remove your own access.');
    cb.checked = true;
    return;
  }

  const { error } = await supabase
    .from('profiles')
    .update({ [field]: cb.checked })
    .eq('user_id', userId);

  if (error) {
    console.error('Permission update failed', error);
    cb.checked = !cb.checked;
  }
}

/* ===============================
   STATUS
================================ */
async function changeAccountStatus(select) {
  const userId = select.dataset.user;
  const status = select.value;

  if (!confirm(`Set user to "${status.toUpperCase()}"?`)) {
    return;
  }

  const { error } = await supabase
    .from('profiles')
    .update({ status })
    .eq('user_id', userId);

  if (error) {
    alert('Failed to update user status.');
    console.error(error);
  }
}

/* ===============================
   PRESETS
================================ */
async function applyRolePreset(presetKey) {
  const userId = document.getElementById('accessUserSelect').value;
  if (!userId) {
    alert('Select a user first.');
    return;
  }

  const preset = ACCESS_ROLE_PRESETS[presetKey];
  if (!preset) return;

  if (
    userId === currentProfile.user_id &&
    preset.can_manage_access === false
  ) {
    alert('You cannot remove your own access.');
    return;
  }

  if (!confirm(`Apply "${presetKey}" preset?`)) return;

  const { error } = await supabase
    .from('profiles')
    .update(preset)
    .eq('user_id', userId);

  if (error) {
    alert('Failed to apply role preset.');
    console.error(error);
    return;
  }

  await loadAccessProfile(userId);
}

/* ===============================
   PENDING USERS
================================ */

async function loadPendingUsers() {
  const tbody = document.getElementById('pendingUsersTable');
  if (!tbody) return;

  tbody.innerHTML = '';

  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, display_name, email')
    .eq('status', 'pending')
    .eq('school_id', currentProfile.school_id) // ✅ REQUIRED
    .order('email');

  if (error || !data.length) {
    tbody.innerHTML =
      '<tr><td colspan="3" class="muted">No pending users</td></tr>';
    return;
  }

  data.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.display_name ?? '—'}</td>
      <td>${p.email}</td>
      <td><button class="btn btn-primary">Activate</button></td>
    `;
    tr.querySelector('button').onclick = async () => {
      await supabase
        .from('profiles')
        .update({ status: 'active', can_login: true })
        .eq('user_id', p.user_id);

      loadPendingUsers();
    };
    tbody.appendChild(tr);
  });
}


/* ===============================
   EVENTS
================================ */
function wireAccessEvents() {
  document
    .getElementById('accessUserSelect')
    .addEventListener('change', e =>
      loadAccessProfile(e.target.value)
    );

  document
    .getElementById('accessPreset')
    .addEventListener('change', e => {
      applyRolePreset(e.target.value);
      e.target.value = '';
    });

  document
    .querySelectorAll('#accessPermissions input[type="checkbox"]')
    .forEach(cb =>
      cb.addEventListener('change', () =>
        toggleAccessPermission(cb)
      )
    );

  document
    .getElementById('accessStatusSelect')
    .addEventListener('change', e =>
      changeAccountStatus(e.target)
    );
}
