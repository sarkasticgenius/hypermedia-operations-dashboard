// Generic tile-grid heatmap, parameterized by a color function and a content
// renderer - the original app repeats this exact grid(auto-fill,minmax(180px,1fr))
// pattern near-verbatim in Locations, the Broadsign/Grassfish console panels, and
// the Ticket heatmap; here it's one function reused by all of them.
export function heatmapGrid(items, { colorFn, contentHtml, textColorFn, onClick }) {
  if (!items.length) return '<div class="empty">Nothing to show.</div>';
  const tiles = items.map((item) => {
    const color = colorFn(item);
    const textColor = textColorFn ? textColorFn(item) : '#fff';
    const clickAttr = onClick ? ` onclick="${onClick(item)}"` : '';
    return `
      <div style="background:${color};border-radius:10px;padding:12px;min-height:90px;color:${textColor};cursor:${onClick ? 'pointer' : 'default'};display:flex;flex-direction:column;justify-content:center;"${clickAttr}>
        ${contentHtml(item)}
      </div>
    `;
  }).join('');
  return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;">${tiles}</div>`;
}
