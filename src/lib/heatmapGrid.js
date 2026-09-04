// Generic tile-grid heatmap, parameterized by a color function and a content
// renderer - the original app repeats this exact grid(auto-fill,minmax(180px,1fr))
// pattern near-verbatim in Locations, the Broadsign/Grassfish console panels, and
// the Ticket heatmap; here it's one function reused by all of them.
import { esc } from './format.js';

export function heatmapGrid(items, { colorFn, contentHtml, textColorFn, onClick }) {
  if (!items.length) return '<div class="empty">Nothing to show.</div>';
  const tiles = items.map((item) => {
    const color = colorFn(item);
    const textColor = textColorFn ? textColorFn(item) : '#fff';
    // esc() here is the outer HTML-attribute boundary - callers are responsible for their own
    // JS-string-level escaping of any interpolated value (see jsAttr()/jsAttrSq() in format.js)
    // since onClick(item) returns a JS call expression, not plain text.
    const clickAttr = onClick ? ` onclick="${esc(onClick(item))}"` : '';
    return `
      <div style="background:${color};border-radius:10px;padding:12px;min-height:90px;color:${textColor};cursor:${onClick ? 'pointer' : 'default'};display:flex;flex-direction:column;justify-content:center;"${clickAttr}>
        ${contentHtml(item)}
      </div>
    `;
  }).join('');
  return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;">${tiles}</div>`;
}
