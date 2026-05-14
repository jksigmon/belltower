import { supabase } from './admin.supabase.js';
import { initUserMenu } from './user-menu.js';

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
  initUserMenu(profile.display_name ?? profile.email);

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

  // Load access request badge count for admins
  if (currentProfile.can_manage_access || currentProfile.is_superadmin) {
    const { count } = await supabase
      .from('access_requests')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', currentProfile.school_id)
      .eq('status', 'pending');
    const badge = document.getElementById('accessRequestBadge');
    if (badge && count > 0) badge.textContent = String(count);
  }

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

if (target === '#carpools') {
  const carpools = await import('./admin.carpools.js');
  await carpools.initCarpoolsSection(currentProfile);
}

if (target === '#access') {
  const access = await import('./admin.access.js');
  await access.initAccessSection(currentProfile, currentModules);
  const accessReqs = await import('./admin.access-requests.js');
  await accessReqs.initAccessRequests(currentProfile);
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
  const in7  = new Date(); in7.setDate(in7.getDate() + 7);
  const in7Str  = in7.toISOString().slice(0, 10);
  const in30 = new Date(); in30.setDate(in30.getDate() + 30);
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
    // Named alert queries
    queries.alertCancels = supabase.from('pto_requests')
      .select('id, status, employees(first_name, last_name)')
      .eq('school_id', schoolId).in('status', ['CANCEL_REQUESTED', 'RESCIND_REQUESTED']).limit(8);
    queries.alertStaffOut = supabase.from('pto_requests')
      .select('id, pto_type, employees(first_name, last_name)')
      .eq('school_id', schoolId).eq('status', 'APPROVED')
      .lte('start_date', today).gte('end_date', today).limit(8);
  }

  if (moduleEnabled('substitutes') && p.can_manage_substitutes) {
    queries.subUnassigned = supabase.from('v_pending_coverage_days').select('pto_request_id', { count: 'exact', head: true })
      .eq('school_id', schoolId);
    queries.subToday = supabase.from('substitute_assignments').select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).eq('status', 'scheduled').eq('start_date', today);
    // Named alert queries
    queries.alertCoverage = supabase.from('v_pending_coverage_days')
      .select('out_first_name, out_last_name, coverage_date, pto_type')
      .eq('school_id', schoolId).order('coverage_date', { ascending: true }).limit(8);
  }

  if (moduleEnabled('licensure') && p.can_manage_licensure) {
    queries.licExpiring = supabase.from('staff_licenses').select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).eq('alert_muted', false)
      .lte('expiration_date', in30Str).gte('expiration_date', today).neq('status', 'revoked');
    // Named alert queries — split into critical (≤7d) and warning (8–30d)
    queries.alertLicCritical = supabase.from('staff_licenses')
      .select('id, license_type, expiration_date, employees(first_name, last_name)')
      .eq('school_id', schoolId).eq('alert_muted', false)
      .lte('expiration_date', in7Str).gte('expiration_date', today)
      .neq('status', 'revoked').order('expiration_date').limit(8);
    queries.alertLicWarning = supabase.from('staff_licenses')
      .select('id, license_type, expiration_date, employees(first_name, last_name)')
      .eq('school_id', schoolId).eq('alert_muted', false)
      .gt('expiration_date', in7Str).lte('expiration_date', in30Str)
      .neq('status', 'revoked').order('expiration_date').limit(8);
  }

  if (moduleEnabled('carline') && (p.can_view_carline || p.is_superadmin)) {
    queries.carline = supabase.from('carline_events')
      .select('id, status, closed_at, carline_calls(status)')
      .eq('school_id', schoolId).eq('event_date', today).maybeSingle();
  }

  if (p.can_manage_access || p.is_superadmin) {
    queries.accessRequests = supabase.from('access_requests')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId)
      .eq('status', 'pending');
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
    const event = r.carline.data;
    if (event) {
      const calls      = event.carline_calls ?? [];
      const dismissed  = calls.filter(c => c.status === 'CALLED' || c.status === 'LOADED').length;
      const issues     = calls.filter(c => c.status === 'RECALLED').length;
      const isOpen     = event.status === 'OPEN';

      const statusEl    = document.getElementById('statCarlineStatus');
      const timeEl      = document.getElementById('statCarlineTime');
      const dismissedEl = document.getElementById('statCarlineDismissed');
      const issuesEl    = document.getElementById('statCarlineIssues');
      const cardEl      = document.getElementById('dashCarline');

      if (statusEl) {
        statusEl.textContent = isOpen ? 'Open' : 'Closed';
        statusEl.style.color = isOpen ? '#16a34a' : '#64748b';
      }
      if (timeEl) {
        if (isOpen) {
          timeEl.textContent = 'In progress';
        } else if (event.closed_at) {
          const t = new Date(event.closed_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          timeEl.textContent = `Closed at ${t}`;
        }
      }
      if (dismissedEl) {
        dismissedEl.textContent = `${dismissed} student${dismissed !== 1 ? 's' : ''} dismissed`;
      }
      if (issuesEl) {
        issuesEl.textContent = issues > 0 ? `${issues} issue${issues !== 1 ? 's' : ''}` : '0 issues';
        issuesEl.style.color = issues > 0 ? '#dc2626' : '';
      }
      if (cardEl) {
        cardEl.className = 'stat' + (issues > 0 && !isOpen ? ' stat-warn' : '');
      }

      show('dashCarline');
      show('dashStatus');
    }
  }

  if (r.noFamily !== undefined) {
    set('statNoFamily',     r.noFamily.count ?? 0);     show('dashNoFamily');
    set('statNoSupervisor', r.noSupervisor.count ?? 0); show('dashNoSupervisor');
    show('dashHealth');
  }

  // ── Today's Alerts panel ──────────────────────────────────────────
  const canSeeAlerts = p.is_superadmin || p.can_approve_pto || p.can_manage_substitutes || p.can_manage_licensure || p.can_manage_access;
  if (canSeeAlerts) {
    const fmtDate = d => {
      if (d === today) return 'today';
      const dt = new Date(d + 'T00:00:00');
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };
    const daysUntil = d => Math.round((new Date(d + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
    const fullName = e => e ? `${e.first_name} ${e.last_name}` : 'Unknown';

    const alerts = [];

    // 🔴 Coverage gaps (most critical — named, upcoming)
    (r.alertCoverage?.data ?? []).forEach(row => {
      alerts.push({
        level: 'red',
        text: `${row.out_first_name} ${row.out_last_name} is out ${fmtDate(row.coverage_date)} — no substitute assigned`,
        href: '/app/substitutes.html'
      });
    });

    // 🔴 Licenses expiring within 7 days
    (r.alertLicCritical?.data ?? []).forEach(lic => {
      const d = daysUntil(lic.expiration_date);
      const when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
      alerts.push({
        level: 'red',
        text: `${fullName(lic.employees)}'s ${lic.license_type} license expires ${when}`,
        href: '/app/licensure.html'
      });
    });

    // 🟡 Pending access requests
    if ((r.accessRequests?.count ?? 0) > 0) {
      const n = r.accessRequests.count;
      alerts.push({
        level: 'amber',
        text: `${n} access request${n === 1 ? '' : 's'} pending review`,
        href: '/admin.html#access'
      });
    }

    // 🟡 PTO cancellation / rescission requests
    (r.alertCancels?.data ?? []).forEach(req => {
      const action = req.status === 'RESCIND_REQUESTED' ? 'rescind' : 'cancel';
      alerts.push({
        level: 'amber',
        text: `${fullName(req.employees)} has requested to ${action} approved PTO`,
        href: '/app/pto.html'
      });
    });

    // 🟡 Pending PTO count
    if ((r.ptoPending?.count ?? 0) > 0) {
      const n = r.ptoPending.count;
      alerts.push({
        level: 'amber',
        text: `${n} PTO request${n === 1 ? '' : 's'} awaiting approval`,
        href: '/app/pto.html'
      });
    }

    // 🟡 Licenses expiring in 8–30 days
    (r.alertLicWarning?.data ?? []).forEach(lic => {
      const d = daysUntil(lic.expiration_date);
      alerts.push({
        level: 'amber',
        text: `${fullName(lic.employees)}'s ${lic.license_type} license expires in ${d} days`,
        href: '/app/licensure.html'
      });
    });

    // 🔵 Staff out today (informational)
    (r.alertStaffOut?.data ?? []).forEach(req => {
      alerts.push({
        level: 'blue',
        text: `${fullName(req.employees)} is out today — ${req.pto_type}`,
        href: '/app/pto.html'
      });
    });

    const list = document.getElementById('dashAlertsList');
    const allClear = document.getElementById('dashAlertsAllClear');
    if (alerts.length === 0) {
      allClear.style.display = '';
    } else {
      list.innerHTML = alerts.map(a =>
        `<div class="dash-alert-item">` +
        `<span class="dash-alert-dot dash-alert-dot--${a.level}"></span>` +
        `<span class="dash-alert-text">${a.text}</span>` +
        `<a href="${a.href}" class="dash-alert-link">View →</a>` +
        `</div>`
      ).join('');
    }
    show('dashAlertsSection');
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
