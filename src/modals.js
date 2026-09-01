import { STATE } from './state.js';

const registry = {};
// Modals registered with { wide: true } (tables too wide for the default 480px to show without a
// horizontal scrollbar - e.g. offlineAssetsModal's Location/Name/Detail/Remote Access columns)
// render at 900px instead. max-width:92vw still comes from the .modal class either way, so this
// stays responsive on a narrow viewport - it only widens the modal where the content actually needs it.
const wideTypes = new Set();
export function registerModal(type, renderFn, opts) {
  registry[type] = renderFn;
  if (opts?.wide) wideTypes.add(type);
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
  const wideStyle = wideTypes.has(STATE.modal.type) ? ' style="width:900px;"' : '';
  return `
    <div class="modal-overlay" onclick="if(event.target===this && Date.now()-${openedAt}>300) App.closeModal()">
      <div class="modal"${wideStyle} onclick="event.stopPropagation()">${fn(STATE.modal.data || {})}</div>
    </div>
  `;
}

export function loadingCard(errorMessage) {
  if (errorMessage) {
    return `<div class="card"><div class="empty">Failed to load: ${errorMessage}</div></div>`;
  }
  return `<div class="page-loading">Loading...</div>`;
}
