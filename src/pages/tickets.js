import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete, canExportArea } from '../auth.js';
import { listTickets, saveTicket, deleteTicket } from '../data/tickets.js';
import { updateScreenReport } from '../data/screenReports.js';
import { listLocations } from '../data/locations.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { assetInventoryForLocationFull, screenLabel } from '../data/locationStats.js';
import { svgGroupedBarChart } from '../lib/charts.js';
import { heatmapGrid } from '../lib/heatmapGrid.js';
import { logAudit } from '../lib/audit.js';
import { esc, jsAttr, fmtDate } from '../lib/format.js';
import { exportToExcel } from '../lib/excelExport.js';
import { getSignedUrl } from '../lib/storage.js';
import { sortTh, applySort } from '../lib/sortableTable.js';
import { renderTabs } from '../lib/tabs.js';

const STATUS_BADGE = { Open: 'b-red', 'In Progress': 'b-amber', Resolved: 'b-blue', Closed: 'b-gray' };

async function loadTicketsData() {
  const [tickets, locations, assetInventory] = await Promise.all([
    listTickets(), listLocations(), listAssetInventory(),
  ]);
  return { tickets, locations, assetInventory };
}

// Self-loading (not just a cache read): the ticket modal can be opened from other pages too
// (e.g. the Broadsign/Grassfish Console heatmaps' "+ Ticket" buttons), which never call
// renderTickets() to prime this cache - loadData() is safe to call repeatedly, so this triggers
// the fetch on first access from anywhere.
function pageData() { return loadData('ticketsPage', loadTicketsData); }

function filteredTickets(tickets) {
  const typeTab = STATE.ticketTypeTab || 'All';
  const statusTab = STATE.ticketStatusTab || 'All';
  const search = (STATE.ticketSearch || '').trim().toLowerCase();
  const locFilter = STATE.ticketLocationFilter;
  return tickets.filter((t) => {
    if (typeTab !== 'All' && t.type !== typeTab) return false;
    if (statusTab !== 'All') {
      if (statusTab === 'Closed' ? (t.status !== 'Closed' && t.status !== 'Resolved') : t.status !== statusTab) return false;
    }
    if (locFilter && (t.location || 'Unspecified') !== locFilter) return false;
    if (search && !(`${t.title} ${t.location || ''} ${t.description || ''}`.toLowerCase().includes(search))) return false;
    return true;
  });
}

// Global Created/Solved/Pending summary, deliberately computed off the full unfiltered ticket
// list (same as renderCharts()) so it reads as a stable "state of all tickets" figure regardless
// of whatever type/status/search filter happens to be active on the List view right now, and stays
// visible across List/Calendar/Heatmap instead of only appearing inside the Calendar tab.
function createdSolvedPendingSummary(tickets) {
  const created = tickets.length;
  const solved = tickets.filter((t) => t.status === 'Closed' || t.status === 'Resolved').length;
  const pending = tickets.filter((t) => t.status === 'Open' || t.status === 'In Progress').length;
  return `<div class="kpi-row">
    <div class="kpi"><div class="label">Created</div><div class="value">${created}</div></div>
    <div class="kpi" style="border-left:4px solid #1f9d55;"><div class="label">Solved</div><div class="value">${solved}</div></div>
    <div class="kpi" style="border-left:4px solid #e0a13a;"><div class="label">Pending</div><div class="value">${pending}</div></div>
  </div>`;
}

export function renderTickets() {
  const data = loadData('ticketsPage', loadTicketsData);
  if (data === null) return loadingCard();
  if (data.__error) return loadingCard(data.__error);

  const { tickets } = data;
  const view = STATE.ticketView || 'list';
  const visible = filteredTickets(tickets);

  const viewTabs = renderTabs([
    { key: 'list', label: 'List' }, { key: 'calendar', label: 'Calendar' }, { key: 'heatmap', label: 'Heatmap' },
  ], view, 'App.setTicketView');

  let body;
  if (view === 'calendar') body = renderCalendar(tickets);
  else if (view === 'heatmap') body = renderTicketHeatmap(tickets);
  else body = renderListView(visible);

  return `
    ${createdSolvedPendingSummary(tickets)}
    ${renderCharts(tickets)}
    ${STATE.ticketLocationFilter ? `<div class="banner">Filtered to location: <strong>${esc(STATE.ticketLocationFilter)}</strong> <button class="link-btn" onclick="App.clearTicketLocationFilter()">Clear filter</button></div>` : ''}
    <div class="toolbar">
      ${viewTabs}
      <div class="toolbar-actions">
        ${canExportArea('tickets') ? `<button class="btn-sm" onclick="App.exportTicketsExcel()">Export</button>` : ''}
        ${canAdd('tickets') ? `<button class="btn btn-orange" onclick="App.editTicket(null)">+ New Ticket</button>` : ''}
      </div>
    </div>
    ${view === 'list' ? `
      <div class="toolbar">
        ${renderTabs([{ key: 'All', label: 'All' }, { key: 'Issue', label: 'Issue Tickets' }, { key: 'Internal', label: 'Internal Tickets' }], STATE.ticketTypeTab || 'All', 'App.setTicketTypeTab')}
        ${renderTabs(['All', 'Open', 'In Progress', 'Closed'].map((s) => ({ key: s, label: s })), STATE.ticketStatusTab || 'All', 'App.setTicketStatusTab')}
      </div>
      <div class="field" style="max-width:320px;"><input id="ticket-search" placeholder="Search tickets..." value="${esc(STATE.ticketSearch || '')}" oninput="App.setTicketSearch(this.value)"></div>
    ` : ''}
    ${body}
  `;
}

export function setTicketView(v) { setState({ ticketView: v }); }
export function setTicketTypeTab(v) { setState({ ticketTypeTab: v }); }
export function setTicketStatusTab(v) { setState({ ticketStatusTab: v }); }
export function setTicketSearch(v) { setState({ ticketSearch: v }); }
export function clearTicketLocationFilter() { setState({ ticketLocationFilter: null }); }

// -------------------- charts --------------------
function last6MonthLabels() {
  const now = new Date();
  const labels = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    labels.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return labels;
}

function renderCharts(tickets) {
  const months = last6MonthLabels();
  const opened = months.map((m) => tickets.filter((t) => (t.date_reported || '').startsWith(m)).length);
  const closed = months.map((m) => tickets.filter((t) => (t.date_closed || '').startsWith(m)).length);

  const priorities = ['Low', 'Medium', 'High', 'Critical'];
  const byPriority = priorities.map((p) => tickets.filter((t) => (t.priority || 'Medium') === p).length);

  const locCounts = {};
  for (const t of tickets) {
    const loc = (t.location || '').trim() || 'Unspecified';
    locCounts[loc] = (locCounts[loc] || 0) + 1;
  }
  const topLocs = Object.entries(locCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-bottom:20px;">
      <div class="card" style="margin-bottom:0;">
        <div class="card-head"><h3>Opened vs Closed (6mo)</h3></div>
        ${svgGroupedBarChart(months, [{ name: 'Opened', color: '#e07a2c', values: opened }, { name: 'Closed', color: '#1f9d55', values: closed }])}
      </div>
      <div class="card" style="margin-bottom:0;">
        <div class="card-head"><h3>By Priority</h3></div>
        ${svgGroupedBarChart(priorities, [{ name: 'Tickets', color: '#3a7ca5', values: byPriority }])}
      </div>
      <div class="card" style="margin-bottom:0;">
        <div class="card-head"><h3>Top Locations by Ticket Count</h3></div>
        ${svgGroupedBarChart(topLocs.map((l) => l[0]), [{ name: 'Tickets', color: '#8e44ad', values: topLocs.map((l) => l[1]) }])}
      </div>
    </div>
  `;
}

// -------------------- list view --------------------
function renderListView(visible) {
  const sorted = applySort(visible, 'ticketsList', {
    title: (t) => t.title || '', location: (t) => t.location || '', status: (t) => t.status || '',
    priority: (t) => t.priority || '', reported: (t) => t.date_reported || '',
  });
  const rows = sorted.map((t) => `
    <tr>
      <td>${esc(t.title)}</td>
      <td>${esc(t.location || '-')}</td>
      <td class="tcenter"><span class="badge ${STATUS_BADGE[t.status] || 'b-gray'}">${esc(t.status)}</span></td>
      <td>${esc(t.priority)}</td>
      <td>${fmtDate(t.date_reported)}</td>
      <td>
        ${canEdit('tickets') ? `<button class="btn-sm" onclick="App.editTicket('${t.id}')">Edit</button>` : ''}
        ${canDelete('tickets') ? `<button class="btn-sm" onclick="App.removeTicket('${t.id}')">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');
  return `
    <div class="card">
      ${visible.length === 0 ? '<div class="empty">No tickets match your filters.</div>' : `
        <table>
          <thead><tr>${sortTh('ticketsList', 'title', 'Title')}${sortTh('ticketsList', 'location', 'Location')}${sortTh('ticketsList', 'status', 'Status', null, 'center')}${sortTh('ticketsList', 'priority', 'Priority')}${sortTh('ticketsList', 'reported', 'Reported')}<th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

// -------------------- calendar --------------------
function kpiRowForTickets(list) {
  const total = list.length;
  const open = list.filter((t) => t.status === 'Open').length;
  const inProgress = list.filter((t) => t.status === 'In Progress').length;
  const closed = list.filter((t) => t.status === 'Closed' || t.status === 'Resolved').length;
  return `<div class="kpi-row">
    <div class="kpi"><div class="label">Total</div><div class="value">${total}</div></div>
    <div class="kpi"><div class="label">Open</div><div class="value">${open}</div></div>
    <div class="kpi"><div class="label">In Progress</div><div class="value">${inProgress}</div></div>
    <div class="kpi"><div class="label">Closed</div><div class="value">${closed}</div></div>
  </div>`;
}

function renderCalendar(tickets) {
  const mode = STATE.ticketCalMode || 'month';
  const modeTabs = renderTabs([{ key: 'month', label: 'Month' }, { key: 'week', label: 'Week' }], mode, 'App.setTicketCalMode');
  const body = mode === 'week' ? renderWeekStrip(tickets) : renderMonthGrid(tickets);
  return `<div class="card">${modeTabs}${body}</div>`;
}

function renderMonthGrid(tickets) {
  const monthStr = STATE.tkMonth || new Date().toISOString().slice(0, 7);
  const [y, m] = monthStr.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const firstDow = new Date(y, m - 1, 1).getDay();
  const byDay = {};
  const monthTickets = tickets.filter((t) => (t.date_reported || '').startsWith(monthStr));
  for (const t of monthTickets) {
    const day = Number(t.date_reported.split('-')[2]);
    byDay[day] = byDay[day] || [];
    byDay[day].push(t);
  }
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return `
    ${kpiRowForTickets(monthTickets)}
    <div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0;">
      <button class="btn-sm" onclick="App.shiftTicketMonth(-1)">&larr; Prev</button>
      <strong>${new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
      <button class="btn-sm" onclick="App.shiftTicketMonth(1)">Next &rarr;</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;">
      ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="small muted" style="text-align:center;font-weight:700;">${d}</div>`).join('')}
      ${cells.map((d) => d === null ? '<div></div>' : `
        <div style="min-height:74px;border:1px solid var(--border);border-radius:6px;padding:4px;">
          <div class="small" style="font-weight:700;">${d}</div>
          ${(byDay[d] || []).slice(0, 3).map((t) => `<div class="badge ${STATUS_BADGE[t.status] || 'b-gray'}" style="display:block;margin-top:2px;cursor:pointer;font-size:9.5px;" onclick="App.editTicket('${t.id}')">${esc((t.title || '').slice(0, 16))}</div>`).join('')}
          ${(byDay[d] || []).length > 3 ? `<div class="small muted">+${(byDay[d] || []).length - 3}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function startOfWeek(d) {
  const r = new Date(d);
  r.setDate(r.getDate() - r.getDay());
  return r;
}

function renderWeekStrip(tickets) {
  const start = STATE.tkWeekStart ? new Date(STATE.tkWeekStart + 'T00:00:00') : startOfWeek(new Date());
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const todayStr = new Date().toISOString().slice(0, 10);
  const dayStrs = days.map((d) => d.toISOString().slice(0, 10));
  const weekTickets = tickets.filter((t) => dayStrs.includes(t.date_reported));

  return `
    ${kpiRowForTickets(weekTickets)}
    <div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0;">
      <button class="btn-sm" onclick="App.shiftTicketWeek(-1)">&larr; Prev</button>
      <strong>${days[0].toLocaleDateString()} - ${days[6].toLocaleDateString()}</strong>
      <button class="btn-sm" onclick="App.shiftTicketWeek(1)">Next &rarr;</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;">
      ${days.map((d) => {
        const dayStr = d.toISOString().slice(0, 10);
        const dayTickets = tickets.filter((t) => t.date_reported === dayStr);
        const isToday = dayStr === todayStr;
        return `
          <div style="min-height:220px;border:1px solid ${isToday ? '#e07a2c' : 'var(--border)'};background:${isToday ? 'rgba(224,122,44,0.06)' : '#fff'};border-radius:8px;padding:6px;">
            <div class="small" style="font-weight:700;">${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</div>
            ${dayTickets.map((t) => `<div class="badge ${STATUS_BADGE[t.status] || 'b-gray'}" style="display:block;margin-top:4px;cursor:pointer;font-size:10px;" onclick="App.editTicket('${t.id}')">${esc(t.title)}</div>`).join('')}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

export function setTicketCalMode(m) { setState({ ticketCalMode: m }); }
export function shiftTicketMonth(delta) {
  const cur = STATE.tkMonth || new Date().toISOString().slice(0, 7);
  const [y, m] = cur.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  setState({ tkMonth: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` });
}
export function shiftTicketWeek(delta) {
  const cur = STATE.tkWeekStart ? new Date(STATE.tkWeekStart + 'T00:00:00') : startOfWeek(new Date());
  cur.setDate(cur.getDate() + delta * 7);
  setState({ tkWeekStart: cur.toISOString().slice(0, 10) });
}

// -------------------- heatmap --------------------
function ticketHeatColor(stats) {
  if (stats.total === 0) return '#f4f3f0';
  if (stats.open === 0) return '#1f9d55';
  if (stats.open === 1) return '#e0a13a';
  if (stats.open <= 3) return '#e07a2c';
  return '#c0392b';
}

function renderTicketHeatmap(tickets) {
  const byLoc = {};
  for (const t of tickets) {
    const loc = (t.location || '').trim() || 'Unspecified';
    byLoc[loc] = byLoc[loc] || { total: 0, open: 0 };
    byLoc[loc].total++;
    if (t.status !== 'Closed' && t.status !== 'Resolved') byLoc[loc].open++;
  }
  const items = Object.entries(byLoc).map(([loc, stats]) => ({ loc, stats }))
    .sort((a, b) => b.stats.open - a.stats.open || b.stats.total - a.stats.total);

  return `
    <div class="card">
      <div class="card-head"><h3>Ticket Heatmap</h3><div class="desc">Colored by open-ticket load</div></div>
      ${heatmapGrid(items, {
        colorFn: (i) => ticketHeatColor(i.stats),
        contentHtml: (i) => `<div style="font-weight:700;font-size:12.5px;">${esc(i.loc)}</div><div style="font-size:11px;margin-top:4px;">${i.stats.open} open / ${i.stats.total} total</div>`,
        onClick: (i) => `App.filterTicketsByLocation("${jsAttr(i.loc)}")`,
      })}
    </div>
  `;
}

export function filterTicketsByLocation(loc) {
  setState({ ticketView: 'list', ticketStatusTab: 'All', ticketLocationFilter: loc });
}

// -------------------- per-screen ticket history --------------------
// How many times a given screen (Asset Inventory row) has had a ticket raised against it, and
// the history itself - surfaced on the ticket form so reporting/closing a ticket shows whether
// this is a one-off or a screen that keeps coming back.
function assetTicketHistory(assetInvId, tickets, excludeId) {
  if (!assetInvId) return [];
  return (tickets || [])
    .filter((t) => t.asset_inv_id === assetInvId && t.id !== excludeId)
    .sort((a, b) => (b.date_reported || '').localeCompare(a.date_reported || ''));
}

function renderTicketHistoryBlock(assetInvId, tickets, excludeId) {
  if (!assetInvId) return '';
  const history = assetTicketHistory(assetInvId, tickets, excludeId);
  if (!history.length) return `<div class="small muted" style="margin:-6px 0 10px;">No prior tickets for this screen.</div>`;
  const rows = history.map((t) => `
    <tr>
      <td>${fmtDate(t.date_reported)}</td>
      <td>${esc(t.title)}</td>
      <td class="tcenter"><span class="badge ${STATUS_BADGE[t.status] || 'b-gray'}">${esc(t.status)}</span></td>
    </tr>
  `).join('');
  return `
    <details style="margin:-6px 0 10px;" ${history.length > 3 ? '' : 'open'}>
      <summary class="small" style="cursor:pointer;font-weight:600;">${history.length} prior ticket${history.length === 1 ? '' : 's'} for this screen</summary>
      <table style="margin-top:6px;"><thead><tr><th>Reported</th><th>Title</th><th class="tcenter">Status</th></tr></thead><tbody>${rows}</tbody></table>
    </details>
  `;
}

// Direct DOM update (not setState) - same reasoning as onTicketLocationChange: this fires from
// inside an already-open modal and must not discard whatever else the admin has typed.
export function onTicketScreenChange(value) {
  const el = document.getElementById('tk-history');
  if (!el) return;
  const tickets = pageData()?.tickets || [];
  const excludeId = STATE.modal?.data?.id || null;
  el.innerHTML = renderTicketHistoryBlock(value || null, tickets, excludeId);
}

// -------------------- CRUD --------------------
export async function exportTicketsExcel() {
  const tickets = pageData()?.tickets || [];
  await exportToExcel('tickets.xlsx', [
    { label: 'Title', value: (t) => t.title }, { label: 'Location', value: (t) => t.location },
    { label: 'Status', value: (t) => t.status }, { label: 'Priority', value: (t) => t.priority },
    { label: 'Reported', value: (t) => t.date_reported }, { label: 'Closed', value: (t) => t.date_closed },
    { label: 'Reported By', value: (t) => t.reported_by }, { label: 'Root Cause', value: (t) => t.root_cause },
  ], tickets);
}

export function editTicket(id) {
  const tickets = pageData()?.tickets || [];
  const row = id ? tickets.find((t) => t.id === id) : null;
  openModal('ticket', row || { date_reported: new Date().toISOString().slice(0, 10), status: 'Open' });
}

export async function removeTicket(id) {
  if (!confirm('Move this ticket to the Recycle Bin?')) return;
  try {
    await deleteTicket(id);
    await logAudit('Delete ticket', id);
    invalidate('ticketsPage');
    invalidate('opsOverviewV2');
    invalidate('assetsInventoryPage');
    toast('Ticket deleted');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

// Direct DOM manipulation, not a setState() re-render - a full re-render would rebuild the whole
// form from `data` (captured once when the modal opened), discarding whatever the admin has
// already typed into Title/Description/other fields since then. Matches the original app's
// pattern for exactly this kind of "one field's change affects another field's options" case.
export function onTicketLocationChange(value) {
  const screenSel = document.getElementById('tk-screen');
  if (!screenSel) return;
  const pd = pageData();
  const locations = pd?.locations || [];
  const assetInventory = pd?.assetInventory || [];
  const loc = value ? locations.find((l) => l.name === value) : null;
  const screens = loc ? assetInventoryForLocationFull(loc, locations, assetInventory) : [];
  screenSel.innerHTML = '<option value="">-</option>'
    + screens.map((s) => `<option value="${s.id}">${esc(screenLabel(s))}</option>`).join('');
  onTicketScreenChange('');
}

export async function viewTicketPhoto() {
  const path = document.getElementById('tk-existing-photo-path')?.value;
  if (!path) return;
  try {
    const url = await getSignedUrl(path, 300);
    window.open(url, '_blank');
  } catch (e) { toast(e.message, 'error'); }
}

// Only unlinks it from THIS ticket (clears the hidden path so save() won't carry it over) -
// doesn't delete the underlying file, since a Screen Report attachment still belongs to that
// report regardless of whether the admin wants it on the ticket too.
export function removeTicketPhoto() {
  const pathInput = document.getElementById('tk-existing-photo-path');
  if (pathInput) pathInput.value = '';
  const row = document.getElementById('tk-existing-photo-row');
  if (row) row.style.display = 'none';
}

export async function saveTicketForm(event) {
  event.preventDefault();
  const id = document.getElementById('tk-id').value || null;
  const status = document.getElementById('tk-status').value;
  const rootCause = document.getElementById('tk-root-cause').value.trim();
  if (status === 'Closed' && !rootCause) {
    toast('Root cause is required before closing a ticket', 'error');
    return;
  }
  const assetInvId = document.getElementById('tk-screen').value || null;
  const pd = pageData();
  const screen = assetInvId ? pd.assetInventory.find((a) => a.id === assetInvId) : null;
  const row = {
    id,
    type: document.getElementById('tk-type').value,
    title: document.getElementById('tk-title').value.trim(),
    location: document.getElementById('tk-location').value,
    assetInvId,
    assetInvLabel: screen ? screenLabel(screen) : null,
    description: document.getElementById('tk-description').value.trim(),
    status,
    priority: document.getElementById('tk-priority').value,
    rootCause,
    reportedBy: document.getElementById('tk-reported-by').value.trim(),
    dateReported: document.getElementById('tk-date-reported').value || null,
    dateClosed: status === 'Closed' ? new Date().toISOString().slice(0, 10) : null,
    // Whatever's left in this hidden field once the form's submitted - the ticket's existing
    // photo_path, a Screen Report attachment carried over on open, or '' if the admin hit Remove -
    // takes effect whenever a NEW file isn't also being uploaded (see saveTicket).
    photoPath: document.getElementById('tk-existing-photo-path')?.value || null,
  };
  const photoFile = document.getElementById('tk-photo')?.files?.[0] || null;
  // A ticket opened from Screen Reports > Create Ticket carries this through the modal's own data
  // (STATE.modal.data, the prefill object) rather than any form field, since it's plumbing between
  // pages, not something the admin edits - marks that report handled once the ticket actually
  // saves, so it drops off the "needs action" list without deleting the report itself (still
  // useful history against that screen).
  const screenReportId = STATE.modal?.data?.__screenReportId || null;
  try {
    const saved = await saveTicket(row, photoFile);
    await logAudit(id ? 'Edit ticket' : 'Add ticket', row.title);
    invalidate('ticketsPage');
    invalidate('opsOverviewV2');
    invalidate('assetsInventoryPage');
    if (screenReportId) {
      try {
        await updateScreenReport(screenReportId, { status: 'Ticket Created', ticket_id: saved.id });
        invalidate('screenReports');
      } catch (e) { /* non-fatal - the ticket itself already saved fine */ }
    }
    closeModal();
    toast('Ticket saved');
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('ticket', (data) => {
  const pd = pageData();
  const locations = pd?.locations || [];
  const assetInventory = pd?.assetInventory || [];
  const selectedLoc = data.location ? locations.find((l) => l.name === data.location) : null;
  const screens = selectedLoc ? assetInventoryForLocationFull(selectedLoc, locations, assetInventory) : [];
  return `
    <h3>${data.id ? 'Edit' : 'New'} Ticket</h3>
    <form onsubmit="App.saveTicketForm(event)">
      <input type="hidden" id="tk-id" value="${esc(data.id || '')}">
      <div class="field"><label>Title</label><input id="tk-title" value="${esc(data.title || '')}" required></div>
      <div class="grid2">
        <div class="field"><label>Type</label>
          <select id="tk-type">
            <option value="Issue" ${data.type === 'Issue' ? 'selected' : ''}>Issue</option>
            <option value="Internal" ${data.type === 'Internal' ? 'selected' : ''}>Internal</option>
          </select>
        </div>
        <div class="field"><label>Priority</label>
          <select id="tk-priority">
            ${['Low', 'Medium', 'High', 'Critical'].map((p) => `<option value="${p}" ${(data.priority || 'Medium') === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="grid2">
        <div class="field"><label>Location</label>
          <select id="tk-location" onchange="App.onTicketLocationChange(this.value)">
            <option value="">-</option>
            ${locations.map((l) => `<option value="${esc(l.name)}" ${data.location === l.name ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Screen (optional)</label>
          <select id="tk-screen" onchange="App.onTicketScreenChange(this.value)">
            <option value="">-</option>
            ${screens.map((s) => `<option value="${s.id}" ${data.asset_inv_id === s.id ? 'selected' : ''}>${esc(screenLabel(s))}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="tk-history">${renderTicketHistoryBlock(data.asset_inv_id || null, pd?.tickets || [], data.id)}</div>
      <div class="field"><label>Description</label><textarea id="tk-description" rows="3">${esc(data.description || '')}</textarea></div>
      <div class="grid2">
        <div class="field"><label>Status</label>
          <select id="tk-status">
            ${['Open', 'In Progress', 'Resolved', 'Closed'].map((s) => `<option value="${s}" ${(data.status || 'Open') === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Reported By</label><input id="tk-reported-by" value="${esc(data.reported_by || '')}"></div>
      </div>
      <div class="field"><label>Date Reported</label><input id="tk-date-reported" type="date" value="${data.date_reported || ''}"></div>
      <div class="field"><label>Root Cause (required to close)</label><textarea id="tk-root-cause" rows="2">${esc(data.root_cause || '')}</textarea></div>
      <div class="field"><label>Photo/Video</label>
        <input id="tk-photo" type="file" accept="image/*,video/*">
        <input type="hidden" id="tk-existing-photo-path" value="${esc(data.photo_path || '')}">
        <div id="tk-existing-photo-row" class="small" style="margin-top:4px;display:flex;align-items:center;gap:10px;${data.photo_path ? '' : 'display:none;'}">
          <span>${data.__fromScreenReport ? 'Attached from the screen report' : 'Current attachment'}:</span>
          <button type="button" class="link-btn" onclick="App.viewTicketPhoto()">View</button>
          <button type="button" class="link-btn" style="color:#c0392b;" onclick="App.removeTicketPhoto()">Remove</button>
        </div>
        ${data.__extraReportMediaCount ? `<div class="small muted" style="margin-top:4px;">+${data.__extraReportMediaCount} more attachment(s) on the original Screen Report (Screen Reports &gt; View).</div>` : ''}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Save</button>
      </div>
    </form>
  `;
});
