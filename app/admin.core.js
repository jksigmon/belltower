import { supabase } from './admin.supabase.js';
import { initUserMenu } from './user-menu.js';
import { esc } from './admin.shared.js';
import { loadWeather } from './weather.js';
import { initCalendarStrip } from './calendar-strip.js';

let currentProfile = null;
let currentModules = {}; // { pto: true, substitutes: false, ... }
let effectiveSchoolId = null;

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
  .select('*, schools!profiles_school_id_fkey(id, name, timezone, weather_lat, weather_lon, school_modules(module, enabled))')
  .eq('user_id', user.id)
  .single();

  if (error) {
    console.error('Failed to load profile', error);
    return;
  }

  currentProfile = profile;
  effectiveSchoolId = profile.school_id;

  if (!currentProfile.can_access_admin && !currentProfile.is_superadmin) {
    window.location.href = '/staff.html';
    return;
  }

  initUserMenu(profile.display_name ?? profile.email);

  currentModules = {};
  (profile.schools?.school_modules || []).forEach(r => { currentModules[r.module] = r.enabled; });

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning,' : hour < 17 ? 'Good afternoon,' : 'Good evening,';
  document.getElementById('dashGreeting').textContent = greeting;

  document.getElementById('dashboardUser').textContent =
    currentProfile.display_name ?? currentProfile.email;

  const schoolEl = document.getElementById('dashboardSchool');
  if (schoolEl) {
    const schoolName = profile.schools?.name ?? '';
    schoolEl.innerHTML = `<i data-lucide="building-2"></i>${schoolName}`;
    schoolEl.style.display = schoolName ? '' : 'none';
  }

  const roleEl = document.getElementById('dashboardRole');
  if (roleEl) {
    const roleLabel = profile.is_superadmin ? 'Super Admin'
      : profile.role === 'admin' ? 'Administrator'
      : profile.role === 'front office' ? 'Front Office'
      : 'Staff';
    roleEl.innerHTML = `<i data-lucide="shield-check"></i>${roleLabel}`;
  }

  if (window.lucide) lucide.createIcons({ el: document.querySelector('.dash-banner') });

  const bannerDateEl = document.getElementById('dashBannerDate');
  if (bannerDateEl) {
    const now = new Date();
    const dayName  = now.toLocaleDateString('en-US', { weekday: 'long' });
    const fullDate = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    bannerDateEl.innerHTML = `<span class="dash-banner-date-day">${dayName}</span><span class="dash-banner-date-full">${fullDate}</span>`;
  }

  initCalendarStrip(supabase, effectiveSchoolId, document.getElementById('dashCalChip'));

  loadWeather('dashWeather', profile.schools?.weather_lat, profile.schools?.weather_lon, profile.schools?.timezone);

  if (profile.is_superadmin) await initSchoolSwitcher(profile);

  // Pending status notice
  const pendingNotice = document.getElementById('pending');
  if (currentProfile.status === 'pending' && pendingNotice) {
    pendingNotice.style.display = 'block';
  }

  gateNavigation();
  initNavCollapse();

  // Show nav immediately — badge and dashboard stats fill in below
  document.getElementById('adminNav')?.classList.remove('hidden');

  await setActive(location.hash || '#dashboard');
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

  document.querySelector('.wrap > main')?.scrollTo({ top: 0, behavior: 'instant' });


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
  const routes = {
    '#staff':       () => import('./admin.staff.js').then(m => m.initStaffSection(currentProfile)),
    '#students':    () => import('./admin.students.js').then(m => m.initStudentsSection(currentProfile)),
    '#families':    () => import('./admin.families.js').then(m => m.initFamiliesSection(currentProfile)),
    '#guardians':   () => import('./admin.guardians.js').then(m => m.initGuardiansSection(currentProfile)),
    '#bus':         () => import('./admin.busgroups.js').then(m => m.initBusGroupsSection(currentProfile)),
    '#carpools':    () => import('./admin.carpools.js').then(m => m.initCarpoolsSection(currentProfile)),
    '#access':      () => Promise.all([
      import('./admin.access.js').then(m => m.initAccessSection(currentProfile, currentModules)),
      import('./admin.access-requests.js').then(m => m.initAccessRequests(currentProfile)),
    ]),
    '#bulk-upload': () => import('./admin.bulk.js').then(m => m.initBulkSection()),
    '#exports':     () => import('./admin.exports.js').then(m => m.initExportsSection(currentProfile)),
    '#campuses':    () => import('./admin.campuses.js').then(m => m.initCampusesSection(currentProfile)),
    '#schools':     () => import('./admin.schools.js').then(m => m.initSchoolsSection(currentProfile)),
    '#promotion':        () => import('./admin.promotion.js').then(m => m.initPromotionSection(currentProfile)),
    '#data-collection':  () => import('./admin.data-collection.js').then(m => m.initDataCollectionSection(currentProfile)),
    '#requests':         () => import('./admin.requests.js').then(m => m.initRequestsSection(currentProfile)),
  };

  if (routes[target]) await routes[target]();
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
  // Schools link (superadmin only)
  const schoolsLink = document.getElementById('navSchools');
  if (schoolsLink) {
    if (currentProfile.is_superadmin) schoolsLink.style.display = 'flex';
    else schoolsLink.remove();
  }

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



/* ===============================
   NAV COLLAPSE
================================ */
function initNavCollapse() {
  // Operations = expanded by default; Directory + Settings = collapsed by default
  const defaults = { operations: false, directory: true, settings: true };

  Object.keys(defaults).forEach(group => {
    const btn   = document.querySelector(`.nav-section-toggle[data-group="${group}"]`);
    const panel = document.getElementById(`navGroup-${group}`);
    if (!btn || !panel) return;

    const saved = localStorage.getItem(`nav-collapsed-${group}`);
    const isCollapsed = saved !== null ? saved === 'true' : defaults[group];

    if (isCollapsed) {
      panel.classList.add('collapsed');
      btn.classList.add('collapsed');
    }

    btn.addEventListener('click', () => {
      const nowCollapsed = panel.classList.toggle('collapsed');
      btn.classList.toggle('collapsed', nowCollapsed);
      localStorage.setItem(`nav-collapsed-${group}`, String(nowCollapsed));
    });
  });
}

async function loadDashboardStats() {
  const schoolId = effectiveSchoolId;
  const today    = new Date().toISOString().slice(0, 10);
  const p        = currentProfile;


  const set  = (id, val) => { const el = document.getElementById(id); if (el) { el.textContent = val; el.classList.remove('skeleton', 'stat-skel'); } };
  const show = id => { const el = document.getElementById(id); if (el) el.style.display = ''; };
  const setAlert = (statId, _cardId, count) => {
    const num = document.getElementById(statId);
    if (!num) return;
    num.textContent = count;
    num.classList.remove('skeleton', 'stat-skel');
  };

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
      .select('id, status, employees!pto_requests_employee_id_fkey(first_name, last_name)')
      .eq('school_id', schoolId).in('status', ['CANCEL_REQUESTED', 'RESCIND_REQUESTED']).limit(8);
    queries.alertStaffOut = supabase.from('pto_requests')
      .select('id, pto_type, employees!pto_requests_employee_id_fkey(first_name, last_name, staff_group_id, staff_groups(name, sort_order))')
      .eq('school_id', schoolId).eq('status', 'APPROVED')
      .lte('start_date', today).gte('end_date', today);
  }

  if (moduleEnabled('substitutes') && p.can_manage_substitutes) {
    queries.subUnassigned = supabase.from('v_pending_coverage_days').select('pto_request_id', { count: 'exact', head: true })
      .eq('school_id', schoolId);
    queries.subToday = supabase.from('substitute_assignments').select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).eq('status', 'scheduled').eq('start_date', today);
    queries.subCancellations = supabase.from('v_pending_cancellation_days').select('assignment_id', { count: 'exact', head: true })
      .eq('school_id', schoolId).eq('assignment_status', 'scheduled');
    // Named alert queries
    queries.alertCoverage = supabase.from('v_pending_coverage_days')
      .select('out_first_name, out_last_name, coverage_date, pto_type')
      .eq('school_id', schoolId).order('coverage_date', { ascending: true }).limit(8);
    queries.alertSubCancellations = supabase.from('v_pending_cancellation_days')
      .select('out_first_name, out_last_name, coverage_date')
      .eq('school_id', schoolId).eq('assignment_status', 'scheduled')
      .order('coverage_date', { ascending: true }).limit(8);
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

  if (moduleEnabled('compliance') && p.can_manage_compliance) {
    queries.bgPending = supabase.from('compliance_bg_check_requests').select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).in('status', ['pending', 'submitted']);
    queries.agreementsExpiring = supabase.from('compliance_agreements').select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).is('voided_at', null)
      .lte('expires_at', in30Str).gte('expires_at', today);
  }

  if (moduleEnabled('carline') && (p.can_view_carline || p.is_superadmin)) {
    queries.carline = supabase.from('carline_events')
      .select('id, status, closed_at, carline_calls(status)')
      .eq('school_id', schoolId).eq('event_date', today);
  }

  if (p.can_manage_access || p.is_superadmin) {
    queries.accessRequests = supabase.from('access_requests')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId)
      .eq('status', 'pending');
  }

  if (p.is_superadmin || p.can_manage_students) {
    queries.studentBirthdays = supabase.from('students')
      .select('first_name, last_name, birthdate')
      .eq('school_id', schoolId)
      .eq('active', true)
      .not('birthdate', 'is', null)
      .limit(500);
  }

  queries.staffBirthdays = supabase.from('employees')
    .select('first_name, last_name, birthdate')
    .eq('school_id', schoolId)
    .eq('active', true)
    .not('birthdate', 'is', null)
    .limit(500);

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
  if (moduleEnabled('carline') && p.can_view_carline) actions.push({ label: 'Start Carline', icon: 'car', href: '/app/carline-input.html', variant: 'amber' });
  if (isAdmin) actions.push({ label: 'Add Student', icon: 'graduation-cap', href: '#students', variant: 'secondary' });
  if (isAdmin) actions.push({ label: 'Add Staff',   icon: 'user-plus', href: '#staff',    variant: 'secondary' });
  if (moduleEnabled('pto') && (p.can_approve_pto || p.can_view_pto_calendar)) actions.push({ label: 'Review Leave', icon: 'calendar-check', href: '/app/pto.html', variant: 'secondary' });
  if (moduleEnabled('substitutes') && p.can_manage_substitutes) actions.push({ label: 'Substitutes', icon: 'repeat-2', href: '/app/substitutes.html', variant: 'secondary' });
  if (row && actions.length) {
    row.innerHTML = '';
    actions.forEach(({ label, icon, href, variant }) => {
      const a = document.createElement('a');
      a.className = `dash-action-btn dash-action-btn--${variant}`;
      a.href = href;
      if (!href.startsWith('#')) a.target = '_blank';
      const iconEl = document.createElement('i');
      iconEl.dataset.lucide = icon;
      a.appendChild(iconEl);
      a.appendChild(document.createTextNode(label));
      row.appendChild(a);
    });
    if (window.lucide) lucide.createIcons({ el: row });
    show('dashQuickActions');
  }

  if (r.ptoPending !== undefined) {
    setAlert('statPtoPending', 'dashPtoPending', r.ptoPending.count ?? 0); show('dashPtoPending');
    setAlert('statPtoCancels', 'dashPtoCancels', r.ptoCancels.count ?? 0); show('dashPtoCancels');
    set('statStaffOut', r.staffOut.count ?? 0);
    // Per-group breakdown (only shown when staff groups are configured)
    const staffOutRows = r.alertStaffOut?.data ?? [];
    const groupCounts = {};
    staffOutRows.forEach(req => {
      const grp = req.employees?.staff_groups;
      if (!grp) return;
      const key = grp.name;
      if (!groupCounts[key]) groupCounts[key] = { count: 0, sort_order: grp.sort_order ?? 99 };
      groupCounts[key].count++;
    });
    const groupEntries = Object.entries(groupCounts)
      .sort((a, b) => a[1].sort_order - b[1].sort_order);
    const breakdownEl = document.getElementById('statStaffOutBreakdown');
    const cardEl = document.getElementById('dashStaffOut');
    if (groupEntries.length > 0 && breakdownEl) {
      breakdownEl.textContent = groupEntries.map(([name, g]) => `${name}: ${g.count}`).join(' · ');
      breakdownEl.style.display = '';
      if (cardEl) cardEl.classList.add('stat-wide');
    }
    show('dashStaffOut');
    show('dashAttention');
  }

  if (r.subUnassigned !== undefined) {
    setAlert('statSubUnassigned',    'dashSubUnassigned',    r.subUnassigned.count ?? 0);    show('dashSubUnassigned');
    set('statSubToday', r.subToday.count ?? 0); show('dashSubToday');
    setAlert('statSubCancellations', 'dashSubCancellations', r.subCancellations.count ?? 0); show('dashSubCancellations');
    show('dashAttention');
  }

  if (r.licExpiring !== undefined) {
    setAlert('statLicExpiring', 'dashLicExpiring', r.licExpiring.count ?? 0);
    show('dashLicExpiring');
    show('dashAttention');
  }

  if (r.bgPending !== undefined) {
    setAlert('statBgPending', 'dashBgPending', r.bgPending.count ?? 0);
    show('dashBgPending');
    show('dashAttention');
  }

  if (r.agreementsExpiring !== undefined) {
    setAlert('statAgreementsExpiring', 'dashAgreementsExpiring', r.agreementsExpiring.count ?? 0);
    show('dashAgreementsExpiring');
    show('dashAttention');
  }

  if (r.carline !== undefined) {
    const events = r.carline.data || [];
    if (events.length > 0) {
      const allCalls   = events.flatMap(ev => ev.carline_calls ?? []);
      const dismissed  = allCalls.filter(c => c.status === 'CALLED' || c.status === 'LOADED').length;
      const issues     = allCalls.filter(c => c.status === 'RECALLED').length;
      const isOpen     = events.some(ev => ev.status === 'OPEN');
      const latestClose = events.map(ev => ev.closed_at).filter(Boolean).sort().at(-1);

      const statusEl    = document.getElementById('statCarlineStatus');
      const timeEl      = document.getElementById('statCarlineTime');
      const dismissedEl = document.getElementById('statCarlineDismissed');
      const issuesEl    = document.getElementById('statCarlineIssues');
      const cardEl      = document.getElementById('dashCarline');

      if (statusEl) {
        statusEl.textContent = isOpen ? 'Open' : 'Closed';
        statusEl.className = isOpen ? 'status-success' : 'status-muted';
      }
      if (timeEl) {
        if (isOpen) {
          timeEl.textContent = 'In progress';
        } else if (latestClose) {
          const t = new Date(latestClose).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          timeEl.textContent = `Closed at ${t}`;
        }
      }
      if (dismissedEl) {
        dismissedEl.textContent = `${dismissed} student${dismissed !== 1 ? 's' : ''} dismissed`;
      }
      if (issuesEl) {
        issuesEl.textContent = issues > 0 ? `${issues} recall${issues !== 1 ? 's' : ''}` : '0 recalls';
        issuesEl.className = issues > 0 ? 'status-danger' : '';
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

  // Update nav badge from already-fetched access request count
  if (r.accessRequests !== undefined) {
    const count = r.accessRequests.count ?? 0;
    const badge = document.getElementById('accessRequestBadge');
    if (badge && count > 0) badge.textContent = String(count);
  }

  // ── Upcoming Birthdays ────────────────────────────────────────────
  {
    const todayDate = new Date(); todayDate.setHours(0, 0, 0, 0);
    const fmtBday = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const allBdays = [];

    const collectBdays = (rows, type) => {
      (rows || []).forEach(s => {
        if (!s.birthdate) return;
        const [bYear, bMonth, bDay] = s.birthdate.split('-').map(Number);
        let bday = new Date(todayDate.getFullYear(), bMonth - 1, bDay);
        if (bday < todayDate) bday = new Date(todayDate.getFullYear() + 1, bMonth - 1, bDay);
        const daysLeft = Math.round((bday - todayDate) / 86400000);
        if (daysLeft <= 7) {
          allBdays.push({ name: `${s.first_name} ${s.last_name}`, age: bday.getFullYear() - bYear, daysLeft, bday, type });
        }
      });
    };

    collectBdays(r.studentBirthdays?.data, 'student');
    collectBdays(r.staffBirthdays?.data, 'staff');
    allBdays.sort((a, b) => a.daysLeft - b.daysLeft);

    if (allBdays.length > 0) {
      const list = document.getElementById('dashBirthdayList');
      const shown  = allBdays.filter(s => s.daysLeft <= 1);
      const hidden = allBdays.filter(s => s.daysLeft > 1);

      const buildLi = s => {
        const isToday    = s.daysLeft === 0;
        const when       = isToday ? 'Today!' : s.daysLeft === 1 ? 'Tomorrow' : `In ${s.daysLeft} days`;
        const secondary  = s.type === 'student' ? `Turning ${s.age} · ${fmtBday(s.bday)}` : fmtBday(s.bday);
        const initials   = s.name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
        const roleLabel  = s.type === 'staff' ? 'Staff' : `Student`;
        const li = document.createElement('li');
        li.className = 'staff-dash-request-row dash-bday-row';
        li.innerHTML = `
          <span class="dash-bday-av">${esc(initials)}</span>
          <span style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:0.8125rem;color:#1e293b;line-height:1.3;">${esc(s.name)}</div>
            <div style="font-size:0.7rem;color:#94a3b8;line-height:1.3;">${esc(roleLabel)} · ${esc(secondary)}</div>
          </span>
          <span class="staff-dash-req-badge${isToday ? ' bday-today' : ''}" style="background:#fef08a;color:#92400e;">${when}</span>
        `;
        return li;
      };

      const ul = document.createElement('ul');
      ul.style.cssText = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;';

      // If no one has a birthday today or tomorrow, show all directly
      const hasImminent = shown.length > 0;
      (hasImminent ? shown : allBdays).forEach(s => ul.appendChild(buildLi(s)));

      let extUl = null;
      if (hasImminent && hidden.length > 0) {
        extUl = document.createElement('ul');
        extUl.style.cssText = 'list-style:none;margin:0;padding:0;display:none;flex-direction:column;gap:5px;';
        hidden.forEach(s => extUl.appendChild(buildLi(s)));

        const toggleLi = document.createElement('li');
        toggleLi.style.cssText = 'padding:4px 0 2px;';
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'bday-toggle-btn';
        toggleBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="bday-toggle-icon"><polyline points="6 9 12 15 18 9"/></svg>
          <span class="bday-toggle-label">${hidden.length} more birthday${hidden.length > 1 ? 's' : ''} this week</span>
        `;
        toggleBtn.addEventListener('click', () => {
          const expanded = extUl.style.display !== 'none';
          extUl.style.display = expanded ? 'none' : '';
          toggleBtn.classList.toggle('bday-toggle-open', !expanded);
          toggleBtn.querySelector('.bday-toggle-label').textContent = expanded
            ? `${hidden.length} more birthday${hidden.length > 1 ? 's' : ''} this week`
            : 'Show less';
        });
        toggleLi.appendChild(toggleBtn);
        ul.appendChild(toggleLi);
      }

      list.innerHTML = '';
      list.appendChild(ul);
      if (extUl) list.appendChild(extUl);
      show('dashBirthdays');
    }
  }

  // ── Today's Alerts panel ──────────────────────────────────────────
  const canSeeAlerts = p.is_superadmin || p.can_approve_pto || p.can_manage_substitutes || p.can_manage_licensure || p.can_manage_compliance || p.can_manage_access;
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

    // 🟠 Pending sub cancellations — PTO was cancelled but sub assignment still scheduled
    (r.alertSubCancellations?.data ?? []).forEach(row => {
      alerts.push({
        level: 'amber',
        text: `${row.out_first_name} ${row.out_last_name}'s leave was cancelled — sub assignment on ${fmtDate(row.coverage_date)} still needs to be cancelled`,
        href: '/app/substitutes.html#cancellations'
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
        text: `${fullName(req.employees)} has requested to ${action} approved leave`,
        href: '/app/pto.html#cancellations'
      });
    });

    // 🟡 Pending PTO count
    if ((r.ptoPending?.count ?? 0) > 0) {
      const n = r.ptoPending.count;
      alerts.push({
        level: 'amber',
        text: `${n} leave request${n === 1 ? '' : 's'} awaiting approval`,
        href: '/app/pto.html#pending'
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
    (r.alertStaffOut?.data ?? []).slice(0, 8).forEach(req => {
      alerts.push({
        level: 'blue',
        text: `${fullName(req.employees)} is out today — ${req.pto_type}`,
        href: '/app/pto.html#calendar'
      });
    });

    const levelIcon = { red: 'alert-triangle', amber: 'shield-alert', blue: 'calendar-clock' };
    const list = document.getElementById('dashAlertsList');
    const allClear = document.getElementById('dashAlertsAllClear');
    if (alerts.length === 0) {
      allClear.style.display = '';
    } else {
      list.innerHTML = alerts.map(a =>
        `<a href="${a.href}" class="dash-alert-item">` +
        `<span class="dash-alert-icon dash-alert-icon--${a.level}"><i data-lucide="${levelIcon[a.level] || 'info'}"></i></span>` +
        `<span class="dash-alert-text">${a.text}</span>` +
        `<span class="dash-alert-link">View →</span>` +
        `</a>`
      ).join('');
      if (window.lucide) lucide.createIcons({ el: list });
    }
    show('dashAlertsSection');
  }

  document.getElementById('dashGrid')?.classList.add('loaded');

}

/* ===============================
   SCHOOL SWITCHER (superadmin only)
================================ */

async function initSchoolSwitcher(profile) {
  const wrap = document.getElementById('schoolSwitcherWrap');
  const sel  = document.getElementById('schoolSwitcher');
  if (!wrap || !sel) return;

  const { data: schools } = await supabase
    .from('schools')
    .select('id, name')
    .order('name');

  if (!schools || schools.length < 2) return;

  sel.innerHTML = '';
  schools.forEach(s => {
    const opt = new Option(s.name, s.id);
    if (s.id === profile.school_id) opt.selected = true;
    sel.appendChild(opt);
  });

  sel.addEventListener('change', async () => {
    const chosen = sel.value;
    // Update school_id so every page (pto, staff, subs, etc.) picks up the switch automatically
    await supabase.from('profiles')
      .update({ school_id: chosen, active_school_id: chosen })
      .eq('user_id', profile.user_id);
    location.reload();
  });

  wrap.hidden = false;
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
