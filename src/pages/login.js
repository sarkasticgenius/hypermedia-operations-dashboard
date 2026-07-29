import { STATE, setState } from '../state.js';
import { login } from '../auth.js';
import { LOGO_IMG } from '../logo.js';
import { esc } from '../lib/format.js';

export function renderLogin() {
  const err = STATE.loginError ? `<div class="login-error">${esc(STATE.loginError)}</div>` : '';
  return `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-logo">
          <div class="logo-badge logo-badge-lg">${LOGO_IMG}</div>
          <div class="login-title">HYPERMEDIA</div>
        </div>
        <div class="login-sub">Operations Dashboard</div>
        ${err}
        <form onsubmit="App.doLogin(event)">
          <div class="field">
            <label>Email</label>
            <input id="login-email" type="email" autocomplete="username" required value="${esc(STATE.loginEmailDraft || '')}">
          </div>
          <div class="field">
            <label>Password</label>
            <input id="login-password" type="password" autocomplete="current-password" required>
          </div>
          <button class="btn btn-primary btn-full" type="submit" ${STATE.loginBusy ? 'disabled' : ''}>
            ${STATE.loginBusy ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
        <div class="login-hint">
          Sign in with the email your admin created for you. First time setting this app up?
          The first account created (via the seed/bootstrap step) becomes the admin.
        </div>
      </div>
    </div>
  `;
}

export async function doLogin(event) {
  event.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  setState({ loginBusy: true, loginError: null, loginEmailDraft: email });
  try {
    await login(email, password);
    setState({ loginBusy: false, loginError: null });
  } catch (e) {
    setState({ loginBusy: false, loginError: e.message || 'Login failed' });
  }
}
