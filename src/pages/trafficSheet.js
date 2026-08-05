// Traffic Sheet - a live campaign schedule report proxied from the AdLive Center Traffic Sheet
// API (see supabase/functions/traffic-sheet-proxy). Nothing here is synced into a table: the
// current month is auto-loaded on first view (so the Summary can show today's active campaigns
// without the user having to do anything first), and "Apply Month Filter" re-fetches a specific
// range on demand - held in STATE only for the current session.
//
// The API's own venue objects ({ venue, venueType, network, screens }) are the only source of
// truth for which sub-tab a campaign belongs to - this is a different platform than our own
// Supabase asset_inventory/networks tables, so its venueType/network strings can't be assumed to
// match ours. Mapping confirmed with the customer:
//   - Malls: venueType === "MALLS", excluding MAF malls (those live in their own tab instead)
//   - MAF Malls: the Malls subset whose venue name matches a known MAF mall (same keyword list
//     used for Asset Inventory's MAF Malls filter, see src/data/locationStats.js)
//   - In-Stores: venue/network name mentions LULU, Union Coop, or ADCOOP
//   - Royals: network name mentions ROYALS
//   - Gems: venue name matches one of the 3 Palm Dubai Gems assets (Zumurod/Ruby/Fairouz) -
//     hardcoded venue names, not a network/category, per the customer's own description
//   - ENOC: venue/network name mentions ENOC - its own tab, deliberately NOT part of In-Stores
//   - SHZ Bridges: venueType or venue name mentions "BRIDGE". Originally also matched on
//     network containing "SHARJAH"/"SHZ", which wrongly pulled in "ENOC Sharjah" (a real Petrol
//     Stations venue confirmed via Asset Inventory, category unrelated to bridges) - cross-checked
//     against Asset Inventory/Locations, which has no Sharjah-bridges chain at all (only
//     'Metro Bridges', Dubai-only), so there's nothing there to key off; "BRIDGE" in the venue's
//     own name/venueType is the only safe signal until real API data confirms otherwise.
import { STATE, setState, loadData } from '../state.js';
import { loadingCard } from '../modals.js';
import { getAllSettings } from '../data/settings.js';
import { MAF_MALL_VENUE_KEYWORDS } from '../data/locationStats.js';
import { supabase } from '../supabaseClient.js';
import { isAdmin } from '../auth.js';
import { esc, jsAttr, todayISO } from '../lib/format.js';
import { renderTabs } from '../lib/tabs.js';

const TAB_DEFS = [
  { key: 'shzBridges', label: 'SHZ Bridges' },
  { key: 'malls', label: 'Malls' },
  { key: 'mafMalls', label: 'MAF Malls' },
  { key: 'stores', label: 'In-Stores' },
  { key: 'royals', label: 'Royals' },
  { key: 'gems', label: 'Gems' },
  { key: 'enoc', label: 'ENOC' },
];

const STORE_KEYWORDS = ['LULU', 'UNION COOP', 'ADCOOP'];
const GEMS_VENUE_KEYWORDS = ['PALM DUBAI ZUMUROD', 'PALM DUBAI RUBY', 'PALM DUBAI FAIROUZ'];

function defaultMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function isMafMallVenue(name) {
  return MAF_MALL_VENUE_KEYWORDS.some((k) => name.includes(k));
}

function venueMatchesTab(venue, tabKey) {
  const venueType = (venue.venueType || '').toUpperCase();
  const network = (venue.network || '').toUpperCase();
  const name = (venue.venue || '').toUpperCase();
  switch (tabKey) {
    case 'malls':
      return venueType === 'MALLS' && !isMafMallVenue(name);
    case 'mafMalls':
      return venueType === 'MALLS' && isMafMallVenue(name);
    case 'stores':
      return STORE_KEYWORDS.some((k) => name.includes(k) || network.includes(k));
    case 'royals':
      return network.includes('ROYALS');
    case 'gems':
      return GEMS_VENUE_KEYWORDS.some((k) => name.includes(k));
    case 'enoc':
      return name.includes('ENOC') || network.includes('ENOC');
    case 'shzBridges':
      return venueType.includes('BRIDGE') || name.includes('BRIDGE');
    default:
      return false;
  }
}

// Attaches __matchedVenues (the subset of a campaign's venues that belong to this tab/location
// search) so the summary table and campaign list stay consistent with each other. locationSearch
// is a case-insensitive substring match against venue name, same filtering feel as the Locations
// workspace's search box rather than an exact-match dropdown.
function filteredCampaigns(data, tabKey, locationSearch) {
  const needle = locationSearch.trim().toLowerCase();
  const campaigns = data?.campaigns || [];
  return campaigns
    .map((c) => {
      const venues = (c.venues || []).filter((v) => venueMatchesTab(v, tabKey) && (!needle || (v.venue || '').toLowerCase().includes(needle)));
      return venues.length ? { ...c, __matchedVenues: venues } : null;
    })
    .filter(Boolean);
}

function locationSummary(campaigns) {
  const map = new Map();
  campaigns.forEach((c) => {
    (c.__matchedVenues || []).forEach((v) => {
      if (!map.has(v.venue)) map.set(v.venue, { venue: v.venue, venueType: v.venueType, network: v.network, screens: 0, campaigns: new Set() });
      const entry = map.get(v.venue);
      entry.screens = Math.max(entry.screens, v.screens || 0);
      entry.campaigns.add(c.contract);
    });
  });
  return [...map.values()].sort((a, b) => a.venue.localeCompare(b.venue));
}

function isActiveOn(campaign, dateIso) {
  if (campaign.startDate && campaign.endDate) return campaign.startDate <= dateIso && campaign.endDate >= dateIso;
  return (campaign.days || []).some((d) => d.date === dateIso && d.spots > 0);
}

function collectDates(campaigns) {
  const set = new Set();
  campaigns.forEach((c) => (c.days || []).forEach((d) => set.add(d.date)));
  return [...set].sort();
}

function groupDatesByMonth(dates) {
  const groups = [];
  dates.forEach((d) => {
    const month = d.slice(0, 7);
    let g = groups[groups.length - 1];
    if (!g || g.month !== month) { g = { month, dates: [] }; groups.push(g); }
    g.dates.push(d);
  });
  return groups;
}

function formatMonthLabel(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function statusBadge(status) {
  const s = (status || '').toLowerCase();
  let cls = 'b-blue';
  if (s.includes('live') || s.includes('running')) cls = 'b-green';
  else if (s.includes('complete')) cls = 'b-gray';
  else if (s.includes('pending') || s.includes('scheduled')) cls = 'b-amber';
  else if (s.includes('paused') || s.includes('stopped')) cls = 'b-red';
  return `<span class="badge ${cls}">${esc(status || 'Unknown')}</span>`;
}

// Each row's venue name is clickable - sets the location search box to that exact venue, so
// clicking a location filters the whole page down to just its campaigns (summary + list/grid).
function renderSummaryCard(summarySource, summary, totalScreens, filterApplied) {
  const rows = summary.map((s) => `
    <tr style="cursor:pointer;" onclick="App.setTrafficSheetLocationSearch('${jsAttr(s.venue)}')" title="Click to filter to this location">
      <td>${esc(s.venue)}</td>
      <td>${esc(s.venueType || '-')}</td>
      <td>${esc(s.network || '-')}</td>
      <td class="tright">${s.screens || 0}</td>
      <td class="tright">${s.campaigns.size}</td>
    </tr>
  `).join('');
  return `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-head">
        <h3>Summary${filterApplied ? '' : ' - Today'}</h3>
        <div class="desc">${summarySource.length} campaign(s) ${filterApplied ? 'in the selected period' : 'active today'}, ${totalScreens} screen(s) across ${summary.length} location(s). Click a location to filter.</div>
      </div>
      <table><thead><tr><th>Location</th><th>Venue Type</th><th>Network</th><th class="tright">Screens</th><th class="tright">Campaigns</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5"><div class="empty">No data.</div></td></tr>'}</tbody></table>
    </div>
  `;
}

// Default view (no month filter applied yet) - a plain list of what's running today, no day grid.
function renderTodayList(campaigns) {
  if (!campaigns.length) {
    return '<div class="card"><div class="empty">No active campaigns today for this tab/location.</div></div>';
  }
  const rows = campaigns.map((c) => `
    <tr>
      <td>${esc(c.contract || '')}</td>
      <td>${esc(c.campaignName || '')}</td>
      <td>${esc((c.__matchedVenues || []).map((v) => v.venue).join(', '))}</td>
      <td>${statusBadge(c.status)}</td>
      <td>${esc(c.startDate || '')}</td>
      <td>${esc(c.endDate || '')}</td>
    </tr>
  `).join('');
  return `
    <div class="card">
      <div class="card-head"><h3>Today's Active Campaigns</h3><div class="desc">Pick a month range above and click "Apply Month Filter" to see the full day-by-day breakdown instead.</div></div>
      <table><thead><tr><th>Contract</th><th>Campaign Name</th><th>Venue(s)</th><th>Status</th><th>Start</th><th>End</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>
  `;
}

// Filtered view (month filter applied) - the full day-by-day spot grid.
function renderDayGrid(campaigns) {
  if (!campaigns.length) {
    return '<div class="card"><div class="empty">No campaigns found for this tab/period/location.</div></div>';
  }
  const dates = collectDates(campaigns);
  const dateGroups = groupDatesByMonth(dates);

  const monthHeadRow = `<tr><th colspan="7"></th>${dateGroups.map((g) => `<th colspan="${g.dates.length}" class="tsheet-month-head">${esc(formatMonthLabel(g.month))}</th>`).join('')}</tr>`;
  const dayHeadRow = `<tr>
    <th>Contract</th><th>Campaign Name</th><th>Start</th><th>End</th><th>Days</th><th>Loop Count</th><th>Status</th>
    ${dates.map((d) => `<th class="tsheet-day">${esc(d.slice(8, 10))}</th>`).join('')}
  </tr>`;

  const bodyRows = campaigns.map((c) => {
    const dayMap = {};
    (c.days || []).forEach((d) => { dayMap[d.date] = d.spots; });
    return `<tr>
      <td>${esc(c.contract || '')}</td>
      <td>${esc(c.campaignName || '')}</td>
      <td>${esc(c.startDate || '')}</td>
      <td>${esc(c.endDate || '')}</td>
      <td class="tright">${c.campaignDays ?? ''}</td>
      <td class="tright">${c.loopCount ?? ''}</td>
      <td>${statusBadge(c.status)}</td>
      ${dates.map((d) => {
        const spots = dayMap[d];
        return `<td class="tsheet-cell${spots ? ' tsheet-active' : ''}">${spots ? esc(String(spots)) : ''}</td>`;
      }).join('')}
    </tr>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-head"><h3>Campaigns</h3></div>
      <div class="tsheet-wrap">
        <table class="tsheet-table">
          <thead>${monthHeadRow}${dayHeadRow}</thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

export function renderTrafficSheet() {
  const settings = loadData('settings', getAllSettings);
  if (settings === null) return loadingCard();
  if (settings?.__error) return loadingCard(settings.__error);
  const cfg = settings.trafficSheetApi || {};

  if (!cfg.enabled || !cfg.apiKey) {
    return `
      <div class="card">
        <div class="empty">
          Traffic Sheet isn't configured yet.<br>
          ${isAdmin() ? 'Add the API key under Settings &gt; Integrations &gt; Traffic Sheet API.' : 'Ask an administrator to configure the Traffic Sheet API under Settings &gt; Integrations.'}
        </div>
      </div>
    `;
  }

  const tab = STATE.trafficSheetTab || 'malls';
  const start = STATE.trafficSheetStart || defaultMonth();
  const end = STATE.trafficSheetEnd || start;
  const locationSearch = STATE.trafficSheetLocationSearch || '';
  const loading = STATE.trafficSheetLoading;
  const error = STATE.trafficSheetError;
  const data = STATE.trafficSheetData;
  const filterApplied = !!STATE.trafficSheetFilterApplied;

  // Auto-load the current month exactly once on first view, so Summary has "today" data to show
  // without requiring the user to click anything first - guarded so re-renders don't refire it.
  if (!data && !loading && !STATE.trafficSheetAutoFetchStarted) {
    STATE.trafficSheetAutoFetchStarted = true;
    queueMicrotask(autoFetchTrafficSheet);
  }

  const campaigns = data ? filteredCampaigns(data, tab, locationSearch) : [];
  const todaysCampaigns = campaigns.filter((c) => isActiveOn(c, todayISO()));
  const summarySource = filterApplied ? campaigns : todaysCampaigns;
  const summary = locationSummary(summarySource);
  const totalScreens = summary.reduce((sum, s) => sum + (s.screens || 0), 0);

  let detailHtml;
  if (!data) {
    detailHtml = `<div class="card"><div class="empty">${loading ? "Loading today's traffic sheet..." : 'Pick a month range and click "Apply Month Filter" to load the traffic sheet.'}</div></div>`;
  } else {
    detailHtml = renderSummaryCard(summarySource, summary, totalScreens, filterApplied)
      + (filterApplied ? renderDayGrid(campaigns) : renderTodayList(todaysCampaigns));
  }

  return `
    ${renderTabs(TAB_DEFS, tab, 'App.setTrafficSheetTab')}
    <div class="toolbar">
      <div class="toolbar-actions" style="align-items:flex-end;">
        <div class="field" style="margin-bottom:0;"><label>Start Month</label><input type="month" id="tsheet-start" value="${esc(start)}"></div>
        <div class="field" style="margin-bottom:0;"><label>End Month</label><input type="month" id="tsheet-end" value="${esc(end)}"></div>
        <div class="field" style="margin-bottom:0;min-width:220px;"><label>Search Location</label>
          <input id="tsheet-location-search" placeholder="Search locations..." value="${esc(locationSearch)}" oninput="App.setTrafficSheetLocationSearch(this.value)">
        </div>
        <button class="btn btn-orange" type="button" ${loading ? 'disabled' : ''} onclick="App.fetchTrafficSheet()">${loading ? 'Loading...' : 'Apply Month Filter'}</button>
      </div>
    </div>
    ${error ? `<div class="login-error" style="margin-bottom:14px;">${esc(error)}</div>` : ''}
    ${detailHtml}
  `;
}

export function setTrafficSheetTab(tab) {
  setState({ trafficSheetTab: tab });
}

export function setTrafficSheetLocationSearch(value) {
  setState({ trafficSheetLocationSearch: value });
}

async function runTrafficSheetFetch(start, end, extraState) {
  setState({ trafficSheetStart: start, trafficSheetEnd: end, trafficSheetLoading: true, trafficSheetError: null, ...extraState });
  try {
    const { data, error } = await supabase.functions.invoke('traffic-sheet-proxy', { body: { startMonth: start, endMonth: end } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    setState({ trafficSheetData: data, trafficSheetLoading: false });
  } catch (e) {
    setState({ trafficSheetLoading: false, trafficSheetError: e.message || 'Failed to fetch traffic sheet' });
  }
}

// The explicit "Apply Month Filter" action - this is what flips the page from the default
// "today's active campaigns" view into the full period breakdown + day-by-day grid.
export async function fetchTrafficSheet() {
  const start = document.getElementById('tsheet-start').value || defaultMonth();
  const end = document.getElementById('tsheet-end').value || start;
  await runTrafficSheetFetch(start, end, { trafficSheetFilterApplied: true });
}

function autoFetchTrafficSheet() {
  const start = defaultMonth();
  return runTrafficSheetFetch(start, start, {});
}
