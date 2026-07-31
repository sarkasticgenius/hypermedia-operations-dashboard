import { supabase } from './supabaseClient.js';
import { STATE } from './state.js';
import { logAudit } from './lib/audit.js';

// The admin's own session is stashed in sessionStorage (not STATE, which gets overwritten the
// moment the impersonated session's SIGNED_IN event fires and auth.js reloads the profile) so
// "Return to Admin" can restore it - and in sessionStorage rather than localStorage so it never
// survives closing the tab, and never leaks across tabs into an unrelated session.
const STORAGE_KEY = 'hm_impersonation_admin_session';

export function isImpersonating() {
  return !!sessionStorage.getItem(STORAGE_KEY);
}

export function impersonationAdminName() {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw).adminName || null; } catch (e) { return null; }
}

// Exchanges a service-role-issued magic-link token for a real session as the target user -
// see supabase/functions/admin-impersonate for why this never touches the target's password.
export async function startImpersonation(targetUserId) {
  const { data, error } = await supabase.functions.invoke('admin-impersonate', { body: { targetUserId } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);

  const { data: { session: adminSession } } = await supabase.auth.getSession();
  if (!adminSession) throw new Error('No active admin session to save');

  // Logged as the admin, before the session swap below - so it's attributed to the admin who
  // initiated it, not the impersonated user.
  await logAudit('Impersonate user', data.targetName || targetUserId);

  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
    access_token: adminSession.access_token,
    refresh_token: adminSession.refresh_token,
    adminName: STATE.user?.name || STATE.user?.username || 'Admin',
  }));

  const { error: otpError } = await supabase.auth.verifyOtp({ token_hash: data.tokenHash, type: 'magiclink' });
  if (otpError) {
    sessionStorage.removeItem(STORAGE_KEY);
    throw otpError;
  }
}

export async function stopImpersonation() {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  const { access_token, refresh_token } = JSON.parse(raw);
  sessionStorage.removeItem(STORAGE_KEY);
  const { error } = await supabase.auth.setSession({ access_token, refresh_token });
  if (error) throw error;
}
