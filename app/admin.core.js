import { supabase } from './admin.supabase.js';

let currentProfile = null;
let currentModules = {}; // { pto: true, substitutes: false, ... }

/* ===============================
   INIT
================================ */

async function init() {
  const session = await supabase.auth.getSession();

  if (!session?.data?.session?.user) {
    window.location.href = '/login.html';
    return;
  }

  const user = session.data.session.user;

  
const { data: profile, error } = await supabase
  .from('profiles')
  .select(`
    *,
    schools (
      id,
      name
    )
  `)
  .eq('user_id', user.id)
  .single();


  if (error) {
    console.error('Failed to load profile', error);
    return;
  }

  currentProfile = profile;

  // Load school modules before gating nav
  const { data: moduleRows } = await supabase
    .from('school_modules')
    .select('module, enabled')
    .eq('school_id', profile.school_id);

  currentModules = {};
  (moduleRows || []).forEach(r => { currentModules[r.module] = r.enabled; });

document.getElementById('dashboardUser').textContent =
  currentProfile.display_name ?? currentProfile.email;

document.getElementById('dashboardSchool').textContent =
  profile.schools?.name ?? '';

  // Pending status notice
  const pendingNotice = document.getElementById('pending');
  if (currentProfile.status === 'pending' && pendingNotice) {
    pendingNotice.style.display = 'block';
  }

  // Apply permissions + module gates before anything is visible
  gateNavigation();

  // Resolve initial route FIRST
  await setActive(location.hash || '#dashboard');

  // ✅ Reveal nav only once everything is ready
  document.getElementById('adminNav')?.classList.remove('hidden');
}

/* ===============================
   NAV / ROUTING
================================ */
async function setActive(hash) {
  const target = hash || '#dashboard';

  document.querySelectorAll('nav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === target);
  });

  document.querySelectorAll('.admin-section').forEach(s =>
    s.classList.remove('active')
  );

  const section = document.querySelector(target);
  if (!section) return;
  section.classList.add('active');


if (target === '#dashboard') {
  await loadDashboardStats();
}

  
const fade = section.querySelector('.fade-in');
if (fade) {
  requestAnimationFrame(() => {
    fade.classList.add('visible');
  });
}
  /* ✅ Lazy‑load feature modules */

  if (target === '#staff') {
    const staff = await import('./admin.staff.js');
    await staff.initStaffSection(currentProfile);
  }

  if (target === '#students') {
    const students = await import('./admin.students.js');
	console.log('students module:', students);
    await students.initStudentsSection(currentProfile);
  }
  
	if (target === '#families') {
	  const families = await import('./admin.families.js');
	  await families.initFamiliesSection(currentProfile);
	}

if (target === '#guardians') {
  const guardians = await import('./admin.guardians.js');
  await guardians.initGuardiansSection(currentProfile);
}

if (target === '#bus') {
  const busGroups = await import('./admin.busgroups.js');
  await busGroups.initBusGroupsSection(currentProfile);
}

if (target === '#access') {
  const access = await import('./admin.access.js');
  await access.initAccessSection(currentProfile, currentModules);
}

if (target === '#bulk-upload') {
  const bulk = await import('./admin.bulk.js');
  await bulk.initBulkSection();
}

if (target === '#exports') {
  const exportsModule = await import('./admin.exports.js');
  await exportsModule.initExportsSection(currentProfile);
}

if (target === '#campuses') {
  const cam = await import('./admin.campuses.js');
  await cam.initCampusesSection(currentProfile);
}

}

/* ===============================
   NAV GATING
================================ */
function moduleEnabled(mod) {
  // Superadmin bypasses all module gates.
  // If no row exists for the module, default to enabled (safe for legacy schools).
  if (currentProfile.is_superadmin) return true;
  if (!mod) return true;
  return currentModules[mod] !== false;
}

function gateNavigation() {
  // Individual capability-gated links (may also carry data-module)
  document.querySelectorAll('nav a[data-cap]').forEach(link => {
    const cap = link.dataset.cap;
    const mod = link.dataset.module;
    const hasCap = currentProfile.is_superadmin || currentProfile[cap];
    if (hasCap && moduleEnabled(mod)) {
      link.style.display = 'flex';
    } else {
      link.remove();
    }
  });

  // PTO grouped module
  document.querySelectorAll('nav a[data-cap-group="pto"]').forEach(link => {
    if (!moduleEnabled('pto')) { link.remove(); return; }
    if (
      currentProfile.is_superadmin ||
      currentProfile.can_view_pto_calendar ||
      currentProfile.can_review_pto ||
      currentProfile.can_approve_pto ||
      currentProfile.can_generate_pto_reports
    ) {
      link.style.display = 'flex';
    } else {
      link.remove();
    }
  });

  // Substitutes grouped module
  document.querySelectorAll('nav a[data-cap-group="substitutes"]').forEach(link => {
    if (!moduleEnabled('substitutes')) { link.remove(); return; }
    if (currentProfile.is_superadmin || currentProfile.can_manage_substitutes === true) {
      link.style.display = 'flex';
    } else {
      link.remove();
    }
  });

  // Carline grouped module
  document.querySelectorAll('nav a[data-cap-group="carline"]').forEach(link => {
    if (!moduleEnabled('carline')) { link.remove(); return; }
    if (currentProfile.is_superadmin || currentProfile.can_view_carline === true) {
      link.style.display = 'flex';
    } else {
      link.remove();
    }
  });
}



async function loadDashboardStats() {
  const schoolId = currentProfile.school_id;
  const today    = new Date().toISOString().slice(0, 10);
  const p        = currentProfile;

  const dateEl = document.getElementById('dashBannerDate');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
  }

  const set  = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const show = id => { const el = document.getElementById(id); if (el) el.style.display = ''; };

  // ── Build all queries synchronously based on capabilities ─────────
  const in30 = new Date();
  in30.setDate(in30.getDate() + 30);
  const in30Str = in30.toISOString().slice(0, 10);

  const queries = {
    students:      supabase.from('students').select('id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('active', true),
    activeStaff:   supabase.from('employees').select('id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('active', true),
    inactiveStaff: supabase.from('employees').select('id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('active', false),
    families:      supabase.from('families').select('id', { count: 'exact', head: true }).eq('school_id', schoolId),
    buses:         supabase.from('bus_groups').select('id', { count: 'exact', head: true }).eq('school_id', schoolId),
  };

  if (moduleEnabled('pto') && p.can_approve_pto) {
    queries.ptoPending = supabase.from('pto_requests').select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).eq('status', 'PENDING');
    queries.ptoCancels = supabase.from('pto_requests').select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).in('status', ['CANCEL_REQUESTED', 'RESCIND_REQUESTED']);
    queries.staffOut = supabase.from('pto_requests').select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).eq('status', 'APPROVED').lte('start_date', today).gte('end_date', today);
  }

  if (moduleEnabled('substitutes') && p.can_manage_substitutes) {
    queries.subUnassigned = supabase.from('v_pending_coverage_days').select('pto_request_id', { count: 'exact', head: true })
      .eq('school_id', schoolId);
    queries.subToday = supabase.from('substitute_assignments').select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).eq('status', 'scheduled').eq('start_date', today);
  }

  if (moduleEnabled('licensure') && p.can_manage_licensure) {
    queries.licExpiring = supabase.from('staff_licenses').select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).eq('alert_muted', false)
      .lte('expiration_date', in30Str).gte('expiration_date', today).neq('status', 'revoked');
  }

  if (moduleEnabled('carline') && (p.can_view_carline || p.is_superadmin)) {
    queries.carline = supabase.from('carline_events').select('status')
      .eq('school_id', schoolId).eq('event_date', today).neq('status', 'CLOSED').maybeSingle();
  }

  const canSeeHealth = p.is_superadmin || p.can_access_admin || p.can_manage_access;
  if (canSeeHealth) {
    queries.noFamily     = supabase.from('students').select('id', { count: 'exact', head: true }).eq('school_id', schoolId).is('family_id', null);
    queries.noSupervisor = supabase.from('employees').select('id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('active', true).is('supervisor_id', null);
  }

  // ── Fire everything in parallel ───────────────────────────────────
  const keys    = Object.keys(queries);
  const results = await Promise.all(keys.map(k => queries[k]));
  const r       = Object.fromEntries(keys.map((k, i) => [k, results[i]]));

  // ── Apply all DOM updates synchronously ───────────────────────────

  set('statStudents',  r.students.count ?? 0);
  set('statStaff',     r.activeStaff.count ?? 0);
  set('statStaffLabel', `Staff${(r.inactiveStaff.count ?? 0) > 0 ? ` (${r.inactiveStaff.count} inactive)` : ''}`);
  set('statFamilies',  r.families.count ?? 0);
  set('statBusGroups', r.buses.count ?? 0);

  const totalStaff = (r.activeStaff.count ?? 0) + (r.inactiveStaff.count ?? 0);
  if (totalStaff > 0) {
    set('statActiveStaff', r.activeStaff.count ?? 0);
    set('statActiveStaffSub', `${r.inactiveStaff.count ?? 0} inactive`);
    const subEl = document.getElementById('statActiveStaffSub');
    if (subEl) subEl.className = 'stat-sub';
    show('dashActiveStaff');
    show('dashStatus');
  }

  const isAdmin = p.is_superadmin || p.can_access_admin || p.can_manage_access;
  const row = document.getElementById('dashActionsRow');
  const actions = [];
  if (isAdmin) actions.push({ label: 'Add Student', icon: 'user-plus', href: '#students', variant: 'primary' });
  if (isAdmin) actions.push({ label: 'Add Staff',   icon: 'user-plus', href: '#staff',    variant: 'primary' });
  if (moduleEnabled('pto') && (p.can_approve_pto || p.can_view_pto_calendar)) actions.push({ label: 'PTO', icon: 'calendar', href: '/app/pto.html', variant: 'secondary' });
  if (moduleEnabled('substitutes') && p.can_manage_substitutes) actions.push({ label: 'Substitutes', icon: 'repeat-2', href: '/app/substitutes.html', variant: 'secondary' });
  if (moduleEnabled('carline') && p.can_view_carline) actions.push({ label: 'Carline', icon: 'car', href: '/app/carline-input.html', variant: 'secondary' });
  if (row && actions.length) {
    row.innerHTML = '';
    actions.forEach(({ label, icon, href, variant }) => {
      const a = document.createElement('a');
      a.className = `dash-action-btn dash-action-btn--${variant}`;
      a.innerHTML = `<i data-lucide="${icon}"></i>${label}`;
      a.href = href;
      if (!href.startsWith('#')) a.target = '_blank';
      row.appendChild(a);
    });
    if (window.lucide) lucide.createIcons({ el: row });
    show('dashQuickActions');
  }

  if (r.ptoPending !== undefined) {
    set('statPtoPending', r.ptoPending.count ?? 0);  show('dashPtoPending');
    set('statPtoCancels', r.ptoCancels.count ?? 0);  show('dashPtoCancels');
    set('statStaffOut',   r.staffOut.count ?? 0);    show('dashStaffOut');
    show('dashAttention');
  }

  if (r.subUnassigned !== undefined) {
    set('statSubUnassigned', r.subUnassigned.count ?? 0);  show('dashSubUnassigned');
    set('statSubToday',      r.subToday.count ?? 0);       show('dashSubToday');
    show('dashAttention');
  }

  if (r.licExpiring !== undefined) {
    set('statLicExpiring', r.licExpiring.count ?? 0);
    show('dashLicExpiring');
    show('dashAttention');
  }

  if (r.carline !== undefined) {
    const statusEl = document.getElementById('statCarlineStatus');
    if (statusEl) {
      if (r.carline.data?.status === 'OPEN') {
        statusEl.textContent = 'OPEN';
        statusEl.style.color = '#16a34a';
      } else {
        statusEl.textContent = 'CLOSED';
        statusEl.style.color = '#64748b';
      }
    }
    show('dashCarline');
    show('dashStatus');
  }

  if (r.noFamily !== undefined) {
    set('statNoFamily',     r.noFamily.count ?? 0);     show('dashNoFamily');
    set('statNoSupervisor', r.noSupervisor.count ?? 0); show('dashNoSupervisor');
    show('dashHealth');
  }

  // ── Reveal everything at once ─────────────────────────────────────
  const dashGrid = document.getElementById('dashGrid');
  if (dashGrid) {
    requestAnimationFrame(() => { dashGrid.style.opacity = '1'; });
  }
}

/* ===============================
   EVENTS
================================ */
window.addEventListener('hashchange', () =>
  setActive(location.hash)
);

document.querySelectorAll('nav a').forEach(link => {
  link.addEventListener('click', e => {
    const href = link.getAttribute('href');
    if (!href.startsWith('#')) return;
    e.preventDefault();
    history.pushState(null, '', href);
    setActive(href);
  });
});


document
  .getElementById('signOut')
  ?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = '/login.html';
  });


/* ===============================
   BOOT
================================ */
init();
