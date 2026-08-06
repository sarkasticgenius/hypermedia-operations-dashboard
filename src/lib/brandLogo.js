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

function initialsBadgeHtml(name, size) {
  const fontSize = Math.round(size * 0.4);
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:6px;background:#f0ede8;color:#8a8478;font-size:${fontSize}px;font-weight:600;vertical-align:middle;">${esc(initials(name))}</span>`;
}

// Small brand-logo avatar for a venue/contractor/client name, sourced from the brand_logos cache
// (populated by Settings > Integrations > Brandfetch - this never calls the API directly). Falls
// back to an initials badge when nothing's cached yet for that name - also on load failure (the
// cached logo_url 404s/403s at view time even though a URL is on file, e.g. Brandfetch's Logo Link
// CDN returning 403 for a domain-override URL that worked when it was first cached), by swapping
// the broken <img> for the same initials badge markup instead of just hiding it and leaving blank
// space.
//
// fallbackName: an optional second name to try when `name` itself has no logo cached - e.g. Dubai
// Metro station names pass their generic parent brand ("Dubai Metro Rail") here, so a station
// that's just a plain area name (no real sponsor) still shows the Metro logo instead of initials.
export function brandLogoTag(name, size = 22, fallbackName = null) {
  if (!name) return '';
  const map = brandLogoMap();
  const primary = map.get(String(name).toLowerCase());
  const fallback = fallbackName ? map.get(String(fallbackName).toLowerCase()) : null;
  const useFallback = !primary?.logo_url && fallback?.logo_url;
  const row = useFallback ? fallback : primary;
  const badgeName = useFallback ? fallbackName : name;
  if (row?.logo_url) {
    const fallbackHtml = initialsBadgeHtml(badgeName, size).replace(/"/g, '&quot;');
    return `<img src="${esc(row.logo_url)}" alt="" style="width:${size}px;height:${size}px;border-radius:6px;object-fit:contain;background:#fff;border:1px solid #eee;vertical-align:middle;" onerror="this.outerHTML='${fallbackHtml}'">`;
  }
  return initialsBadgeHtml(name, size);
}
