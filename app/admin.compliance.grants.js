
import { supabase } from './admin.supabase.js';
import { esc } from './admin.shared.js';
import { openDrawer, closeDrawer, showToast } from './admin.compliance.utils.js';

let grantCache            = [];
let selectedGranteeProfile = null;
let grantStaffSearchTimer  = null;
let grantTeacherCache      = [];
let _profile               = null;

// ═══════════════════════════════════════════════════════════════════════
// COMPLIANCE REPORT GRANTS
// ═══════════════════════════════════════════════════════════════════════

export async function loadGrants(profile) {
  if (profile) _profile = profile;
  const tbody = document.getElementById('grantTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center;padding:24px 0;">Loading…</td></tr>';

  const { data, error } = await supabase
    .from('compliance_report_grants')
    .select(`
      id,
      grantee:profiles!grantee_id ( id, display_name, email ),
      teacher:employees!teacher_id ( id, first_name, last_name ),
      grantor:profiles!granted_by  ( display_name, email ),
      granted_at
    `)
    .eq('school_id', _profile.school_id)
    .order('granted_at', { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="status-danger" style="text-align:center;padding:24px 0;">Failed: ${esc(error.message)}</td></tr>`;
    return;
  }

  grantCache = data ?? [];

  if (!grantCache.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center;padding:24px 0;">No grants yet.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  grantCache.forEach(row => {
    const tr      = document.createElement('tr');
    const grantee = row.grantee;
    const teacher = row.teacher;
    const grantor = row.grantor;
    tr.innerHTML = `
      <td>${esc(grantee?.display_name ?? grantee?.email ?? '—')}</td>
      <td>${teacher ? `${esc(teacher.first_name)} ${esc(teacher.last_name)}` : '<span class="muted">—</span>'}</td>
      <td>${esc(grantor?.display_name ?? grantor?.email ?? '—')}</td>
      <td><button class="btn btn-sm" data-id="${esc(row.id)}" style="color:var(--danger);">Revoke</button></td>
    `;
    tr.querySelector('button[data-id]').addEventListener('click', () => revokeGrant(row.id));
    tbody.appendChild(tr);
  });
}

async function revokeGrant(grantId) {
  if (!confirm('Revoke this access grant?')) return;
  const { error } = await supabase
    .from('compliance_report_grants')
    .delete()
    .eq('id', grantId)
    .eq('school_id', _profile.school_id);
  if (error) { alert(`Failed: ${error.message}`); return; }
  showToast('Grant revoked');
  await loadGrants();
}

export async function openGrantDrawer() {
  selectedGranteeProfile = null;

  document.getElementById('grantStaffSearch').value = '';
  document.getElementById('grantStaffResults').innerHTML =
    '<div style="padding:12px 14px;text-align:center;color:var(--text-muted);font-size:13px;">Type a name or email to search.</div>';
  document.getElementById('grantDrawerMsg').textContent = '';
  document.getElementById('grantDrawerSave').disabled = true;

  if (!grantTeacherCache.length) {
    const { data } = await supabase
      .from('employees')
      .select('id, first_name, last_name')
      .eq('school_id', _profile.school_id)
      .eq('active', true)
      .order('last_name');
    grantTeacherCache = data ?? [];
  }

  const sel = document.getElementById('grantTeacherSelect');
  sel.innerHTML = '<option value="">Select a teacher…</option>';
  grantTeacherCache.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = `${t.last_name}, ${t.first_name}`;
    sel.appendChild(opt);
  });

  openDrawer('grant');
}

export function onGrantStaffSearchInput() {
  clearTimeout(grantStaffSearchTimer);
  grantStaffSearchTimer = setTimeout(searchGrantStaff, 280);
}

async function searchGrantStaff() {
  const term = document.getElementById('grantStaffSearch')?.value.trim();
  const resultsEl = document.getElementById('grantStaffResults');

  if (!term || term.length < 2) {
    resultsEl.innerHTML = '<div style="padding:12px 14px;text-align:center;color:var(--text-muted);font-size:13px;">Type a name or email to search.</div>';
    return;
  }

  resultsEl.innerHTML = '<div style="padding:12px 14px;text-align:center;color:var(--text-muted);font-size:13px;">Searching…</div>';

  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email')
    .eq('school_id', _profile.school_id)
    .or(`display_name.ilike.%${term}%,email.ilike.%${term}%`)
    .limit(15);

  if (error) {
    resultsEl.innerHTML = `<div style="padding:12px 14px;color:var(--danger);font-size:13px;">Search failed: ${esc(error.message)}</div>`;
    return;
  }

  if (!data?.length) {
    resultsEl.innerHTML = '<div style="padding:12px 14px;text-align:center;color:var(--text-muted);font-size:13px;">No staff found.</div>';
    return;
  }

  resultsEl.innerHTML = '';
  data.forEach(p => {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.12s;';
    div.innerHTML = `
      <div>
        <div style="font-size:14px;font-weight:600;">${esc(p.display_name ?? p.email)}</div>
        <div style="font-size:12px;color:var(--text-muted);">${esc(p.email)}</div>
      </div>
      <button class="btn btn-sm" data-pid="${esc(p.id)}" data-pname="${esc(p.display_name ?? p.email)}">Select</button>
    `;
    div.querySelector('button').addEventListener('click', e => {
      const btn = e.currentTarget;
      selectGrantee(btn.dataset.pid, btn.dataset.pname);
    });
    div.addEventListener('mouseenter', () => { div.style.background = '#f8fafc'; });
    div.addEventListener('mouseleave', () => { div.style.background = ''; });
    resultsEl.appendChild(div);
  });
}

function selectGrantee(profileId, profileName) {
  selectedGranteeProfile = profileId;

  document.querySelectorAll('#grantStaffResults button[data-pid]').forEach(btn => {
    btn.textContent = btn.dataset.pid === profileId ? '✓ Selected' : 'Select';
    btn.style.background  = btn.dataset.pid === profileId ? 'var(--primary)' : '';
    btn.style.color       = btn.dataset.pid === profileId ? '#fff' : '';
    btn.style.borderColor = btn.dataset.pid === profileId ? 'var(--primary)' : '';
  });

  const msg = document.getElementById('grantDrawerMsg');
  msg.textContent = `Selected: ${profileName}`;
  msg.style.color = 'var(--success, #15803d)';
  document.getElementById('grantDrawerSave').disabled = false;
}

export async function saveGrant() {
  if (!selectedGranteeProfile) return;
  const teacherId = document.getElementById('grantTeacherSelect')?.value;
  const msgEl     = document.getElementById('grantDrawerMsg');

  if (!teacherId) {
    msgEl.textContent = 'Please select a teacher.';
    msgEl.style.color = 'var(--danger)';
    return;
  }

  const saveBtn = document.getElementById('grantDrawerSave');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  const { error } = await supabase
    .from('compliance_report_grants')
    .insert({
      school_id:  _profile.school_id,
      grantee_id: selectedGranteeProfile,
      teacher_id: teacherId,
      granted_by: _profile.id,
    });

  saveBtn.disabled = false; saveBtn.textContent = 'Save Grant';

  if (error) {
    msgEl.textContent = error.code === '23505' ? 'This grant already exists.' : `Failed: ${esc(error.message)}`;
    msgEl.style.color = 'var(--danger)';
    return;
  }

  closeDrawer('grant');
  showToast('Access granted');
  await loadGrants();
}
