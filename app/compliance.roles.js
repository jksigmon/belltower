
// Single source of truth for volunteer role -> requirement definitions.
// Previously this list was hand-duplicated (with wording already
// drifting between copies) in app/staff.html's request form and
// app/admin.compliance.bg.js's "Add Record" drawer. Both render their
// role checkboxes from VOLUNTEER_ROLES here instead.
//
// `requires` only lists credentials this module can actually check
// against compliance_volunteers (bg / mvr / dl / insurance). Signed
// Confidentiality Agreement and Chaperone Guidelines are separate
// records in compliance_agreements, matched by email/guardian_id --
// tracking those against a specific role is a separate piece of work
// and isn't evaluated by statusForRole() below.

export const VOLUNTEER_ROLES = {
  'Lunch Parent': {
    label: 'Lunch Parent',
    description: 'BG check + Confidentiality Agreement',
    requires: ['bg'],
    icon: '<path d="m2.37 11.223 8.372-6.777a2 2 0 0 1 2.516 0l8.371 6.777" /><path d="M21 15a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-5.25" /><path d="M3 15a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h9" /><path d="m6.67 15 6.13 4.6a2 2 0 0 0 2.8-.4l3.15-4.2" /><rect width="20" height="4" x="2" y="11" rx="1" />',
  },
  'Field Trip Chaperone': {
    label: 'Field Trip Chaperone',
    description: 'BG check + Confidentiality + Chaperone Guidelines',
    requires: ['bg'],
    icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />',
  },
  'Field Trip Driver': {
    label: 'Field Trip Driver',
    description: 'BG check + Confidentiality + Chaperone Guidelines + MVR + DL & insurance on file',
    requires: ['bg', 'mvr', 'dl', 'insurance'],
    icon: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" /><circle cx="7" cy="17" r="2" /><path d="M9 17h6" /><circle cx="17" cy="17" r="2" />',
  },
  'Coaching/Athletics': {
    label: 'Coaching / Athletics',
    description: 'BG check required',
    requires: ['bg'],
    icon: '<path d="M14.4 14.4 9.6 9.6" /><path d="M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z" /><path d="m21.5 21.5-1.4-1.4" /><path d="M3.9 3.9 2.5 2.5" /><path d="M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z" />',
  },
  // Unlike the fixed roles above, "Other" carries no inherent meaning --
  // what the person will actually be doing only exists in the free-text
  // notes on the request. `requiresDetails` is what every form that
  // collects roles keys off of to make that text mandatory (see
  // wireRoleDetailsRequirement below); without it an "Other" chip on the
  // volunteer roster tells an admin nothing at all.
  'Other': {
    label: 'Other',
    description: 'BG check + a note describing the role',
    requires: ['bg'],
    requiresDetails: true,
    icon: '<circle cx="12" cy="12" r="10" /><path d="M17 12h.01" /><path d="M12 12h.01" /><path d="M7 12h.01" />',
  },
};

export const DETAIL_ROLE_HINT = 'Tell us what this person will be doing. Required when "Other" is selected.';
export const DETAIL_ROLE_ERROR = 'Add a note describing the role. This is required when "Other" is selected.';

export function rolesRequireDetails(roles) {
  return (roles ?? []).some(r => VOLUNTEER_ROLES[r]?.requiresDetails);
}

export function checkedRoles(inputName, root = document) {
  return [...root.querySelectorAll(`input[name="${inputName}"]:checked`)].map(cb => cb.value);
}

const CREDENTIAL_LABELS = {
  bg:        'Background check',
  mvr:       'Motor vehicle report',
  dl:        "Driver's license",
  insurance: 'Insurance',
};

function dateStatus(expiresAt) {
  if (!expiresAt) return 'missing';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp = new Date(expiresAt + 'T12:00:00');
  return exp < today ? 'expired' : 'ok';
}

// bg/mvr are "cleared" credentials (need a cleared_at on file, not just
// a future expiry); dl/insurance are plain expiry dates with no
// separate cleared marker.
const CREDENTIAL_CHECKS = {
  bg:        v => (v.bg_cleared_at  ? dateStatus(v.bg_expires_at)  : 'missing'),
  mvr:       v => (v.mvr_cleared_at ? dateStatus(v.mvr_expires_at) : 'missing'),
  dl:        v => dateStatus(v.dl_expires_at),
  insurance: v => dateStatus(v.insurance_expires_at),
};

// Per-credential status ('missing' | 'expired' | 'ok'), independent of
// any role -- used to render the BG/MVR/DL/Insurance chips shown for
// every volunteer regardless of which roles they hold.
export function credentialStatus(volunteer, cred) {
  const check = CREDENTIAL_CHECKS[cred];
  return check ? check(volunteer) : 'missing';
}

// Computes eligibility for one role identically wherever it's needed
// (Needs Attention, the Volunteer Directory, field trip chaperone
// assignment) instead of each surface re-deriving its own notion of
// "compliant". missing = credential never on file; expired = on file
// but lapsed.
export function statusForRole(volunteer, roleKey) {
  const role = VOLUNTEER_ROLES[roleKey];
  if (!role) return { ok: false, missing: [], expired: [] };

  const missing = [];
  const expired = [];
  for (const cred of role.requires) {
    const status = CREDENTIAL_CHECKS[cred](volunteer);
    if (status === 'missing') missing.push(cred);
    else if (status === 'expired') expired.push(cred);
  }
  return { ok: missing.length === 0 && expired.length === 0, missing, expired };
}

export function credentialLabel(cred) {
  return CREDENTIAL_LABELS[cred] ?? cred;
}

// Renders the role-selection checkbox grid shared by the staff request
// form and the manager "Add Record" drawer. `inputName` lets each
// caller keep its own querySelector scope (`bgRole` vs `bgDrawerRole`).
export function roleCheckboxGridHTML(inputName) {
  return Object.entries(VOLUNTEER_ROLES).map(([key, role]) => `
    <label class="bg-role-card${role.requiresDetails ? ' bg-role-card-wide' : ''}">
      <input type="checkbox" name="${inputName}" value="${key}" class="bg-role-check">
      <span class="bg-role-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${role.icon}</svg></span>
      <div>
        <div class="bg-role-name">${role.label}</div>
        <div class="bg-role-desc">${role.description}</div>
      </div>
    </label>`).join('');
}

// Keeps a notes field in step with the role cards above it: checking a
// role that `requiresDetails` (i.e. "Other") flips the notes field from
// optional to required, in the markup as well as in the submit-time
// check each caller runs with rolesRequireDetails(). Wired once per
// root -- the role grid is re-rendered with innerHTML on every drawer
// open, but the container (and the notes field) outlive that, so a
// naive per-open addEventListener would stack duplicates.
//
// Returns the sync function so a caller can re-run it after clearing
// the form programmatically (checkboxes reset in JS fire no 'change').
const _detailsWiredRoots = new WeakSet();
export function wireRoleDetailsRequirement({ inputName, notesEl, showWhenRequired = [], hideWhenRequired = [], root = document }) {
  const basePlaceholder = notesEl?.placeholder ?? '';

  const sync = () => {
    const required = rolesRequireDetails(checkedRoles(inputName, root));
    showWhenRequired.filter(Boolean).forEach(el => { el.style.display = required ? '' : 'none'; });
    hideWhenRequired.filter(Boolean).forEach(el => { el.style.display = required ? 'none' : ''; });
    if (notesEl) notesEl.placeholder = required ? 'What will this person be doing?' : basePlaceholder;
    return required;
  };

  if (!_detailsWiredRoots.has(root)) {
    _detailsWiredRoots.add(root);
    root.addEventListener('change', e => { if (e.target?.name === inputName) sync(); });
  }
  sync();
  return sync;
}
