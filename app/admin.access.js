// admin.access.js
import { supabase } from './admin.supabase.js';
import { esc, getAvatarColor, dbError, debounce } from './admin.shared.js';

let currentProfile;
let currentModules = {};
let initialized = false;

let currentAccessView = 'person';
let gridProfiles      = [];
let gridSearchTerm    = '';
let gridSelectedField = '';
let gridLoaded        = false;
let auditLoaded       = false;

/* ===============================
   ROLE PRESETS
================================ */
const ACCESS_ROLE_PRESETS = {
  teacher: {
    can_login: true,
    can_access_admin: false,
    can_manage_access: false,
    can_manage_campuses: false,
    can_manage_calendar: false,
    can_manage_resource_docs: false,
    can_manage_reservations: false,
    can_manage_inventory: false,
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
    can_manage_pto_balances: false,
    can_generate_pto_reports: false,
    can_view_carline: false,
    can_bulk_upload: false,
    can_export_data: false,
    can_manage_licensure: false,
    can_manage_compliance: false,
    can_manage_requests: false
  },
  office: {
    can_login: true,
    can_access_admin: true,
    can_manage_access: false,
    can_manage_campuses: false,
    can_manage_calendar: false,
    can_manage_resource_docs: false,
    can_manage_reservations: false,
    can_manage_inventory: false,
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
    can_manage_pto_balances: false,
    can_generate_pto_reports: false,
    can_view_carline: true,
    can_bulk_upload: false,
    can_export_data: true,
    can_manage_licensure: false,
    can_manage_compliance: false,
    can_manage_requests: false
  },
  admin: {
    can_login: true,
    can_access_admin: true,
    can_manage_access: true,
    can_manage_campuses: true,
    can_manage_calendar: true,
    can_manage_resource_docs: true,
    can_manage_reservations: true,
    can_manage_inventory: true,
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
    can_manage_pto_balances: true,
    can_generate_pto_reports: true,
    can_view_carline: true,
    can_bulk_upload: true,
    can_export_data: true,
    can_manage_licensure: true,
    can_manage_compliance: true,
    can_manage_requests: true
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
  await loadUnlinkedAccounts();

  // Match the always-fresh behavior above for whichever view is currently
  // showing, in case permissions changed elsewhere since last visit.
  if (currentAccessView === 'grid') { gridLoaded = false; await loadAccessGrid(); }
  if (currentAccessView === 'audit') { auditLoaded = false; await loadAuditLog(); }
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
    .select(`
      id, user_id, school_id, employee_id,
      display_name, email, status, is_superadmin,
      can_login, can_access_admin, can_manage_access,
      can_view_pto_calendar, can_review_pto, can_approve_pto, can_submit_on_behalf,
      is_fallback_approver, can_adjust_pto, can_manage_pto_balances, can_generate_pto_reports,
      can_view_carline, can_manage_carline,
      can_manage_staff, can_manage_students, can_manage_placement,
      can_manage_families, can_manage_guardians, can_manage_bus_groups,
      can_manage_carpools, can_manage_substitutes, can_manage_campuses,
      can_manage_calendar, can_manage_resource_docs, can_manage_reservations, can_manage_inventory,
      can_bulk_upload, can_export_data, can_manage_licensure, can_manage_compliance, can_manage_field_trips,
      can_manage_requests
    `)
    .eq('id', profileId)
    .single();

  if (error) {
    console.error('Failed to load access profile', error);
    return;
  }

  const name = p.display_name ?? '—';
  const initials = name.split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const avatarBg = getAvatarColor(name);
  document.getElementById('accessUserMeta').innerHTML = `
    <div class="access-user-card">
      <div class="access-user-avatar" style="background:${avatarBg}">${esc(initials)}</div>
      <div>
        <div class="access-user-name">${esc(name)}</div>
        <div class="access-user-email">${esc(p.email)}</div>
      </div>
    </div>
  `;

  if (!p.user_id) {
    document.getElementById('accessUserMeta').innerHTML += `
      <p style="margin-top:10px;margin-bottom:0;color:#f59e0b;font-size:13px;">
        This person has not signed in yet. Permissions can be assigned after their first login.
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
    .eq('user_id', userId)
    .eq('school_id', currentProfile.school_id);

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
  const container = document.getElementById('pendingUsersTable');
  if (!container) return;

  container.innerHTML = '';

  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, display_name, email')
    .eq('status', 'pending')
    .eq('school_id', currentProfile.school_id)
    .order('email');

  if (error || !data.length) {
    container.innerHTML = '<p class="muted">No pending users</p>';
    return;
  }

  data.forEach(p => {
    const card = document.createElement('div');
    card.className = 'access-req-card';
    card.innerHTML = `
      <div class="access-req-card-main">
        <div class="access-req-name">${esc(p.display_name ?? '—')}</div>
        <div class="access-req-email">${esc(p.email)}</div>
      </div>
      <div class="access-req-actions">
        <button class="btn btn-sm btn-primary">Activate</button>
      </div>
    `;

    card.querySelector('button').onclick = async () => {
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

    container.appendChild(card);
  });
}


/* ===============================
   UNLINKED ACCOUNTS
   Active profiles with no employee_id. Includes people who already
   signed in and hit the dead end in staff.html (user_id set), plus
   preloaded profiles that will hit it the moment they first log in
   (user_id still null) — both are fixed the same way.
================================ */

async function loadUnlinkedAccounts() {
  const container = document.getElementById('unlinkedAccountsTable');
  if (!container) return;

  container.innerHTML = '';

  const { data, error } = await supabase
    .from('profiles')
    .select('id, user_id, display_name, email')
    .eq('status', 'active')
    .eq('school_id', currentProfile.school_id)
    .eq('can_login', true)
    .is('employee_id', null)
    .order('email');

  if (error || !data.length) {
    container.innerHTML = '<p class="muted">No unlinked accounts</p>';
    return;
  }

  const { data: candidateEmployees } = await supabase
    .from('employees')
    .select('id, first_name, last_name, email')
    .eq('school_id', currentProfile.school_id)
    .is('profile_id', null)
    .order('last_name');

  const emailMatch = p =>
    (candidateEmployees ?? []).find(e => (e.email ?? '').toLowerCase() === (p.email ?? '').toLowerCase());

  const matchCount = data.filter(emailMatch).length;

  const headerHtml = matchCount
    ? `<div class="access-req-card" style="background:#eff6ff;">
         <div class="access-req-card-main">
           <div class="access-req-name">${matchCount} account${matchCount === 1 ? '' : 's'} have a matching employee record by email</div>
           <div class="access-req-email">Auto-link fills in the matches below; review before saving, or link individually.</div>
         </div>
         <div class="access-req-actions">
           <button class="btn btn-sm btn-primary" id="autoLinkUnlinkedBtn">Auto-link all matches</button>
         </div>
       </div>`
    : '';

  container.innerHTML = headerHtml;

  const doLink = async (p, employeeId, employee) => {
    const employeeName = employee
      ? `${employee.first_name ?? ''} ${employee.last_name ?? ''}`.trim()
      : '';

    const { error: linkError } = await supabase
      .from('profiles')
      .update({
        employee_id: employeeId,
        ...(employeeName ? { display_name: employeeName } : {})
      })
      .eq('id', p.id);

    if (linkError) {
      console.error('Failed to link profile to employee:', linkError);
      return false;
    }

    await supabase
      .from('employees')
      .update({ profile_id: p.id })
      .eq('id', employeeId);

    return true;
  };

  data.forEach(p => {
    const card = document.createElement('div');
    card.className = 'access-req-card';

    const match = emailMatch(p);

    const options = (candidateEmployees ?? [])
      .map(e => `<option value="${esc(e.id)}" ${match && e.id === match.id ? 'selected' : ''}>${esc(`${e.first_name ?? ''} ${e.last_name ?? ''}`.trim() || e.email)} — ${esc(e.email ?? '')}</option>`)
      .join('');

    const statusBadge = p.user_id
      ? `<span class="staff-position-badge" style="background:#fee2e2;color:#991b1b;">Already hit the error</span>`
      : `<span class="staff-position-badge" style="background:#fef9c3;color:#854d0e;">Not yet logged in</span>`;

    card.innerHTML = `
      <div class="access-req-card-main">
        <div class="access-req-name">${esc(p.display_name ?? '—')} ${statusBadge}</div>
        <div class="access-req-email">${esc(p.email)}</div>
      </div>
      <div class="access-req-actions" style="gap:8px;">
        <select class="unlinked-employee-select">
          <option value="">Link to existing employee…</option>
          ${options}
        </select>
        <button class="btn btn-sm btn-primary unlinked-link-btn">Link</button>
        <button class="btn btn-sm btn-outline unlinked-dismiss-btn" title="Revoke login — use for former staff no longer at the school">Not an employee</button>
      </div>
    `;

    card.querySelector('.unlinked-link-btn').onclick = async () => {
      const select = card.querySelector('.unlinked-employee-select');
      const employeeId = select.value;

      if (!employeeId) {
        alert('Select an employee to link first.');
        return;
      }

      const employee = (candidateEmployees ?? []).find(e => e.id === employeeId);
      const ok = await doLink(p, employeeId, employee);

      if (!ok) {
        alert('Failed to link account.');
        return;
      }

      await loadUnlinkedAccounts();
    };

    card.querySelector('.unlinked-dismiss-btn').onclick = async () => {
      if (!confirm(`Revoke login for ${p.display_name ?? p.email}? Use this for former staff who are no longer with the school.`)) return;

      const { error: dismissError } = await supabase
        .from('profiles')
        .update({ can_login: false })
        .eq('id', p.id);

      if (dismissError) {
        console.error('Failed to revoke login:', dismissError);
        alert('Failed to update account.');
        return;
      }

      await loadUnlinkedAccounts();
    };

    container.appendChild(card);
  });

  document.getElementById('autoLinkUnlinkedBtn')?.addEventListener('click', async () => {
    if (!confirm(`Auto-link ${matchCount} account${matchCount === 1 ? '' : 's'} by matching email?`)) return;

    for (const p of data) {
      const match = emailMatch(p);
      if (match) await doLink(p, match.id, match);
    }

    await loadUnlinkedAccounts();
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

  document.querySelectorAll('#accessViewToggle .access-view-btn').forEach(btn =>
    btn.addEventListener('click', () => switchAccessView(btn.dataset.view)));

  document.getElementById('accessGridSearch')?.addEventListener('input', debounce(e => {
    gridSearchTerm = e.target.value.trim().toLowerCase();
    renderPermissionGridFiltered();
  }, 200));

  document.getElementById('accessGridPermSelect')?.addEventListener('change', e => {
    gridSelectedField = e.target.value;
    renderPermissionGridFiltered();
  });
}

/* ===============================
   VIEW TOGGLE (By Person / Grid / Change Log)
================================ */
async function switchAccessView(view) {
  currentAccessView = view;

  document.getElementById('accessByPersonView').style.display = view === 'person' ? '' : 'none';
  document.getElementById('accessGridView').style.display     = view === 'grid'   ? '' : 'none';
  document.getElementById('accessAuditLogView').style.display = view === 'audit'  ? '' : 'none';

  document.querySelectorAll('#accessViewToggle .access-view-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.view === view));

  if (view === 'grid' && !gridLoaded) await loadAccessGrid();
  if (view === 'audit' && !auditLoaded) await loadAuditLog();
}

/* ===============================
   PERMISSIONS GRID
   Reads the field/group/module structure straight from the existing
   By Person checkbox markup (rather than duplicating a second hardcoded
   list here) so the grid can never drift out of sync with it.
================================ */
function readPermissionFieldGroups() {
  const groups = [];
  document.querySelectorAll('#accessPermissions > .panel').forEach(panel => {
    const groupLabel = panel.querySelector('h4')?.textContent?.trim() ?? '';
    const fields = [];
    panel.querySelectorAll('input[type="checkbox"][data-field]').forEach(input => {
      const label = input.closest('label');
      const name = label?.querySelector('.perm-name')?.textContent?.trim() ?? input.dataset.field;
      fields.push({ field: input.dataset.field, label: name, module: label?.dataset.module || null });
    });
    if (fields.length) groups.push({ label: groupLabel, fields });
  });
  return groups;
}

function visiblePermissionFieldGroups() {
  const groups = readPermissionFieldGroups();
  if (currentProfile.is_superadmin) return groups;
  return groups
    .map(g => ({ ...g, fields: g.fields.filter(f => !f.module || currentModules[f.module] !== false) }))
    .filter(g => g.fields.length);
}

function populatePermSelect() {
  const select = document.getElementById('accessGridPermSelect');
  if (!select || select.dataset.populated) return;
  select.dataset.populated = '1';

  visiblePermissionFieldGroups().forEach(g => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = g.label;
    g.fields.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.field;
      opt.textContent = f.label;
      optgroup.appendChild(opt);
    });
    select.appendChild(optgroup);
  });
}

async function loadAccessGrid() {
  const wrap = document.getElementById('accessGridTableWrap');
  populatePermSelect();

  const allFields = visiblePermissionFieldGroups().flatMap(g => g.fields).map(f => f.field);

  const { data, error } = await supabase
    .from('profiles')
    .select(`id, user_id, display_name, email, is_superadmin, employees!profiles_employee_id_fkey(position), ${allFields.join(', ')}`)
    .eq('school_id', currentProfile.school_id)
    .order('display_name');

  if (error) {
    dbError(error, 'Failed to load permissions grid');
    if (wrap) wrap.innerHTML = '<p class="muted" style="padding:16px 0;">Failed to load.</p>';
    return;
  }

  gridProfiles = data ?? [];
  gridLoaded = true;
  renderPermissionGridFiltered();
}

function renderPermissionGridFiltered() {
  const wrap = document.getElementById('accessGridTableWrap');
  if (!wrap) return;

  if (!gridSelectedField) {
    wrap.innerHTML = `
      <div class="admin-empty-state">
        <div class="admin-empty-state-icon"><i data-lucide="list-checks"></i></div>
        <p class="admin-empty-state-title">Pick a permission to get started</p>
        <p class="admin-empty-state-desc">Choose one from the dropdown above and every staff member will appear here with a toggle you can flip right in the list.</p>
      </div>`;
    if (window.lucide) lucide.createIcons({ el: wrap });
    return;
  }

  const term = gridSearchTerm;
  const filtered = term
    ? gridProfiles.filter(p =>
        (p.display_name ?? '').toLowerCase().includes(term) ||
        (p.email ?? '').toLowerCase().includes(term))
    : gridProfiles;

  renderPermissionToggleList(filtered);
}

function renderPermissionToggleList(profiles) {
  const wrap = document.getElementById('accessGridTableWrap');
  const field = gridSelectedField;

  if (!profiles.length) {
    wrap.innerHTML = `
      <div class="admin-empty-state">
        <div class="admin-empty-state-icon"><i data-lucide="search-x"></i></div>
        <p class="admin-empty-state-title">No staff match your search</p>
        <p class="admin-empty-state-desc">Try a different name or email.</p>
      </div>`;
    if (window.lucide) lucide.createIcons({ el: wrap });
    return;
  }

  const rows = profiles.map(p => {
    const name = p.display_name || p.email || '—';
    const initials = name.split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const checked  = p[field] === true;
    const lockedForSelf = p.user_id === currentProfile.user_id && field === 'can_manage_access';
    const position = p.employees?.position
      ? `<span class="staff-position-badge">${esc(p.employees.position)}</span>`
      : '';
    const toggle = p.is_superadmin
      ? `<span class="access-always-on-badge" title="Superadmins always have every permission">Always On</span>`
      : `<input type="checkbox" class="access-toggle-switch"
               data-profile="${esc(p.id)}" data-user="${esc(p.user_id)}" data-field="${esc(field)}"
               ${checked ? 'checked' : ''} ${lockedForSelf ? 'disabled' : ''}>`;
    return `
      <div class="access-toggle-row">
        <div class="access-toggle-name">
          <div class="access-user-avatar" style="background:${getAvatarColor(name)}">${esc(initials)}</div>
          <span>${esc(name)}</span>
          ${position}
        </div>
        ${toggle}
      </div>`;
  }).join('');

  wrap.innerHTML = `<div class="access-toggle-list">${rows}</div>`;

  wrap.querySelectorAll('.access-toggle-switch').forEach(cb =>
    cb.addEventListener('change', () => toggleGridPermission(cb)));
}

async function toggleGridPermission(cb) {
  const profileId = cb.dataset.profile;
  const userId    = cb.dataset.user;
  const field     = cb.dataset.field;

  if (field === 'can_manage_access' && userId === currentProfile.user_id && !cb.checked) {
    alert('You cannot remove your own access.');
    cb.checked = true;
    return;
  }

  const { error } = await supabase.from('profiles').update({ [field]: cb.checked }).eq('id', profileId);

  if (error) {
    dbError(error, 'Failed to update permission');
    cb.checked = !cb.checked;
    return;
  }

  const cached = gridProfiles.find(p => p.id === profileId);
  if (cached) cached[field] = cb.checked;
}

/* ===============================
   CHANGE LOG
================================ */
async function loadAuditLog() {
  const wrap = document.getElementById('accessAuditLogWrap');

  const { data, error } = await supabase
    .from('permission_audit_log')
    .select(`
      id, field_name, old_value, new_value, changed_at,
      target:profiles!permission_audit_log_target_profile_id_fkey(display_name, email),
      changer:profiles!permission_audit_log_changed_by_profile_id_fkey(display_name, email)
    `)
    .eq('school_id', currentProfile.school_id)
    .order('changed_at', { ascending: false })
    .limit(200);

  if (error) {
    dbError(error, 'Failed to load change log');
    if (wrap) wrap.innerHTML = '<p class="muted" style="padding:16px 0;">Failed to load.</p>';
    return;
  }

  auditLoaded = true;
  renderAuditLog(data ?? []);
}

function renderAuditLog(entries) {
  const wrap = document.getElementById('accessAuditLogWrap');
  if (!wrap) return;

  if (!entries.length) {
    wrap.innerHTML = '<p class="muted" style="padding:16px 0;">No permission changes recorded yet.</p>';
    return;
  }

  wrap.innerHTML = `
    <table class="admin-table">
      <thead><tr><th>Date</th><th>Changed By</th><th>Staff Member</th><th>Permission</th><th>Change</th></tr></thead>
      <tbody>
        ${entries.map(e => {
          const when = new Date(e.changed_at).toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
          });
          const before = e.old_value === null ? '<span class="muted">—</span>' : (e.old_value ? 'On' : 'Off');
          const after  = e.new_value
            ? '<strong style="color:#15803d;">On</strong>'
            : '<strong style="color:#dc2626;">Off</strong>';
          return `
            <tr>
              <td style="font-size:12px;color:#6b7280;white-space:nowrap;">${esc(when)}</td>
              <td>${esc(e.changer?.display_name ?? 'System')}</td>
              <td>${esc(e.target?.display_name ?? '—')}</td>
              <td style="font-size:12px;"><code>${esc(e.field_name)}</code></td>
              <td>${before} → ${after}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}
