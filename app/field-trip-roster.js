// Single source of truth for "who is on this field trip's roster".
//
// grades mode:  every active student in trip.grade_levels, minus anyone with
//               a field_trip_students row where attending = false.
// custom mode:  exactly the students with a field_trip_students row
//               (attending says whether they are actually going).
//
// An empty grades-mode trip has an empty roster. It never means "everyone".

const BATCH = 1000;
const ID_CHUNK = 150; // keeps .in('id', ...) URLs well under PostgREST limits

export const ROSTER_SELECT = 'id, first_name, last_name, grade_level, homeroom_teacher_id, employees!left(first_name, last_name)';

// PostgREST caps unranged selects at 1000 rows, so page with .range().
export async function fetchAllRows(builder) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await builder().range(from, from + BATCH - 1);
    if (error) return { error };
    rows.push(...data);
    if (data.length < BATCH) break;
    from += BATCH;
  }
  return { data: rows };
}

export function isCustomRoster(trip) {
  return trip?.roster_mode === 'custom';
}

// Returns { data: [{ ...studentColumns, attending }], error }.
// Pass attendingOnly to drop students marked not attending.
export async function loadTripRoster(supabase, trip, { schoolId, select = ROSTER_SELECT, attendingOnly = false } = {}) {
  const { data: ftRows, error: ftErr } = await fetchAllRows(() =>
    supabase.from('field_trip_students').select('student_id, attending').eq('field_trip_id', trip.id));
  if (ftErr) return { error: ftErr };
  const overrides = new Map((ftRows ?? []).map(r => [r.student_id, r.attending]));

  let students = [];
  if (isCustomRoster(trip)) {
    const ids = [...overrides.keys()];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data, error } = await supabase.from('students').select(select)
        .eq('school_id', schoolId).eq('active', true).in('id', ids.slice(i, i + ID_CHUNK));
      if (error) return { error };
      students.push(...data);
    }
    students.sort((a, b) => (a.last_name ?? '').localeCompare(b.last_name ?? '') || (a.first_name ?? '').localeCompare(b.first_name ?? ''));
  } else {
    const grades = trip.grade_levels ?? [];
    if (grades.length) {
      const { data, error } = await fetchAllRows(() => supabase.from('students').select(select)
        .eq('school_id', schoolId).eq('active', true).in('grade_level', grades)
        .order('last_name', { ascending: true }).order('id', { ascending: true }));
      if (error) return { error };
      students = data;
    }
  }

  const roster = students.map(s => ({ ...s, attending: overrides.has(s.id) ? overrides.get(s.id) : true }));
  return { data: attendingOnly ? roster.filter(s => s.attending) : roster };
}

// Cheap attending headcount without loading the roster.
export async function countTripAttending(supabase, trip, { schoolId }) {
  if (isCustomRoster(trip)) {
    const { count, error } = await supabase.from('field_trip_students')
      .select('student_id, students!inner(active)', { count: 'exact', head: true })
      .eq('field_trip_id', trip.id).eq('attending', true).eq('students.active', true);
    return { count: error ? null : (count ?? 0), error };
  }
  const grades = trip.grade_levels ?? [];
  if (!grades.length) return { count: 0 };
  const [{ count: total, error: e1 }, { data: out, error: e2 }] = await Promise.all([
    supabase.from('students').select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId).eq('active', true).in('grade_level', grades),
    fetchAllRows(() => supabase.from('field_trip_students').select('student_id')
      .eq('field_trip_id', trip.id).eq('attending', false).order('student_id')),
  ]);
  const error = e1 || e2;
  return { count: error ? null : Math.max(0, (total ?? 0) - (out ?? []).length), error };
}

// Before removing students from a custom roster: who has money recorded
// (removal is refused, since it would delete the payment history) and who
// holds a vehicle seat (removal is allowed, but the user is told first).
export async function findRosterRemovalImpact(supabase, tripId, removedIds) {
  const paid = new Set(), seated = new Set();
  for (let i = 0; i < removedIds.length; i += ID_CHUNK) {
    const chunk = removedIds.slice(i, i + ID_CHUNK);
    const [pay, veh] = await Promise.all([
      supabase.from('field_trip_payments').select('student_id, amount_paid').eq('field_trip_id', tripId).in('student_id', chunk),
      supabase.from('field_trip_vehicle_assignments').select('student_id').eq('field_trip_id', tripId).in('student_id', chunk),
    ]);
    if (pay.error || veh.error) return { error: pay.error || veh.error };
    (pay.data ?? []).forEach(r => { if (Number(r.amount_paid ?? 0) > 0) paid.add(r.student_id); });
    (veh.data ?? []).forEach(r => seated.add(r.student_id));
  }
  return { paid: [...paid], seated: [...seated] };
}

// Replace a custom roster's membership with `nextIds`, touching only the diff.
// Rows (and attending flags) for kept students are left alone.
export async function saveCustomRoster(supabase, trip, { schoolId, nextIds, currentIds }) {
  const next = new Set(nextIds);
  const cur  = new Set(currentIds);
  const toAdd    = [...next].filter(id => !cur.has(id));
  const toRemove = [...cur].filter(id => !next.has(id));

  for (let i = 0; i < toAdd.length; i += 500) {
    const { error } = await supabase.from('field_trip_students').upsert(
      toAdd.slice(i, i + 500).map(student_id => ({ school_id: schoolId, field_trip_id: trip.id, student_id, attending: true })),
      { onConflict: 'field_trip_id,student_id' });
    if (error) return { error };
  }
  for (let i = 0; i < toRemove.length; i += ID_CHUNK) {
    const chunk = toRemove.slice(i, i + ID_CHUNK);
    // Clean up per-student rows that would otherwise dangle on the trip.
    for (const table of ['field_trip_vehicle_assignments', 'field_trip_permission_slips', 'field_trip_payments']) {
      const { error } = await supabase.from(table).delete().eq('field_trip_id', trip.id).in('student_id', chunk);
      if (error) return { error };
    }
    const { error } = await supabase.from('field_trip_students').delete().eq('field_trip_id', trip.id).in('student_id', chunk);
    if (error) return { error };
  }

  // Keep grade_levels in sync (display + conflict checks only).
  const ids = [...next];
  const gradeSet = new Set();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await supabase.from('students').select('grade_level').in('id', ids.slice(i, i + ID_CHUNK));
    if (error) return { error };
    (data ?? []).forEach(s => s.grade_level && gradeSet.add(s.grade_level));
  }
  const grade_levels = [...gradeSet];
  const { error } = await supabase.from('field_trips').update({ grade_levels }).eq('id', trip.id);
  return { error, grade_levels };
}

// True when any student on the trip has money recorded against them.
export async function tripHasStudentPayments(supabase, tripId) {
  const { data, error } = await supabase.from('field_trip_payments').select('amount_paid')
    .eq('field_trip_id', tripId).not('student_id', 'is', null).gt('amount_paid', 0).limit(1);
  return { has: !error && (data ?? []).length > 0, error };
}

// Wipe all per-student rows for a trip. Used when a trip switches between
// grade-based and custom rosters, because the same field_trip_students rows
// mean different things in each mode (opt-outs vs. members).
export async function resetTripStudentData(supabase, tripId) {
  for (const table of ['field_trip_vehicle_assignments', 'field_trip_permission_slips', 'field_trip_students']) {
    const { error } = await supabase.from(table).delete().eq('field_trip_id', tripId);
    if (error) return { error };
  }
  const { error } = await supabase.from('field_trip_payments').delete().eq('field_trip_id', tripId).not('student_id', 'is', null);
  return { error };
}
