import { supabase } from './supabaseClient.js';
import { STATE, setState, render } from './state.js';
import { logAudit } from './lib/audit.js';

// Same 12 areas / 5-flag model as the original app's PERMISSION_AREAS + PERM_NONE/PERM_FULL.
export const PERMISSION_AREAS = [
  'assets', 'assetsInventory', 'orders', 'locations', 'campaigns', 'staticCampaigns',
  'permits', 'metroPic', 'tickets', 'simCards', 'pdooh', 'dashboards',
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

export async function login(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  await logAudit('Login', '');
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

export function permObj(area) {
  return isAdmin() ? PERM_FULL : (STATE.permissions[area] || PERM_NONE);
}

export function canView(area) { return !!permObj(area).view; }
export function canAdd(area) { return !!permObj(area).add; }
export function canEdit(area) { return !!permObj(area).edit; }
export function canDelete(area) { return !!permObj(area).delete; }
export function canExportArea(area) { return !!permObj(area).export; }
