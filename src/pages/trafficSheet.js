// Traffic Sheet - a live campaign schedule report proxied from the AdLive Center Traffic Sheet
// API (see supabase/functions/traffic-sheet-proxy). Unlike the other integrations in this app,
// nothing here is synced into a table: the user picks a month range, clicks Fetch, and the
// response is held in STATE only for the current session - re-fetch to refresh.
//
// The API's own venue objects ({ venue, venueType, network, screens }) are the only source of
// truth for which sub-tab a campaign belongs to - this is a different platform than our own
// Supabase asset_inventory/networks tables, so its venueType/network strings can't be assumed to
// match ours. Mapping confirmed with the customer:
//   - Malls: venueType === "MALLS" (per the API's own example response)
//   - MAF Malls: the Malls subset whose venue name matches a known MAF mall (same keyword list
//     used for Asset Inventory's MAF Malls filter, see src/data/locationStats.js)
//   - Stores: venue/network name mentions LULU, Union Coop, ADCOOP, or ENOC
//   - Royals: network name mentions ROYALS
//   - Gems: venue name matches one of the 3 Palm Dubai Gems assets (Zumurod/Ruby/Fairouz) -
//     hardcoded venue names, not a network/category, per the customer's own description
//   - SHZ Bridges: venueType mentions "BRIDGE" (best guess pending real sample data - no
//     Sharjah-bridges grouping exists anywhere else in this app to confirm against; revisit once
//     real API responses are seen)
import { STATE, setState, loadData } from '../state.js';
import { loadingCard } from '../modals.js';
import { getAllSettings } from '../data/settings.js';
import { MAF_MALL_VENUE_KEYWORDS } from '../data/locationStats.js';
import { supabase } from '../supabaseClient.js';
import { isAdmin } from '../auth.js';
import { esc } from '../lib/format.js';
import { renderTabs } from '../lib/tabs.js';

const TAB_DEFS = [
  { key: 'shzBridges', label: 'SHZ Bridges' },
  { key: 'malls', label: 'Malls' },
  { key: 'mafMalls', label: 'MAF Malls' },
  { key: 'stores', label: 'Stores' },
  { key: 'royals', label: 'Royals' },
  { key: 'gems', label: 'Gems' },
];

const STORE_KEYWORDS = ['LULU', 'UNION COOP', 'ADCOOP', 'ENOC'];
const GEMS_VENUE_KEYWORDS = ['PALM DUBAI ZUMUROD', 'PALM DUBAI RUBY', 'PALM DUBAI FAIROUZ'];

function defaultMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function venueMatchesTab(venue, tabKey) {
  const venueType = (venue.venueType || '').toUpperCase();
  const network = (venue.network || '').toUpperCase();
  const name = (venue.venue || '').toUpperCase();
  switch (tabKey) {
    case 'malls':
      return venueType === 'MALLS';
    case 'mafMalls':
      return venueType === 'MALLS' && MAF_MALL_VENUE_KEYWORDS.some((k) => name.includes(k));
    case 'stores':
      return STORE_KEYWORDS.some((k) => name.includes(k) || network.includes(k));
    case 'royals':
      return network.includes('ROYALS');
    case 'gems':
      return GEMS_VENUE_KEYWORDS.some((k) => name.includes(k));
    case 'shzBridges':
      return venueType.includes('BRIDGE') || network.includes('SHZ') || network.includes('SHARJAH');
    default:
      return false;
  }
}

function locationsForTab(data, tabKey) {
  const set = new Set();
  (data?.campaigns || []).forEach((c) => (c.venues || []).forEach((v) => {
    if (venueMatchesTab(v, tabKey)) set.add(v.venue);
  }));
  return [...set].sort();
}

// Attaches __matchedVenues (the subset of a campaign's venues that belong to this tab/location)
// so the summary table and campaign list stay consistent with each other.
function filteredCampaigns(data, tabKey, location) {
  const campaigns = data?.campaigns || [];
  return campaigns
    .map((c) => {
      const venues = (c.venues || []).filter((v) => venueMatchesTab(v, tabKey) && (!location || v.venue === location));
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

function renderTrafficSheetBody(campaigns, summary, totalScreens, dates, dateGroups) {
  if (!campaigns.length) {
    return '<div class="card"><div class="empty">No campaigns found for this tab/period/location.</div></div>';
  }

  const summaryRows = summary.map((s) => `
    <tr>
      <td>${esc(s.venue)}</td>
      <td>${esc(s.venueType || '-')}</td>
      <td>${esc(s.network || '-')}</td>
      <td class="tright">${s.screens || 0}</td>
      <td class="tright">${s.campaigns.size}</td>
    </tr>
  `).join('');

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
    <div class="card" style="margin-bottom:16px;">
      <div class="card-head"><h3>Summary</h3><div class="desc">${campaigns.length} campaign(s) running, ${totalScreens} screen(s) across ${summary.length} location(s).</div></div>
      <table><thead><tr><th>Location</th><th>Venue Type</th><th>Network</th><th class="tright">Screens</th><th class="tright">Campaigns</th></tr></thead>
      <tbody>${summaryRows}</tbody></table>
    </div>
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
  const location = STATE.trafficSheetLocation || '';
  const loading = STATE.trafficSheetLoading;
  const error = STATE.trafficSheetError;
  const data = STATE.trafficSheetData;

  const locations = data ? locationsForTab(data, tab) : [];
  const campaigns = data ? filteredCampaigns(data, tab, location) : [];
  const summary = locationSummary(campaigns);
  const totalScreens = summary.reduce((sum, s) => sum + (s.screens || 0), 0);
  const dates = collectDates(campaigns);
  const dateGroups = groupDatesByMonth(dates);

  return `
    ${renderTabs(TAB_DEFS, tab, 'App.setTrafficSheetTab')}
    <div class="toolbar">
      <div class="toolbar-actions" style="align-items:flex-end;">
        <div class="field" style="margin-bottom:0;"><label>Start Month</label><input type="month" id="tsheet-start" value="${esc(start)}"></div>
        <div class="field" style="margin-bottom:0;"><label>End Month</label><input type="month" id="tsheet-end" value="${esc(end)}"></div>
        <div class="field" style="margin-bottom:0;min-width:220px;"><label>Location</label>
          <select id="tsheet-location" onchange="App.setTrafficSheetLocation(this.value)">
            <option value="">All Locations</option>
            ${locations.map((l) => `<option value="${esc(l)}" ${location === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-orange" type="button" ${loading ? 'disabled' : ''} onclick="App.fetchTrafficSheet()">${loading ? 'Loading...' : 'Fetch'}</button>
      </div>
    </div>
    ${error ? `<div class="login-error" style="margin-bottom:14px;">${esc(error)}</div>` : ''}
    ${!data
      ? '<div class="card"><div class="empty">Pick a month range and click Fetch to load the traffic sheet.</div></div>'
      : renderTrafficSheetBody(campaigns, summary, totalScreens, dates, dateGroups)}
  `;
}

export function setTrafficSheetTab(tab) {
  setState({ trafficSheetTab: tab, trafficSheetLocation: '' });
}

export function setTrafficSheetLocation(value) {
  setState({ trafficSheetLocation: value });
}

export async function fetchTrafficSheet() {
  const start = document.getElementById('tsheet-start').value || defaultMonth();
  const end = document.getElementById('tsheet-end').value || start;
  setState({ trafficSheetStart: start, trafficSheetEnd: end, trafficSheetLoading: true, trafficSheetError: null });
  try {
    const { data, error } = await supabase.functions.invoke('traffic-sheet-proxy', { body: { startMonth: start, endMonth: end } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    setState({ trafficSheetData: data, trafficSheetLoading: false, trafficSheetLocation: '' });
  } catch (e) {
    setState({ trafficSheetLoading: false, trafficSheetError: e.message || 'Failed to fetch traffic sheet' });
  }
}
