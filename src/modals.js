import { STATE } from './state.js';

const registry = {};
export function registerModal(type, renderFn) {
  registry[type] = renderFn;
}

export function renderModalRoot() {
  if (!STATE.modal) return '';
  const fn = registry[STATE.modal.type];
  if (!fn) return '';
  return `
    <div class="modal-overlay" onclick="if(event.target===this) App.closeModal()">
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
