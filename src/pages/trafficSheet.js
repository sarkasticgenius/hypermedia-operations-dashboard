// Traffic Sheet - a live campaign schedule report proxied from the AdLive Center Traffic Sheet
// API (see supabase/functions/traffic-sheet-proxy). Nothing here is synced into a table: the
// current month is auto-loaded on first view, and "Apply Month Filter" re-fetches a specific
// range on demand - held in STATE only for the current session.
//
// Sub-tab filters were built against a real August 2026 pull (206 campaigns) rather than guesses
// - the venue objects ({ venue, venueType, network, screens }) come from a completely different
// platform than our own Supabase asset_inventory/networks tables, and its real data turned up
// several naming quirks worth recording:
//   - venueType casing is inconsistent ("Malls" and "MALLS" both appear for the same category) -
//     always compare uppercased.
//   - Mall venue names use US spelling "CENTER" (e.g. "SHARJAH CITY CENTER"), not the UK "CENTRE"
//     our own Asset Inventory uses - normalizeVenueText() below rewrites CENTER->CENTRE before any
//     keyword match so the same MAF_MALL_VENUE_KEYWORDS list (UK spelling) still matches. This was
//     the actual cause of "MAF malls not pulling all details" - none of the 7 real MAF City
//     Centre/MOE venues carry "MAF" in their network (all under "Retail NW (A) FMCG"), so the
//     venue-name keyword match is the ONLY path that can catch them; it just needed the spelling
//     fix. Malls (non-MAF) and MAF Malls are mutually exclusive: Malls excludes anything the MAF
//     keyword list catches.
//   - "SHZ Bridges" was matching on network text containing "Sharjah"/"SHZ", which wrongly pulled
//     in "ENOC Sharjah" (a real Convenience Stores venue in this data, nothing to do with
//     bridges). The real August pull has NO venue/network containing the literal word "bridge" at
//     all - what actually IS the Dubai Metro pedestrian-bridge inventory shows up under
//     venueType "METRO OUTDOOR" (venue names like "BUSINESS BAY", "FINANCIAL CENTER", "WORLD
//     TRADE CENTER", "ALKHAIL (AL FARDAN)" - a near-exact match to our own Locations' 'Metro
//     Bridges' chain members), so that's the real filter now, with a literal "BRIDGE" text match
//     kept as a fallback in case of future overpass-style naming.
//   - Gems' 3 Palm venues are spelled "PALM-DUBAI ZUMUROD" (hyphen, no space before DUBAI) in real
//     data, not "PALM DUBAI ZUMUROD" - normalizeVenueText() also collapses hyphens/underscores to
//     spaces so the keyword list doesn't need a hyphen-exact variant.
//   - "ENOC Hatta" is a distinct venue (network "ENOC DUBAI") that should roll up into "ENOC
//     Dubai" in the summary/location list per the customer - handled by mergeVenueName() rather
//     than a matching rule, since Hatta still needs to match the ENOC tab, just displayed/grouped
//     under the merged name afterward.
//   - Stores (labeled "In-Stores") is LULU/Union Coop/ADCOOP only - ENOC deliberately has its own
//     tab, not part of In-Stores.
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

// Uppercases + normalizes spelling/separator quirks seen in the real API data (US "CENTER" vs UK
// "CENTRE", hyphens vs spaces) so keyword matches don't need a variant per quirk.
function normalizeVenueText(s) {
  return (s || '').toUpperCase().replace(/CENTER/g, 'CENTRE').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// "ENOC Hatta" rolls up into "ENOC Dubai" for display/grouping (summary, location dropdown,
// campaign list) - applied after tab matching, so Hatta still matches the ENOC tab on its own
// name first.
function mergeVenueName(name) {
  return normalizeVenueText(name) === 'ENOC HATTA' ? 'ENOC Dubai' : name;
}

function isMafVenue(venue) {
  const network = (venue.network || '').toUpperCase();
  if (network.includes('MAF')) return true;
  const venueType = (venue.venueType || '').toUpperCase();
  if (venueType !== 'MALLS') return false;
  const name = normalizeVenueText(venue.venue);
  return MAF_MALL_VENUE_KEYWORDS.some((k) => name.includes(k));
}

function venueMatchesTab(venue, tabKey) {
  const venueType = (venue.venueType || '').toUpperCase();
  const network = (venue.network || '').toUpperCase();
  const name = normalizeVenueText(venue.venue);
  switch (tabKey) {
    case 'malls':
      return venueType === 'MALLS' && !isMafVenue(venue);
    case 'mafMalls':
      return isMafVenue(venue);
    case 'stores':
      return STORE_KEYWORDS.some((k) => name.includes(k) || network.includes(k));
    case 'royals':
      return network.includes('ROYALS');
    case 'gems':
      return GEMS_VENUE_KEYWORDS.some((k) => name.includes(k));
    case 'enoc':
      return name.includes('ENOC') || network.includes('ENOC');
    case 'shzBridges':
      return venueType === 'METRO OUTDOOR' || name.includes('BRIDGE');
    default:
      return false;
  }
}

function locationsForTab(data, tabKey) {
  const set = new Set();
  (data?.campaigns || []).forEach((c) => (c.venues || []).forEach((v) => {
    if (venueMatchesTab(v, tabKey)) set.add(mergeVenueName(v.venue));
  }));
  return [...set].sort();
}

// Attaches __matchedVenues (the subset of a campaign's venues that belong to this tab/location,
// with ENOC Hatta already merged into ENOC Dubai) so the summary table and campaign list stay
// consistent with each other.
function filteredCampaigns(data, tabKey, location) {
  const campaigns = data?.campaigns || [];
  return campaigns
    .map((c) => {
      const venues = (c.venues || [])
        .filter((v) => venueMatchesTab(v, tabKey))
        .map((v) => ({ ...v, venue: mergeVenueName(v.venue) }))
        .filter((v) => !location || v.venue === location);
      return venues.length ? { ...c, __matchedVenues: venues } : null;
    })
    .filter(Boolean);
}

function inDateRange(dateIso, startDate, endDate) {
  if (startDate && dateIso < startDate) return false;
  if (endDate && dateIso > endDate) return false;
  return true;
}

// Optional day-level refinement on top of the month-granularity API fetch - the API itself only
// takes startMonth/endMonth, so narrowing to a specific date window happens client-side against
// whatever month(s) are already loaded.
function withinDateRange(campaign, startDate, endDate) {
  if (!startDate && !endDate) return true;
  const days = campaign.days || [];
  if (days.length) return days.some((d) => inDateRange(d.date, startDate, endDate));
  if (campaign.startDate && campaign.endDate) {
    if (endDate && campaign.startDate > endDate) return false;
    if (startDate && campaign.endDate < startDate) return false;
    return true;
  }
  return true;
}

function isActiveOn(campaign, dateIso) {
  if (campaign.startDate && campaign.endDate) return campaign.startDate <= dateIso && campaign.endDate >= dateIso;
  return (campaign.days || []).some((d) => d.date === dateIso && d.spots > 0);
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

// Each row's venue name is clickable - sets the Location dropdown to that exact venue, so
// clicking a location filters the whole page down to just its campaigns.
function renderSummaryCard(campaigns, summary, totalScreens) {
  const rows = summary.map((s) => `
    <tr style="cursor:pointer;" onclick="App.setTrafficSheetLocation('${jsAttr(s.venue)}')" title="Click to filter to this location">
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
        <h3>Summary</h3>
        <div class="desc">${campaigns.length} campaign(s), ${totalScreens} screen(s) across ${summary.length} location(s) for the selected range. Click a location to filter.</div>
      </div>
      <table><thead><tr><th>Location</th><th>Venue Type</th><th>Network</th><th class="tright">Screens</th><th class="tright">Campaigns</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5"><div class="empty">No data.</div></td></tr>'}</tbody></table>
    </div>
  `;
}

// Always-visible live snapshot of what's running today, independent of any Start/End Date
// narrowing applied to the grid below.
function renderTodayList(campaigns) {
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
    <div class="card" style="margin-bottom:16px;">
      <div class="card-head"><h3>Today's Active Campaigns</h3><div class="desc">${campaigns.length} campaign(s) active today for this tab/location.</div></div>
      <table><thead><tr><th>Contract</th><th>Campaign Name</th><th>Venue(s)</th><th>Status</th><th>Start</th><th>End</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6"><div class="empty">No active campaigns today.</div></td></tr>'}</tbody></table>
    </div>
  `;
}

// The full day-by-day spot grid, matching the customer's original campaign sheet layout.
function renderDayGrid(campaigns, startDate, endDate) {
  if (!campaigns.length) {
    return '<div class="card"><div class="empty">No campaigns found for this tab/period/location.</div></div>';
  }
  let dates = collectDates(campaigns);
  if (startDate || endDate) dates = dates.filter((d) => inDateRange(d, startDate, endDate));
  if (!dates.length) {
    return '<div class="card"><div class="empty">No day-level data in the selected date range.</div></div>';
  }
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
  const location = STATE.trafficSheetLocation || '';
  const startDate = STATE.trafficSheetStartDate || '';
  const endDate = STATE.trafficSheetEndDate || '';
  const loading = STATE.trafficSheetLoading;
  const error = STATE.trafficSheetError;
  const data = STATE.trafficSheetData;

  // Auto-load the current month exactly once on first view - guarded so re-renders don't refire.
  if (!data && !loading && !STATE.trafficSheetAutoFetchStarted) {
    STATE.trafficSheetAutoFetchStarted = true;
    queueMicrotask(autoFetchTrafficSheet);
  }

  const locations = data ? locationsForTab(data, tab) : [];
  const campaigns = data ? filteredCampaigns(data, tab, location) : [];
  const gridCampaigns = (startDate || endDate) ? campaigns.filter((c) => withinDateRange(c, startDate, endDate)) : campaigns;
  const summary = locationSummary(gridCampaigns);
  const totalScreens = summary.reduce((sum, s) => sum + (s.screens || 0), 0);
  const todaysCampaigns = campaigns.filter((c) => isActiveOn(c, todayISO()));

  let detailHtml;
  if (!data) {
    detailHtml = `<div class="card"><div class="empty">${loading ? "Loading today's traffic sheet..." : 'Pick a month range and click "Apply Month Filter" to load the traffic sheet.'}</div></div>`;
  } else {
    detailHtml = renderSummaryCard(gridCampaigns, summary, totalScreens)
      + renderTodayList(todaysCampaigns)
      + renderDayGrid(gridCampaigns, startDate, endDate);
  }

  return `
    ${renderTabs(TAB_DEFS, tab, 'App.setTrafficSheetTab')}
    <div class="toolbar">
      <div class="toolbar-actions" style="align-items:flex-end;flex-wrap:wrap;">
        <div class="field" style="margin-bottom:0;"><label>Start Month</label><input type="month" id="tsheet-start" value="${esc(start)}"></div>
        <div class="field" style="margin-bottom:0;"><label>End Month</label><input type="month" id="tsheet-end" value="${esc(end)}"></div>
        <div class="field" style="margin-bottom:0;"><label>Start Date (optional)</label><input type="date" value="${esc(startDate)}" onchange="App.setTrafficSheetStartDate(this.value)"></div>
        <div class="field" style="margin-bottom:0;"><label>End Date (optional)</label><input type="date" value="${esc(endDate)}" onchange="App.setTrafficSheetEndDate(this.value)"></div>
        <div class="field" style="margin-bottom:0;min-width:220px;"><label>Location</label>
          <select onchange="App.setTrafficSheetLocation(this.value)">
            <option value="">All Locations</option>
            ${locations.map((l) => `<option value="${esc(l)}" ${location === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-orange" type="button" ${loading ? 'disabled' : ''} onclick="App.fetchTrafficSheet()">${loading ? 'Loading...' : 'Apply Month Filter'}</button>
      </div>
    </div>
    ${error ? `<div class="login-error" style="margin-bottom:14px;">${esc(error)}</div>` : ''}
    ${detailHtml}
  `;
}

// Resets the Location filter on tab switch, since a location selected under one tab (e.g. a mall
// name) is meaningless once viewing a different tab (e.g. ENOC) - leaving it set silently
// filtered the new tab down to nothing.
export function setTrafficSheetTab(tab) {
  setState({ trafficSheetTab: tab, trafficSheetLocation: '' });
}

export function setTrafficSheetLocation(value) {
  setState({ trafficSheetLocation: value });
}

export function setTrafficSheetStartDate(value) {
  setState({ trafficSheetStartDate: value });
}

export function setTrafficSheetEndDate(value) {
  setState({ trafficSheetEndDate: value });
}

async function runTrafficSheetFetch(start, end) {
  setState({ trafficSheetStart: start, trafficSheetEnd: end, trafficSheetLoading: true, trafficSheetError: null });
  try {
    const { data, error } = await supabase.functions.invoke('traffic-sheet-proxy', { body: { startMonth: start, endMonth: end } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    setState({ trafficSheetData: data, trafficSheetLoading: false });
  } catch (e) {
    setState({ trafficSheetLoading: false, trafficSheetError: e.message || 'Failed to fetch traffic sheet' });
  }
}

export async function fetchTrafficSheet() {
  const start = document.getElementById('tsheet-start').value || defaultMonth();
  const end = document.getElementById('tsheet-end').value || start;
  await runTrafficSheetFetch(start, end);
}

function autoFetchTrafficSheet() {
  const start = defaultMonth();
  return runTrafficSheetFetch(start, start);
}
