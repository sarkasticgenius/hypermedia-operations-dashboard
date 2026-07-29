import { STATE, setState } from '../state.js';
import { esc } from './format.js';

// Shared sortable-column-header primitive, ported from the original app's
// sortTh()/applySort()/toggleSort() (its one genuinely reusable pattern) -
// state lives in STATE.tableSort[scope] so multiple tables on one page (or
// across pages) don't collide.
export function sortTh(scope, key, label) {
  const sort = STATE.tableSort?.[scope];
  const active = sort && sort.key === key;
  const arrow = active ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : '';
  return `<th style="cursor:pointer;user-select:none;" onclick="App.toggleSort('${scope}','${key}')">${esc(label)}${arrow}</th>`;
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
