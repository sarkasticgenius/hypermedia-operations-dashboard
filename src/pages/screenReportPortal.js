// The no-login screen-issue-report portal - reached by scanning the QR code stuck on a physical
// screen (?portal=report&asset=<id>). Mirrors contractorPortal.js's standalone render loop (no
// STATE/auth involved at all) since this visitor never signs in.
import { supabase } from '../supabaseClient.js';
import { LOGO_IMG } from '../logo.js';
import { esc } from '../lib/format.js';

const state = { assetId: null, asset: null, error: null, busy: false, done: false };

export function initScreenReportPortal() {
  const params = new URLSearchParams(window.location.search);
  state.assetId = params.get('asset');
  return !!(params.get('portal') === 'report' && state.assetId);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function loadAsset() {
  const { data, error } = await supabase.functions.invoke('screen-report-portal', {
    body: { action: 'get', assetId: state.assetId },
  });
  if (error || data?.error) {
    state.error = data?.error || error.message;
  } else {
    state.asset = data.asset;
  }
}

export async function renderScreenReportPortal() {
  if (!state.asset && !state.error) await loadAsset();

  if (state.error) {
    return wrap(`<div class="login-error">${esc(state.error)}</div>`);
  }
  if (state.done) {
    return wrap(`<div class="banner">Thanks - your report has been sent to our team.</div>`);
  }
  const a = state.asset;

  return wrap(`
    <div class="field"><label>Screen</label><div><strong>${esc(a.name)}</strong></div></div>
    <div class="field"><label>Location</label><div class="small muted">${esc(a.venue || '-')}${a.location ? ` &middot; ${esc(a.location)}` : ''}</div></div>
    <form id="portal-form">
      <div class="field"><label>What's wrong with this screen?</label><textarea id="portal-description" rows="3" required placeholder="e.g. Black screen, flickering, no sound..."></textarea></div>
      <div class="field"><label>Your Name (optional)</label><input id="portal-reporter-name"></div>
      <div class="field"><label>Photo/Video (optional, up to 5)</label><input id="portal-media" type="file" accept="image/*,video/*" multiple></div>
      <button class="btn btn-primary btn-full" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Submitting...' : 'Report Issue'}</button>
    </form>
  `);
}

function wrap(inner) {
  return `
    <div class="login-wrap">
      <div class="login-card" style="width:420px;">
        <div class="login-logo"><div class="logo-badge logo-badge-lg">${LOGO_IMG}</div><div class="login-title">HYPERMEDIA</div></div>
        <div class="login-sub">Report a Screen Issue</div>
        ${inner}
      </div>
    </div>
  `;
}

export function bindScreenReportPortalForm(rerender) {
  const form = document.getElementById('portal-form');
  if (!form) return;
  form.onsubmit = async (event) => {
    event.preventDefault();
    state.busy = true;
    rerender();
    try {
      const description = document.getElementById('portal-description').value.trim();
      const reporterName = document.getElementById('portal-reporter-name').value.trim();
      const files = Array.from(document.getElementById('portal-media').files || []).slice(0, 5);
      const media = await Promise.all(files.map(async (f) => ({ name: f.name, dataUrl: await fileToDataUrl(f) })));
      const { data, error } = await supabase.functions.invoke('screen-report-portal', {
        body: { action: 'submit', assetId: state.assetId, description, reporterName, media },
      });
      if (error || data?.error) throw new Error(data?.error || error.message);
      state.done = true;
    } catch (e) {
      state.error = e.message;
    } finally {
      state.busy = false;
      rerender();
    }
  };
}
