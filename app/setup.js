import { supabase } from './admin.supabase.js';

let profile = null;
let schoolId = null;
let allSchools = [];

/* ===============================
   INIT
================================ */

async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) { window.location.href = '/login.html'; return; }

  const { data: p, error } = await supabase
    .from('profiles')
    .select('id, user_id, school_id, display_name, email, is_superadmin, can_access_admin, status')
    .eq('user_id', session.user.id)
    .single();

  if (error || !p) { window.location.href = '/login.html'; return; }
  if (!p.can_access_admin && !p.is_superadmin) { window.location.href = '/admin.html'; return; }

  profile = p;
  schoolId = p.school_id;

  const initials = (p.display_name || p.email || '?')
    .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('userInitials').textContent = initials;

  document.getElementById('signOut').addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = '/login.html';
  });

  document.getElementById('refreshBtn').addEventListener('click', () => runChecklist());

  if (p.is_superadmin) {
    const { data: schools } = await supabase.from('schools').select('id, name').order('name');
    allSchools = schools ?? [];
    renderSchoolPicker();
  }

  document.getElementById('setupSpinner').style.display = 'none';
  document.getElementById('setupContent').style.display = 'block';

  if (schoolId) await runChecklist();
}

/* ===============================
   SCHOOL PICKER (superadmin)
================================ */

function renderSchoolPicker() {
  const wrap = document.getElementById('schoolPickerWrap');
  if (!wrap || !allSchools.length) return;
  wrap.style.display = 'flex';

  const sel = document.getElementById('schoolPicker');
  sel.innerHTML = allSchools.map(s =>
    `<option value="${s.id}"${s.id === schoolId ? ' selected' : ''}>${s.name}</option>`
  ).join('');

  sel.addEventListener('change', async () => {
    schoolId = sel.value;
    await runChecklist();
  });
}

/* ===============================
   LOAD ALL CHECKLIST DATA
================================ */

async function runChecklist() {
  const root = document.getElementById('checklistRoot');
  root.innerHTML = '<p class="setup-loading">Checking setup status…</p>';

  const [
    schoolRes,
    modulesRes,
    campusRes,
    employeeRes,
    adminProfilesRes,
    studentRes,
    familyRes,
    busGroupRes,
    ptoBalsRes,
    complianceFormsRes,
  ] = await Promise.all([
    supabase.from('schools')
      .select('name, timezone, grade_levels, terminal_grade')
      .eq('id', schoolId).single(),
    supabase.from('school_modules')
      .select('module, enabled').eq('school_id', schoolId),
    supabase.from('campuses')
      .select('id', { count: 'exact', head: true }).eq('school_id', schoolId),
    supabase.from('employees')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).eq('active', true),
    supabase.from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).eq('status', 'active').eq('can_access_admin', true),
    supabase.from('students')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).eq('active', true),
    supabase.from('families')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).eq('active', true),
    supabase.from('bus_groups')
      .select('id', { count: 'exact', head: true }).eq('school_id', schoolId),
    supabase.from('pto_balances')
      .select('id', { count: 'exact', head: true }).eq('school_id', schoolId),
    supabase.from('compliance_form_templates')
      .select('id', { count: 'exact', head: true }).eq('school_id', schoolId),
  ]);

  const school      = schoolRes.data ?? {};
  const modules     = {};
  (modulesRes.data ?? []).forEach(m => { modules[m.module] = m.enabled; });

  const counts = {
    campus:          campusRes.count          ?? 0,
    employee:        employeeRes.count         ?? 0,
    admin:           adminProfilesRes.count    ?? 0,
    student:         studentRes.count          ?? 0,
    family:          familyRes.count           ?? 0,
    busGroup:        busGroupRes.count         ?? 0,
    ptoBalance:      ptoBalsRes.count          ?? 0,
    complianceForm:  complianceFormsRes.count  ?? 0,
  };

  const phases = buildPhases(school, modules, counts);
  render(phases);
}

/* ===============================
   BUILD CHECKLIST PHASES
================================ */

function buildPhases(school, modules, c) {
  const sup = profile.is_superadmin;
  const ptoOn        = !!modules['pto'];
  const carlineOn    = !!modules['carline'];
  const complianceOn = !!modules['compliance'];
  const anyModule    = Object.values(modules).some(Boolean);

  const phases = [];

  // ── 1. School Configuration ──────────────────────────────────
  const hasName     = !!school.name;
  const hasTimezone = !!school.timezone;
  const grades      = Array.isArray(school.grade_levels) ? school.grade_levels : [];
  const hasGrades   = grades.length > 0;
  const hasTerminal = !!school.terminal_grade;

  phases.push({
    title: 'School Configuration',
    icon: 'cog',
    steps: [
      mkStep(
        'School name & timezone',
        !hasName     ? 'error'   :
        !hasTimezone ? 'warning' : 'complete',
        hasName ? `${school.name}${school.timezone ? ` · ${school.timezone}` : ''}` : null,
        !hasName     ? 'School name is missing. Contact Belltower support to set it.' :
        !hasTimezone ? 'Timezone is not set — PTO calendars and email notifications will show incorrect times.' : null,
        sup ? 'admin.html#schools' : null,
        sup ? 'Edit in Schools' : null,
      ),
      mkStep(
        'Grade levels & terminal grade',
        !hasGrades   ? 'error'   :
        !hasTerminal ? 'warning' : 'complete',
        hasGrades ? `${grades.length} grade level${grades.length !== 1 ? 's' : ''} · Terminal: ${school.terminal_grade ?? 'not set'}` : null,
        !hasGrades   ? 'Grade levels must be configured before bulk upload, class placement, or year-end promotion will work.' :
        !hasTerminal ? 'Terminal grade is not set — year-end promotion won\'t know which students to graduate.' : null,
        sup ? 'admin.html#schools' : null,
        sup ? 'Edit in Schools' : null,
      ),
      mkStep(
        'Modules enabled',
        anyModule ? 'complete' : 'error',
        anyModule
          ? Object.entries(modules).filter(([, v]) => v).map(([k]) => MODULE_LABELS[k] ?? k).join(' · ')
          : null,
        !anyModule ? 'No modules are enabled. Enable at least one module to unlock features for this school.' : null,
        sup ? 'admin.html#schools' : null,
        sup ? 'Edit in Schools' : null,
      ),
    ],
  });

  // ── 2. Campuses & Staff ──────────────────────────────────────
  phases.push({
    title: 'Campuses & Staff',
    icon: 'people',
    steps: [
      mkStep(
        'Campus configured',
        c.campus >= 1 ? 'complete' : carlineOn ? 'warning' : 'complete',
        c.campus > 0 ? plural(c.campus, 'campus', 'campuses') : 'No campuses — not required for a standalone school',
        c.campus === 0 && carlineOn ? 'Carline is enabled but no campuses are set up. The carline screen uses campus filtering, so at least one campus record is needed.' : null,
        'admin.html#campuses',
        'Go to Campuses',
      ),
      mkStep(
        'Employees loaded',
        c.employee === 0 ? 'error' : 'complete',
        c.employee > 0 ? `${plural(c.employee, 'active employee')}` : null,
        c.employee === 0 ? 'No employees loaded. Add staff records manually or use Bulk Upload.' : null,
        'admin.html#staff',
        'Go to Staff',
      ),
      mkStep(
        'Admin account activated',
        c.admin === 0 ? 'error' :
        c.admin === 1 ? 'warning' : 'complete',
        c.admin > 0 ? `${plural(c.admin, 'active admin account')}` : null,
        c.admin === 0 ? 'No admin accounts are active. At least one school admin must be activated under User Access & Permissions.' :
        c.admin === 1 ? 'Only one admin account active. Consider enabling a backup admin in case of absence.' : null,
        'admin.html#access',
        'Go to Access',
      ),
    ],
  });

  // ── 3. Student Directory ─────────────────────────────────────
  phases.push({
    title: 'Student Directory',
    icon: 'students',
    steps: [
      mkStep(
        'Students loaded',
        c.student === 0 ? 'error' : 'complete',
        c.student > 0 ? plural(c.student, 'active student') : null,
        c.student === 0 ? 'No students loaded. Add individually or use Bulk Upload.' : null,
        'admin.html#students',
        'Go to Students',
      ),
      mkStep(
        'Families loaded',
        c.family === 0 ? 'error' : 'complete',
        c.family > 0 ? plural(c.family, 'active family', 'active families') : null,
        c.family === 0 ? 'No families loaded. Students should be linked to a family so carline tag lookup works.' : null,
        'admin.html#families',
        'Go to Families',
      ),
    ],
  });

  // ── 4. Carline (conditional) ─────────────────────────────────
  if (carlineOn) {
    phases.push({
      title: 'Carline Setup',
      icon: 'car',
      steps: [
        mkStep(
          'Bus groups configured',
          c.busGroup >= 1 ? 'complete' : 'warning',
          c.busGroup > 0 ? plural(c.busGroup, 'bus group') : null,
          c.busGroup === 0 ? 'No bus groups set up. If the school uses buses, add bus groups so they appear as buttons on the carline screen. Skip if bus-free.' : null,
          'admin.html#bus',
          'Go to Bus Groups',
        ),
        mkStep(
          'Carline tag numbers',
          c.family === 0 ? 'error' : 'warning',
          c.family > 0 ? `${plural(c.family, 'family', 'families')} loaded — verify all have real tag numbers` : null,
          'Every family needs a unique carline tag number (not a TBD placeholder) before dismissal can run. Check the Families list and update any placeholders.',
          'admin.html#families',
          'Review Families',
        ),
      ],
    });
  }

  // ── 5. PTO Setup (conditional) ───────────────────────────────
  if (ptoOn) {
    const allBalsSet  = c.ptoBalance > 0 && c.ptoBalance >= c.employee;
    const someBalsSet = c.ptoBalance > 0 && c.ptoBalance < c.employee;
    phases.push({
      title: 'PTO Setup',
      icon: 'calendar',
      steps: [
        mkStep(
          'PTO allotments applied',
          allBalsSet  ? 'complete' :
          someBalsSet ? 'warning'  : 'error',
          c.ptoBalance > 0
            ? `${c.ptoBalance} of ${c.employee} employee${c.employee !== 1 ? 's' : ''} have PTO balances initialized`
            : null,
          c.ptoBalance === 0
            ? 'No PTO balances set. Go to PTO Management → Adjust Balances → Annual Allotments and run allotments for all staff.'
            : someBalsSet
            ? `${c.employee - c.ptoBalance} employee${c.employee - c.ptoBalance !== 1 ? 's' : ''} may not have PTO balances yet. Run Annual Allotments or add balances individually.`
            : null,
          '/pto.html',
          'Go to PTO',
        ),
      ],
    });
  }

  // ── 6. Compliance (conditional) ──────────────────────────────
  if (complianceOn) {
    phases.push({
      title: 'Compliance Setup',
      icon: 'shield',
      steps: [
        mkStep(
          'Volunteer form templates',
          c.complianceForm >= 1 ? 'complete' : 'warning',
          c.complianceForm > 0 ? plural(c.complianceForm, 'form template') : null,
          c.complianceForm === 0
            ? 'No form templates created. Create at least one volunteer agreement form so guardians can sign online. You can still track background checks without forms.'
            : null,
          'admin.html#compliance',
          'Go to Compliance',
        ),
      ],
    });
  }

  return phases;
}

/* ===============================
   RENDER
================================ */

function render(phases) {
  const allSteps = phases.flatMap(p => p.steps);
  const complete = allSteps.filter(s => s.status === 'complete').length;
  const total    = allSteps.length;
  const pct      = total > 0 ? Math.round((complete / total) * 100) : 0;
  const barColor = pct === 100 ? '#16a34a' : pct >= 60 ? '#d97706' : '#dc2626';

  const schoolName = allSchools.find(s => s.id === schoolId)?.name ?? '';

  document.getElementById('checklistRoot').innerHTML = `
    ${schoolName && profile.is_superadmin ? `<p class="setup-school-label">${schoolName}</p>` : ''}

    <div class="setup-progress-wrap">
      <div class="setup-progress-header">
        <span class="setup-progress-label">${complete} of ${total} steps complete</span>
        <span class="setup-progress-pct" style="color:${barColor};">${pct}%</span>
      </div>
      <div class="setup-progress-bar">
        <div class="setup-progress-fill" style="width:${pct}%;background:${barColor};"></div>
      </div>
      ${pct === 100 ? `<p class="setup-all-done">Everything looks good — this school is ready to go.</p>` : ''}
    </div>

    ${phases.map(renderPhase).join('')}
  `;
}

function renderPhase(phase) {
  return `
    <div class="setup-phase">
      <div class="setup-phase-title">
        ${PHASE_ICONS[phase.icon] ?? ''}
        ${phase.title}
      </div>
      <div class="setup-phase-steps">
        ${phase.steps.map(renderStep).join('')}
      </div>
    </div>
  `;
}

function renderStep(s) {
  return `
    <div class="setup-step setup-step-${s.status}">
      <div class="setup-step-icon">${STATUS_ICONS[s.status]}</div>
      <div class="setup-step-body">
        <div class="setup-step-title">${s.title}</div>
        ${s.stat   ? `<div class="setup-step-stat">${s.stat}</div>`     : ''}
        ${s.detail ? `<div class="setup-step-detail">${s.detail}</div>` : ''}
      </div>
      ${s.link ? `<a href="${s.link}" class="setup-step-link">${s.linkLabel}</a>` : ''}
    </div>
  `;
}

/* ===============================
   HELPERS
================================ */

function mkStep(title, status, stat, detail, link, linkLabel) {
  return { title, status, stat: stat || null, detail: detail || null, link: link || null, linkLabel: linkLabel || 'Go →' };
}

function plural(n, singular, plural) {
  return `${n} ${n === 1 ? singular : (plural ?? singular + 's')}`;
}

const MODULE_LABELS = {
  pto:         'PTO',
  substitutes: 'Substitutes',
  carline:     'Carline',
  licensure:   'Licensure',
  compliance:  'Compliance',
  field_trips: 'Field Trips',
};

const PHASE_ICONS = {
  cog: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/></svg>`,
  people: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  students: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>`,
  car: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v5"/><circle cx="16" cy="17" r="2"/><circle cx="9" cy="17" r="2"/><line x1="13" y1="17" x2="11" y2="17"/></svg>`,
  calendar: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  shield: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
};

const STATUS_ICONS = {
  complete: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  warning:  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  error:    `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
};

document.addEventListener('DOMContentLoaded', init);
