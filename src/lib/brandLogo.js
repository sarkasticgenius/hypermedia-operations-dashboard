import { loadData } from '../state.js';
import { listBrandLogos } from '../data/brandLogos.js';
import { esc } from './format.js';

function brandLogoMap() {
  const rows = loadData('brandLogos', listBrandLogos);
  if (!rows || rows.__error) return new Map();
  return new Map(rows.map((r) => [r.name.toLowerCase(), r]));
}

function initials(name) {
  return (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

// Small brand-logo avatar for a venue/contractor/client name, sourced from the brand_logos cache
// (populated by Settings > Integrations > Brandfetch - this never calls the API directly). Falls
// back to an initials badge when nothing's cached yet for that name.
export function brandLogoTag(name, size = 22) {
  if (!name) return '';
  const row = brandLogoMap().get(String(name).toLowerCase());
  if (row?.logo_url) {
    return `<img src="${esc(row.logo_url)}" alt="" style="width:${size}px;height:${size}px;border-radius:6px;object-fit:contain;background:#fff;border:1px solid #eee;vertical-align:middle;" onerror="this.style.display='none'">`;
  }
  const fontSize = Math.round(size * 0.4);
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:6px;background:#f0ede8;color:#8a8478;font-size:${fontSize}px;font-weight:600;vertical-align:middle;">${esc(initials(name))}</span>`;
}
