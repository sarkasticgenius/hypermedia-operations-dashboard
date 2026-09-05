import { STATE, setState, toast, loadData, invalidate } from '../state.js';
import { supabase } from '../supabaseClient.js';
import { changeOwnPassword } from '../auth.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';

export function renderAccount() {
  const u = STATE.user;
  return `
    <div class="card">
      <div class="card-head"><h3>Profile</h3></div>
      <form onsubmit="App.saveAccountProfile(event)">
        <div class="grid2">
          <div class="field"><label>Name</label><input id="acct-name" value="${esc(u.name || '')}" required></div>
          <div class="field"><label>Title</label><input id="acct-title" value="${esc(u.title || '')}"></div>
        </div>
        <div class="field"><label>Username</label><input value="${esc(u.username || '')}" disabled></div>
        <button class="btn btn-orange" type="submit">Save profile</button>
      </form>
    </div>
    <div class="card">
      <div class="card-head"><h3>Change password</h3></div>
      <form onsubmit="App.saveAccountPassword(event)">
        <div class="field"><label>New password</label><input id="acct-password" type="password" minlength="8" required></div>
        <button class="btn btn-orange" type="submit">Update password</button>
      </form>
    </div>
    <div class="card">
      <div class="card-head"><h3>Two-Factor Authentication</h3></div>
      ${renderMfaSection()}
    </div>
  `;
}

export async function saveAccountProfile(event) {
  event.preventDefault();
  const name = document.getElementById('acct-name').value.trim();
  const title = document.getElementById('acct-title').value.trim();
  const { error } = await supabase.from('profiles').update({ name, title }).eq('id', STATE.user.id);
  if (error) { toast(error.message, 'error'); return; }
  await logAudit('Edit own profile', '');
  setState({ user: { ...STATE.user, name, title } });
  toast('Profile updated');
}

export async function saveAccountPassword(event) {
  event.preventDefault();
  const password = document.getElementById('acct-password').value;
  try {
    await changeOwnPassword(password);
    toast('Password updated');
    setState({});
  } catch (e) {
    toast(e.message || 'Failed to update password', 'error');
  }
}

// Every account's MFA enrollment state, straight from Supabase Auth (auth.mfa_factors isn't
// exposed to the client via PostgREST/RLS at all - this is the real, first-party way to read it).
async function listMfaFactors() {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return data;
}

// Opt-in only - nothing here is ever forced on anyone. An account that never enrolls a factor
// never sees the login challenge either (see gateOnMfaChallenge in auth.js), so this card is the
// entire feature surface: enabling it is the only way it ever affects a login.
function renderMfaSection() {
  const factors = loadData('mfaFactors', listMfaFactors);
  if (factors === null) return '<div class="small muted">Loading...</div>';
  if (factors?.__error) return `<div class="small" style="color:#c0392b;">${esc(factors.__error)}</div>`;
  const verified = (factors.totp || []).find((f) => f.status === 'verified');

  if (STATE.mfaEnroll) {
    const err = STATE.mfaEnroll.error ? `<div class="login-error" style="margin-bottom:10px;">${esc(STATE.mfaEnroll.error)}</div>` : '';
    return `
      <div class="small muted" style="margin-bottom:10px;">Scan this with an authenticator app (Google Authenticator, Authy, 1Password, etc.), then enter the 6-digit code it shows.</div>
      <div style="max-width:220px;margin-bottom:10px;">${STATE.mfaEnroll.qr}</div>
      <div class="small muted" style="margin-bottom:10px;">Can't scan it? Enter this key manually: <code>${esc(STATE.mfaEnroll.secret)}</code></div>
      ${err}
      <form onsubmit="App.verifyAccountMfaEnrollment(event)">
        <div class="field"><label>6-digit code</label><input id="acct-mfa-code" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6" required autofocus></div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-orange" type="submit" ${STATE.mfaEnroll.busy ? 'disabled' : ''}>${STATE.mfaEnroll.busy ? 'Verifying...' : 'Verify & Enable'}</button>
          <button type="button" class="btn-sm" onclick="App.cancelAccountMfaEnrollment()">Cancel</button>
        </div>
      </form>
    `;
  }

  if (verified) {
    return `
      <div class="small" style="margin-bottom:10px;"><span class="badge b-green">Enabled</span> Two-factor authentication is protecting this account.</div>
      <button class="btn-sm" style="color:#c0392b;" onclick="App.removeAccountMfaFactor('${verified.id}')">Remove Two-Factor Authentication</button>
    `;
  }

  return `
    <div class="small muted" style="margin-bottom:10px;">Not enabled. Two-factor authentication adds a code from your phone on top of your password - entirely optional.</div>
    <button class="btn btn-orange" onclick="App.startAccountMfaEnrollment()">Enable Two-Factor Authentication</button>
  `;
}

export async function startAccountMfaEnrollment() {
  try {
    // Without an explicit issuer, Supabase labels the factor in the authenticator app using this
    // project's configured Site URL - which shows up as something like "localhost:3000" rather
    // than anything a person setting this up on their phone would recognize.
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', issuer: 'Hypermedia Ops', friendlyName: 'Hypermedia Ops' });
    if (error) throw error;
    setState({ mfaEnroll: { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret, busy: false, error: null } });
  } catch (e) {
    toast(e.message || 'Could not start two-factor setup', 'error');
  }
}

export async function verifyAccountMfaEnrollment(event) {
  event.preventDefault();
  const code = document.getElementById('acct-mfa-code').value.trim();
  const factorId = STATE.mfaEnroll?.factorId;
  setState({ mfaEnroll: { ...STATE.mfaEnroll, busy: true, error: null } });
  try {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) throw error;
    await logAudit('Enable two-factor authentication', '');
    setState({ mfaEnroll: null });
    invalidate('mfaFactors');
    toast('Two-factor authentication enabled');
  } catch (e) {
    setState({ mfaEnroll: { ...STATE.mfaEnroll, busy: false, error: e.message || 'Invalid code - try again.' } });
  }
}

export async function cancelAccountMfaEnrollment() {
  const factorId = STATE.mfaEnroll?.factorId;
  setState({ mfaEnroll: null });
  // Best-effort: an unverified factor left behind is harmless (it never counts as "enrolled"
  // anywhere this app checks), so a failure here isn't worth surfacing to the user.
  if (factorId) {
    try { await supabase.auth.mfa.unenroll({ factorId }); } catch {}
  }
}

export async function removeAccountMfaFactor(factorId) {
  if (!confirm('Remove two-factor authentication from your account? Only your password will be needed to sign in afterward.')) return;
  try {
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    if (error) throw error;
    await logAudit('Remove two-factor authentication', '');
    invalidate('mfaFactors');
    toast('Two-factor authentication removed');
    setState({});
  } catch (e) {
    toast(e.message || 'Could not remove two-factor authentication', 'error');
  }
}
