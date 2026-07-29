import { esc } from './format.js';

// Dependency-free inline-SVG bar chart, ported from the original app's
// svgGroupedBarChart(): plain <rect> bars per category/series, 3 gridlines
// (0/50%/100% of max), truncated category labels, HTML legend when >1 series.
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

  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const n = categories.length;
  const groupW = plotW / n;
  const barGap = 4;
  const barW = series.length ? Math.max(2, (groupW - barGap * 2) / series.length) : 0;

  let gridlines = '';
  [0, 0.5, 1].forEach((frac) => {
    const y = padT + plotH * (1 - frac);
    gridlines += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" stroke="#f0efec" stroke-width="1"/>`;
    gridlines += `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="#b5b2ab">${Math.round(max * frac)}</text>`;
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
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, barW - 2).toFixed(1)}" height="${barH.toFixed(1)}" fill="${s.color}" rx="2"/>`;
      if (val > 0) {
        bars += `<text x="${(x + (barW - 2) / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="9" text-anchor="middle" fill="#6b7280">${val}</text>`;
      }
    });
    const label = cat.length > 13 ? cat.slice(0, 12) + '…' : cat;
    labels += `<text x="${(groupX + groupW / 2).toFixed(1)}" y="${(height - padB + 14).toFixed(1)}" font-size="9.5" text-anchor="middle" fill="#7a766d"><title>${esc(cat)}</title>${esc(label)}</text>`;
  });

  const legend = series.length > 1
    ? `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:11.5px;color:var(--text-dim);">
        ${series.map((s) => `<span style="display:inline-flex;align-items:center;gap:5px;"><span style="width:10px;height:10px;border-radius:2px;background:${s.color};display:inline-block;"></span>${esc(s.name)}</span>`).join('')}
      </div>`
    : '';

  return `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;max-width:${width}px;display:block;">
      ${gridlines}${bars}${labels}
    </svg>
    ${legend}
  `;
}

// Single stroked-circle donut with a centered value/label, ported from the
// original app's svgDonutChart().
export function svgDonutChart(pct, color, size = 130, centerMain = '', centerSub = '') {
  const strokeWidth = 14;
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const offset = circumference * (1 - clamped / 100);
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#f0efec" stroke-width="${strokeWidth}"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"
        stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
        transform="rotate(-90 ${cx} ${cy})" style="transition:stroke-dashoffset .4s;"/>
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="20" font-weight="700" fill="#26241f">${esc(String(centerMain))}</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="10.5" fill="#7a766d">${esc(String(centerSub))}</text>
    </svg>
  `;
}
