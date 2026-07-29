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
// typing in - this restores it by id, same trick the original app used.
export function render() {
  if (!renderFn || !rootEl) return;
  const active = document.activeElement;
  const activeId = active && active.id ? active.id : null;
  const hasSelection = active && 'selectionStart' in active;
  const selStart = hasSelection ? active.selectionStart : null;
  const selEnd = hasSelection ? active.selectionEnd : null;

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
  setState({ modal: { type, data: data || {} } });
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
