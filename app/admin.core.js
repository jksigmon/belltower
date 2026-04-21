import { supabase } from './admin.supabase.js';

let currentProfile = null;

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

document.getElementById('dashboardUser').textContent =
  currentProfile.display_name ?? currentProfile.email;

document.getElementById('dashboardSchool').textContent =
  profile.schools?.name ?? '';

  // Pending status notice
  const pendingNotice = document.getElementById('pending');
  if (currentProfile.status === 'pending' && pendingNotice) {
    pendingNotice.style.display = 'block';
  }

  // Apply permissions before anything is visible
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
  await access.initAccessSection(currentProfile);
}

if (target === '#bulk-upload') {
  const bulk = await import('./admin.bulk.js');
  await bulk.initBulkSection();
}

}

/* ===============================
   NAV GATING
================================ */
function gateNavigation() {
  document.querySelectorAll('nav a[data-cap]').forEach(link => {
    const cap = link.dataset.cap;
    if (currentProfile.is_superadmin || currentProfile[cap]) {
      link.style.display = 'flex';
    } else {
      link.remove();
    }
  });
  
  
document.querySelectorAll('nav a[data-cap-group="pto"]').forEach(link => {
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
