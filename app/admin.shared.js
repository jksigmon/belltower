
// admin.shared.js
import { supabase } from './admin.supabase.js';

/* ===============================
   SHARED CACHES
================================ */
let familyCache = null;
let busGroupCache = null;

/* ===============================
   FAMILY OPTIONS (Students, Guardians)
================================ */
export async function loadFamilyOptions(selectors = []) {
  if (!familyCache) {
    const { data, error } = await supabase
      .from('families')
      .select('id, carline_tag_number, family_name')
      .eq('active', true)
      .order('carline_tag_number');

    if (error) {
      console.error('Failed to load family options', error);
      return;
    }

    familyCache = data || [];
  }

  selectors.forEach(selector => {
    const select = document.querySelector(selector);
    if (!select) return;

    select.innerHTML = '<option value="">Select family</option>';

    familyCache.forEach(f => {
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
export async function loadBusGroupOptions(selector) {
  if (!busGroupCache) {
    const { data, error } = await supabase
      .from('bus_groups')
      .select('id, name')
      .order('name');

    if (error) {
      console.error('Failed to load bus group options', error);
      return;
    }

    busGroupCache = data || [];
  }

  const select = document.querySelector(selector);
  if (!select) return;

  select.innerHTML = '<option value="">No bus</option>';

  busGroupCache.forEach(bg => {
    const opt = document.createElement('option');
    opt.value = bg.id;
    opt.textContent = bg.name;
    select.appendChild(opt);
  });
}

/* ===============================
   CACHE INVALIDATION (IMPORTANT)
================================ */
export function invalidateFamilyCache() {
  familyCache = null;
}

export function invalidateBusGroupCache() {
  busGroupCache = null;
}
