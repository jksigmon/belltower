
// admin.shared.js
import { supabase } from './admin.supabase.js';

/* ===============================
   SHARED CACHES
================================ */
const familyCache = {};
const busGroupCache = {};

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
      opt.textContent =
        `${f.carline_tag_number} – ${f.family_name ?? '(no name)'}`;
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

export function nextGrade(grade) {
  const idx = GRADE_ORDER.indexOf(grade);
  if (idx < 0 || idx >= GRADE_ORDER.length - 1) return null;
  return GRADE_ORDER[idx + 1];
}

export function isTerminalGrade(grade) {
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
