// admin.access.js
import { supabase } from './admin.supabase.js';

let currentProfile;
let currentModules = {};
let initialized = false;

/* ===============================
   ROLE PRESETS
================================ */
const ACCESS_ROLE_PRESETS = {
  teacher: {
    can_login: true,
    can_access_admin: false,
    can_manage_access: false,
    can_manage_campuses: false,
    can_manage_staff: false,
    can_manage_students: false,
    can_manage_placement: false,
    can_manage_families: false,
    can_manage_guardians: false,
    can_manage_bus_groups: false,
    can_manage_carpools: false,
    can_manage_substitutes: false,
    can_view_pto_calendar: false,
    can_review_pto: false,
    can_approve_pto: false,
    can_adjust_pto: false,
    can_generate_pto_reports: false,
    can_view_carline: false,
    can_bulk_upload: false,
    can_export_data: false,
    can_manage_licensure: false
  },
  office: {
    can_login: true,
    can_access_admin: true,
    can_manage_access: false,
    can_manage_campuses: false,
    can_manage_students: true,
    can_manage_placement: false,
    can_manage_families: true,
    can_manage_guardians: true,
    can_manage_bus_groups: true,
    can_manage_carpools: false,
    can_manage_substitutes: true,
    can_view_pto_calendar: true,
    can_review_pto: false,
    can_approve_pto: false,
    can_adjust_pto: false,
    can_generate_pto_reports: false,
    can_view_carline: true,
    can_bulk_upload: false,
    can_export_data: true,
    can_manage_licensure: false
  },
  admin: {
    can_login: true,
    can_access_admin: true,
    can_manage_access: true,
    can_manage_campuses: true,
    can_manage_staff: true,
    can_manage_students: true,
    can_manage_placement: true,
    can_manage_families: true,
    can_manage_guardians: true,
    can_manage_bus_groups: true,
    can_manage_carpools: true,
    can_manage_substitutes: true,
    can_view_pto_calendar: true,
    can_review_pto: true,
    can_approve_pto: true,
    can_adjust_pto: true,
    can_generate_pto_reports: true,
    can_view_carline: true,
    can_bulk_upload: true,
    can_export_data: true,
    can_manage_licensure: true
  }
};

/* ===============================
   ENTRY POINT
================================ */
export async function initAccessSection(profile, modules = {}) {
  currentProfile = profile;
  currentModules = modules;

  if (!currentProfile.can_manage_access && !currentProfile.is_superadmin) {
    alert('You are not authorized to manage user access.');
    return;
  }

  if (!initialized) {
    applyModuleGating();
    wireAccessEvents();
    initialized = true;
  }

  await loadAccessUserOptions();
  await loadPendingUsers();
}

function applyModuleGating() {
  // Hide the entire PTO panel or individual operation labels when the module is disabled.
  // Superadmin always sees everything.
  if (currentProfile.is_superadmin) return;

  document.querySelectorAll('#accessPermissions [data-module]').forEach(el => {
    const mod = el.dataset.module;
    // If the module row is absent (undefined) we default to visible.
    if (currentModules[mod] === false) {
      el.style.display = 'none';
    }
  });
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
    .select('id, user_id, display_name, email')
    .eq('school_id', currentProfile.school_id)
    .order('display_name');

  if (error) {
    console.error('Failed to load access users', error);
    return;
  }

  data.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.display_name ?? '—'} — ${p.email}`;
    select.appendChild(opt);
  });
}

/* ===============================
   LOAD PROFILE
================================ */
async function loadAccessProfile(profileId) {
  if (!profileId) return;

  document.getElementById('accountStatusPanel').style.display = 'none';
  document.getElementById('accessPermissions').style.display = 'none';
  document.getElementById('accessUserMeta').innerHTML = '';

  const { data: p, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', profileId)
    .single();

  if (error) {
    console.error('Failed to load access profile', error);
    return;
  }

  document.getElementById('accessUserMeta').innerHTML = `
    <strong>${p.display_name ?? '—'}</strong><br>${p.email}
  `;

  if (!p.user_id) {
    document.getElementById('accessUserMeta').innerHTML += `
      <p style="margin-top:0.5rem;color:#f59e0b;">
        This person has a profile but has not signed in yet. Access permissions can be assigned after their first login.
      </p>
    `;
    return;
  }

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
    .eq('school_id', currentProfile.school_id)
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
      try {
        /* ===============================
           1️⃣ Load full profile (need profile.id!)
        ================================ */
        const { data: userProfile, error: profileError } = await supabase
          .from('profiles')
          .select('id, user_id, display_name, email, school_id, employee_id')
          .eq('user_id', p.user_id)
          .single();

        if (profileError || !userProfile) {
          console.error('Failed to load pending profile:', profileError);
          alert('Failed to load user profile.');
          return;
        }

        /* ===============================
           2️⃣ Resolve existing employee
        ================================ */
        let employeeId = userProfile.employee_id;

        // A️⃣ Already linked? ✅
        if (!employeeId) {
          const { data: empByProfile } = await supabase
            .from('employees')
            .select('id')
            .eq('profile_id', userProfile.id)
            .maybeSingle();

          if (empByProfile) {
            employeeId = empByProfile.id;
          }
        }

        // B️⃣ Fallback: match by email (most common)
        if (!employeeId) {
          const { data: empByEmail } = await supabase
            .from('employees')
            .select('id')
            .eq('email', userProfile.email)
            .maybeSingle();

          if (empByEmail) {
            employeeId = empByEmail.id;

            // ✅ Link employee → profile
            await supabase
              .from('employees')
              .update({ profile_id: userProfile.id })
              .eq('id', employeeId);
          }
        }

        /* ===============================
           3️⃣ Create employee ONLY if missing
        ================================ */
        if (!employeeId) {
          const nameParts = (userProfile.display_name || '').trim().split(' ');
          const firstName = nameParts[0] || null;
          const lastName = nameParts.slice(1).join(' ') || null;

          const { data: newEmployee, error: employeeError } = await supabase
            .from('employees')
            .insert({
              profile_id: userProfile.id,
              school_id: userProfile.school_id,
              first_name: firstName,
              last_name: lastName,
              email: userProfile.email,
              position: 'Staff',
              active: true
            })
            .select('id')
            .single();

          if (employeeError || !newEmployee) {
            console.error('Failed to create employee:', employeeError);
            alert('Failed to create employee record.');
            return;
          }

          employeeId = newEmployee.id;
        }

        /* ===============================
           4️⃣ Activate profile
        ================================ */
        const { error: activateError } = await supabase
          .from('profiles')
          .update({
            status: 'active',
            can_login: true,
            employee_id: employeeId
          })
          .eq('id', userProfile.id);

        if (activateError) {
          console.error('Failed to activate user:', activateError);
          alert('Failed to activate user.');
          return;
        }

        // ✅ Refresh pending list
        await loadPendingUsers();

      } catch (err) {
        console.error('Activation failed:', err);
        alert('Unexpected error during activation.');
      }
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
