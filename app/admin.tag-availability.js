
import { supabase } from './admin.supabase.js?v=2';
import { esc, showToast } from './admin.shared.js?v=3';

/* ===============================
   AVAILABLE TAG NUMBERS
================================

   Family numbers (families.carline_tag_number) and pickup tags
   (carpools.tag_number) draw from one shared pool -- see
   findTagConflict() in admin.shared.js and the DB triggers in
   20260817000001_carpool_students_and_tag_collisions.sql. Neither
   directory alone shows what's actually free: the Families tab has
   the gaps but not the pickup tags, the Pickup Tags tab has neither,
   and "Releasable only" surfaces families with no active students
   without saying anything about the unclaimed numbers between them.

   This computes the whole pool in one place and splits it three ways:

     available   -- claimed by nothing; use immediately
     reclaimable -- held by a family with no active students. NOT
                    available: the family row owns the number until it
                    is deleted or renumbered, regardless of active
                    status (the uniqueness index and both triggers
                    ignore active). Listed separately because these are
                    one delete away, which is how a retired family
                    number gets reused as a pickup tag.
     in use      -- everything else; not shown, only counted.
*/

const BATCH_SIZE = 1000;

// How many reclaimable rows to render before collapsing to a count.
// The full list is what "Releasable only" on the Families tab is for.
const RECLAIMABLE_DISPLAY_CAP = 60;

let currentProfile = null;
let wired = false;
let lastResult = null;   // kept so "Copy list" doesn't have to refetch

/* ===============================
   DATA
================================ */

// PostgREST caps unranged selects at 1000 rows, so page through --
// a school past the cap would otherwise have numbers off the end of
// the list reported as free when they're already assigned.
async function fetchAll(builder) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await builder().range(from, from + BATCH_SIZE - 1);
    if (error) return { error };
    rows.push(...data);
    if (data.length < BATCH_SIZE) break;
    from += BATCH_SIZE;
  }
  return { data: rows };
}

// Tag numbers are text, so only all-digit values can take part in gap
// math. "007" is normalised to 7 and claims 7 -- erring toward claimed,
// since suggesting 7 as free would let someone create a second tag that
// reads identically at the curb.
function toNumeric(tag) {
  const trimmed = String(tag ?? '').trim();
  return /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
}

async function loadTagPool(schoolId) {
  const [familiesRes, carpoolsRes, activeStudentsRes] = await Promise.all([
    fetchAll(() => supabase.from('families')
      .select('id, family_name, carline_tag_number, active')
      .eq('school_id', schoolId)),
    fetchAll(() => supabase.from('carpools')
      .select('tag_number, label')
      .eq('school_id', schoolId)),
    fetchAll(() => supabase.from('students')
      .select('family_id')
      .eq('school_id', schoolId)
      .eq('active', true)
      .not('family_id', 'is', null)),
  ]);

  const error = familiesRes.error || carpoolsRes.error || activeStudentsRes.error;
  if (error) return { error };

  const families = familiesRes.data || [];
  const carpools = carpoolsRes.data || [];
  const familiesWithActiveStudents = new Set((activeStudentsRes.data || []).map(r => r.family_id));

  // Bucket by number first, classify after, so a number claimed from more
  // than one direction lands in exactly one category. Counting inline
  // instead would let a pickup tag that collides with a reclaimable family
  // number fall through every bucket.
  const heldByActiveFamily = new Set();
  const heldByCarpool      = new Set();
  const emptyFamilies      = new Map();   // n -> { label, inactive }
  const nonNumeric         = [];

  for (const f of families) {
    const n = toNumeric(f.carline_tag_number);
    if (n === null) { nonNumeric.push(f.carline_tag_number); continue; }
    if (familiesWithActiveStudents.has(f.id)) {
      heldByActiveFamily.add(n);
    } else {
      emptyFamilies.set(n, {
        label:    (f.family_name || '').trim() || '(Unnamed family)',
        inactive: f.active === false,
      });
    }
  }

  for (const c of carpools) {
    const n = toNumeric(c.tag_number);
    if (n === null) { nonNumeric.push(c.tag_number); continue; }
    heldByCarpool.add(n);
  }

  const claimed = new Set([...heldByActiveFamily, ...heldByCarpool, ...emptyFamilies.keys()]);

  // Only genuinely one delete away: another family or a pickup tag holding
  // the same number would still own it afterwards.
  const reclaimable = [...emptyFamilies.entries()]
    .filter(([n]) => !heldByCarpool.has(n) && !heldByActiveFamily.has(n))
    .map(([number, info]) => ({ number, ...info }));

  const inUseCount = claimed.size - reclaimable.length;
  const ceiling    = claimed.size ? Math.max(...claimed) : 0;

  const available = [];
  for (let n = 1; n <= ceiling; n++) {
    if (!claimed.has(n)) available.push(n);
  }

  reclaimable.sort((a, b) => a.number - b.number);

  return {
    data: {
      available,
      reclaimable,
      nonNumeric,
      ceiling,
      inUseCount,
      claimedCount: claimed.size,
    }
  };
}

/* ===============================
   FORMATTING
================================ */

// [3, 8, 9, 10, 22] -> [{from:3,to:3}, {from:8,to:10}, {from:22,to:22}]
// Consecutive gaps collapse into ranges so a few hundred free numbers
// stay skimmable instead of filling the screen with chips.
function toRanges(numbers) {
  const ranges = [];
  for (const n of numbers) {
    const last = ranges[ranges.length - 1];
    if (last && n === last.to + 1) last.to = n;
    else ranges.push({ from: n, to: n });
  }
  return ranges;
}

function rangeLabel({ from, to }) {
  if (from === to)     return `${from}`;
  if (to === from + 1) return `${from}, ${to}`;
  return `${from}–${to}`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/* ===============================
   RENDER
================================ */

function canSeePickupTags() {
  return currentProfile?.is_superadmin === true
      || currentProfile?.can_view_carline === true
      || currentProfile?.can_manage_carline === true
      || currentProfile?.can_manage_carpools === true;
}

function renderResult(r) {
  const parts = [];

  // Without carline read access the carpools query returns an empty set
  // rather than an error, which is indistinguishable from "no pickup
  // tags exist" -- so say so instead of quietly overstating what's free.
  if (!canSeePickupTags()) {
    parts.push(`
      <div class="tag-avail-warning">
        You don't have carline access, so pickup tag numbers couldn't be checked.
        This list may include numbers already used by a pickup tag.
      </div>
    `);
  }

  if (!r.claimedCount) {
    parts.push(`<p class="tag-avail-summary">No tag numbers assigned yet — every number is free.</p>`);
    return parts.join('');
  }

  parts.push(`
    <p class="tag-avail-summary">
      <strong>${plural(r.available.length, 'number', 'numbers')}</strong> free below #${r.ceiling},
      and everything from <strong>#${r.ceiling + 1}</strong> up is unused.
      ${plural(r.inUseCount, 'number is', 'numbers are')} currently in use.
    </p>
  `);

  /* --- Available --- */
  parts.push(`<h4 class="tag-avail-heading">Available now</h4>`);
  if (!r.available.length) {
    parts.push(`
      <p class="tag-avail-empty">
        No gaps below #${r.ceiling}. Start at #${r.ceiling + 1}, or free one of the numbers below.
      </p>
    `);
  } else {
    parts.push(`
      <div class="tag-avail-chips">
        ${toRanges(r.available).map(range =>
          `<span class="tag-avail-chip">${esc(rangeLabel(range))}</span>`
        ).join('')}
      </div>
    `);
  }

  /* --- Reclaimable --- */
  parts.push(`
    <h4 class="tag-avail-heading">
      Reclaimable
      <span class="tag-avail-heading-note">held by a family with no active students</span>
    </h4>
  `);
  if (!r.reclaimable.length) {
    parts.push(`<p class="tag-avail-empty">None — every assigned family number has an active student.</p>`);
  } else {
    const shown = r.reclaimable.slice(0, RECLAIMABLE_DISPLAY_CAP);
    parts.push(`
      <p class="tag-avail-note">
        These aren't free yet. A family owns its number whether or not it's active, so to reuse one
        as a pickup tag, delete that family first (Families → open it → Delete). Releasing the tag
        empties the family but keeps the number.
      </p>
      <div class="tag-avail-reclaim-list">
        ${shown.map(item => `
          <div class="tag-avail-reclaim-row">
            <span class="carline-tag-badge">#${esc(item.number)}</span>
            <span class="tag-avail-reclaim-name">${esc(item.label)}</span>
            ${item.inactive ? '<span class="staff-inactive-badge">Inactive</span>' : ''}
          </div>
        `).join('')}
      </div>
      ${r.reclaimable.length > shown.length ? `
        <p class="tag-avail-empty">
          + ${r.reclaimable.length - shown.length} more — use “Releasable only” on the Families tab for the full list.
        </p>` : ''}
    `);
  }

  /* --- Non-numeric --- */
  if (r.nonNumeric.length) {
    parts.push(`
      <p class="tag-avail-note">
        ${plural(r.nonNumeric.length, 'tag uses', 'tags use')} letters or symbols
        (${esc(r.nonNumeric.slice(0, 8).join(', '))}${r.nonNumeric.length > 8 ? '…' : ''})
        and ${r.nonNumeric.length === 1 ? 'is' : 'are'} left out of the numbering above.
      </p>
    `);
  }

  return parts.join('');
}

/* ===============================
   MODAL
================================ */

function closeModal() {
  const modal = document.getElementById('availableTagsModal');
  if (modal) modal.hidden = true;
}

function copyAvailable() {
  if (!lastResult) return;
  const text = lastResult.available.length
    ? toRanges(lastResult.available).map(rangeLabel).join(', ') + `, and #${lastResult.ceiling + 1} and up`
    : `#${lastResult.ceiling + 1} and up`;
  navigator.clipboard?.writeText(text)
    .then(() => showToast('Available numbers copied.', 'success'))
    .catch(() => showToast('Could not copy to clipboard.', 'error'));
}

function wireModal() {
  if (wired) return;
  wired = true;
  document.getElementById('availableTagsClose')?.addEventListener('click', closeModal);
  document.getElementById('availableTagsDone')?.addEventListener('click', closeModal);
  document.getElementById('availableTagsCopy')?.addEventListener('click', copyAvailable);
  document.getElementById('availableTagsModal')?.addEventListener('click', e => {
    if (e.target.id === 'availableTagsModal') closeModal();
  });
}

export async function openAvailableTagsModal(profile) {
  currentProfile = profile;
  wireModal();

  const modal = document.getElementById('availableTagsModal');
  const body  = document.getElementById('availableTagsBody');
  const copy  = document.getElementById('availableTagsCopy');
  if (!modal || !body) return;

  lastResult = null;
  if (copy) copy.disabled = true;
  body.innerHTML = '<p class="tag-avail-empty">Checking every family number and pickup tag…</p>';
  modal.hidden = false;

  const { data, error } = await loadTagPool(profile.school_id);
  if (error) {
    console.error('[Tag availability] Failed to load tag pool:', error.message);
    body.innerHTML = '<p class="tag-avail-empty">Couldn’t load tag numbers. Try again.</p>';
    return;
  }

  lastResult = data;
  if (copy) copy.disabled = false;
  body.innerHTML = renderResult(data);
}
