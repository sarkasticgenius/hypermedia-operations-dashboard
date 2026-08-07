import { render } from './state.js';

// Manual opt-in only - deliberately does NOT read prefers-color-scheme, so a user whose OS
// happens to be in dark mode still sees the normal (light) look by default, same as before this
// existed. index.html has a small inline script that applies the saved choice to <html> before
// first paint, so this module doesn't need its own init step.
const STORAGE_KEY = 'hm-ops-theme';

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* private-browsing storage block */ }
  document.documentElement.setAttribute('data-theme', next);
  render();
}

export function renderThemeToggle() {
  return `
    <button class="theme-toggle" type="button" onclick="App.toggleTheme()" title="Toggle dark mode" aria-label="Toggle dark mode">
      <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      <svg class="icon-moon" viewBox="0 0 24 24" fill="currentColor"><path d="M20 14.5A8.5 8.5 0 1110.5 4a6.5 6.5 0 009.5 10.5z"/></svg>
    </button>
  `;
}
