import { supabase } from './admin.supabase.js?v=2';
import { esc, showToast, dbError } from './admin.shared.js?v=4';

// The approved list of addresses managers can forward a request to. Lives in
// its own module so admin.requests.js only has to mount it as a tab.

let profile = null;
let container = null;
let destinations = [];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function renderForwardingView(el, currentProfile) {
  container = el;
  profile = currentProfile;
  container.innerHTML = '<p style="color:#9ca3af;padding:16px 0;">Loading…</p>';
  await load();
  render();
}

async function load() {
  const { data, error } = await supabase
    .from('request_forward_destinations')
    .select('id, name, email, is_active')
    .eq('school_id', profile.school_id)
    .order('name');
  if (error) dbError(error, 'Could not load destinations');
  destinations = data ?? [];
}

function render() {
  container.innerHTML = `
    <p style="font-size:13px;color:#6b7280;margin:0 0 16px;max-width:640px;line-height:1.6;">
      Managers can forward a request they receive to any address on this list, for example when a
      facilities request is really an IT issue. They can only pick from here, so request details
      never go to an address you haven't approved. Every forward is logged on the request.
    </p>

    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:6px;">
      <div style="flex:1 1 180px;max-width:240px;">
        <label class="form-label" for="reqFwdName">Name</label>
        <input id="reqFwdName" class="form-control" type="text" maxlength="80" placeholder="IT Helpdesk" />
      </div>
      <div style="flex:1 1 240px;max-width:320px;">
        <label class="form-label" for="reqFwdEmail">Email</label>
        <input id="reqFwdEmail" class="form-control" type="email" placeholder="helpdesk@example.com" />
      </div>
      <button class="btn btn-primary" id="reqFwdAddBtn" style="height:36px;">Add destination</button>
    </div>
    <p id="reqFwdError" style="color:#dc2626;font-size:13px;margin:6px 0 16px;display:none;"></p>

    ${destinations.length ? `
      <table class="data-table" style="max-width:720px;margin-top:16px;">
        <thead>
          <tr><th>Name</th><th>Email</th><th style="width:90px;">Status</th><th style="width:170px;"></th></tr>
        </thead>
        <tbody>
          ${destinations.map(d => `
            <tr data-id="${esc(d.id)}">
              <td>${esc(d.name)}</td>
              <td style="color:#6b7280;word-break:break-all;">${esc(d.email)}</td>
              <td><span class="status-badge ${d.is_active ? 'badge-green' : 'badge-gray'}">${d.is_active ? 'Active' : 'Inactive'}</span></td>
              <td style="text-align:right;white-space:nowrap;">
                <button class="btn btn-sm req-fwd-toggle">${d.is_active ? 'Deactivate' : 'Activate'}</button>
                <button class="btn btn-sm danger req-fwd-delete">Remove</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`
      : `<p style="color:#9ca3af;font-size:13px;margin-top:16px;">No destinations yet. Until you add one, managers won't see a Forward option.</p>`}
  `;

  document.getElementById('reqFwdAddBtn').addEventListener('click', addDestination);
  container.querySelectorAll('.req-fwd-toggle').forEach(btn =>
    btn.addEventListener('click', () => toggleDestination(btn.closest('tr').dataset.id)));
  container.querySelectorAll('.req-fwd-delete').forEach(btn =>
    btn.addEventListener('click', () => removeDestination(btn.closest('tr').dataset.id)));
}

function showError(msg) {
  const el = document.getElementById('reqFwdError');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
}

async function addDestination() {
  const name  = document.getElementById('reqFwdName').value.trim();
  const email = document.getElementById('reqFwdEmail').value.trim();

  if (!name) return showError('Enter a name managers will recognize, like "IT Helpdesk".');
  if (!EMAIL_RE.test(email)) return showError('Enter a valid email address.');
  if (destinations.some(d => d.email.toLowerCase() === email.toLowerCase())) {
    return showError('That email address is already on the list.');
  }
  showError('');

  const btn = document.getElementById('reqFwdAddBtn');
  btn.disabled = true;
  const { error } = await supabase.from('request_forward_destinations').insert({
    school_id:  profile.school_id,
    name,
    email,
    created_by: profile.id,
  });
  btn.disabled = false;
  if (error) return dbError(error, 'Could not add destination');

  showToast('Destination added.');
  await load();
  render();
}

async function toggleDestination(id) {
  const dest = destinations.find(d => d.id === id);
  if (!dest) return;
  const { error } = await supabase
    .from('request_forward_destinations')
    .update({ is_active: !dest.is_active })
    .eq('id', id);
  if (error) return dbError(error, 'Could not update destination');
  await load();
  render();
}

async function removeDestination(id) {
  const dest = destinations.find(d => d.id === id);
  if (!dest) return;
  if (!confirm(`Remove "${dest.name}" from the list? Past forwards to it stay on their requests.`)) return;
  const { error } = await supabase.from('request_forward_destinations').delete().eq('id', id);
  if (error) return dbError(error, 'Could not remove destination');
  await load();
  render();
}
