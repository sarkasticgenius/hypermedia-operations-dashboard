import { esc } from './format.js';

// Shared tab-bar renderer so every page's tab strip looks and behaves the same, instead of each
// page hand-rolling its own `TABS.map(...)` string. `tabs` is `{ key, label, count? }[]`; `handler`
// is the bare App.* function name (as a string) to call with the clicked tab's key on click.
export function renderTabs(tabs, activeKey, handler) {
  return `<div class="tabs">${tabs.map((t) => `
    <div class="tab${activeKey === t.key ? ' active' : ''}" onclick="${handler}('${t.key}')">
      <span>${esc(t.label)}</span>${t.count != null ? `<span class="tab-count">${t.count}</span>` : ''}
    </div>
  `).join('')}</div>`;
}
