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
  await loadDashboardStats(section);
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



async function loadDashboardStats(dashboardSection) {
  const statStudents   = dashboardSection.querySelector('#statStudents');
  const statStaff      = dashboardSection.querySelector('#statStaff');
  const statFamilies   = dashboardSection.querySelector('#statFamilies');
  const statBusGroups  = dashboardSection.querySelector('#statBusGroups');

  // Defensive guard (never crashes again)
  if (!statStudents) return;

  const schoolId = currentProfile.school_id;

  const [
    students,
    staff,
    families,
    buses
  ] = await Promise.all([
    supabase.from('students').select('id', { count: 'exact', head: true }).eq('school_id', schoolId),
    supabase.from('employees').select('id', { count: 'exact', head: true }).eq('school_id', schoolId),
    supabase.from('families').select('id', { count: 'exact', head: true }).eq('school_id', schoolId),
    supabase.from('bus_groups').select('id', { count: 'exact', head: true }).eq('school_id', schoolId)
  ]);

  statStudents.textContent  = students.count ?? 0;
  statStaff.textContent     = staff.count ?? 0;
  statFamilies.textContent  = families.count ?? 0;
  statBusGroups.textContent = buses.count ?? 0;
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
