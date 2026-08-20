import { supabase } from './admin.supabase.js?v=2';
import { initUserMenu } from './user-menu.js?v=2';
import { esc, initDashClamps, BDAY_VISIBLE } from './admin.shared.js?v=3';
import { loadWeather } from './weather.js';
import { initCalendarStrip } from './calendar-strip.js';

let currentProfile = null;
let currentModules = {}; // { pto: true, substitutes: false, ... }
let effectiveSchoolId = null;

// PostgREST caps an unranged select at 1000 rows with no error. Same pattern
// as fetchAllRows in carline.html / fetchAllIds in admin.families.js.
const ROW_PAGE_SIZE = 1000;
// Throws rather than returning whatever partial rows were collected so far --
// callers below need to tell "genuinely empty" apart from "the request
// failed," or a failed fetch quietly renders as a real zero on the dashboard
// instead of surfacing through the existing failedKeys error banner.
async function fetchAllRows(build) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build().range(from, from + ROW_PAGE_SIZE - 1);
    if (error) { console.error('Paged fetch failed', error); throw error; }
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < ROW_PAGE_SIZE) return rows;
    from += ROW_PAGE_SIZE;
  }
}

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
    document.body.insertAdjacentHTML('afterbegin', `
      <div style="background:#fef2f2;border-bottom:1px solid #fecaca;color:#991b1b;padding:14px 20px;font-size:14px;display:flex;align-items:center;justify-content:center;gap:12px;">
        Something went wrong loading your account. Please try again.
        <button onclick="location.reload()" style="background:#991b1b;color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:13px;cursor:pointer;">Retry</button>
      </div>
    `);
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

  const canManageCalendar = profile.is_superadmin || profile.role === 'admin' || profile.can_manage_calendar === true;
  initCalendarStrip(supabase, effectiveSchoolId, document.getElementById('dashCalChip'), canManageCalendar, {
    eventsCard:    document.getElementById('dashEventList'),
    eventsSection: document.getElementById('dashEvents'),
    eventsLink:    document.getElementById('dashEventsLink'),
  });

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
    '#students':    () => import('./admin.students.js?v=2').then(m => m.initStudentsSection(currentProfile)),
    '#families':    () => import('./admin.families.js').then(m => m.initFamiliesSection(currentProfile)),
    '#guardians':   () => import('./admin.guardians.js').then(m => m.initGuardiansSection(currentProfile)),
    '#bus':         () => import('./admin.busgroups.js').then(m => m.initBusGroupsSection(currentProfile)),
    '#carpools':    () => import('./admin.carpools.js').then(m => m.initCarpoolsSection(currentProfile)),
    '#access':      () => Promise.all([
      import('./admin.access.js').then(m => m.initAccessSection(currentProfile, currentModules)),
      import('./admin.access-requests.js').then(m => m.initAccessRequests(currentProfile)),
    ]),
    '#bulk-upload': () => import('./admin.bulk.js').then(m => m.initBulkSection()),
    '#exports':     () => import('./admin.exports.js?v=2').then(m => m.initExportsSection(currentProfile)),
    '#campuses':    () => import('./admin.campuses.js').then(m => m.initCampusesSection(currentProfile)),
    '#schools':     () => import('./admin.schools.js').then(m => m.initSchoolsSection(currentProfile)),
    '#promotion':        () => import('./admin.promotion.js').then(m => m.initPromotionSection(currentProfile)),
    '#data-collection':  () => import('./admin.data-collection.js').then(m => m.initDataCollectionSection(currentProfile)),
    '#resource-docs':    () => import('./admin.resource-docs.js').then(m => m.initResourceDocsSection(currentProfile)),
    '#reservations':     () => import('./admin.reservations.js').then(m => m.initReservationsSection(currentProfile)),
    '#inventory':        () => import('./admin.inventory.js').then(m => m.initInventorySection(currentProfile)),
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
    const altCap = link.dataset.capAlt;
    const mod = link.dataset.module;
    const hasCap = currentProfile.is_superadmin || currentProfile[cap] || (altCap && currentProfile[altCap]);
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
    // Named alert queries — capped at the next 30 days. The view itself
    // only filters coverage_date >= today, so without an upper bound a gap
    // three months out would surface in a panel called "Today's Alerts".
    // The Needs Attention counts above stay unbounded: those are totals.
    // Fetch generously within that window; rows are grouped per-employee
    // client-side, so one multi-day absence can't crowd others out.
    queries.alertCoverage = supabase.from('v_pending_coverage_days')
      .select('out_first_name, out_last_name, coverage_date, pto_type')
      .eq('school_id', schoolId).lte('coverage_date', in30Str)
      .order('coverage_date', { ascending: true }).limit(60);
    queries.alertSubCancellations = supabase.from('v_pending_cancellation_days')
      .select('out_first_name, out_last_name, coverage_date')
      .eq('school_id', schoolId).eq('assignment_status', 'scheduled')
      .lte('coverage_date', in30Str)
      .order('coverage_date', { ascending: true }).limit(60);
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
      .select('id, status, closed_at')
      .eq('school_id', schoolId).eq('event_date', today);
    // Split out rather than embedded (carline_events(...,carline_calls(status))).
    // Two reasons: that embedded form compiles to a LATERAL join PostgREST
    // evaluates per-row with no usable index, which timed out in production
    // against a school's accumulated call history (see carline.html's
    // loadExistingCalls for the full incident writeup); and this can now be
    // paginated past the 1000-row cap the same way the board and kiosk are.
    // Resolves to a {data, error} shape (not a bare array) so a failure here
    // surfaces through the existing failedKeys banner below instead of
    // silently rendering as a real zero.
    queries.carlineCalls = queries.carline.then(({ data: events }) => {
      const eventIds = (events || []).map(ev => ev.id);
      if (!eventIds.length) return { data: [], error: null };
      return fetchAllRows(() => supabase.from('carline_calls')
        .select('status, carline_event_id')
        .in('carline_event_id', eventIds)
        .order('id'))
        .then(data => ({ data, error: null }))
        .catch(error => ({ data: null, error }));
    });
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

  // Some individual queries can fail (RLS, timeout, etc.) while others
  // succeed — without this, a failed count silently renders as "0" via the
  // `?? 0` fallbacks below, indistinguishable from a genuinely empty school.
  const failedKeys = keys.filter(k => r[k]?.error);
  if (failedKeys.length) {
    console.error('Dashboard stat queries failed', failedKeys.map(k => [k, r[k].error]));
    const grid = document.getElementById('dashGrid');
    if (grid && !document.getElementById('dashStatsErrorBanner')) {
      grid.insertAdjacentHTML('beforebegin', `
        <div id="dashStatsErrorBanner" style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:10px 16px;border-radius:8px;font-size:13px;margin-bottom:12px;">
          Some dashboard numbers below may be inaccurate — they failed to load. <a href="#" onclick="location.reload();return false;" style="color:#92400e;font-weight:600;">Refresh to retry</a>.
        </div>
      `);
    }
  }

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
  if (moduleEnabled('carline') && p.can_view_carline) actions.push({ label: 'Carline', icon: 'car', href: '/app/carline.html?from=admin', variant: 'primary' });
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
      const allCalls   = r.carlineCalls?.data || [];
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

      const buildLi = s => {
        const isToday    = s.daysLeft === 0;
        const when       = isToday ? 'Today!' : s.daysLeft === 1 ? 'Tomorrow' : `In ${s.daysLeft} days`;
        const dayLabel   = isToday ? 'Today' : fmtBday(s.bday);
        const secondary  = s.type === 'student' ? `Turning ${s.age} · ${dayLabel}` : dayLabel;
        const initials   = s.name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
        const roleLabel  = s.type === 'staff' ? 'Staff' : `Student`;
        const li = document.createElement('li');
        li.className = 'bday-row';
        li.innerHTML = `
          <span class="dash-bday-av">${esc(initials)}</span>
          <span style="flex:1;min-width:0;">
            <div class="bday-row-name">${esc(s.name)}</div>
            <div class="bday-row-meta">${esc(roleLabel)} · ${esc(secondary)}</div>
          </span>
          <span class="bday-pill${isToday ? ' bday-today' : ''}">${when}</span>
        `;
        return li;
      };

      const ul = document.createElement('ul');
      ul.style.cssText = 'list-style:none;margin:0;padding:0;';

      // Show the soonest few (list is day-sorted), but never collapse
      // someone whose birthday is today or tomorrow behind the toggle.
      // Same rule on the staff dashboard so both cards behave alike.
      const imminent = allBdays.filter(s => s.daysLeft <= 1).length;
      const cut      = Math.max(BDAY_VISIBLE, imminent);
      const visible  = allBdays.slice(0, cut);
      const rest     = allBdays.slice(cut);
      visible.forEach(s => ul.appendChild(buildLi(s)));

      let extUl = null;
      const foot = document.getElementById('dashBirthdayFoot');
      if (rest.length > 0) {
        extUl = document.createElement('ul');
        extUl.style.cssText = 'list-style:none;margin:0;padding:0;display:none;';
        rest.forEach(s => extUl.appendChild(buildLi(s)));

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'bday-toggle-btn';
        toggleBtn.innerHTML = `
          <span class="bday-toggle-label">View more birthdays</span>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="bday-toggle-icon"><polyline points="6 9 12 15 18 9"/></svg>
        `;
        toggleBtn.addEventListener('click', () => {
          const expanded = extUl.style.display !== 'none';
          extUl.style.display = expanded ? 'none' : '';
          toggleBtn.classList.toggle('bday-toggle-open', !expanded);
          toggleBtn.querySelector('.bday-toggle-label').textContent = expanded
            ? 'View more birthdays'
            : 'Show less';
        });
        if (foot) {
          foot.innerHTML = '';
          foot.appendChild(toggleBtn);
          foot.style.display = '';
        }
      } else if (foot) {
        foot.style.display = 'none';
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

    // Collapse per-day rows into one alert per employee. Eight rows of
    // "Rachel is out Sep N" bury every other alert; one row with a day
    // count carries the same urgency without the noise. Rows arrive
    // date-sorted, so dates[0] is always the soonest.
    const groupByEmployee = rows => {
      const byEmp = new Map();
      (rows ?? []).forEach(row => {
        const name = `${row.out_first_name} ${row.out_last_name}`;
        if (!byEmp.has(name)) byEmp.set(name, []);
        byEmp.get(name).push(row.coverage_date);
      });
      return byEmp;
    };

    // Only print "Aug 24 – Aug 27" when the days really are one stretch.
    // Scattered days (4 single days spread over two months) rendered as a
    // first–last range read as one long absence, which they aren't.
    // Gaps of up to 3 days count as contiguous so a Fri→Mon absence — a
    // weekend, not a return to work — still reads as a single stretch.
    const isContiguousRun = dates => dates.every((d, i) => {
      if (i === 0) return true;
      const gap = (new Date(d + 'T00:00:00') - new Date(dates[i - 1] + 'T00:00:00')) / 86400000;
      return gap <= 3;
    });

    // "next today" doesn't read, so call it out directly when one is today
    const soonestLabel = dates =>
      dates[0] === today ? 'one is today' : `next ${fmtDate(dates[0])}`;

    // 🔴 Coverage gaps (most critical — named, upcoming)
    groupByEmployee(r.alertCoverage?.data).forEach((dates, name) => {
      let text;
      if (dates.length === 1) {
        text = `${name} is out ${fmtDate(dates[0])} — no substitute assigned`;
      } else if (isContiguousRun(dates)) {
        text = `${name} is out ${fmtDate(dates[0])} – ${fmtDate(dates.at(-1))} — ${dates.length} days with no substitute assigned`;
      } else {
        text = `${name} — ${dates.length} days with no substitute assigned, ${soonestLabel(dates)}`;
      }
      alerts.push({ level: 'red', text, href: '/app/substitutes.html' });
    });

    // 🟠 Pending sub cancellations — PTO was cancelled but sub assignment still scheduled
    groupByEmployee(r.alertSubCancellations?.data).forEach((dates, name) => {
      let text;
      if (dates.length === 1) {
        text = `${name}'s leave was cancelled — sub assignment on ${fmtDate(dates[0])} still needs to be cancelled`;
      } else if (isContiguousRun(dates)) {
        text = `${name}'s leave was cancelled — ${dates.length} sub assignments (${fmtDate(dates[0])} – ${fmtDate(dates.at(-1))}) still need to be cancelled`;
      } else {
        text = `${name}'s leave was cancelled — ${dates.length} sub assignments still need to be cancelled, ${soonestLabel(dates)}`;
      }
      alerts.push({ level: 'amber', text, href: '/app/substitutes.html#cancellations' });
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
  initDashClamps(document.getElementById('dashGrid') ?? document);

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
