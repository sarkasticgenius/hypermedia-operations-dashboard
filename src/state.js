// Ephemeral UI/session state - never persisted. Mirrors the original app's STATE object;
// actual data now lives in Supabase, not here. STATE.user/permissions are populated by auth.js.
export const STATE = {
  page: 'dashboard',
  modal: null,
  user: null,
  permissions: {},
  navExpanded: {},
  activeDashSection: null,
  activeDashboard: null,
  loading: false,
  toasts: [],
  pageData: {},
};

let rootEl = null;
let renderFn = null;

export function initRender(el, fn) {
  rootEl = el;
  renderFn = fn;
}

// innerHTML replace on every render kills focus/caret position in whatever input the user is
// typing in - this restores it by id, same trick the original app used. It also tears down and
// rebuilds every DOM node, so any scrollable container snaps back to scrollTop 0 on every
// setState() call - e.g. clicking "+ Add" partway down a long search-result list inside a modal
// (Locations' asset-link search) kicked the whole modal back to the top. Captured/restored the
// same way as focus: by selector rather than by scroll offset stored in STATE, since it's purely
// a rendering artifact, not app state worth persisting.
export function render() {
  if (!renderFn || !rootEl) return;
  const active = document.activeElement;
  const activeId = active && active.id ? active.id : null;
  const hasSelection = active && 'selectionStart' in active;
  const selStart = hasSelection ? active.selectionStart : null;
  const selEnd = hasSelection ? active.selectionEnd : null;

  const modalEl = document.querySelector('.modal');
  const modalScroll = modalEl ? modalEl.scrollTop : null;
  const contentEl = document.querySelector('.content');
  const contentScroll = contentEl ? contentEl.scrollTop : null;

  rootEl.innerHTML = renderFn();

  if (activeId) {
    const restored = document.getElementById(activeId);
    if (restored) {
      restored.focus();
      if (selStart != null && restored.setSelectionRange) {
        try { restored.setSelectionRange(selStart, selEnd); } catch (e) { /* not a text input */ }
      }
    }
  }
  if (modalScroll != null) {
    const newModal = document.querySelector('.modal');
    if (newModal) newModal.scrollTop = modalScroll;
  }
  if (contentScroll != null) {
    const newContent = document.querySelector('.content');
    if (newContent) newContent.scrollTop = contentScroll;
  }
}

export function setState(patch) {
  Object.assign(STATE, patch);
  render();
}

// Simple cache-and-render-on-arrival pattern for async Supabase fetches inside a synchronous
// HTML-string render function: first call kicks off the load and returns null (page shows a
// loading placeholder); once the promise resolves the data is cached and render() re-runs, so
// this call then returns the cached value. Call invalidate(key) after any mutation to refetch.
export function loadData(key, loaderFn) {
  const entry = STATE.pageData[key];
  if (entry && entry.status === 'ready') return entry.data;
  if (entry && entry.status === 'error') return { __error: entry.message };
  if (!entry) {
    STATE.pageData[key] = { status: 'loading' };
    loaderFn()
      .then((data) => { STATE.pageData[key] = { status: 'ready', data }; render(); })
      .catch((err) => { STATE.pageData[key] = { status: 'error', message: err.message || String(err) }; render(); });
  }
  return null;
}

export function invalidate(key) {
  delete STATE.pageData[key];
}

export function openModal(type, data) {
  setState({ modal: { type, data: data || {}, openedAt: Date.now() } });
}

export function closeModal() {
  setState({ modal: null });
}

let toastId = 0;
export function toast(message, kind) {
  const id = ++toastId;
  STATE.toasts.push({ id, message, kind: kind || 'info' });
  render();
  setTimeout(() => {
    STATE.toasts = STATE.toasts.filter((t) => t.id !== id);
    render();
  }, 4000);
}

export function renderToasts() {
  return STATE.toasts
    .map((t) => `<div class="toast${t.kind === 'error' ? ' error' : ''}">${t.message}</div>`)
    .join('');
}
