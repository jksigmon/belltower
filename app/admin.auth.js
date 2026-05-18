import { supabase } from './admin.supabase.js';
import { initUserMenu } from './user-menu.js';

/**
 * Checks for a valid auth session. Redirects to loginRedirect if none.
 * Returns the session or null (after redirect).
 */
export async function requireAuth({ loginRedirect = '/login.html' } = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) {
    window.location.href = loginRedirect;
    return null;
  }
  return session;
}

/**
 * Loads a profile for the given userId. Calls initUserMenu.
 * Redirects to capRedirect if profile is missing or requiredCap is not met.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} [opts.select='*']
 * @param {string} [opts.requiredCap]        - profile field that must be true (or is_superadmin)
 * @param {string} [opts.capRedirect='/admin.html']
 */
export async function loadProfile({
  userId,
  select = '*',
  requiredCap,
  capRedirect = '/admin.html',
} = {}) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select(select)
    .eq('user_id', userId)
    .single();

  if (error || !profile) {
    console.error('Profile load failed', error);
    window.location.href = capRedirect;
    return null;
  }

  if (requiredCap && !profile.is_superadmin && !profile[requiredCap]) {
    window.location.href = capRedirect;
    return null;
  }

  initUserMenu(profile.display_name ?? profile.email);
  return profile;
}

/**
 * Convenience wrapper: requireAuth + loadProfile in one call.
 * Returns the profile or null (after redirect).
 */
export async function initPage({
  select = '*',
  requiredCap,
  loginRedirect = '/login.html',
  capRedirect = '/admin.html',
} = {}) {
  const session = await requireAuth({ loginRedirect });
  if (!session) return null;
  return loadProfile({ userId: session.user.id, select, requiredCap, capRedirect });
}
