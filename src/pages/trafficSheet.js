// Traffic Sheet - a live campaign schedule report proxied from the AdLive Center Traffic Sheet
// API (see supabase/functions/traffic-sheet-proxy). Nothing here is synced into a table: the
// current month is auto-loaded on first view, and Start/End Date (the primary controls - the API
// itself only takes month granularity, derived from whichever month(s) the picked dates touch)
// + "Apply Date Filter" re-fetches a specific range on demand - held in STATE only for the
// current session. "Today's Campaigns" is a dedicated cross-category tab (ignores venueType/
// network entirely) for what's live right now regardless of which venue group it's in.
//
// NOTE on per-venue day data: the API's `days` array is per-CAMPAIGN, not per-venue (confirmed
// against a real campaign spanning all 3 Gems venues - one flat `days` array covering all of
// them combined, no venue-level breakdown anywhere in the response). So when a campaign spans
// multiple venues and the Location filter narrows to just one of them, the day-by-day spot grid
// still shows that campaign's combined total, not a number specific to the selected venue - the
// data to split it out doesn't exist in this endpoint's response. Screens/campaign counts in the
// Summary table ARE per-venue (from each venue's own `screens` field) and unaffected by this.
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
import { exportToCsv } from '../lib/csv.js';

// "Today's Campaigns" and "FOC / Marketing" are both cross-category views -
// venueMatchesTab('today'/'focMarketing') matches every venue, so neither is scoped to any single
// venueType/network the way the other tabs are. FOC/Marketing campaigns are filtered OUT of every
// other tab (including Today's Campaigns and each venue tab's date-wise grid) so they only ever
// show up in their own dedicated tab - see applyFocMarketingFilter().
const TAB_DEFS = [
  { key: 'today', label: "Today's Campaigns" },
  { key: 'focMarketing', label: 'FOC / Marketing' },
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
const FOC_MARKETING_KEYWORDS = ['FOC', 'MARKETING', 'MKTG'];

function isFocMarketingCampaign(campaign) {
  const name = (campaign.campaignName || '').toUpperCase();
  return FOC_MARKETING_KEYWORDS.some((k) => name.includes(k));
}

// Applied after venue-based filtering, on every tab: FOC/Marketing campaigns are pulled out of
// whichever venue-category tab they'd otherwise appear in (and out of Today's Campaigns) and only
// ever surface under the dedicated FOC / Marketing tab, matched by campaign name.
function applyFocMarketingFilter(campaigns, tabKey) {
  return tabKey === 'focMarketing'
    ? campaigns.filter(isFocMarketingCampaign)
    : campaigns.filter((c) => !isFocMarketingCampaign(c));
}

function defaultMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Start/End Date are the primary, user-facing controls - the API itself only takes month
// granularity, so the default range is the current month's first/last day and any date range
// the user picks gets rounded out to whichever month(s) it touches for the actual fetch (see
// fetchTrafficSheet), then narrowed back down to the exact days client-side (withinDateRange).
function monthBounds(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { start: `${monthStr}-01`, end: `${monthStr}-${String(lastDay).padStart(2, '0')}` };
}

function defaultDateRange() {
  return monthBounds(defaultMonth());
}

// Uppercases + normalizes spelling/separator quirks seen in the real API data (US "CENTER" vs UK
// "CENTRE", hyphens vs spaces) so keyword matches don't need a variant per quirk.
function normalizeVenueText(s) {
  return (s || '').toUpperCase().replace(/CENTER/g, 'CENTRE').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Venue-name rollups applied for display/grouping (summary, location dropdown, campaign list)
// only - the raw name is still what's matched against tab/keyword rules first, so e.g. "Royals
// Entry 2" still matches the Royals tab on its own name/network before being merged here.
//   - "ENOC Hatta" -> "ENOC Dubai"
//   - "Royals Entry 1/2/3" -> "Royals Entry", "Royals Exit 1/2/3" -> "Royals Exit"
function mergeVenueName(name) {
  const n = normalizeVenueText(name);
  if (n === 'ENOC HATTA') return 'ENOC Dubai';
  if (/^ROYALS ENTRY \d+$/.test(n)) return 'Royals Entry';
  if (/^ROYALS EXIT \d+$/.test(n)) return 'Royals Exit';
  return name;
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
    case 'today':
    case 'focMarketing':
      return true;
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
// with rollups like ENOC Hatta -> ENOC Dubai or Royals Entry 1/2/3 -> Royals Entry already
// applied to `venue`) so the summary table and campaign list stay consistent with each other.
// __rawVenue keeps the pre-merge name too - locationSummary needs it to sum screens correctly
// across distinct physical venues that got merged into one display row, instead of maxing them
// down to just one.
function filteredCampaigns(data, tabKey, location) {
  const campaigns = data?.campaigns || [];
  return campaigns
    .map((c) => {
      const venues = (c.venues || [])
        .filter((v) => venueMatchesTab(v, tabKey))
        .map((v) => ({ ...v, __rawVenue: v.venue, venue: mergeVenueName(v.venue) }))
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

function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// A single venue legitimately shows up under several different AdLive network values across
// different campaign bookings (e.g. "ENOC Dubai" spans "ENOC AutoPro", "ENOC DUBAI", "ENOC
// C-Store Pelmet" depending on which product line booked it - confirmed against real data, over
// half of all venues have more than one distinct network value). Picking just the first one seen
// (the previous behavior) made the Network column look arbitrary/wrong - showing every distinct
// value fixes that.
//
// Screens are tracked per __rawVenue (the pre-merge name) and summed, not maxed, across raw
// venues - maxing was correct for the same physical venue appearing in multiple campaigns (its
// screen count shouldn't multiply just because it's booked twice), but wrong for a merged group
// like "Royals Entry" (Entry 1/2/3, each its own physical location with its own screen): that
// needs 1+1+1=3, not max(1,1,1)=1. Confirmed against Asset Inventory - all 6 Royals Entry/Exit
// venues are 1 screen each there too, so Entry should total 3 and Exit should total 3.
function locationSummary(campaigns) {
  const map = new Map();
  campaigns.forEach((c) => {
    (c.__matchedVenues || []).forEach((v) => {
      if (!map.has(v.venue)) map.set(v.venue, { venue: v.venue, venueType: v.venueType, networks: new Set(), campaigns: new Set(), screensByRaw: new Map() });
      const entry = map.get(v.venue);
      if (v.network) entry.networks.add(v.network);
      entry.campaigns.add(c.contract);
      const rawKey = v.__rawVenue || v.venue;
      entry.screensByRaw.set(rawKey, Math.max(entry.screensByRaw.get(rawKey) || 0, v.screens || 0));
    });
  });
  return [...map.values()]
    .map((e) => ({
      ...e,
      screens: [...e.screensByRaw.values()].reduce((sum, n) => sum + n, 0),
      network: [...e.networks].sort().join(', ') || '-',
    }))
    .sort((a, b) => a.venue.localeCompare(b.venue));
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

// Quick-glance counts above everything else - scoped to the current tab/location like the rest
// of the page. "Expiring" = endDate falls on that exact day (regardless of status text), not a
// generic "ending soon" window.
function renderQuickStatTiles(todayActive, todayExpiring, yesterdayActive, yesterdayExpired) {
  return `
    <div class="kpi-row" style="margin-bottom:16px;">
      <div class="kpi" style="border-left:4px solid #1f9d55;"><div class="label">Today - Active</div><div class="value">${todayActive}</div></div>
      <div class="kpi" style="border-left:4px solid #b45309;"><div class="label">Today - Expiring</div><div class="value">${todayExpiring}</div></div>
      <div class="kpi" style="border-left:4px solid #2563eb;"><div class="label">Yesterday - Active</div><div class="value">${yesterdayActive}</div></div>
      <div class="kpi" style="border-left:4px solid #6b7280;"><div class="label">Yesterday - Expired</div><div class="value">${yesterdayExpired}</div></div>
    </div>
  `;
}

// Each row's venue name is clickable - sets the Location dropdown to that exact venue, so
// clicking a location filters the whole page down to just its campaigns. "Network" is every
// distinct value AdLive Center's own API reports for that venue across its campaign bookings -
// see the file-header note and locationSummary() for why it's a list rather than one value.
function renderSummaryCard(campaigns, summary, totalScreens) {
  const rows = summary.map((s) => `
    <tr style="cursor:pointer;" onclick="App.setTrafficSheetLocation('${jsAttr(s.venue)}')" title="Click to filter to this location">
      <td>${esc(s.venue)}</td>
      <td>${esc(s.venueType || '-')}</td>
      <td>${esc(s.network)}</td>
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
// narrowing applied to the grid below. Start/End/Status columns are nowrap - narrow columns next
// to Campaign Name's free text otherwise wrap "2026-06-22" onto two lines.
function renderTodayList(campaigns) {
  const rows = campaigns.map((c) => `
    <tr>
      <td>${esc(c.campaignName || '')}</td>
      <td>${esc((c.__matchedVenues || []).map((v) => v.venue).join(', '))}</td>
      <td class="tsheet-nowrap">${statusBadge(c.status)}</td>
      <td class="tsheet-nowrap">${esc(c.startDate || '')}</td>
      <td class="tsheet-nowrap">${esc(c.endDate || '')}</td>
    </tr>
  `).join('');
  return `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-head"><h3>Today's Active Campaigns</h3><div class="desc">${campaigns.length} campaign(s) active today for this tab/location.</div></div>
      <table><thead><tr><th>Campaign Name</th><th>Venue(s)</th><th class="tsheet-nowrap">Status</th><th class="tsheet-nowrap">Start</th><th class="tsheet-nowrap">End</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5"><div class="empty">No active campaigns today.</div></td></tr>'}</tbody></table>
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

  const monthHeadRow = `<tr><th colspan="6"></th>${dateGroups.map((g) => `<th colspan="${g.dates.length}" class="tsheet-month-head">${esc(formatMonthLabel(g.month))}</th>`).join('')}</tr>`;
  const dayHeadRow = `<tr>
    <th>Campaign Name</th><th>Start</th><th>End</th><th>Days</th><th>Loop Count</th><th>Status</th>
    ${dates.map((d) => `<th class="tsheet-day">${esc(d.slice(8, 10))}</th>`).join('')}
  </tr>`;

  const bodyRows = campaigns.map((c) => {
    const dayMap = {};
    (c.days || []).forEach((d) => { dayMap[d.date] = d.spots; });
    return `<tr>
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
  const isTodayTab = tab === 'today';
  const location = STATE.trafficSheetLocation || '';
  const defaults = defaultDateRange();
  const startDate = STATE.trafficSheetStartDate || defaults.start;
  const endDate = STATE.trafficSheetEndDate || defaults.end;
  const loading = STATE.trafficSheetLoading;
  const error = STATE.trafficSheetError;
  const data = STATE.trafficSheetData;

  // Auto-load the current month exactly once on first view - guarded so re-renders don't refire.
  if (!data && !loading && !STATE.trafficSheetAutoFetchStarted) {
    STATE.trafficSheetAutoFetchStarted = true;
    queueMicrotask(autoFetchTrafficSheet);
  }

  const locations = data ? locationsForTab(data, tab) : [];
  const campaigns = data ? applyFocMarketingFilter(filteredCampaigns(data, tab, location), tab) : [];
  // The Today's Campaigns tab is inherently "right now", so it ignores the chosen Start/End Date
  // and always shows exactly what's active today - every other tab (including FOC / Marketing)
  // respects the date range.
  const gridCampaigns = isTodayTab
    ? campaigns.filter((c) => isActiveOn(c, todayISO()))
    : campaigns.filter((c) => withinDateRange(c, startDate, endDate));
  const summary = locationSummary(gridCampaigns);
  const totalScreens = summary.reduce((sum, s) => sum + (s.screens || 0), 0);
  const today = todayISO();
  const yesterday = yesterdayISO();
  const todaysCampaigns = campaigns.filter((c) => isActiveOn(c, today));
  const todayExpiringCount = campaigns.filter((c) => c.endDate === today).length;
  const yesterdayActiveCount = campaigns.filter((c) => isActiveOn(c, yesterday)).length;
  const yesterdayExpiredCount = campaigns.filter((c) => c.endDate === yesterday).length;

  let detailHtml;
  if (!data) {
    detailHtml = `<div class="card"><div class="empty">${loading ? "Loading today's traffic sheet..." : 'Pick a date range and click "Apply Date Filter" to load the traffic sheet.'}</div></div>`;
  } else {
    detailHtml = renderQuickStatTiles(todaysCampaigns.length, todayExpiringCount, yesterdayActiveCount, yesterdayExpiredCount)
      + renderSummaryCard(gridCampaigns, summary, totalScreens)
      + (isTodayTab ? '' : renderTodayList(todaysCampaigns))
      + renderDayGrid(gridCampaigns, isTodayTab ? '' : startDate, isTodayTab ? '' : endDate);
  }

  return `
    ${renderTabs(TAB_DEFS, tab, 'App.setTrafficSheetTab')}
    <div class="toolbar">
      <div class="toolbar-actions" style="align-items:flex-end;flex-wrap:wrap;">
        <div class="field" style="margin-bottom:0;"><label>Start Date</label><input type="date" id="tsheet-start-date" value="${esc(startDate)}"></div>
        <div class="field" style="margin-bottom:0;"><label>End Date</label><input type="date" id="tsheet-end-date" value="${esc(endDate)}"></div>
        <div class="field" style="margin-bottom:0;min-width:220px;"><label>Location</label>
          <select onchange="App.setTrafficSheetLocation(this.value)">
            <option value="">All Locations</option>
            ${locations.map((l) => `<option value="${esc(l)}" ${location === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-orange" type="button" ${loading ? 'disabled' : ''} onclick="App.fetchTrafficSheet()">${loading ? 'Loading...' : 'Apply Date Filter'}</button>
        <button class="btn-outline btn-sm" type="button" ${data ? '' : 'disabled'} onclick="App.downloadTrafficSheetCsv()">Download CSV</button>
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

// Re-fetches whenever the API-backed month range needs to change (a different date range was
// picked, or the location dropdown changed doesn't need this - only the API call does).
async function runTrafficSheetFetch(startDate, endDate) {
  const startMonth = startDate.slice(0, 7);
  const endMonth = endDate.slice(0, 7);
  setState({ trafficSheetStartDate: startDate, trafficSheetEndDate: endDate, trafficSheetLoading: true, trafficSheetError: null });
  try {
    const { data, error } = await supabase.functions.invoke('traffic-sheet-proxy', { body: { startMonth, endMonth } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    setState({ trafficSheetData: data, trafficSheetLoading: false });
  } catch (e) {
    setState({ trafficSheetLoading: false, trafficSheetError: e.message || 'Failed to fetch traffic sheet' });
  }
}

// The explicit "Apply Date Filter" action - Start/End Date are the primary controls now; the
// month(s) needed for the actual API call are derived from whatever dates are picked.
export async function fetchTrafficSheet() {
  const defaults = defaultDateRange();
  const startDate = document.getElementById('tsheet-start-date').value || defaults.start;
  const endDate = document.getElementById('tsheet-end-date').value || defaults.end;
  await runTrafficSheetFetch(startDate, endDate);
}

function autoFetchTrafficSheet() {
  const { start, end } = defaultDateRange();
  return runTrafficSheetFetch(start, end);
}

// Exports whatever's currently on screen (current tab/location/date-range) as a wide CSV - one
// row per campaign, one column per visible day, matching the on-screen grid.
export function downloadTrafficSheetCsv() {
  const data = STATE.trafficSheetData;
  if (!data) return;
  const tab = STATE.trafficSheetTab || 'malls';
  const isTodayTab = tab === 'today';
  const location = STATE.trafficSheetLocation || '';
  const defaults = defaultDateRange();
  const startDate = STATE.trafficSheetStartDate || defaults.start;
  const endDate = STATE.trafficSheetEndDate || defaults.end;

  const campaigns = applyFocMarketingFilter(filteredCampaigns(data, tab, location), tab);
  const gridCampaigns = isTodayTab
    ? campaigns.filter((c) => isActiveOn(c, todayISO()))
    : campaigns.filter((c) => withinDateRange(c, startDate, endDate));
  let dates = collectDates(gridCampaigns);
  if (!isTodayTab) dates = dates.filter((d) => inDateRange(d, startDate, endDate));

  const columns = [
    { label: 'Campaign Name', value: (c) => c.campaignName || '' },
    { label: 'Venue(s)', value: (c) => (c.__matchedVenues || []).map((v) => v.venue).join('; ') },
    { label: 'Start', value: (c) => c.startDate || '' },
    { label: 'End', value: (c) => c.endDate || '' },
    { label: 'Campaign Days', value: (c) => c.campaignDays ?? '' },
    { label: 'Loop Count', value: (c) => c.loopCount ?? '' },
    { label: 'Status', value: (c) => c.status || '' },
    ...dates.map((d) => ({ label: d, value: (c) => (c.days || []).find((x) => x.date === d)?.spots ?? '' })),
  ];
  const tabLabel = (TAB_DEFS.find((t) => t.key === tab) || {}).label || tab;
  exportToCsv(`traffic-sheet-${tabLabel.replace(/\s+/g, '-')}-${startDate}-to-${endDate}.csv`, columns, gridCampaigns);
}
