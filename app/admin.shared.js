
// admin.shared.js
import { supabase } from './admin.supabase.js';

/* ===============================
   SHARED CACHES
================================ */
const familyCache = {};
const busGroupCache = {};
const schoolConfigCache = {};

/* ===============================
   SCHOOL CONFIG
================================ */

/**
 * Loads and caches per-school configuration (grades, feature flags, etc.).
 * Returns an object with:
 *   grade_levels: string[]       — ordered grade list for this school
 *   terminal_grade: string       — last grade before graduation
 *   uses_homerooms: boolean
 *   require_mvr_for_drivers: boolean
 *   modules: { [module]: boolean } — enabled state per module key
 */
export async function loadSchoolConfig(schoolId) {
  if (schoolConfigCache[schoolId]) return schoolConfigCache[schoolId];

  const [schoolRes, modulesRes] = await Promise.all([
    supabase
      .from('schools')
      .select('grade_levels, terminal_grade, uses_homerooms, require_mvr_for_drivers')
      .eq('id', schoolId)
      .single(),
    supabase
      .from('school_modules')
      .select('module, enabled')
      .eq('school_id', schoolId),
  ]);

  const modules = {};
  (modulesRes.data ?? []).forEach(m => { modules[m.module] = m.enabled; });

  schoolConfigCache[schoolId] = { ...(schoolRes.data ?? {}), modules };
  return schoolConfigCache[schoolId];
}

/* ===============================
   FAMILY OPTIONS (Students, Guardians)
================================ */
export async function loadFamilyOptions(selectors = [], schoolId) {
  if (!familyCache[schoolId]) {
    const { data, error } = await supabase
      .from('families')
      .select('id, carline_tag_number, family_name')
      .eq('school_id', schoolId)
      .eq('active', true)
      .order('carline_tag_number');

    if (error) {
      console.error('Failed to load family options', error);
      return;
    }

    familyCache[schoolId] = data || [];
  }

  selectors.forEach(selector => {
    const select = document.querySelector(selector);
    if (!select) return;

    select.innerHTML = '<option value="">Select family</option>';

    familyCache[schoolId].forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.carline_tag_number
        ? `${f.carline_tag_number} – ${f.family_name ?? '(no name)'}`
        : (f.family_name ?? '(no name)');
      select.appendChild(opt);
    });
  });
}

/* ===============================
   BUS GROUP OPTIONS (Students)
================================ */
export async function loadBusGroupOptions(selector, schoolId) {
  if (!busGroupCache[schoolId]) {
    const { data, error } = await supabase
      .from('bus_groups')
      .select('id, name')
      .eq('school_id', schoolId)
      .order('name');

    if (error) {
      console.error('Failed to load bus group options', error);
      return;
    }

    busGroupCache[schoolId] = data || [];
  }

  const select = document.querySelector(selector);
  if (!select) return;

  select.innerHTML = '<option value="">No bus</option>';

  busGroupCache[schoolId].forEach(bg => {
    const opt = document.createElement('option');
    opt.value = bg.id;
    opt.textContent = bg.name;
    select.appendChild(opt);
  });
}

/* ===============================
   CACHE INVALIDATION (IMPORTANT)
================================ */
export function invalidateFamilyCache(schoolId) {
  if (schoolId) delete familyCache[schoolId];
  else Object.keys(familyCache).forEach(k => delete familyCache[k]);
}

export function searchFamilies(schoolId, term) {
  const cache = familyCache[schoolId] ?? [];
  if (!term) return cache.slice(0, 8);
  const t = term.toLowerCase();
  return cache.filter(f =>
    (f.family_name ?? '').toLowerCase().includes(t) ||
    String(f.carline_tag_number ?? '').includes(t)
  ).slice(0, 8);
}

export function invalidateBusGroupCache(schoolId) {
  if (schoolId) delete busGroupCache[schoolId];
  else Object.keys(busGroupCache).forEach(k => delete busGroupCache[k]);
}

/* ===============================
   SHARED UI UTILITIES
================================ */

export function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getAvatarColor(name) {
  const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export function debounce(fn, delay = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

export function cloneSelectOptions(sourceId, target, selectedValue) {
  target.innerHTML = '';
  document.querySelectorAll(`${sourceId} option`).forEach(opt =>
    target.appendChild(opt.cloneNode(true))
  );
  target.value = selectedValue ?? '';
}

/* ===============================
   GRADE UTILITIES
================================ */
export const GRADE_ORDER = ['PK', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

/**
 * Returns the next grade after `grade`, using the school's configured grade list.
 * Pass schoolConfig (from loadSchoolConfig) for per-school grades; omit for K-12 default.
 */
export function nextGrade(grade, schoolConfig) {
  const grades = schoolConfig?.grade_levels ?? GRADE_ORDER;
  const idx = grades.indexOf(grade);
  if (idx < 0 || idx >= grades.length - 1) return null;
  return grades[idx + 1];
}

/**
 * Returns true if `grade` is the last grade in this school's sequence.
 * Pass schoolConfig for per-school config; omit for K-12 default.
 */
export function isTerminalGrade(grade, schoolConfig) {
  if (schoolConfig?.terminal_grade) return grade === schoolConfig.terminal_grade;
  if (schoolConfig?.grade_levels?.length) return grade === schoolConfig.grade_levels[schoolConfig.grade_levels.length - 1];
  return grade === '12';
}

export function gradeLabel(grade) {
  if (!grade) return 'Unknown';
  if (grade === 'PK') return 'Pre-K';
  if (grade === 'K') return 'Kindergarten';
  const n = parseInt(grade);
  if (!isNaN(n)) {
    const v = n % 100;
    const suffix = (v >= 11 && v <= 13) ? 'th' : (['th', 'st', 'nd', 'rd'][v % 10] || 'th');
    return `${n}${suffix} Grade`;
  }
  return `Grade ${grade}`;
}

/* ===============================
   DATE / TIME UTILITIES
================================ */

/**
 * Formats a time string (HH:MM or HH:MM:SS) as "8:30 AM".
 * Returns empty string for falsy input.
 */
export function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hr = parseInt(h, 10);
  return `${hr % 12 || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
}

/**
 * Returns today's date as an ISO date string (YYYY-MM-DD) in local time.
 */
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Formats a date string or ISO timestamp as "May 22, 2026".
 * Handles date-only strings safely (avoids UTC-midnight timezone shift).
 */
export function fmtShortDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr.includes('T') ? dateStr : dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ===============================
   ERROR HANDLING
================================ */

/**
 * Logs a Supabase error to the console and shows a user-friendly alert.
 * Distinguishes duplicate-key (23505) and permission (42501) errors.
 */
export function dbError(error, context = 'Operation failed') {
  console.error(context, error);
  let msg;
  if (error?.code === '23505') {
    msg = `${context}: this record already exists.`;
  } else if (error?.code === '42501') {
    msg = `${context}: permission denied.`;
  } else {
    msg = `${context}${error?.message ? ': ' + error.message : '.'}`;
  }
  showToast(msg, 'error');
}

export function showToast(message, type = 'success', duration = 4500) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const icons = { success: '✓', error: '✕', warn: '⚠', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;

  const icon = document.createElement('em');
  icon.className = 'toast-icon';
  icon.textContent = icons[type] ?? icons.info;

  const msg = document.createElement('span');
  msg.className = 'toast-message';
  msg.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.textContent = '×';

  toast.appendChild(icon);
  toast.appendChild(msg);
  toast.appendChild(closeBtn);

  const dismiss = () => {
    toast.classList.add('toast--out');
    setTimeout(() => toast.remove(), 220);
  };

  closeBtn.addEventListener('click', dismiss);
  container.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('toast--in')));

  if (duration > 0) {
    const timer = setTimeout(dismiss, duration);
    closeBtn.addEventListener('click', () => clearTimeout(timer), { once: true });
  }
}
