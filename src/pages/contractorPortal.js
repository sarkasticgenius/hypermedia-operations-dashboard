import { supabase } from '../supabaseClient.js';
import { LOGO_IMG } from '../logo.js';
import { esc } from '../lib/format.js';

const state = { ticketId: null, ticket: null, error: null, busy: false, done: false };

export function initContractorPortal() {
  const params = new URLSearchParams(window.location.search);
  state.ticketId = params.get('ticket');
  return !!(params.get('portal') === 'close' && state.ticketId);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function loadTicket() {
  const { data, error } = await supabase.functions.invoke('close-ticket-portal', {
    body: { action: 'get', ticketId: state.ticketId },
  });
  if (error || data?.error) {
    state.error = data?.error || error.message;
  } else {
    state.ticket = data.ticket;
  }
}

export async function renderContractorPortal() {
  if (!state.ticket && !state.error) await loadTicket();

  if (state.error) {
    return wrap(`<div class="login-error">${esc(state.error)}</div>`);
  }
  if (state.done) {
    return wrap(`<div class="banner">Ticket closed. Thank you.</div>`);
  }
  const t = state.ticket;
  if (t.status === 'Closed') {
    return wrap(`<div class="banner">This ticket is already closed.</div>`);
  }

  return wrap(`
    <div class="field"><label>Ticket</label><div><strong>${esc(t.title)}</strong></div></div>
    <div class="field"><label>Location</label><div>${esc(t.location || '-')}</div></div>
    <div class="field"><label>Description</label><div class="small muted">${esc(t.description || '-')}</div></div>
    <form id="portal-form">
      <div class="field"><label>Your Name</label><input id="portal-closed-by" required></div>
      <div class="field"><label>Root Cause</label><textarea id="portal-root-cause" rows="3" required></textarea></div>
      <div class="field"><label>Photo/Video (optional, up to 5)</label><input id="portal-media" type="file" accept="image/*,video/*" multiple></div>
      <button class="btn btn-primary btn-full" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Submitting...' : 'Close Ticket'}</button>
    </form>
  `);
}

function wrap(inner) {
  return `
    <div class="login-wrap">
      <div class="login-card" style="width:420px;">
        <div class="login-logo"><div class="logo-badge logo-badge-lg">${LOGO_IMG}</div><div class="login-title">HYPERMEDIA</div></div>
        <div class="login-sub">Close Ticket</div>
        ${inner}
      </div>
    </div>
  `;
}

export function bindContractorPortalForm(rerender) {
  const form = document.getElementById('portal-form');
  if (!form) return;
  form.onsubmit = async (event) => {
    event.preventDefault();
    state.busy = true;
    rerender();
    try {
      const closedBy = document.getElementById('portal-closed-by').value.trim();
      const rootCause = document.getElementById('portal-root-cause').value.trim();
      const files = Array.from(document.getElementById('portal-media').files || []).slice(0, 5);
      const media = await Promise.all(files.map(async (f) => ({ name: f.name, dataUrl: await fileToDataUrl(f) })));
      const { data, error } = await supabase.functions.invoke('close-ticket-portal', {
        body: { action: 'close', ticketId: state.ticketId, closedBy, rootCause, media },
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
