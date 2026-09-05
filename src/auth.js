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
  'reporting', 'workspaceDirectory', 'screenReports',
];

export const PERM_NONE = { view: false, add: false, edit: false, delete: false, export: false };
export const PERM_FULL = { view: true, add: true, edit: true, delete: true, export: true };
export const PERM_VIEW = { view: true, add: false, edit: false, delete: false, export: false };

let authReadyResolve;
export const authReady = new Promise((resolve) => { authReadyResolve = resolve; });

export async function initAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session && !(await gateOnMfaChallenge())) await loadProfile(session.user.id);
  authReadyResolve();
  render();

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT') {
      setState({ user: null, permissions: {}, page: 'dashboard', mfaChallenge: null });
    } else if (event === 'PASSWORD_RECOVERY') {
      // Fires automatically once the Supabase client parses a genuine recovery link's token out of
      // the URL (see request-password-reset edge function / src/pages/login.js's
      // renderPasswordRecovery) - main.js's rootRender() checks this before the normal
      // user/renderShell branch, so a recovery session never silently drops someone into the
      // dashboard without setting a new password first.
      setState({ passwordRecoveryMode: true });
    } else if (session && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
      if (!STATE.user || STATE.user.id !== session.user.id) {
        if (!(await gateOnMfaChallenge())) {
          await loadProfile(session.user.id);
          // Only a genuine new sign-in, never a background token refresh, counts as a login for
          // the audit trail/history - and only once actually fully authenticated (no two-factor
          // pending), matching what verifyMfaChallenge records for the challenged case below.
          if (event === 'SIGNED_IN') { await logAudit('Login', ''); await recordLoginEvent('login'); }
          render();
        }
      }
    }
  });
}

// True (and STATE.mfaChallenge set to the factor to verify) when the current session has a
// verified TOTP factor this particular session hasn't proven yet - blocks loadProfile()/the real
// app from ever rendering until the code is submitted (see main.js's rootRender). Checked on
// every fresh sign-in AND on session restore (a page refresh mid-challenge, or a tab closed before
// finishing it, must re-prompt rather than silently granting access at aal1). Fails OPEN (returns
// false) on any error here - this client-side gate is a UX nudge, not the actual security
// boundary; that's Stage B's RLS-level aal2 check on is_admin/has_permission/is_own_client/
// is_active_user, which fails CLOSED regardless of what this function does.
//
// The "no challenge needed" branches assign STATE.mfaChallenge directly rather than going through
// setState() - both call sites (initAuth's bootstrap block and its onAuthStateChange listener)
// already do their own render() once this whole gate+loadProfile sequence finishes, so a setState()
// here would only ever add an EXTRA, premature render in between: STATE.user is still null at that
// point (loadProfile hasn't run yet), so rootRender briefly shows the login page before the real
// one replaces it a moment later. Confirmed live - a refresh with an already-aal2 session flashed
// the login screen for a beat on every single reload before this was a direct assignment. Only the
// genuine "show the challenge screen" transition actually needs setState's immediate render, since
// that IS the next thing the user should see, with nothing else about to render over it.
async function gateOnMfaChallenge() {
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) { STATE.mfaChallenge = null; return false; }
    if (data.nextLevel === 'aal2' && data.currentLevel !== data.nextLevel) {
      const { data: factorsData } = await supabase.auth.mfa.listFactors();
      const factor = factorsData?.totp?.find((f) => f.status === 'verified');
      if (factor) { setState({ mfaChallenge: { factorId: factor.id } }); return true; }
    }
    STATE.mfaChallenge = null;
    return false;
  } catch {
    STATE.mfaChallenge = null;
    return false;
  }
}

// Submits the code from login.js's challenge screen. Kept separate from the SIGNED_IN listener's
// own gateOnMfaChallenge call (rather than re-running that same check) since this is invoked
// directly from a user action with the code in hand - no need to re-derive anything, just verify.
export async function verifyMfaChallenge(code) {
  const factorId = STATE.mfaChallenge?.factorId;
  if (!factorId) throw new Error('No pending two-factor challenge.');
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: String(code).trim() });
  if (error) throw error;
  setState({ mfaChallenge: null });
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    await loadProfile(session.user.id);
    await logAudit('Login', '');
    await recordLoginEvent('login');
  }
}

async function loadProfile(userId) {
  // Fired together rather than fetching user_permissions only after learning the role isn't
  // admin: userId alone is enough to kick both off, and waiting on them sequentially cost every
  // non-admin sign-in/session-restore a full second round trip an admin never paid (admin
  // permissions are just PERM_FULL for every area, built locally with no query at all) - visible
  // as admins landing on the dashboard noticeably faster than everyone else. The only cost is an
  // admin's session also fetches a user_permissions row set it then ignores below, which is a
  // handful of rows at most.
  const [{ data: profile, error }, { data: perms }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
    supabase.from('user_permissions').select('*').eq('user_id', userId),
  ]);

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
    for (const area of PERMISSION_AREAS) {
      const row = (perms || []).find((p) => p.area === area);
      permissions[area] = row
        ? { view: row.can_view, add: row.can_add, edit: row.can_edit, delete: row.can_delete, export: row.can_export }
        : { ...PERM_NONE };
    }
  }

  STATE.user = profile;
  STATE.permissions = permissions;
  // A client-role login only has one real page to be on - this runs on every session restore,
  // including a hard browser refresh (getSession() -> loadProfile() on init, same as a fresh
  // SIGNED_IN), so a client landing back on their own Campaign Monitor after refreshing needs no
  // separate mechanism beyond forcing it here. Left alone if they're on Account (changing their
  // password), so this doesn't fight a page they navigated to on purpose.
  if (profile.role === 'client' && STATE.page !== 'account') {
    STATE.page = 'clientCampaignMonitor';
  }
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
  // Nothing else to do here - setSession() above fires Supabase's own SIGNED_IN event, and
  // initAuth()'s listener reacts to it: either a two-factor challenge blocks the rest of sign-in
  // (see gateOnMfaChallenge), or loadProfile() runs and the Login audit/history record fires right
  // there, once sign-in is ACTUALLY complete rather than merely "a token was adopted." Recording it
  // here unconditionally would log a login that a wrong or abandoned two-factor code never finished.
}

// IP/location/browser for the Admin > Login History tab - see record-login-event, which resolves
// all of that server-side from the request itself rather than trusting the client. Best-effort and
// never lets a login/logout fail because of it: this is a secondary audit trail, not something
// worth blocking or erroring a real sign-in/out over if the function call itself has a bad moment.
async function recordLoginEvent(event) {
  try {
    await supabase.functions.invoke('record-login-event', { body: { event } });
  } catch (e) {
    console.warn('login history record failed', e);
  }
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
  // Must happen BEFORE signOut() - record-login-event authenticates the caller from this session's
  // own JWT, which stops being valid the moment signOut() below actually completes.
  await recordLoginEvent('logout');
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
