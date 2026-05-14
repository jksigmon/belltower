
const AVATAR_COLORS = [
  '#2563eb', '#7c3aed', '#0891b2',
  '#059669', '#d97706', '#db2777', '#dc2626',
];

function pickColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function initUserMenu(displayName) {
  const name = displayName || '';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = parts.length === 0 ? '?'
    : parts.length === 1 ? parts[0][0].toUpperCase()
    : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();

  const initialsEl  = document.getElementById('userInitials');
  const nameEl      = document.getElementById('userDropdownName');
  const avatarBtn   = document.getElementById('userAvatar');
  const dropdown    = document.getElementById('userDropdown');

  if (initialsEl)  initialsEl.textContent      = initials;
  if (nameEl)      nameEl.textContent           = name;
  if (avatarBtn)   avatarBtn.style.background   = pickColor(name || initials);

  if (!avatarBtn || !dropdown) return;

  avatarBtn.addEventListener('click', e => {
    e.stopPropagation();
    const opening = dropdown.hidden;
    dropdown.hidden = !opening;
    avatarBtn.setAttribute('aria-expanded', String(opening));
  });

  document.addEventListener('click', () => {
    dropdown.hidden = true;
    avatarBtn.setAttribute('aria-expanded', 'false');
  });

  dropdown.addEventListener('click', e => e.stopPropagation());
}
