// Which bit of STATE survives a browser refresh. Navigation lives entirely in memory here (there
// is no URL routing in this app), so before this a plain F5 dropped whoever was mid-task on some
// page back onto the default one - losing their place with no way to get back except re-navigating.
// Only the "where was I" keys are kept: not `modal` (a refresh should not reopen a dialog), not
// `pageData` (that is a cache with its own TTL), and nothing about the signed-in user.
//
// sessionStorage rather than localStorage, deliberately - it is per-tab and dies with the tab, so a
// refresh keeps your place while a brand-new tab still starts clean at the default page.
const NAV_PERSIST_KEY = 'hmops.nav';
const NAV_PERSIST_KEYS = ['page', 'activeDashSection', 'activeDashboard', 'activeClientId', 'settingsTab', 'trafficSheetLocation'];

function loadPersistedNav() {
  try {
    const raw = sessionStorage.getItem(NAV_PERSIST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function persistNav() {
  try {
    const out = {};
    for (const k of NAV_PERSIST_KEYS) {
      if (STATE[k] !== undefined && STATE[k] !== null) out[k] = STATE[k];
    }
    sessionStorage.setItem(NAV_PERSIST_KEY, JSON.stringify(out));
  } catch { /* private browsing / storage disabled - navigation just stops surviving refresh */ }
}

// Ephemeral UI/session state. Mirrors the original app's STATE object; actual data now lives in
// Supabase, not here. STATE.user/permissions are populated by auth.js. The nav keys above are
// restored over the defaults so a refresh lands back where the user was.
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
  ...loadPersistedNav(),
};

let rootEl = null;
let renderFn = null;

export function initRender(el, fn) {
  rootEl = el;
  renderFn = fn;
}

// Callbacks run after every render() call, in addition to the normal HTML-string rebuild above.
// Only needed by pages that own a real, persistent (non-string) DOM subtree - e.g. Creative
// Resizer's canvas/video/ffmpeg workspace, which can't be safely torn down and recreated from a
// string every time some unrelated part of the app calls setState() (a toast elsewhere, a
// background data refresh). Such a page keeps its live subtree in a detached element and uses this
// hook to re-attach it into its render()-generated placeholder every time, instead of rebuilding it.
const afterRenderHooks = [];
export function onAfterRender(fn) {
  afterRenderHooks.push(fn);
}

// innerHTML replace on every render kills focus/caret position in whatever input the user is
// typing in - this restores it by id, same trick the original app used. It also tears down and
// rebuilds every DOM node, so any scrollable container snaps back to scrollTop 0 on every
// setState() call - e.g. clicking "+ Add" partway down a long search-result list inside a modal
// (Locations' asset-link search) kicked the whole modal back to the top. Captured/restored the
// same way as focus: by selector rather than by scroll offset stored in STATE, since it's purely
// a rendering artifact, not app state worth persisting.
//
// Same root problem, worse symptom: every modal form field is uncontrolled (its value lives only
// in the DOM, read via document.getElementById(...).value at submit time) and its markup is
// generated from STATE.modal.data - a snapshot taken once when the modal opened. setState() gets
// called constantly for reasons that have nothing to do with the form itself (toggling one checkbox
// in the same modal, an unrelated background auto-refresh elsewhere on the page, another field's
// own onchange handler) - each one blows away and regenerates the whole modal from that stale
// snapshot, silently reverting every other field the user had already typed into. Fixed the same
// way as focus/scroll above: snapshot every field's live value by id right before the innerHTML
// replace, then write it back afterwards for any id that still exists in the new markup.
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

  const fieldSnapshot = {};
  if (modalEl) {
    // type="file" is excluded entirely, not just from the checkbox/radio branch - its .value is a
    // browser-fabricated string (e.g. "C:\fakepath\name.exe") that the browser then REFUSES to
    // write back (throws "may only be programmatically set to the empty string"), and there's no
    // way to restore the actual selected File across an innerHTML rebuild regardless (the DOM node
    // holding it is destroyed). Confirmed live: a re-render mid-upload (any setState(), e.g. the
    // upload's own "Uploading..." toast) threw here and silently aborted the whole upload.
    modalEl.querySelectorAll('input[id]:not([type="file"]), select[id], textarea[id]').forEach((el) => {
      fieldSnapshot[el.id] = (el.type === 'checkbox' || el.type === 'radio') ? { checked: el.checked } : { value: el.value };
    });
  }

  rootEl.innerHTML = renderFn();

  for (const [id, snap] of Object.entries(fieldSnapshot)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if ('checked' in snap) el.checked = snap.checked;
    else el.value = snap.value;
  }

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

  afterRenderHooks.forEach((fn) => fn());
}

export function setState(patch) {
  Object.assign(STATE, patch);
  // Every navigation goes through setState, so this is the one place that needs to record where the
  // user is - see NAV_PERSIST_KEYS above for what is kept and why.
  persistNav();
  render();
}

// Simple cache-and-render-on-arrival pattern for async Supabase fetches inside a synchronous
// HTML-string render function: first call kicks off the load and returns null (page shows a
// loading placeholder); once the promise resolves the data is cached and render() re-runs, so
// this call then returns the cached value. Call invalidate(key) after any mutation to refetch.
//
// Caching layer: entries never used to expire on their own - a page left open (or switched away
// from and back to) kept showing whatever was fetched on its first visit until something
// explicitly called invalidate(), or the whole tab reloaded. Every cached entry now carries a TTL;
// once it's stale, loadData() still returns the cached value immediately (no loading flicker, no
// re-fetch-storm from rapid nav) but kicks off ONE background refetch - render() picks up the
// fresh data as soon as it lands. A failed background refresh just leaves the stale data in place
// rather than surfacing an error over data the user can already see.
const DEFAULT_TTL_MS = 2 * 60 * 1000;

export function loadData(key, loaderFn, ttlMs = DEFAULT_TTL_MS) {
  const entry = STATE.pageData[key];
  if (entry && entry.status === 'ready') {
    if (!entry.revalidating && Date.now() - entry.fetchedAt > ttlMs) {
      entry.revalidating = true;
      loaderFn()
        .then((data) => { STATE.pageData[key] = { status: 'ready', data, fetchedAt: Date.now() }; render(); })
        .catch(() => { entry.revalidating = false; });
    }
    return entry.data;
  }
  if (entry && entry.status === 'error') return { __error: entry.message };
  if (!entry) {
    STATE.pageData[key] = { status: 'loading' };
    loaderFn()
      .then((data) => { STATE.pageData[key] = { status: 'ready', data, fetchedAt: Date.now() }; render(); })
      .catch((err) => { STATE.pageData[key] = { status: 'error', message: err.message || String(err) }; render(); });
  }
  return null;
}

export function invalidate(key) {
  delete STATE.pageData[key];
}

// For periodic/background refresh only - unlike invalidate(), this keeps the existing cached data
// in place (so render() has something to show) and just marks it stale, letting loadData()'s own
// TTL-revalidation logic do a quiet background refetch. invalidate() deletes the entry outright,
// which forces loadData() back into its "loading" branch and returns null - fine after a mutation
// (the page SHOULD show a fresh load), but wrong for a timer-driven refresh, where it produced a
// blank/loading flash every interval even though the page already had perfectly good data to keep
// showing while the new fetch was in flight.
export function revalidate(key) {
  const entry = STATE.pageData[key];
  if (entry && entry.status === 'ready') entry.fetchedAt = 0;
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
