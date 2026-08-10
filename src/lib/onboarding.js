import { STATE, setState } from '../state.js';
import { esc } from './format.js';

// Explanatory (not functional/status) banners across the app - "here's what this page is",
// "here's where a feature moved to" - were previously shown to every user on every visit
// regardless of role. Admins still see them that way (persistent, every visit - they're the ones
// who actually act on some of this, e.g. permission/config notes), but team/client users now see
// a one-time dismissible tip instead: shown once, "Got it" marks it seen, never shown again for
// that user. Persisted in localStorage (not sessionStorage) since "one-time" here means once ever,
// not once per browser session - keyed per-user so a shared machine doesn't cross-dismiss between
// different logins.
const STORAGE_KEY = 'hm-ops-onboarding-seen';

function seenSet() {
  try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); }
  catch (_) { return new Set(); }
}

function tipKey(tipId) {
  return `${STATE.user?.id || 'anon'}:${tipId}`;
}

export function hasSeenTip(tipId) {
  return seenSet().has(tipKey(tipId));
}

export function dismissOnboardingTip(tipId) {
  const seen = seenSet();
  seen.add(tipKey(tipId));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...seen])); } catch (_) { /* private-browsing storage block */ }
  setState({});
}

// isPersistent: true for whoever should keep seeing this every visit (an admin, or a team member
// with the relevant edit permission on pages that use that instead of the admin role - callers
// pass whichever check already gates that page's own elevated actions, not necessarily isAdmin()
// specifically). Returns '' once a non-persistent viewer has dismissed it.
export function renderInfoBanner(tipId, message, isPersistent) {
  if (isPersistent) return `<div class="banner">${message}</div>`;
  if (hasSeenTip(tipId)) return '';
  return `<div class="banner" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
    <span>${message}</span>
    <button class="btn-sm" onclick="App.dismissOnboardingTip('${esc(tipId)}')">Got it</button>
  </div>`;
}
