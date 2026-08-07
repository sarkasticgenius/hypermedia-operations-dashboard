import { esc } from './format.js';

// Unique per-render id suffix for <defs> (gradients) - more than one chart renders on the same
// page at once (Live Ops Overview alone has 5+), so a fixed id would collide and every chart
// would silently reuse whichever gradient definition happened to be first in the DOM.
let chartInstanceId = 0;
function nextChartId() { return `chart${++chartInstanceId}`; }

// Dependency-free inline-SVG bar chart - rounded, gradient-filled "pill" bars and theme-aware
// colors (var(--border)/var(--text-dim)/var(--text), which SVG presentation attributes resolve
// correctly when the SVG is inline in the page, same as any other themed element in this app) for
// an iOS-widget-style look consistent with the rest of the app's tiles, rather than flat rects on
// a plain grid. 3 gridlines (0/50%/100% of max), truncated category labels, pill-badge legend when
// more than one series.
export function svgGroupedBarChart(categories, series, opts = {}) {
  const width = opts.width || 640;
  const height = opts.height || 220;
  const padL = opts.padL ?? 34;
  const padB = opts.padB ?? 44;
  const padT = opts.padT ?? 14;
  const padR = opts.padR ?? 10;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  if (!categories.length) {
    return '<div class="empty">No data to chart.</div>';
  }

  const id = nextChartId();
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const n = categories.length;
  const groupW = plotW / n;
  const barGap = 4;
  const barW = series.length ? Math.max(2, (groupW - barGap * 2) / series.length) : 0;
  const barRadius = Math.min(7, barW / 2);

  const gradientDefs = series.map((s, si) => `
    <linearGradient id="${id}-bar-${si}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${s.color}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${s.color}" stop-opacity="0.72"/>
    </linearGradient>
  `).join('');

  let gridlines = '';
  [0, 0.5, 1].forEach((frac) => {
    const y = padT + plotH * (1 - frac);
    gridlines += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>`;
    gridlines += `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="var(--text-dim)">${Math.round(max * frac)}</text>`;
  });

  let bars = '';
  let labels = '';
  categories.forEach((cat, ci) => {
    const groupX = padL + ci * groupW;
    series.forEach((s, si) => {
      const val = s.values[ci] || 0;
      const barH = (val / max) * plotH;
      const x = groupX + barGap + si * barW;
      const y = padT + (plotH - barH);
      const w = Math.max(0, barW - 2);
      // A plain rx-rounded rect rounds ALL four corners, which pinches the bottom into the axis
      // line at small heights - clipPath + a fully-rounded "pill" rect (ry = half the bar's own
      // width) behind it keeps just the top rounded and the bottom flush, the actual iOS-widget bar
      // shape, without needing a separate top-only-rounding trick per bar height.
      bars += `<clipPath id="${id}-clip-${ci}-${si}"><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${(barH + barRadius).toFixed(1)}"/></clipPath>
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${barH.toFixed(1)}" rx="${barRadius.toFixed(1)}" fill="url(#${id}-bar-${si})" clip-path="url(#${id}-clip-${ci}-${si})"/>`;
      if (val > 0) {
        bars += `<text x="${(x + w / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="9.5" font-weight="700" text-anchor="middle" fill="var(--text-dim)">${val}</text>`;
      }
    });
    const label = cat.length > 13 ? cat.slice(0, 12) + '…' : cat;
    labels += `<text x="${(groupX + groupW / 2).toFixed(1)}" y="${(height - padB + 14).toFixed(1)}" font-size="9.5" text-anchor="middle" fill="var(--text-dim)"><title>${esc(cat)}</title>${esc(label)}</text>`;
  });

  const legend = series.length > 1
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
        ${series.map((s) => `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:var(--bg);font-size:11px;font-weight:600;color:var(--text-dim);"><span style="width:8px;height:8px;border-radius:50%;background:${s.color};display:inline-block;flex:none;"></span>${esc(s.name)}</span>`).join('')}
      </div>`
    : '';

  return `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;max-width:${width}px;display:block;">
      <defs>${gradientDefs}</defs>
      ${gridlines}${bars}${labels}
    </svg>
    ${legend}
  `;
}

// Single stroked-ring donut with a centered value/label and a subtle gradient stroke - an iOS-
// widget-style "progress ring" rather than a flat single-color arc, theme-aware track/text colors.
export function svgDonutChart(pct, color, size = 130, centerMain = '', centerSub = '') {
  const id = nextChartId();
  const strokeWidth = 14;
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const offset = circumference * (1 - clamped / 100);
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <defs>
        <linearGradient id="${id}-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.75"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="1"/>
        </linearGradient>
      </defs>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${strokeWidth}"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="url(#${id}-ring)" stroke-width="${strokeWidth}"
        stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
        transform="rotate(-90 ${cx} ${cy})" style="transition:stroke-dashoffset .4s;"/>
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="21" font-weight="800" fill="var(--text)">${esc(String(centerMain))}</text>
      <text x="${cx}" y="${cy + 17}" text-anchor="middle" font-size="10.5" font-weight="600" fill="var(--text-dim)">${esc(String(centerSub))}</text>
    </svg>
  `;
}
