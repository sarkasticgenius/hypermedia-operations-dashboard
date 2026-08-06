import { supabase } from './supabaseClient.js';
import { STATE, setState, render } from './state.js';
import { logAudit } from './lib/audit.js';

// Same 5-flag model as the original app's PERM_NONE/PERM_FULL. 'maintenancePanels' (the Broadsign/
// Grassfish/IoT console pages) used to share the 'locations' area with the Locations page itself -
// split into its own area (migration 0021) so an admin can grant one without the other; every
// existing user's 'maintenancePanels' permission was backfilled to match their 'locations'
// permission at split time, so this alone doesn't change anyone's access.
export const PERMISSION_AREAS = [
  'assets', 'assetsInventory', 'orders', 'locations', 'maintenancePanels', 'campaigns', 'staticCampaigns',
  'permits', 'metroPic', 'tickets', 'simCards', 'pdooh', 'dashboards', 'trafficSheet', 'clientCampaigns',
];

export const PERM_NONE = { view: false, add: false, edit: false, delete: false, export: false };
export const PERM_FULL = { view: true, add: true, edit: true, delete: true, export: true };
export const PERM_VIEW = { view: true, add: false, edit: false, delete: false, export: false };

let authReadyResolve;
export const authReady = new Promise((resolve) => { authReadyResolve = resolve; });

export async function initAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) await loadProfile(session.user.id);
  authReadyResolve();
  render();

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT') {
      setState({ user: null, permissions: {}, page: 'dashboard' });
    } else if (event === 'PASSWORD_RECOVERY') {
      // Fires automatically once the Supabase client parses a genuine recovery link's token out of
      // the URL (see request-password-reset edge function / src/pages/login.js's
      // renderPasswordRecovery) - main.js's rootRender() checks this before the normal
      // user/renderShell branch, so a recovery session never silently drops someone into the
      // dashboard without setting a new password first.
      setState({ passwordRecoveryMode: true });
    } else if (session && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
      if (!STATE.user || STATE.user.id !== session.user.id) {
        await loadProfile(session.user.id);
        render();
      }
    }
  });
}

async function loadProfile(userId) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  // A transient/network error fetching the profile must not force a sign-out of an otherwise
  // valid session - this can run again on a background token refresh, and one flaky request
  // shouldn't kick someone out mid-task. Only a genuinely missing or deactivated profile should.
  if (error) return;
  if (!profile || !profile.active) {
    await supabase.auth.signOut();
    STATE.user = null;
    STATE.permissions = {};
    return;
  }

  let permissions = {};
  if (profile.role === 'admin') {
    for (const area of PERMISSION_AREAS) permissions[area] = { ...PERM_FULL };
  } else {
    const { data: perms } = await supabase
      .from('user_permissions')
      .select('*')
      .eq('user_id', userId);
    for (const area of PERMISSION_AREAS) {
      const row = (perms || []).find((p) => p.area === area);
      permissions[area] = row
        ? { view: row.can_view, add: row.can_add, edit: row.can_edit, delete: row.can_delete, export: row.can_export }
        : { ...PERM_NONE };
    }
  }

  STATE.user = profile;
  STATE.permissions = permissions;
}

// Accepts either a username or an email address - signInWithPassword() only takes an email, and
// resolving a username to one can't happen client-side (RLS blocks reading profiles without an
// existing session, on purpose), so this always goes through the resolve-login Edge Function,
// which does the lookup (when needed) and the real sign-in server-side, then hands back a session
// for this client to adopt.
export async function login(identifier, password) {
  const { data, error } = await supabase.functions.invoke('resolve-login', { body: { identifier, password } });
  if (data?.error) throw new Error(data.error);
  if (error) throw new Error('Invalid login credentials');
  const { error: sessionError } = await supabase.auth.setSession({
    access_token: data.access_token, refresh_token: data.refresh_token,
  });
  if (sessionError) throw sessionError;
  await logAudit('Login', '');
}

// Self-service "forgot password" - always resolves to the same generic summary string regardless
// of whether `identifier` matched a real account (see request-password-reset edge function's
// anti-enumeration handling), so the login page never needs to branch its UI on success vs. "no
// such user", only on whether the request itself failed to send.
export async function requestPasswordReset(identifier) {
  const { data, error } = await supabase.functions.invoke('request-password-reset', {
    body: { identifier, origin: window.location.origin },
  });
  if (error) throw error;
  return data?.summary || "If that account exists, we've sent a password reset link to its email address.";
}

export async function logout() {
  await logAudit('Logout', '');
  await supabase.auth.signOut();
}

export async function changeOwnPassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
  await logAudit('Change password', '');
}

export function isAdmin() {
  return STATE.user?.role === 'admin';
}

// A restricted client-portal login (Client Campaigns Monitor) - holds no user_permissions rows at
// all and is gated by profiles.client_id matching instead (see is_own_client() RLS helper), not by
// PERMISSION_AREAS. Used to hide every other nav item/page for this role, not just gate one page.
export function isClientUser() {
  return STATE.user?.role === 'client';
}

export function permObj(area) {
  return isAdmin() ? PERM_FULL : (STATE.permissions[area] || PERM_NONE);
}

export function canView(area) { return !!permObj(area).view; }
export function canAdd(area) { return !!permObj(area).add; }
export function canEdit(area) { return !!permObj(area).edit; }
export function canDelete(area) { return !!permObj(area).delete; }
export function canExportArea(area) { return !!permObj(area).export; }
