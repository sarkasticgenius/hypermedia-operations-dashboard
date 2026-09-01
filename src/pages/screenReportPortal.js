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

// Phones routinely hand this form a 3-8MB photo straight off the camera, and this is a no-login
// portal reached by QR code - whoever's reporting could be on weak mall/station wifi. Downscaling
// client-side (the only compression reliably available in a browser with no extra library) is what
// keeps the upload fast and keeps the attachments bucket from growing indefinitely. Real video
// transcoding isn't practical client-side, so video just gets a hard size cap instead - see
// fileToMediaItem.
const MAX_IMAGE_DIMENSION = 1600;
const IMAGE_JPEG_QUALITY = 0.8;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

// Never upscales (scale is capped at 1) - an already-small image is re-encoded as-is, not blown up.
function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY));
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Could not decode image')); };
    img.src = objectUrl;
  });
}

// The downscaled output is always a JPEG regardless of the source format, so the name travelling
// with it needs to say so too - the edge function derives the storage path's extension straight
// from this name, and a stale ".png"/".heic" on real JPEG bytes would mislead anyone who later
// opens the file directly by its path.
function withJpgExtension(name) {
  const dot = name.lastIndexOf('.');
  return `${dot === -1 ? name : name.slice(0, dot)}.jpg`;
}

async function fileToMediaItem(file) {
  if (file.type.startsWith('image/')) {
    try {
      return { name: withJpgExtension(file.name), dataUrl: await downscaleImage(file) };
    } catch {
      // An unusual/undecodable image format (falls through to the raw upload below) shouldn't
      // block the whole report over one bad file.
    }
  }
  if (file.type.startsWith('video/') && file.size > MAX_VIDEO_BYTES) {
    throw new Error(`"${file.name}" is over ${(MAX_VIDEO_BYTES / (1024 * 1024)).toFixed(0)}MB - please attach a shorter clip or a lower-resolution export.`);
  }
  return { name: file.name, dataUrl: await fileToDataUrl(file) };
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
      <div class="field"><label>Photo/Video (optional, up to 5, video max 50MB each)</label><input id="portal-media" type="file" accept="image/*,video/*" multiple></div>
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
      const media = await Promise.all(files.map(fileToMediaItem));
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
