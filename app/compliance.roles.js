
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
  },
  'Field Trip Chaperone': {
    label: 'Field Trip Chaperone',
    description: 'BG check + Confidentiality + Chaperone Guidelines',
    requires: ['bg'],
  },
  'Field Trip Driver': {
    label: 'Field Trip Driver',
    description: 'BG check + Confidentiality + Chaperone Guidelines + MVR + DL & insurance on file',
    requires: ['bg', 'mvr', 'dl', 'insurance'],
  },
  'Coaching/Athletics': {
    label: 'Coaching / Athletics',
    description: 'BG check required',
    requires: ['bg'],
  },
};

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
    <label class="bg-role-card">
      <input type="checkbox" name="${inputName}" value="${key}" class="bg-role-check">
      <div>
        <div class="bg-role-name">${role.label}</div>
        <div class="bg-role-desc">${role.description}</div>
      </div>
    </label>`).join('');
}
