import { STATE, setState } from '../state.js';
import { esc } from './format.js';

// Shared sortable-column-header primitive, ported from the original app's
// sortTh()/applySort()/toggleSort() (its one genuinely reusable pattern) -
// state lives in STATE.tableSort[scope] so multiple tables on one page (or
// across pages) don't collide.
//
// widthCh (optional, in `ch` units - roughly one character wide, so it scales with font size)
// pins the column to a fixed width. Pair this with `table-layout:fixed` on the parent <table> (see
// FIXED_TABLE_STYLE below) - without an explicit width per column, an auto-layout table re-measures
// column widths from whatever rows are currently in the DOM, so sorting a paginated/sliced table
// (which swaps in a different subset of rows) visibly shifts every column even though the header
// row itself never changed. A fixed width sourced from the full (unsliced) row set, not just the
// currently-visible page, stays constant across sorts and page turns.
//
// align (optional, 'center'|'right') - a header's own label is very often longer than the short
// badge/number every row actually shows in that column (e.g. "DAYS TO EXPIRE" vs "18d"), so with
// the default left alignment the value sits flush against the header's left edge while the rest of
// the (header-label-driven) column width goes empty to its right - reads as misaligned even though
// nothing is technically wrong. Passing the same align here and on the column's <td> class
// (tcenter/tright) keeps the two visually centered on each other instead.
export function sortTh(scope, key, label, widthCh, align) {
  const sort = STATE.tableSort?.[scope];
  const active = sort && sort.key === key;
  const arrow = active ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : '';
  const widthStyle = widthCh ? `width:${widthCh}ch;` : '';
  const alignClass = align === 'center' ? ' tcenter' : align === 'right' ? ' tright' : '';
  return `<th class="${alignClass.trim()}" style="${widthStyle}cursor:pointer;user-select:none;" onclick="App.toggleSort('${scope}','${key}')">${esc(label)}${arrow}</th>`;
}

// Inline style for the <table> tag itself, pairing with sortTh's widthCh above - table-layout:fixed
// makes column widths come from the header row's specified widths alone, immune to which body rows
// happen to be rendered on a given page/sort. Exported as a constant so every table using this
// pattern stays visually consistent.
export const FIXED_TABLE_STYLE = 'table-layout:fixed;';

// Computes a stable per-column width (in ch) from the FULL row set (before any pagination slicing),
// so the result doesn't change depending on which page/sort order is currently on screen - only a
// genuine change to the underlying data (a new filter/search, a fresh fetch) shifts it. Capped to
// [min,max] so one outlier value can't blow the column out; the header label's own length is always
// included as a floor so a short value set still leaves room for the label.
//
// pad defaults to 5, not a couple of characters of breathing room - a table cell's own padding
// (~10px each side, ~20px/2.7ch total at this app's font size) counts against a column's specified
// width under table-layout:fixed the same way border-box would, regardless of the cell's own
// box-sizing, so a value that's a tight character-count match for its column (e.g. a 4-digit number
// in a 7ch column) was overflowing and getting silently ellipsis-clipped even though nothing about
// the VALUE itself was too long - confirmed live (Placements Stats' "calls" column truncating an
// unremarkable 4-digit count to 2 digits).
export function colWidthCh(rows, accessor, label, { min = 8, max = 40, pad = 5 } = {}) {
  let longest = (label || '').length;
  for (const r of rows) {
    const v = accessor(r);
    if (v == null || v === '') continue;
    const len = String(v).length;
    if (len > longest) longest = len;
  }
  return Math.max(min, Math.min(max, longest + pad));
}

export function toggleSort(scope, key) {
  STATE.tableSort = STATE.tableSort || {};
  const current = STATE.tableSort[scope];
  STATE.tableSort[scope] = current && current.key === key
    ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'asc' };
  setState({});
}

// accessors: { [key]: (row) => comparable value }
export function applySort(list, scope, accessors) {
  const sort = STATE.tableSort?.[scope];
  if (!sort || !accessors[sort.key]) return list;
  const acc = accessors[sort.key];
  const sorted = [...list].sort((a, b) => {
    const av = acc(a);
    const bv = acc(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    return String(av).localeCompare(String(bv));
  });
  if (sort.dir === 'desc') sorted.reverse();
  return sorted;
}
