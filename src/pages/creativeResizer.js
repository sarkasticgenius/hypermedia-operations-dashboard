import { esc } from '../lib/format.js';
import { onAfterRender } from '../state.js';

// Creative Resizer: resizes/re-renders images (Canvas) and video (ffmpeg.wasm, or a local native-
// ffmpeg helper if one is running on 127.0.0.1:8765) to one or more target output sizes, entirely
// client-side. Ported from a standalone tool (Creative Resizer.html) into this app as its own
// workspace/page.
//
// Everything below (dropzone, queue, canvas rendering, ffmpeg loading/encoding, results grid, ZIP
// download) is built and driven with plain DOM APIs against a single detached root element rather
// than through this app's usual render-a-string-on-every-setState() pattern. That's deliberate: the
// rest of the app rebuilds #app's whole innerHTML from a string on every setState() anywhere (a
// toast elsewhere, a background data refresh, a theme toggle) - fine for stateless markup, but fatal
// here since this page holds a File, in-flight Blob/object-URL results, a loaded ffmpeg instance and
// a possibly-mid-encode job queue that can't be serialized into a template string and reconstructed.
// Instead the real workspace element is built once, kept alive in `widgetEl` for the lifetime of the
// tab, and re-attached (moved, never recreated) into its render()-generated placeholder via
// onAfterRender() every time the app re-renders - see state.js's onAfterRender for the hook itself.
const MOUNT_ID = 'cr-mount-point';

const PRESETS = [
  { label: 'Landscape 4K', sub: '16:9 signage', w: 3840, h: 2160 },
  { label: 'Full HD', sub: '16:9 screens', w: 1920, h: 1080 },
  { label: 'Portrait 4K', sub: '9:16 signage', w: 2160, h: 3840 },
  { label: 'Ultra-wide Banner', sub: '11.25:1', w: 4320, h: 384 },
];

const LOCAL_SERVER = 'http://127.0.0.1:8765';

let widgetEl = null;

export function renderCreativeResizer() {
  return `
    <div class="cr-page">
      <p class="cr-intro">Resize and re-render images and videos to any target output size, entirely in your browser. Add one or more sizes below, render them, then download individually or all at once as a ZIP.</p>
      <div id="${MOUNT_ID}"></div>
    </div>
  `;
}

onAfterRender(() => {
  const mount = document.getElementById(MOUNT_ID);
  if (!mount) return;
  if (!widgetEl) widgetEl = buildWidget();
  if (mount.firstChild !== widgetEl) mount.appendChild(widgetEl);
});

function buildWidget() {
  const root = document.createElement('div');
  root.className = 'cr-workspace';
  root.innerHTML = `
    <style>${CSS}</style>
    <div class="cr-shell">
      <div class="cr-panel cr-panel-left">
        <section>
          <h2>1 &middot; Source File</h2>
          <div class="cr-dropzone" id="cr-dropzone">
            <div class="cr-icon">&#128193;</div>
            <div class="cr-main">Click to choose, or drop a file here</div>
            <div class="cr-sub">Images (JPG, PNG, WebP) or Video (MP4, MOV, WebM)</div>
          </div>
          <input type="file" id="cr-fileInput" accept="image/*,video/*" />
          <div class="cr-file-info" id="cr-fileInfo"></div>
          <button class="cr-clear-btn" id="cr-clearBtn" style="display:none;">Remove file &amp; start over</button>
        </section>

        <section id="cr-sizeSection" style="display:none;">
          <h2>2 &middot; Add Output Sizes</h2>
          <div class="cr-preset-grid" id="cr-presetGrid"></div>
          <div class="cr-custom-row">
            <input type="number" id="cr-customW" placeholder="Width" min="1" max="8000" />
            <span>&times;</span>
            <input type="number" id="cr-customH" placeholder="Height" min="1" max="8000" />
            <button class="cr-add-custom-btn" id="cr-addCustomBtn">+ Add</button>
          </div>
        </section>

        <section id="cr-queueSection" style="display:none;">
          <h2>3 &middot; Output Queue</h2>
          <div class="cr-engine-badge" id="cr-engineBadge" style="display:none;"></div>
          <div class="cr-queue-list" id="cr-queueList">
            <div class="cr-queue-empty">No output sizes added yet &mdash; pick a preset above.</div>
          </div>
          <button class="cr-btn-primary" id="cr-renderBtn" disabled>Render All</button>
          <div class="cr-notice" id="cr-engineNotice" style="display:none;"></div>
        </section>
      </div>

      <div class="cr-panel cr-panel-right">
        <div class="cr-empty-state" id="cr-emptyState">
          <div class="cr-big">&#128444;&#65039; &#127916;</div>
          <div>Choose an image or video on the left to get started.</div>
        </div>

        <div id="cr-workArea" style="display:none;">
          <div class="cr-original-preview" id="cr-originalPreview"></div>
          <div class="cr-section-title-row">
            <h2>Results</h2>
            <button id="cr-downloadAllBtn" hidden>&#11015; Download All (.zip)</button>
          </div>
          <div class="cr-results-grid" id="cr-resultsGrid">
            <div class="cr-queue-empty" style="grid-column:1/-1;">Rendered outputs will appear here.</div>
          </div>
        </div>
      </div>
    </div>
  `;

  wireWidget(root);
  return root;
}

function wireWidget(root) {
  const $ = (sel) => root.querySelector(sel);

  // ---------- State ----------
  let state = {
    file: null,
    type: null, // 'image' | 'video'
    srcURL: null,
    naturalW: 0,
    naturalH: 0,
    duration: 0,
    thumbURL: null,
  };
  let queue = []; // {id, w, h, label, fit, bg, blur, splitPoints, rowGap, status, resultBlob, resultURL, ext, progress}
  let queueIdCounter = 1;
  let ffmpegInstance = null;
  let ffmpegLoading = null;
  let currentJobRef = null;
  let localEngineAvailable = null; // null = unchecked, true/false once known

  // ---------- DOM refs ----------
  const dropzone = $('#cr-dropzone');
  const fileInput = $('#cr-fileInput');
  const fileInfo = $('#cr-fileInfo');
  const clearBtn = $('#cr-clearBtn');
  const sizeSection = $('#cr-sizeSection');
  const presetGrid = $('#cr-presetGrid');
  const customW = $('#cr-customW');
  const customH = $('#cr-customH');
  const addCustomBtn = $('#cr-addCustomBtn');
  const queueSection = $('#cr-queueSection');
  const queueList = $('#cr-queueList');
  const renderBtn = $('#cr-renderBtn');
  const engineNotice = $('#cr-engineNotice');
  const engineBadge = $('#cr-engineBadge');
  const emptyState = $('#cr-emptyState');
  const workArea = $('#cr-workArea');
  const originalPreview = $('#cr-originalPreview');
  const resultsGrid = $('#cr-resultsGrid');
  const downloadAllBtn = $('#cr-downloadAllBtn');

  // ---------- Preset buttons ----------
  PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = 'cr-preset-btn';
    btn.innerHTML = `<span class="cr-p-label">${esc(p.label)}</span><span class="cr-p-dims">${p.w}&times;${p.h} &middot; ${esc(p.sub)}</span>`;
    btn.addEventListener('click', () => addToQueue(p.w, p.h, p.label));
    presetGrid.appendChild(btn);
  });

  addCustomBtn.addEventListener('click', () => {
    const w = parseInt(customW.value, 10);
    const h = parseInt(customH.value, 10);
    if (!w || !h || w < 1 || h < 1 || w > 8000 || h > 8000) {
      alert('Enter a valid width and height (1-8000 px each).');
      return;
    }
    addToQueue(w, h, 'Custom');
    customW.value = '';
    customH.value = '';
  });

  // ---------- File handling ----------
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
  });
  clearBtn.addEventListener('click', resetAll);

  function handleFile(file) {
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) {
      alert('Please choose an image or video file.');
      return;
    }
    if (state.srcURL) URL.revokeObjectURL(state.srcURL);

    state.file = file;
    state.type = isImage ? 'image' : 'video';
    state.srcURL = URL.createObjectURL(file);

    if (isImage) {
      const img = new Image();
      img.onload = () => {
        state.naturalW = img.naturalWidth;
        state.naturalH = img.naturalHeight;
        state.thumbURL = makeThumbnail(img, state.naturalW, state.naturalH);
        onFileReady();
      };
      img.src = state.srcURL;
    } else {
      const vid = document.createElement('video');
      vid.preload = 'metadata';
      vid.muted = true;
      vid.onloadedmetadata = () => {
        state.naturalW = vid.videoWidth;
        state.naturalH = vid.videoHeight;
        state.duration = vid.duration;
        vid.currentTime = Math.min(0.1, (vid.duration || 0) / 2);
        vid.onseeked = () => {
          state.thumbURL = makeThumbnail(vid, state.naturalW, state.naturalH);
          onFileReady();
        };
      };
      vid.src = state.srcURL;
    }
  }

  // A small still frame used only to draw split-point guide lines over in the queue UI (see
  // splitControlsHtml below) - grabbed once per source rather than re-seeking a live <video> per
  // queue item.
  function makeThumbnail(source, sw, sh) {
    const maxDim = 480;
    const scale = Math.min(1, maxDim / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  function onFileReady() {
    queue.forEach((j) => { if (j.resultURL) URL.revokeObjectURL(j.resultURL); });
    queue = [];
    renderQueueList();
    resultsGrid.innerHTML = '<div class="cr-queue-empty" style="grid-column:1/-1;">Rendered outputs will appear here.</div>';
    downloadAllBtn.hidden = true;

    if (state.type === 'video') {
      localEngineAvailable = null;
      checkLocalEngine();
    } else {
      engineBadge.style.display = 'none';
    }

    fileInfo.classList.add('show');
    fileInfo.innerHTML = `
      <div class="cr-name">${esc(state.file.name)}</div>
      <div class="cr-row"><span>Type</span><b>${state.type === 'image' ? 'Image' : 'Video'}</b></div>
      <div class="cr-row"><span>Dimensions</span><b>${state.naturalW}&times;${state.naturalH}px</b></div>
      ${state.type === 'video' ? `<div class="cr-row"><span>Duration</span><b>${state.duration.toFixed(1)}s</b></div>` : ''}
      <div class="cr-row"><span>Size</span><b>${formatBytes(state.file.size)}</b></div>
    `;
    clearBtn.style.display = 'inline-block';
    sizeSection.style.display = 'block';
    queueSection.style.display = 'block';

    emptyState.style.display = 'none';
    workArea.style.display = 'block';

    originalPreview.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.display = 'flex'; wrap.style.gap = '18px'; wrap.style.alignItems = 'center'; wrap.style.width = '100%';

    const mediaEl = state.type === 'image' ? document.createElement('img') : document.createElement('video');
    mediaEl.src = state.srcURL;
    if (state.type === 'video') mediaEl.controls = true;
    wrap.appendChild(mediaEl);

    const meta = document.createElement('div');
    meta.className = 'cr-original-meta';
    meta.innerHTML = `<div class="cr-of-title">Original</div>
      <div><b>${state.naturalW}&times;${state.naturalH}px</b></div>
      <div>${state.type === 'video' ? `${state.duration.toFixed(1)}s &middot; ` : ''}${formatBytes(state.file.size)}</div>`;
    wrap.appendChild(meta);
    originalPreview.appendChild(wrap);
  }

  function resetAll() {
    if (state.srcURL) URL.revokeObjectURL(state.srcURL);
    state = { file: null, type: null, srcURL: null, naturalW: 0, naturalH: 0, duration: 0, thumbURL: null };
    queue.forEach((j) => { if (j.resultURL) URL.revokeObjectURL(j.resultURL); });
    queue = [];
    fileInfo.classList.remove('show');
    fileInfo.innerHTML = '';
    clearBtn.style.display = 'none';
    sizeSection.style.display = 'none';
    queueSection.style.display = 'none';
    emptyState.style.display = 'flex';
    workArea.style.display = 'none';
    fileInput.value = '';
    engineBadge.style.display = 'none';
    localEngineAvailable = null;
    renderQueueList();
  }

  // ---------- Queue management ----------
  function addToQueue(w, h, label) {
    if (queue.some((j) => j.w === w && j.h === h)) return;
    queue.push({
      id: queueIdCounter++,
      w, h, label,
      // Contain by default - shows the full source without cropping any of it, unlike Cover
      // (which crops overflow to fill the target exactly). Switchable per-item in the dropdown.
      fit: 'contain',
      bg: '#000000',
      blur: false,
      // Only used when fit === 'split' (Split & Stack) - see splitControlsHtml/drawSplitStack.
      splitPoints: [50],
      rowGap: 4,
      status: 'pending',
      progress: 0,
      resultBlob: null,
      resultURL: null,
    });
    renderQueueList();
  }

  function removeFromQueue(id) {
    const job = queue.find((j) => j.id === id);
    if (job && job.resultURL) URL.revokeObjectURL(job.resultURL);
    queue = queue.filter((j) => j.id !== id);
    renderQueueList();
    const card = root.querySelector('#cr-result-' + id);
    if (card) card.remove();
    updateDownloadAllVisibility();
  }

  function renderQueueList() {
    if (queue.length === 0) {
      queueList.innerHTML = '<div class="cr-queue-empty">No output sizes added yet &mdash; pick a preset above.</div>';
      renderBtn.disabled = true;
      return;
    }
    renderBtn.disabled = false;
    queueList.innerHTML = '';
    queue.forEach((job) => {
      const item = document.createElement('div');
      item.className = 'cr-queue-item';
      item.id = 'cr-queue-' + job.id;
      item.innerHTML = `
        <div class="cr-qi-top">
          <div class="cr-qi-title">${job.w}&times;${job.h} <span style="color:var(--cr-text-dim);font-weight:400;font-size:11.5px;">&middot; ${esc(job.label)}</span></div>
          <button class="cr-qi-remove" data-id="${job.id}">&#10005;</button>
        </div>
        <div class="cr-qi-controls">
          <select class="cr-fit-select" data-id="${job.id}">
            <option value="cover" ${job.fit === 'cover' ? 'selected' : ''}>Cover (crop to fill)</option>
            <option value="contain" ${job.fit === 'contain' ? 'selected' : ''}>Contain (fit + bars)</option>
            <option value="stretch" ${job.fit === 'stretch' ? 'selected' : ''}>Stretch (fill exactly)</option>
            <option value="split" ${job.fit === 'split' ? 'selected' : ''}>Split &amp; Stack (reflow rows)</option>
          </select>
          ${job.fit === 'contain' || job.fit === 'split' ? `
            <label class="cr-blur-lbl"><input type="checkbox" class="cr-blur-toggle" data-id="${job.id}" ${job.blur ? 'checked' : ''}/> Blur bg</label>
            ${!job.blur ? `<input type="color" class="cr-bg-color" data-id="${job.id}" value="${job.bg}"/>` : ''}
          ` : ''}
        </div>
        ${job.fit === 'split' ? splitControlsHtml(job) : ''}
        <div class="cr-qi-status" id="cr-status-${job.id}">${statusText(job)}</div>
        <div class="cr-qi-bar"><div class="cr-qi-bar-fill" id="cr-bar-${job.id}" style="width:${job.progress}%;"></div></div>
      `;
      queueList.appendChild(item);
    });

    queueList.querySelectorAll('.cr-qi-remove').forEach((b) => b.addEventListener('click', (e) => removeFromQueue(parseInt(e.target.dataset.id, 10))));
    queueList.querySelectorAll('.cr-fit-select').forEach((s) => s.addEventListener('change', (e) => {
      const job = queue.find((j) => j.id === parseInt(e.target.dataset.id, 10));
      job.fit = e.target.value;
      renderQueueList();
    }));
    queueList.querySelectorAll('.cr-bg-color').forEach((s) => s.addEventListener('input', (e) => {
      const job = queue.find((j) => j.id === parseInt(e.target.dataset.id, 10));
      job.bg = e.target.value;
    }));
    queueList.querySelectorAll('.cr-blur-toggle').forEach((s) => s.addEventListener('change', (e) => {
      const job = queue.find((j) => j.id === parseInt(e.target.dataset.id, 10));
      job.blur = e.target.checked;
      renderQueueList();
    }));
    queueList.querySelectorAll('.cr-split-points').forEach((s) => s.addEventListener('change', (e) => {
      const job = queue.find((j) => j.id === parseInt(e.target.dataset.id, 10));
      job.splitPoints = parseSplitPoints(e.target.value);
      renderQueueList();
    }));
    queueList.querySelectorAll('.cr-row-gap').forEach((s) => s.addEventListener('change', (e) => {
      const job = queue.find((j) => j.id === parseInt(e.target.dataset.id, 10));
      job.rowGap = Math.max(0, Math.min(30, parseFloat(e.target.value) || 0));
    }));
  }

  // Split & Stack controls for one queue item: which vertical cut points (as % of source width)
  // divide the source into strips, a gap between the stacked rows, plus a live preview (the
  // cached source thumbnail with dashed lines at each cut) so picking split points isn't blind
  // guesswork - the source has no natural "rows" the tool could detect on its own.
  function splitControlsHtml(job) {
    const lines = job.splitPoints.map((p) => `<div class="cr-split-line" style="left:${p}%;"></div>`).join('');
    return `
      <div class="cr-split-preview" style="background-image:url('${state.thumbURL || ''}')">${lines}</div>
      <div class="cr-split-row">
        <label>Split at (%)</label>
        <input type="text" class="cr-split-points" data-id="${job.id}" value="${job.splitPoints.join(', ')}" placeholder="e.g. 62"/>
      </div>
      <div class="cr-split-row">
        <label>Row gap (%)</label>
        <input type="number" class="cr-row-gap" data-id="${job.id}" value="${job.rowGap}" min="0" max="30" step="0.5"/>
      </div>
    `;
  }

  function statusText(job) {
    if (job.status === 'pending') return 'Not rendered yet';
    if (job.status === 'rendering') {
      if (job.engine === 'local') return 'Rendering via local engine…';
      if (job.engine === 'browser') return `Rendering in browser… ${job.progress}%`;
      return 'Rendering…';
    }
    if (job.status === 'done') return `✓ Done${job.engine ? ` · ${job.engine === 'local' ? 'local engine' : 'browser engine'}` : ''}`;
    if (job.status === 'error') return `✕ ${job.errorMsg || 'Failed'}`;
    return '';
  }

  function updateJobUI(job) {
    const s = root.querySelector('#cr-status-' + job.id);
    if (s) { s.textContent = statusText(job); s.className = 'cr-qi-status ' + (job.status === 'done' ? 'done' : job.status === 'error' ? 'error' : ''); }
    const bar = root.querySelector('#cr-bar-' + job.id);
    if (bar) bar.style.width = `${job.status === 'done' ? 100 : job.progress}%`;
  }

  // ---------- Render pipeline ----------
  renderBtn.addEventListener('click', renderAllJobs);

  async function renderAllJobs() {
    renderBtn.disabled = true;
    renderBtn.textContent = 'Rendering…';
    engineNotice.style.display = 'none';

    for (const job of queue) {
      if (job.status === 'done') continue;
      job.status = 'rendering';
      job.progress = 0;
      updateJobUI(job);
      try {
        if (state.type === 'image') {
          await renderImageJob(job);
        } else {
          await renderVideoJob(job);
        }
        job.status = 'done';
        updateJobUI(job);
        addResultCard(job);
      } catch (err) {
        console.error(err);
        job.status = 'error';
        job.errorMsg = (err && err.message) ? err.message : String(err);
        updateJobUI(job);
        if (state.type === 'video') {
          showEngineNotice(`Video engine failed to load or render: ${job.errorMsg}. This can happen if this view blocks external scripts - try opening the app directly in Chrome or Edge, where the video engine loads normally.`, true);
        }
      }
    }

    renderBtn.disabled = false;
    renderBtn.textContent = 'Render All';
    updateDownloadAllVisibility();
  }

  function showEngineNotice(msg, isErr) {
    engineNotice.style.display = 'block';
    engineNotice.textContent = msg;
    engineNotice.className = 'cr-notice' + (isErr ? ' err' : '');
  }

  // ----- Image rendering (Canvas) -----
  function renderImageJob(job) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = job.w;
          canvas.height = job.h;
          const ctx = canvas.getContext('2d');
          if (job.fit === 'split') {
            drawSplitStack(ctx, img, state.naturalW, state.naturalH, job.w, job.h, job.splitPoints, job.rowGap, job.bg, job.blur);
          } else {
            drawFitted(ctx, img, state.naturalW, state.naturalH, job.w, job.h, job.fit, job.bg, job.blur);
          }

          const isPng = /png/i.test(state.file.type) || /\.png$/i.test(state.file.name);
          const mime = isPng ? 'image/png' : 'image/jpeg';
          const ext = isPng ? 'png' : 'jpg';
          canvas.toBlob((blob) => {
            if (!blob) { reject(new Error('Canvas export failed')); return; }
            job.resultBlob = blob;
            job.resultURL = URL.createObjectURL(blob);
            job.ext = ext;
            resolve();
          }, mime, 0.92);
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('Could not load source image'));
      img.src = state.srcURL;
    });
  }

  function drawFitted(ctx, img, sw, sh, dw, dh, fit, bgColor, blur) {
    ctx.clearRect(0, 0, dw, dh);
    if (fit === 'stretch') {
      ctx.drawImage(img, 0, 0, dw, dh);
      return;
    }
    if (fit === 'cover') {
      const scale = Math.max(dw / sw, dh / sh);
      const rw = sw * scale; const rh = sh * scale;
      ctx.drawImage(img, (dw - rw) / 2, (dh - rh) / 2, rw, rh);
      return;
    }
    // contain
    if (blur) {
      const bgScale = Math.max(dw / sw, dh / sh);
      const bgw = sw * bgScale; const bgh = sh * bgScale;
      ctx.save();
      ctx.filter = 'blur(24px) brightness(0.85)';
      ctx.drawImage(img, (dw - bgw) / 2 - 20, (dh - bgh) / 2 - 20, bgw + 40, bgh + 40);
      ctx.restore();
    } else {
      ctx.fillStyle = bgColor || '#000000';
      ctx.fillRect(0, 0, dw, dh);
    }
    const scale = Math.min(dw / sw, dh / sh);
    const rw = sw * scale; const rh = sh * scale;
    ctx.drawImage(img, (dw - rw) / 2, (dh - rh) / 2, rw, rh);
  }

  // Split & Stack: cuts the source into vertical strips at the given % points (left-to-right),
  // scales each strip to fill the full target width on its own, and stacks them top-to-bottom
  // with a gap between rows - turning an ultra-wide single-row source into a multi-row layout
  // instead of squashing/cropping it as one rigid block. The stacked composite is then placed
  // into the true target canvas via the same Contain logic as drawFitted() above (reused
  // directly - the composite is just treated as if it were the "source image"), so leftover
  // space (or overflow) is handled identically to a normal Contain job.
  function drawSplitStack(ctx, img, sw, sh, dw, dh, splitPoints, rowGapPct, bgColor, blur) {
    const bounds = [0, ...splitPoints.map((p) => p / 100), 1];
    const gapPx = Math.round((rowGapPct / 100) * dh);
    const segments = [];
    let totalH = 0;
    for (let i = 0; i < bounds.length - 1; i++) {
      const x0 = bounds[i] * sw;
      const x1 = bounds[i + 1] * sw;
      const segW = Math.max(1, x1 - x0);
      const segH = Math.max(1, Math.round(sh * (dw / segW)));
      segments.push({ x0, segW, segH });
      totalH += segH;
    }
    totalH += gapPx * (segments.length - 1);

    const stacked = document.createElement('canvas');
    stacked.width = dw;
    stacked.height = Math.max(1, totalH);
    const sctx = stacked.getContext('2d');
    let y = 0;
    segments.forEach((seg, i) => {
      sctx.drawImage(img, seg.x0, 0, seg.segW, sh, 0, y, dw, seg.segH);
      y += seg.segH + (i < segments.length - 1 ? gapPx : 0);
    });

    drawFitted(ctx, stacked, dw, stacked.height, dw, dh, 'contain', bgColor, blur);
  }

  // ----- Video rendering (ffmpeg.wasm) -----
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  async function fetchFileBytes(file) {
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  async function ensureFFmpeg() {
    if (ffmpegInstance) return ffmpegInstance;
    if (ffmpegLoading) return ffmpegLoading;

    ffmpegLoading = (async () => {
      showEngineNotice('Loading video engine (~30MB, first time only)…', false);
      // Served from /public/ffmpeg (same origin as this app) rather than a CDN. ffmpeg.wasm's
      // worker is spawned relative to wherever ffmpeg.js itself was loaded from - pointed at a
      // cross-origin CDN, browsers refuse to construct that worker at all, and CDN-hosted builds
      // otherwise need every file individually re-fetched and wrapped as blob: URLs to work around
      // that, which has proven unreliable (worker's importScripts of a blob-wrapped core failing
      // with "failed to import ffmpeg-core.js"). Same-origin sidesteps all of it.
      const ffmpegDir = `${import.meta.env.BASE_URL}ffmpeg/`;
      if (!window.FFmpegWASM) await loadScript(`${ffmpegDir}ffmpeg.js`);
      const { FFmpeg } = window.FFmpegWASM;
      const ff = new FFmpeg();
      ff.on('progress', ({ progress }) => {
        if (currentJobRef) { currentJobRef.progress = Math.min(99, Math.round(progress * 100)); updateJobUI(currentJobRef); }
      });
      await ff.load({
        coreURL: `${ffmpegDir}ffmpeg-core.js`,
        wasmURL: `${ffmpegDir}ffmpeg-core.wasm`,
      });
      ffmpegInstance = ff;
      engineNotice.style.display = 'none';
      return ff;
    })();

    return ffmpegLoading;
  }

  function hexToFFColor(hex) {
    return `0x${hex.replace('#', '')}`;
  }

  function extOf(name) {
    const m = /\.([a-zA-Z0-9]+)$/.exec(name);
    return m ? m[1].toLowerCase() : 'mp4';
  }

  function buildFilter(job) {
    if (job.fit === 'stretch') {
      return `scale=${job.w}:${job.h}`;
    }
    if (job.fit === 'cover') {
      return `scale=${job.w}:${job.h}:force_original_aspect_ratio=increase,crop=${job.w}:${job.h}`;
    }
    if (job.blur) {
      return `split[bg][fg];[bg]scale=${job.w}:${job.h}:force_original_aspect_ratio=increase,crop=${job.w}:${job.h},boxblur=20:5[bgb];[fg]scale=${job.w}:${job.h}:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2`;
    }
    return `scale=${job.w}:${job.h}:force_original_aspect_ratio=decrease,pad=${job.w}:${job.h}:(ow-iw)/2:(oh-ih)/2:color=${hexToFFColor(job.bg)}`;
  }

  // Video equivalent of drawSplitStack() above, built as an ffmpeg -filter_complex graph since it
  // needs multiple crop/scale streams plus extra "gap" color inputs stacked together (a single
  // -vf chain, as buildFilter() above produces, can only run one input through one linear chain).
  // Strip heights are computed here in JS (not left to ffmpeg expressions) since the source's
  // pixel dimensions are already known client-side, which keeps the filter graph itself simple.
  function buildSplitStackVideoFilter(job, sw, sh, duration) {
    const bounds = [0, ...job.splitPoints.map((p) => p / 100), 1];
    const dw = job.w; const dh = job.h;
    const gapPx = Math.max(0, Math.round((job.rowGap / 100) * dh));
    const segments = [];
    let totalH = 0;
    for (let i = 0; i < bounds.length - 1; i++) {
      const x0 = Math.round(bounds[i] * sw);
      const x1 = Math.round(bounds[i + 1] * sw);
      const segW = Math.max(2, x1 - x0);
      let segH = Math.round(sh * (dw / segW));
      if (segH % 2 !== 0) segH += 1; // even dims required for yuv420p
      segments.push({ x0, segW, segH });
      totalH += segH;
    }
    totalH += gapPx * (segments.length - 1);

    const parts = [];
    segments.forEach((seg, i) => {
      parts.push(`[0:v]crop=w=${seg.segW}:h=${sh}:x=${seg.x0}:y=0,scale=${dw}:${seg.segH}[seg${i}]`);
    });

    const extraInputs = [];
    const stackLabels = [];
    segments.forEach((seg, i) => {
      stackLabels.push(`[seg${i}]`);
      if (i < segments.length - 1 && gapPx > 0) {
        const inputIndex = 1 + extraInputs.length / 4; // each extra input adds 4 argv entries below
        extraInputs.push('-f', 'lavfi', '-i', `color=c=${hexToFFColor(job.bg)}:s=${dw}x${gapPx}:d=${Math.ceil(duration || 1) + 1}`);
        stackLabels.push(`[${inputIndex}:v]`);
      }
    });
    parts.push(`${stackLabels.join('')}vstack=inputs=${stackLabels.length}[stacked]`);

    if (totalH <= dh) {
      const padY = Math.floor((dh - totalH) / 2);
      if (job.blur) {
        parts.push('[stacked]split[stfg][stbg]');
        parts.push(`[stbg]scale=${dw}:${dh}:force_original_aspect_ratio=increase,crop=${dw}:${dh},boxblur=20:5[stbgb]`);
        parts.push(`[stbgb][stfg]overlay=0:${padY}[vout]`);
      } else {
        parts.push(`[stacked]pad=${dw}:${dh}:0:${padY}:color=${hexToFFColor(job.bg)}[vout]`);
      }
    } else {
      parts.push(`[stacked]scale=${dw}:${dh}:force_original_aspect_ratio=decrease,pad=${dw}:${dh}:(ow-iw)/2:(oh-ih)/2:color=${hexToFFColor(job.bg)}[vout]`);
    }

    return { extraInputs, filterComplex: parts.join(';'), outputLabel: '[vout]' };
  }

  // ----- Local native-ffmpeg helper (fast path) -----
  async function checkLocalEngine() {
    engineBadge.style.display = 'flex';
    engineBadge.className = 'cr-engine-badge checking';
    engineBadge.innerHTML = '<span class="cr-eb-text"><span class="cr-eb-dot"></span>Checking for local render engine…</span>';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1000);
      const resp = await fetch(`${LOCAL_SERVER}/health`, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (!resp.ok) throw new Error('bad status');
      const data = await resp.json();
      localEngineAvailable = !!data.ffmpeg;
      if (!data.ffmpeg) {
        engineBadge.className = 'cr-engine-badge off';
        engineBadge.innerHTML = '<span class="cr-eb-text"><span class="cr-eb-dot"></span>Local helper running, but ffmpeg not found on your PATH &mdash; using slower browser engine.</span><button id="cr-recheckEngine">Recheck</button>';
      } else {
        engineBadge.className = 'cr-engine-badge on';
        engineBadge.innerHTML = '<span class="cr-eb-text"><span class="cr-eb-dot"></span>Local engine connected &mdash; fast native rendering.</span><button id="cr-recheckEngine">Recheck</button>';
      }
    } catch (e) {
      localEngineAvailable = false;
      engineBadge.className = 'cr-engine-badge off';
      engineBadge.innerHTML = '<span class="cr-eb-text"><span class="cr-eb-dot"></span>Local engine not running &mdash; using slower browser engine. Start "Creative Resizer Server" for fast rendering.</span><button id="cr-recheckEngine">Recheck</button>';
    }
    const btn = root.querySelector('#cr-recheckEngine');
    if (btn) btn.addEventListener('click', () => { localEngineAvailable = null; checkLocalEngine(); });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('Could not read source file'));
      reader.readAsDataURL(file);
    });
  }

  async function renderViaLocalServer(job) {
    const base64 = await fileToBase64(state.file);
    const resp = await fetch(`${LOCAL_SERVER}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: state.file.name,
        fileBase64: base64,
        width: job.w,
        height: job.h,
        fit: job.fit,
        bg: job.bg,
        blur: job.blur,
        splitPoints: job.splitPoints,
        rowGap: job.rowGap,
      }),
    });
    if (!resp.ok) {
      let msg = 'Local engine returned an error';
      try { const j = await resp.json(); if (j.error) msg = j.error; } catch (e) { /* non-JSON error body */ }
      throw new Error(msg);
    }
    const blob = await resp.blob();
    job.resultBlob = blob;
    job.resultURL = URL.createObjectURL(blob);
    job.ext = 'mp4';
  }

  // ----- Browser (ffmpeg.wasm) fallback path -----
  async function renderViaBrowserEngine(job) {
    currentJobRef = job;
    const ff = await ensureFFmpeg();

    const srcExt = extOf(state.file.name);
    const inputName = `input.${srcExt}`;
    const outputName = `output_${job.w}x${job.h}.mp4`;

    await ff.writeFile(inputName, await fetchFileBytes(state.file));

    // 'ultrafast' only trades encoder compression efficiency for speed - it does not touch output
    // pixel dimensions or the scale filter. The browser engine runs a single-threaded, software
    // x264 encoder, so it's still markedly slower than the local native engine above.
    const encodeArgs = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];

    let args;
    if (job.fit === 'split') {
      const { extraInputs, filterComplex, outputLabel } = buildSplitStackVideoFilter(job, state.naturalW, state.naturalH, state.duration);
      args = ['-i', inputName, ...extraInputs, '-filter_complex', filterComplex, '-map', outputLabel, '-map', '0:a:0?', ...encodeArgs, outputName];
    } else {
      args = ['-i', inputName, '-vf', buildFilter(job), '-map', '0:v:0', '-map', '0:a:0?', ...encodeArgs, outputName];
    }

    await ff.exec(args);
    const data = await ff.readFile(outputName);
    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    job.resultBlob = blob;
    job.resultURL = URL.createObjectURL(blob);
    job.ext = 'mp4';

    try { await ff.deleteFile(inputName); await ff.deleteFile(outputName); } catch (e) { /* best-effort cleanup */ }
    currentJobRef = null;
  }

  // ----- Dispatcher: prefer local native engine, fall back to browser engine -----
  async function renderVideoJob(job) {
    if (localEngineAvailable === null) await checkLocalEngine();

    if (localEngineAvailable) {
      job.engine = 'local';
      updateJobUI(job);
      try {
        await renderViaLocalServer(job);
        return;
      } catch (e) {
        console.warn('Local engine render failed, falling back to browser engine:', e);
        showEngineNotice(`Local engine failed for this job (${e.message}) &mdash; falling back to the slower in-browser engine.`, true);
      }
    }
    job.engine = 'browser';
    updateJobUI(job);
    await renderViaBrowserEngine(job);
  }

  // ---------- Results UI ----------
  function addResultCard(job) {
    let card = root.querySelector('#cr-result-' + job.id);
    if (!card) {
      card = document.createElement('div');
      card.className = 'cr-result-card';
      card.id = 'cr-result-' + job.id;
      const placeholder = resultsGrid.querySelector('.cr-queue-empty');
      if (placeholder) placeholder.remove();
      resultsGrid.appendChild(card);
    }
    const mediaHtml = state.type === 'image'
      ? `<img src="${job.resultURL}" alt="${job.w}x${job.h}"/>`
      : `<video src="${job.resultURL}" controls muted></video>`;

    const fname = `${(state.file.name.replace(/\.[^/.]+$/, '') || 'output')}_${job.w}x${job.h}.${job.ext}`;

    card.innerHTML = `
      <div class="cr-thumb-wrap">${mediaHtml}</div>
      <div class="cr-rc-title">${job.w}&times;${job.h}</div>
      <div class="cr-rc-sub">${esc(job.label)} &middot; ${esc(job.fit)} &middot; ${formatBytes(job.resultBlob.size)}</div>
      <a class="cr-rc-download" href="${job.resultURL}" download="${fname}">&#11015; Download</a>
    `;
  }

  function updateDownloadAllVisibility() {
    const doneCount = queue.filter((j) => j.status === 'done').length;
    downloadAllBtn.hidden = doneCount < 2;
  }

  downloadAllBtn.addEventListener('click', async () => {
    downloadAllBtn.disabled = true;
    downloadAllBtn.textContent = 'Zipping…';
    try {
      // Bundled, not fetched from a CDN. This used to pull JSZip from cdnjs.cloudflare.com at click
      // time - the only third-party CDN left in the app, and the only thing in it served from
      // outside our own origin and Supabase. That made "Download All" quietly dependent on a host we
      // do not control: blocked by a mall network's egress filtering, or cdnjs having a bad day, and
      // the button fails with nothing on screen to explain why.
      //
      // It costs nothing to bundle, because it was ALREADY bundled: pptxgenjs depends on jszip and
      // imports it statically, so every page load was already shipping this library and then
      // downloading a second copy of it over the network to use here. Vite reports the dynamic
      // import as ineffective for exactly that reason - it resolves to the chunk that is already
      // loaded rather than splitting a new one, which is the right outcome and not a problem.
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const baseName = state.file.name.replace(/\.[^/.]+$/, '') || 'output';
      queue.filter((j) => j.status === 'done').forEach((j) => {
        zip.file(`${baseName}_${j.w}x${j.h}.${j.ext}`, j.resultBlob);
      });
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${baseName}_resized.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      alert(`Could not build ZIP: ${e.message}. You can still download each file individually above.`);
    }
    downloadAllBtn.disabled = false;
    downloadAllBtn.textContent = '⬇ Download All (.zip)';
  });
}

// Comma-separated cut points as text ("62" or "30, 70") -> sorted, deduped, clamped array of
// percentages strictly between 0 and 100 (0/100 would create a zero-width strip). Falls back to a
// single centered split if nothing valid was entered, so a job never ends up with zero strips.
function parseSplitPoints(text) {
  const nums = String(text || '')
    .split(',')
    .map((s) => Math.round(parseFloat(s.trim()) * 10) / 10)
    .filter((n) => !Number.isNaN(n) && n > 0 && n < 100);
  const uniqueSorted = [...new Set(nums)].sort((a, b) => a - b);
  return uniqueSorted.length ? uniqueSorted : [50];
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Scoped under .cr-workspace, feeding off this app's own light/dark theme tokens (var(--card-bg),
// var(--border), var(--brand-orange), etc. - see styles.css) rather than the standalone tool's own
// hardcoded dark palette, so it follows the app's theme toggle instead of always rendering dark.
const CSS = `
.cr-intro{font-size:12.5px;color:var(--text-dim);margin:0 0 16px;}
.cr-workspace{
  --cr-panel:var(--card-bg);
  --cr-panel-2:var(--bg);
  --cr-border:var(--border);
  --cr-text:var(--text);
  --cr-text-dim:var(--text-dim);
  --cr-accent:var(--brand-orange);
  --cr-accent-dim:color-mix(in srgb, var(--brand-orange) 30%, var(--card-bg));
  --cr-good:var(--green);
  --cr-bad:var(--red);
  --cr-radius:10px;
  display:block;
}
.cr-workspace *{box-sizing:border-box;}
.cr-workspace .cr-shell{
  display:grid;
  grid-template-columns:minmax(300px,380px) 1fr;
  gap:0;
  background:var(--cr-panel);
  border:1px solid var(--cr-border);
  border-radius:12px;
  overflow:hidden;
  min-height:640px;
}
@media (max-width:860px){
  .cr-workspace .cr-shell{grid-template-columns:1fr;}
}
.cr-workspace .cr-panel{padding:22px;overflow-y:auto;}
.cr-workspace .cr-panel-left{border-right:1px solid var(--cr-border);background:var(--cr-panel-2);}
.cr-workspace .cr-panel-right{background:var(--cr-panel);}
.cr-workspace section{margin-bottom:24px;}
.cr-workspace section > h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--cr-text-dim);margin:0 0 10px;font-weight:600;}

.cr-workspace .cr-dropzone{border:1.5px dashed var(--cr-border);border-radius:var(--cr-radius);padding:26px 16px;text-align:center;cursor:pointer;transition:.15s border-color,.15s background;background:var(--cr-panel);}
.cr-workspace .cr-dropzone:hover,.cr-workspace .cr-dropzone.drag{border-color:var(--cr-accent);background:var(--cr-accent-dim);}
.cr-workspace .cr-icon{font-size:26px;margin-bottom:6px;}
.cr-workspace .cr-main{font-size:13.5px;color:var(--cr-text);}
.cr-workspace .cr-sub{font-size:11.5px;color:var(--cr-text-dim);margin-top:4px;}
.cr-workspace input[type=file]{display:none;}

.cr-workspace .cr-file-info{margin-top:12px;background:var(--cr-panel);border:1px solid var(--cr-border);border-radius:var(--cr-radius);padding:12px 14px;font-size:12.5px;display:none;}
.cr-workspace .cr-file-info.show{display:block;}
.cr-workspace .cr-file-info .cr-row{display:flex;justify-content:space-between;padding:3px 0;color:var(--cr-text-dim);}
.cr-workspace .cr-file-info .cr-row b{color:var(--cr-text);font-weight:500;}
.cr-workspace .cr-file-info .cr-name{font-weight:600;color:var(--cr-text);margin-bottom:6px;word-break:break-all;font-size:13px;}
.cr-workspace .cr-clear-btn{margin-top:10px;font-size:11.5px;color:var(--cr-text-dim);background:none;border:1px solid var(--cr-border);border-radius:6px;padding:5px 10px;cursor:pointer;}
.cr-workspace .cr-clear-btn:hover{color:var(--cr-bad);border-color:var(--cr-bad);}

.cr-workspace .cr-preset-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.cr-workspace .cr-preset-btn{background:var(--cr-panel);border:1px solid var(--cr-border);color:var(--cr-text);border-radius:8px;padding:10px;text-align:left;cursor:pointer;font-size:12.5px;transition:.12s;}
.cr-workspace .cr-preset-btn:hover{border-color:var(--cr-accent);background:var(--cr-accent-dim);}
.cr-workspace .cr-p-label{font-weight:600;display:block;}
.cr-workspace .cr-p-dims{color:var(--cr-text-dim);font-size:11px;display:block;margin-top:2px;}

.cr-workspace .cr-custom-row{display:flex;gap:6px;margin-top:8px;align-items:center;}
.cr-workspace .cr-custom-row input[type=number]{width:100%;background:var(--cr-panel);border:1px solid var(--cr-border);color:var(--cr-text);border-radius:7px;padding:8px;font-size:12.5px;}
.cr-workspace .cr-custom-row span{color:var(--cr-text-dim);font-size:12px;}
.cr-workspace .cr-add-custom-btn{background:var(--cr-accent-dim);border:1px solid var(--cr-accent);color:var(--cr-text);border-radius:7px;padding:8px 12px;cursor:pointer;font-size:12.5px;white-space:nowrap;}
.cr-workspace .cr-add-custom-btn:hover{background:var(--cr-accent);color:#fff;}

.cr-workspace .cr-fit-select-row{display:flex;gap:6px;}
.cr-workspace .cr-fit-opt{flex:1;text-align:center;padding:8px 4px;border:1px solid var(--cr-border);border-radius:7px;font-size:12px;cursor:pointer;background:var(--cr-panel);color:var(--cr-text-dim);}
.cr-workspace .cr-fit-opt.active{border-color:var(--cr-accent);color:var(--cr-text);background:var(--cr-accent-dim);}

.cr-workspace .cr-queue-list{display:flex;flex-direction:column;gap:8px;}
.cr-workspace .cr-queue-empty{color:var(--cr-text-dim);font-size:12.5px;padding:14px;text-align:center;border:1px dashed var(--cr-border);border-radius:8px;}
.cr-workspace .cr-queue-item{background:var(--cr-panel);border:1px solid var(--cr-border);border-radius:9px;padding:10px 12px;}
.cr-workspace .cr-qi-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
.cr-workspace .cr-qi-title{font-size:13px;font-weight:600;color:var(--cr-text);}
.cr-workspace .cr-qi-remove{background:none;border:none;color:var(--cr-text-dim);cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;}
.cr-workspace .cr-qi-remove:hover{color:var(--cr-bad);}
.cr-workspace .cr-qi-controls{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.cr-workspace .cr-qi-controls select{background:var(--cr-panel-2);border:1px solid var(--cr-border);color:var(--cr-text);border-radius:6px;padding:5px 6px;font-size:11.5px;}
.cr-workspace .cr-qi-controls input[type=color]{width:26px;height:26px;padding:0;border:1px solid var(--cr-border);border-radius:6px;background:none;cursor:pointer;}
.cr-workspace .cr-blur-lbl{font-size:11px;color:var(--cr-text-dim);display:flex;align-items:center;gap:4px;}
.cr-workspace .cr-split-preview{position:relative;height:56px;background-size:cover;background-position:center;background-color:#000;background-repeat:no-repeat;border:1px solid var(--cr-border);border-radius:6px;margin-top:8px;overflow:hidden;}
.cr-workspace .cr-split-line{position:absolute;top:0;bottom:0;width:0;border-left:2px dashed #fff;box-shadow:0 0 0 1px rgba(0,0,0,.55);}
.cr-workspace .cr-split-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;}
.cr-workspace .cr-split-row label{font-size:11px;color:var(--cr-text-dim);white-space:nowrap;}
.cr-workspace .cr-split-row input[type=text],.cr-workspace .cr-split-row input[type=number]{width:110px;background:var(--cr-panel-2);border:1px solid var(--cr-border);color:var(--cr-text);border-radius:6px;padding:5px 7px;font-size:11.5px;}
.cr-workspace .cr-qi-status{margin-top:8px;font-size:11.5px;color:var(--cr-text-dim);}
.cr-workspace .cr-qi-status.done{color:var(--cr-good);}
.cr-workspace .cr-qi-status.error{color:var(--cr-bad);}
.cr-workspace .cr-qi-bar{height:4px;background:var(--cr-panel-2);border-radius:2px;overflow:hidden;margin-top:6px;}
.cr-workspace .cr-qi-bar-fill{height:100%;width:0%;background:var(--cr-accent);transition:width .2s;}

.cr-workspace .cr-btn-primary{width:100%;background:var(--cr-accent);border:none;color:#fff;font-weight:600;font-size:13.5px;padding:12px;border-radius:9px;cursor:pointer;margin-top:4px;}
.cr-workspace .cr-btn-primary:hover{filter:brightness(1.06);}
.cr-workspace .cr-btn-primary:disabled{background:var(--cr-border);color:var(--cr-text-dim);cursor:not-allowed;}
.cr-workspace .cr-btn-secondary{width:100%;background:var(--cr-panel);border:1px solid var(--cr-border);color:var(--cr-text);font-weight:600;font-size:13px;padding:10px;border-radius:9px;cursor:pointer;margin-top:8px;}
.cr-workspace .cr-btn-secondary:hover{border-color:var(--cr-good);color:var(--cr-good);}

.cr-workspace .cr-notice{font-size:11.5px;color:var(--cr-text-dim);background:var(--cr-panel);border:1px solid var(--cr-border);border-radius:8px;padding:9px 11px;margin-top:10px;line-height:1.5;}
.cr-workspace .cr-notice.err{border-color:var(--cr-bad);color:var(--cr-bad);background:var(--red-bg);}

.cr-workspace .cr-engine-badge{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;border:1px solid var(--cr-border);border-radius:8px;padding:8px 10px;margin-bottom:10px;background:var(--cr-panel);}
.cr-workspace .cr-eb-text{display:flex;align-items:center;gap:7px;}
.cr-workspace .cr-eb-dot{width:8px;height:8px;border-radius:50%;flex:none;}
.cr-workspace .cr-engine-badge.on .cr-eb-dot{background:var(--cr-good);}
.cr-workspace .cr-engine-badge.off .cr-eb-dot{background:var(--cr-bad);}
.cr-workspace .cr-engine-badge.checking .cr-eb-dot{background:var(--amber);}
.cr-workspace .cr-engine-badge.on{color:var(--cr-good);}
.cr-workspace .cr-engine-badge.off{color:var(--cr-bad);}
.cr-workspace .cr-engine-badge.checking{color:var(--amber);}
.cr-workspace .cr-engine-badge button{background:none;border:1px solid var(--cr-border);color:inherit;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;white-space:nowrap;}
.cr-workspace .cr-engine-badge button:hover{border-color:currentColor;}

.cr-workspace .cr-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:400px;color:var(--cr-text-dim);text-align:center;padding:40px;}
.cr-workspace .cr-big{font-size:34px;margin-bottom:10px;}
.cr-workspace .cr-original-preview{background:var(--cr-panel-2);border:1px solid var(--cr-border);border-radius:var(--cr-radius);padding:16px;margin-bottom:22px;display:flex;gap:18px;align-items:center;}
.cr-workspace .cr-original-preview img,.cr-workspace .cr-original-preview video{max-width:180px;max-height:180px;border-radius:6px;background:#000;}
.cr-workspace .cr-original-meta{font-size:12.5px;color:var(--cr-text-dim);}
.cr-workspace .cr-original-meta b{color:var(--cr-text);}
.cr-workspace .cr-of-title{font-size:14px;font-weight:600;color:var(--cr-text);margin-bottom:6px;}

.cr-workspace .cr-results-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;}
.cr-workspace .cr-result-card{background:var(--cr-panel-2);border:1px solid var(--cr-border);border-radius:var(--cr-radius);padding:14px;}
.cr-workspace .cr-thumb-wrap{background:#000;border-radius:7px;overflow:hidden;display:flex;align-items:center;justify-content:center;height:150px;margin-bottom:10px;}
.cr-workspace .cr-thumb-wrap img,.cr-workspace .cr-thumb-wrap video{max-width:100%;max-height:100%;}
.cr-workspace .cr-rc-title{font-weight:600;font-size:13px;margin-bottom:2px;color:var(--cr-text);}
.cr-workspace .cr-rc-sub{font-size:11.5px;color:var(--cr-text-dim);margin-bottom:10px;}
.cr-workspace .cr-rc-download{display:block;width:100%;text-align:center;background:var(--cr-accent-dim);border:1px solid var(--cr-accent);color:var(--cr-text);padding:8px;border-radius:7px;text-decoration:none;font-size:12.5px;font-weight:600;cursor:pointer;}
.cr-workspace .cr-rc-download:hover{background:var(--cr-accent);color:#fff;}
.cr-workspace .cr-section-title-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;}
.cr-workspace .cr-section-title-row h2{margin:0;font-size:15px;color:var(--cr-text);}
.cr-workspace #cr-downloadAllBtn{background:var(--cr-good);border:none;color:#04241a;font-weight:700;font-size:12.5px;padding:8px 14px;border-radius:8px;cursor:pointer;}
.cr-workspace #cr-downloadAllBtn:hover{filter:brightness(1.08);}
.cr-workspace #cr-downloadAllBtn[hidden]{display:none;}
`;
