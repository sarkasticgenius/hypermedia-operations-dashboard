import { STATE } from './state.js';

const registry = {};
export function registerModal(type, renderFn) {
  registry[type] = renderFn;
}

export function renderModalRoot() {
  if (!STATE.modal) return '';
  const fn = registry[STATE.modal.type];
  if (!fn) return '';
  // Guards against a spurious click-outside-close firing on/right after the same interaction that
  // opened the modal (seen on some touch browsers as a synthetic click landing on the overlay once
  // it swaps into the DOM mid-tap) - a real click-away more than 300ms after opening still closes
  // it instantly, this only blocks a duplicate close from the opening click itself.
  const openedAt = STATE.modal.openedAt || 0;
  return `
    <div class="modal-overlay" onclick="if(event.target===this && Date.now()-${openedAt}>300) App.closeModal()">
      <div class="modal" onclick="event.stopPropagation()">${fn(STATE.modal.data || {})}</div>
    </div>
  `;
}

export function loadingCard(errorMessage) {
  if (errorMessage) {
    return `<div class="card"><div class="empty">Failed to load: ${errorMessage}</div></div>`;
  }
  return `<div class="page-loading">Loading...</div>`;
}
