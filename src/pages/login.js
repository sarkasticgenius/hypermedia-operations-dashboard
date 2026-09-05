import { STATE, setState } from '../state.js';
import { login, requestPasswordReset, verifyMfaChallenge } from '../auth.js';
import { supabase } from '../supabaseClient.js';
import { LOGO_IMG } from '../logo.js';
import { esc } from '../lib/format.js';
import { renderThemeToggle } from '../theme.js';

export function renderLogin() {
  if (STATE.loginView === 'forgot') return renderForgotPassword();
  const err = STATE.loginError ? `<div class="login-error">${esc(STATE.loginError)}</div>` : '';
  return `
    <div class="login-wrap">
      <div class="theme-toggle-corner">${renderThemeToggle()}</div>
      <div class="login-card">
        <div class="login-logo">
          <div class="logo-badge logo-badge-lg">${LOGO_IMG}</div>
          <div class="login-title">HYPERMEDIA</div>
        </div>
        <div class="login-sub">Operations Dashboard</div>
        ${err}
        <form onsubmit="App.doLogin(event)">
          <div class="field">
            <label>Username or Email</label>
            <input id="login-email" type="text" autocomplete="username" required value="${esc(STATE.loginEmailDraft || '')}">
          </div>
          <div class="field">
            <label>Password</label>
            <input id="login-password" type="password" autocomplete="current-password" required>
          </div>
          <button class="btn btn-primary btn-full" type="submit" ${STATE.loginBusy ? 'disabled' : ''}>
            ${STATE.loginBusy ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
        <div class="small" style="text-align:center;margin-top:10px;">
          <a href="#" onclick="event.preventDefault();App.setLoginView('forgot')">Forgot password?</a>
        </div>
        <div class="login-hint">
          Sign in with the username or email your admin set up for you. First time setting this
          app up? The first account created (via the seed/bootstrap step) becomes the admin.
        </div>
      </div>
    </div>
  `;
}

export async function doLogin(event) {
  event.preventDefault();
  const identifier = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  setState({ loginBusy: true, loginError: null, loginEmailDraft: identifier });
  try {
    await login(identifier, password);
    setState({ loginBusy: false, loginError: null });
  } catch (e) {
    setState({ loginBusy: false, loginError: e.message || 'Login failed' });
  }
}

export function setLoginView(view) {
  setState({ loginView: view, forgotMsg: null, forgotError: null });
}

// Shown by main.js's rootRender instead of the normal login form/shell whenever STATE.mfaChallenge
// is set (see gateOnMfaChallenge in auth.js) - a password has already been verified and a real,
// if not-yet-fully-authenticated, session exists at this point; this just collects the code and
// hands it to verifyMfaChallenge to finish signing in.
export function renderMfaChallenge() {
  const err = STATE.mfaChallengeError ? `<div class="login-error">${esc(STATE.mfaChallengeError)}</div>` : '';
  return `
    <div class="login-wrap">
      <div class="theme-toggle-corner">${renderThemeToggle()}</div>
      <div class="login-card">
        <div class="login-logo">
          <div class="logo-badge logo-badge-lg">${LOGO_IMG}</div>
          <div class="login-title">HYPERMEDIA</div>
        </div>
        <div class="login-sub">Enter your two-factor code</div>
        ${err}
        <form onsubmit="App.doMfaChallenge(event)">
          <div class="field">
            <label>6-digit code</label>
            <input id="mfa-challenge-code" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6" required autofocus>
          </div>
          <button class="btn btn-primary btn-full" type="submit" ${STATE.mfaChallengeBusy ? 'disabled' : ''}>
            ${STATE.mfaChallengeBusy ? 'Verifying...' : 'Verify'}
          </button>
        </form>
        <div class="small" style="text-align:center;margin-top:10px;">
          <a href="#" onclick="event.preventDefault();App.logout()">Sign in with a different account</a>
        </div>
      </div>
    </div>
  `;
}

export async function doMfaChallenge(event) {
  event.preventDefault();
  const code = document.getElementById('mfa-challenge-code').value.trim();
  setState({ mfaChallengeBusy: true, mfaChallengeError: null });
  try {
    await verifyMfaChallenge(code);
    setState({ mfaChallengeBusy: false, mfaChallengeError: null });
  } catch (e) {
    setState({ mfaChallengeBusy: false, mfaChallengeError: e.message || 'Invalid code - try again.' });
  }
}

// A locked-out user's self-service recovery entry point - separate from doLogin() above. Always
// shows the same generic outcome message regardless of whether the identifier matched a real
// account (see request-password-reset edge function) - so this UI never needs to branch on
// success/failure the way a normal form would, only on whether the request itself failed to send.
function renderForgotPassword() {
  const msg = STATE.forgotMsg ? `<div class="small muted" style="margin-bottom:10px;">${esc(STATE.forgotMsg)}</div>` : '';
  const err = STATE.forgotError ? `<div class="login-error">${esc(STATE.forgotError)}</div>` : '';
  return `
    <div class="login-wrap">
      <div class="theme-toggle-corner">${renderThemeToggle()}</div>
      <div class="login-card">
        <div class="login-logo">
          <div class="logo-badge logo-badge-lg">${LOGO_IMG}</div>
          <div class="login-title">HYPERMEDIA</div>
        </div>
        <div class="login-sub">Reset your password</div>
        ${msg}${err}
        <form onsubmit="App.doRequestPasswordReset(event)">
          <div class="field">
            <label>Username or Email</label>
            <input id="forgot-identifier" type="text" required value="${esc(STATE.forgotIdentifierDraft || '')}">
          </div>
          <button class="btn btn-primary btn-full" type="submit" ${STATE.forgotBusy ? 'disabled' : ''}>
            ${STATE.forgotBusy ? 'Sending...' : 'Send Reset Link'}
          </button>
        </form>
        <div class="small" style="text-align:center;margin-top:10px;">
          <a href="#" onclick="event.preventDefault();App.setLoginView('login')">Back to sign in</a>
        </div>
      </div>
    </div>
  `;
}

export async function doRequestPasswordReset(event) {
  event.preventDefault();
  const identifier = document.getElementById('forgot-identifier').value.trim();
  setState({ forgotBusy: true, forgotError: null, forgotMsg: null, forgotIdentifierDraft: identifier });
  try {
    const summary = await requestPasswordReset(identifier);
    setState({ forgotBusy: false, forgotMsg: summary });
  } catch (e) {
    setState({ forgotBusy: false, forgotError: e.message || 'Something went wrong - try again.' });
  }
}

// Shown instead of the normal login/shell whenever STATE.passwordRecoveryMode is set (src/auth.js
// sets this from the PASSWORD_RECOVERY auth event, which Supabase's client fires automatically
// once it parses a genuine recovery link's token out of the URL) - a temporary, recovery-scoped
// session already exists at this point, just enough to call auth.updateUser(), not a normal login.
export function renderPasswordRecovery() {
  const err = STATE.recoveryError ? `<div class="login-error">${esc(STATE.recoveryError)}</div>` : '';
  return `
    <div class="login-wrap">
      <div class="theme-toggle-corner">${renderThemeToggle()}</div>
      <div class="login-card">
        <div class="login-logo">
          <div class="logo-badge logo-badge-lg">${LOGO_IMG}</div>
          <div class="login-title">HYPERMEDIA</div>
        </div>
        <div class="login-sub">Set a new password</div>
        ${err}
        <form onsubmit="App.doSetRecoveredPassword(event)">
          <div class="field">
            <label>New Password</label>
            <input id="recovery-password" type="password" minlength="8" required autocomplete="new-password">
          </div>
          <button class="btn btn-primary btn-full" type="submit" ${STATE.recoveryBusy ? 'disabled' : ''}>
            ${STATE.recoveryBusy ? 'Saving...' : 'Set Password & Continue'}
          </button>
        </form>
      </div>
    </div>
  `;
}

export async function doSetRecoveredPassword(event) {
  event.preventDefault();
  const password = document.getElementById('recovery-password').value;
  setState({ recoveryBusy: true, recoveryError: null });
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    setState({ recoveryBusy: false, recoveryError: null, passwordRecoveryMode: false });
  } catch (e) {
    setState({ recoveryBusy: false, recoveryError: e.message || 'Could not set password' });
  }
}
