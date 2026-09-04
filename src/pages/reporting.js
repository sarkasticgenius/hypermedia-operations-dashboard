// Reporting workspace - live data from the AiOO Reporting API (ads.aiootech.com), a completely
// separate system from the AdLive Center Traffic Sheet API this app already integrates with (see
// trafficSheet.js). Nothing here is synced into a table, same "live proxy, nothing persisted"
// shape as Traffic Sheet - see supabase/functions/aioo-reporting-proxy.
//
// Covers every endpoint under the API's "Reporting" tag:
//   /stats-ads (Ads Stats + the Additional Traffic Sheet pivot), /stats-dsps (Programmatic Stats),
//   /stats-placements (Placements Stats), /last-playouts, /avails (Availability Forecast),
//   /placements-status-report (CSV, parsed server-side by the proxy into JSON rows).
//
// Field names for stats-ads/stats-dsps/stats-placements come straight from the raw OpenAPI spec's
// response schemas (adv_name, c_name, a_name, cr_name, s_name, p_name, playouts, impressions,
// impressions_ontarget, revenue, auctions, requests, bids, wins, cpm, calls, etc).
//
// One day of /stats-ads alone can be 15k+ rows, so date-range tabs default to a single day
// (not the API's own 30-day default) to keep the initial load fast - a 30-day pull that size
// risks the edge function or browser choking on the response, which is what silently produced an
// empty Reporting page even after the API connection itself was confirmed working.
//
// That single day is TODAY, not yesterday - confirmed live that AiOO's stats have no same-day
// lag (a same-day pull returned 16,439 rows, right in line with a completed day's ~16k), so
// there's no data-completeness reason to look a day back by default. Today's own totals are
// necessarily partial and grow over the course of the day - that's inherent to viewing an
// in-progress day, not a symptom of anything broken, same as any live dashboard.
import { STATE, setState, loadData, toast } from '../state.js';
import { loadingCard } from '../modals.js';
import { supabase } from '../supabaseClient.js';
import { getSetting } from '../data/settings.js';
import { renderTabs } from '../lib/tabs.js';
import { esc, jsAttrSq, fmtDateTime } from '../lib/format.js';
import { exportReportingCampaignExcel, exportToExcel } from '../lib/excelExport.js';
import { exportCampaignPptxReport } from '../lib/pptxReport.js';
import { isFocMarketingCampaign, statusBadge, groupDatesByMonth, formatMonthLabel } from './trafficSheet.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { sortTh, applySort, colWidthCh, FIXED_TABLE_STYLE } from '../lib/sortableTable.js';

const REPORTING_TABS = [
  { key: 'adsStats', label: 'Ads Stats' },
  { key: 'trafficSheet', label: 'Traffic Data' },
  { key: 'programmatic', label: 'Programmatic Stats' },
  { key: 'placementsStats', label: 'Placements Stats' },
  { key: 'lastPlayouts', label: 'Last Playouts' },
  { key: 'avails', label: 'Availability Forecast' },
  { key: 'statusReport', label: 'Placements Status Report' },
];

// date-range-driven tabs share one Start/End filter and one fetch shape (GET <endpoint>?start&end).
// trafficSheet reuses adsStats' own cached rows/fetch (same underlying data, just pivoted).
const DATE_TABS = {
  adsStats: { endpoint: '/stats-ads', key: 'reportingAdsStats' },
  trafficSheet: { endpoint: '/stats-ads', key: 'reportingAdsStats' },
  programmatic: { endpoint: '/stats-dsps', key: 'reportingDsps' },
  placementsStats: { endpoint: '/stats-placements', key: 'reportingPlacementsStats' },
};

const DSP_SUM_FIELDS = [
  { key: 'auctions', label: 'Auctions' },
  { key: 'requests', label: 'Requests' },
  { key: 'bids', label: 'Bids' },
  { key: 'wins', label: 'Wins' },
  { key: 'playouts', label: 'Playouts' },
  { key: 'impressions', label: 'Impressions' },
  { key: 'revenue', label: 'Revenue' },
];

function defaultDateRange() {
  const today = new Date().toISOString().slice(0, 10);
  return { start: today, end: today };
}

async function fetchReportingStats(endpoint, params = {}) {
  const { data, error } = await supabase.functions.invoke('aioo-reporting-proxy', { body: { endpoint, ...params } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

async function loadDateRangeTab(key, endpoint, start, end) {
  setState({ [`${key}Loading`]: true, [`${key}Error`]: null });
  try {
    const data = await fetchReportingStats(endpoint, { start, end });
    setState({ [key]: data, [`${key}Loading`]: false });
  } catch (e) {
    setState({ [`${key}Loading`]: false, [`${key}Error`]: e.message || 'Failed to load reporting data' });
  }
}

async function loadLastPlayouts() {
  setState({ reportingLastPlayoutsLoading: true, reportingLastPlayoutsError: null });
  try {
    const params = {};
    if (STATE.reportingLpPlacementIds) params.placement_ids = STATE.reportingLpPlacementIds;
    if (STATE.reportingLpSiteId) params.site_id = STATE.reportingLpSiteId;
    if (STATE.reportingLpRetailers) params.retailers = 1;
    const data = await fetchReportingStats('/last-playouts', params);
    setState({ reportingLastPlayouts: data, reportingLastPlayoutsLoading: false });
  } catch (e) {
    setState({ reportingLastPlayoutsLoading: false, reportingLastPlayoutsError: e.message || 'Failed to load playouts' });
  }
}

// Triggers the auto-fetch for whichever tab just became active, once per tab per session (the
// Started flags prevent re-fetching on every re-render) - lastPlayouts is safe to auto-fetch with
// no filters (returns latest playout per screen), but avails/statusReport require explicit user
// input/action first (avails needs placement_ids or ad_id; statusReport can be a large CSV pull).
// trafficSheet needs BOTH stats-ads (Direct) and stats-dsps (Programmatic) to build its merged
// grid - DATE_TABS only maps it to the ads-stats fetch, so the dsps one is kicked off separately.
function ensureTabData(tab) {
  const defaults = defaultDateRange();
  const start = STATE.reportingStartDate || defaults.start;
  const end = STATE.reportingEndDate || defaults.end;
  const dtab = DATE_TABS[tab];
  if (dtab && !STATE[dtab.key] && !STATE[`${dtab.key}Loading`] && !STATE[`${dtab.key}Started`]) {
    STATE[`${dtab.key}Started`] = true;
    queueMicrotask(() => loadDateRangeTab(dtab.key, dtab.endpoint, start, end));
  }
  if (tab === 'trafficSheet' && !STATE.reportingDsps && !STATE.reportingDspsLoading && !STATE.reportingDspsStarted) {
    STATE.reportingDspsStarted = true;
    queueMicrotask(() => loadDateRangeTab('reportingDsps', '/stats-dsps', start, end));
  }
  if (tab === 'lastPlayouts' && !STATE.reportingLastPlayouts && !STATE.reportingLastPlayoutsLoading && !STATE.reportingLastPlayoutsStarted) {
    STATE.reportingLastPlayoutsStarted = true;
    queueMicrotask(loadLastPlayouts);
  }
}

export function setReportingTab(tab) { setState({ reportingTab: tab }); }

export async function applyReportingFilter() {
  const startEl = document.getElementById('reporting-start-date');
  const endEl = document.getElementById('reporting-end-date');
  const defaults = defaultDateRange();
  const start = startEl?.value || defaults.start;
  const end = endEl?.value || defaults.end;
  setState({ reportingStartDate: start, reportingEndDate: end });
  const tab = STATE.reportingTab || 'adsStats';
  const dtab = DATE_TABS[tab];
  if (!dtab) return;
  STATE[`${dtab.key}Started`] = true;
  const reloads = [loadDateRangeTab(dtab.key, dtab.endpoint, start, end)];
  // trafficSheet's grid also depends on stats-dsps (Programmatic) - see ensureTabData - so its own
  // Apply Date Filter needs to refresh both, not just the ads-stats half DATE_TABS maps it to.
  if (tab === 'trafficSheet') {
    STATE.reportingDspsStarted = true;
    reloads.push(loadDateRangeTab('reportingDsps', '/stats-dsps', start, end));
  }
  await Promise.all(reloads);
}

export async function applyLastPlayoutsFilter() {
  const idsEl = document.getElementById('lp-placement-ids');
  const siteEl = document.getElementById('lp-site-id');
  const retailersEl = document.getElementById('lp-retailers');
  setState({
    reportingLpPlacementIds: idsEl?.value.trim() || '',
    reportingLpSiteId: siteEl?.value.trim() || '',
    reportingLpRetailers: !!retailersEl?.checked,
  });
  STATE.reportingLastPlayoutsStarted = true;
  await loadLastPlayouts();
}

// Distinct (site, placement, placement id) combos from whichever stats data is already loaded
// (Ads Stats or Placements Stats) - backs the Avails tab's placement picker so the user can select
// real placements by name instead of having to already know/type a raw numeric Placement ID
// (almost certainly why "Get Forecast" seemed broken - a blind/malformed ID looks identical to a
// real bug, since the API correctly 400s "Missing or invalid parameters" either way).
function availsPlacementOptions() {
  const source = STATE.reportingAdsStats || STATE.reportingPlacementsStats;
  if (!source) return [];
  const rows = extractRows(source);
  if (!rows.length) return [];
  const fields = detectAllFields(rows);
  if (!fields.placementId || !fields.placement) return [];
  const seen = new Map();
  rows.forEach((r) => {
    const pid = r[fields.placementId];
    if (pid == null || seen.has(pid)) return;
    // Whitespace collapsed (not just trimmed) for the DISPLAY text - real vendor data has stray
    // double spaces here and there, and this is cheap tidying regardless of the sort-key work below.
    const site = fields.site ? String(r[fields.site] ?? '').trim().replace(/\s+/g, ' ') : '';
    const placement = String(r[fields.placement] ?? '').trim().replace(/\s+/g, ' ');
    seen.set(pid, { id: pid, placement, site, siteKey: sortKeyFor(site), placementKey: sortKeyFor(placement) });
  });
  // Sorted on the normalized *Key fields, not the raw display text - see sortKeyFor's own comment
  // for why the raw text can't be compared directly. { numeric: true } on top of that sorts
  // "Screen 2" before "Screen 10" (plain string compare treats these as "1" < "2" character-by-
  // character, so "10" through "18" sorted right after "1" and before "2" - confirmed against live
  // EXPO 2020 placement names).
  return [...seen.values()].sort((a, b) =>
    a.siteKey.localeCompare(b.siteKey, undefined, { numeric: true })
    || a.placementKey.localeCompare(b.placementKey, undefined, { numeric: true }));
}

// Real placement names from this vendor use "-" as a catch-all separator with wildly inconsistent
// spacing around it depending on who/what entered that particular row - the same numbered-suffix
// idea shows up as "PARKING-01" (no space), "PARKING -02" (space before only), and "COLUMN - 3"
// (space both sides), all for siblings that should sort together as 01/02/03. Comparing the raw
// text directly means whichever spacing variant a given digit happens to have decides sort order
// ahead of the digit itself (confirmed live: REEM MALL's parking screens and food-court columns
// both scattered out of numeric order this way). Collapsing every hyphen's surrounding whitespace
// to a single canonical "-" (no space) before comparing removes the inconsistency; the ORIGINAL
// spacing is kept for display (this key is sort-only, never rendered).
function sortKeyFor(s) {
  return String(s || '').replace(/\s*-\s*/g, '-');
}

// One entry per distinct site/location in availsPlacementOptions()'s result, in the same
// natural/normalized order, for the Avails tab's Location dropdown - picking a location first,
// then an asset at that location, replaced the old "type into a free-text box to search 1000+
// placements at once" flow (confirmed live: a plain flat list that size needed real effort to
// search through blind; grouping by location first means picking from a dropdown of maybe a dozen
// to a few dozen familiar venue names instead).
function availsLocationGroups(allOptions) {
  const counts = new Map();
  allOptions.forEach((o) => {
    const site = o.site || '(No site)';
    counts.set(site, (counts.get(site) || 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => sortKeyFor(a[0]).localeCompare(sortKeyFor(b[0]), undefined, { numeric: true }))
    .map(([site, count]) => ({ site, count }));
}

export function toggleAvailsPlacement(id) {
  const current = new Set((STATE.reportingAvailsPlacementIds || []).map(String));
  const key = String(id);
  if (current.has(key)) current.delete(key); else current.add(key);
  setState({ reportingAvailsPlacementIds: [...current] });
}
// Switching locations clears any in-progress asset filter from the previous location - carrying it
// over would silently hide every asset at the new location until the user noticed and cleared it.
export function setAvailsLocation(v) { setState({ reportingAvailsLocation: v, reportingAvailsAssetSearch: '' }); }
export function setAvailsAssetSearch(v) { setState({ reportingAvailsAssetSearch: v }); }

// A comma-separated placement_ids list with hundreds of entries is a likely cause of "no forecast
// coming back" on its own (URL/param-length limits on the vendor's side) - this is a soft warning,
// not a hard block, since the API's own limit (if any) isn't documented.
const AVAILS_PLACEMENT_WARN_COUNT = 50;

export async function applyAvailsFilter() {
  const manualIdsEl = document.getElementById('avails-placement-ids-manual');
  const adIdEl = document.getElementById('avails-ad-id');
  const startEl = document.getElementById('avails-start');
  const endEl = document.getElementById('avails-end');
  const pickedIds = STATE.reportingAvailsPlacementIds || [];
  const manualIds = (manualIdsEl?.value.trim() || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allIds = [...new Set([...pickedIds.map(String), ...manualIds])];
  const placementIds = allIds.join(',');
  const adId = adIdEl?.value.trim();
  if (!placementIds && !adId) { toast('Pick at least one placement above, or enter Placement IDs/an Ad ID manually', 'error'); return; }
  if (allIds.length > AVAILS_PLACEMENT_WARN_COUNT) {
    toast(`${allIds.length} placements selected - if nothing comes back, try narrowing this down, the API may not accept a list this long.`, 'error');
  }
  setState({ reportingAvailsLoading: true, reportingAvailsError: null });
  try {
    const params = {};
    if (placementIds) params.placement_ids = placementIds;
    if (adId) params.ad_id = adId;
    if (startEl?.value) params.start = startEl.value;
    if (endEl?.value) params.end = endEl.value;
    const data = await fetchReportingStats('/avails', params);
    setState({ reportingAvails: data, reportingAvailsLoading: false });
  } catch (e) {
    setState({ reportingAvailsLoading: false, reportingAvailsError: e.message || 'Failed to load forecast' });
  }
}

export async function loadStatusReport() {
  setState({ reportingStatusReportLoading: true, reportingStatusReportError: null });
  try {
    const data = await fetchReportingStats('/placements-status-report');
    setState({ reportingStatusReport: data, reportingStatusReportLoading: false });
  } catch (e) {
    setState({ reportingStatusReportLoading: false, reportingStatusReportError: e.message || 'Failed to load report' });
  }
}

async function downloadRowsAsExcel(filename, rows, excludeColumns = []) {
  if (!rows.length) { toast('No rows to download', 'error'); return; }
  const exclude = new Set(excludeColumns);
  const columns = Object.keys(rows[0]).filter((c) => !exclude.has(c)).map((c) => ({ label: c, value: (r) => r[c] ?? '' }));
  await exportToExcel(filename, columns, rows);
}

// Plain "download whatever this tab is currently showing" button, available on every pill tab -
// unlike downloadCampaignReport/downloadCampaignPptxReport (branded, Ads Stats-only, scoped to one
// selected campaign), this just dumps the raw/pivoted rows already on screen as a flat .xlsx.
export async function downloadTabExcel() {
  const tab = STATE.reportingTab || 'adsStats';
  const defaults = defaultDateRange();
  const startDate = STATE.reportingStartDate || defaults.start;
  const endDate = STATE.reportingEndDate || defaults.end;
  const tag = `${startDate}_${endDate}`;

  if (tab === 'adsStats') {
    const raw = STATE.reportingAdsStats;
    if (!raw) { toast('Load Ads Stats data first', 'error'); return; }
    await downloadRowsAsExcel(`ads-stats-${tag}.xlsx`, extractRows(raw));
  } else if (tab === 'trafficSheet') {
    const directRaw = STATE.reportingAdsStats;
    const dspsRaw = STATE.reportingDsps;
    let directRows = directRaw ? extractRows(directRaw) : [];
    let dspsRows = dspsRaw ? extractRows(dspsRaw) : [];
    if (!directRows.length && !dspsRows.length) { toast('No traffic data loaded yet', 'error'); return; }
    const categoryFilter = STATE.reportingTrafficCategory || 'all';
    const assetInventoryForCategory = STATE.pageData.assetInventory?.data;
    if (categoryFilter !== 'all' && assetInventoryForCategory) {
      const venueCategoryMap = buildVenueCategoryMap(assetInventoryForCategory);
      const directFieldsAll = directRows.length ? detectAllFields(directRows) : {};
      const dspsFieldsAll = dspsRows.length ? detectAllFields(dspsRows) : {};
      directRows = directRows.filter((r) => rowMatchesCategory(r, directFieldsAll.site, categoryFilter, venueCategoryMap));
      dspsRows = dspsRows.filter((r) => rowMatchesCategory(r, dspsFieldsAll.site, categoryFilter, venueCategoryMap));
    }
    const directFields = directRows.length ? detectAllFields(directRows) : {};
    const dspsFields = dspsRows.length ? detectAllFields(dspsRows) : {};
    const typeFilter = STATE.reportingTrafficType || 'all';
    const byCampaign = new Map();
    const ingest = (rows, fields, type) => {
      if (!fields.campaign) return;
      if (typeFilter === 'direct' && type !== 'Direct') return;
      if (typeFilter === 'programmatic' && type !== 'Programmatic') return;
      rows.forEach((r) => {
        const campaign = String(r[fields.campaign] ?? '(Unknown Campaign)');
        const key = `${type}::${campaign}`;
        if (!byCampaign.has(key)) byCampaign.set(key, { campaign, type, playouts: 0, impressions: 0 });
        const entry = byCampaign.get(key);
        if (fields.playouts) entry.playouts += Number(r[fields.playouts]) || 0;
        if (fields.impressions) entry.impressions += Number(r[fields.impressions]) || 0;
      });
    };
    ingest(directRows, directFields, 'Direct');
    ingest(dspsRows, dspsFields, 'Programmatic');
    const rows = [...byCampaign.values()].sort((a, b) => a.campaign.localeCompare(b.campaign));
    if (!rows.length) { toast('No rows to download', 'error'); return; }
    await exportToExcel(`traffic-data-${tag}.xlsx`, [
      { label: 'Campaign', value: (r) => r.campaign },
      { label: 'Type', value: (r) => r.type },
      { label: 'Playouts', value: (r) => r.playouts },
      { label: 'Impressions', value: (r) => r.impressions },
    ], rows);
  } else if (tab === 'programmatic') {
    const raw = STATE.reportingDsps;
    if (!raw) { toast('Load Programmatic Stats first', 'error'); return; }
    await downloadRowsAsExcel(`programmatic-stats-${tag}.xlsx`, extractRows(raw), ['adv_id', 'adv_domain', 'c_id', 'c_name', 'a_id', 'a_name', 'd_id', 'd_name', 'avg_mulitiplier']);
  } else if (tab === 'placementsStats') {
    const raw = STATE.reportingPlacementsStats;
    if (!raw) { toast('Load Placements Stats first', 'error'); return; }
    await downloadRowsAsExcel(`placements-stats-${tag}.xlsx`, extractRows(raw));
  } else if (tab === 'lastPlayouts') {
    const data = STATE.reportingLastPlayouts;
    if (!data) { toast('Load Last Playouts first', 'error'); return; }
    const rows = [];
    Object.keys(data).forEach((pid) => (data[pid] || []).forEach((p) => rows.push({ placement_id: pid, ...p })));
    if (!rows.length) { toast('No rows to download', 'error'); return; }
    const campaignByAd = adIdToCampaignMap();
    rows.forEach((r) => { r.campaign = campaignByAd.get(String(r.ad_id)) || ''; });
    await downloadRowsAsExcel(`last-playouts-${tag}.xlsx`, rows);
  } else if (tab === 'avails') {
    const data = STATE.reportingAvails;
    if (!data) { toast('Get a forecast first', 'error'); return; }
    const rows = (data.sites || []).map((s) => ({ site: s.name, cycle_length: s.cycle_length, reserved: s.reserved, available: s.available, available_playouts: s.available_playouts }));
    await downloadRowsAsExcel(`availability-forecast-${tag}.xlsx`, rows);
  } else if (tab === 'statusReport') {
    const raw = STATE.reportingStatusReport;
    if (!raw) { toast('Load the report first', 'error'); return; }
    await downloadRowsAsExcel(`placements-status-report-${tag}.xlsx`, extractRows(raw));
  }
}

// Normalizes whatever the API actually returns (an array of rows, or {rows:[...]}/{data:[...]})
// into a plain row array.
function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

// Tries a short list of likely key names per logical field, case-insensitively, against whatever
// keys a real row actually has - confirmed /stats-ads names listed first.
const FIELD_CANDIDATES = {
  date: ['date', 'day', 'stat_date', 'created'],
  advertiser: ['adv_name', 'advertiser', 'advertiser_name'],
  campaign: ['c_name', 'campaign', 'campaign_name'],
  campaignId: ['c_id'],
  ad: ['a_name', 'ad', 'ad_name'],
  adId: ['a_id'],
  creative: ['cr_name', 'creative', 'creative_name'],
  site: ['s_name', 'site', 'site_name'],
  siteId: ['s_id'],
  placement: ['p_name', 'placement', 'placement_name'],
  placementId: ['p_id'],
  playouts: ['playouts'],
  impressions: ['impressions', 'plays', 'count'],
  impressionsOntarget: ['impressions_ontarget'],
  revenue: ['revenue'],
  dsp: ['dsp_name'],
  dspSeat: ['dsp_seat'],
};
function detectField(row, logicalField) {
  if (!row) return null;
  const keys = Object.keys(row);
  const lowerMap = new Map(keys.map((k) => [k.toLowerCase(), k]));
  for (const candidate of FIELD_CANDIDATES[logicalField] || []) {
    if (lowerMap.has(candidate)) return lowerMap.get(candidate);
  }
  return null;
}
function detectAllFields(rows) {
  const sample = rows[0];
  const fields = {};
  Object.keys(FIELD_CANDIDATES).forEach((f) => { fields[f] = detectField(sample, f); });
  return fields;
}

// Per-campaign report download (Ads Stats tab) - user picks which of these to include; only the
// ones actually present in the current response are offered (see renderReportDownloadPanel).
const REPORT_FIELD_OPTIONS = [
  { key: 'date', label: 'Date' },
  { key: 'advertiser', label: 'Advertiser' },
  { key: 'ad', label: 'Ad' },
  { key: 'creative', label: 'Creative' },
  { key: 'site', label: 'Site' },
  { key: 'placement', label: 'Placement' },
  { key: 'playouts', label: 'Playouts' },
  { key: 'impressions', label: 'Impressions' },
  { key: 'impressionsOntarget', label: 'Impressions (On-target)' },
  { key: 'revenue', label: 'Revenue' },
];
const NUMERIC_REPORT_FIELDS = new Set(['playouts', 'impressions', 'impressionsOntarget', 'revenue']);

export function setReportCampaign(v) {
  // Clears out the previous campaign's metadata/demand-type lookups (below) so a stale campaign's
  // real dates or Direct/Programmatic split never briefly flashes under a newly-selected campaign
  // before its own fetch resolves.
  setState({
    reportingSelectedCampaign: v,
    reportingCampaignMeta: null, reportingCampaignMetaError: null, reportingCampaignMetaStarted: false,
    reportingCampaignAdsInfo: null, reportingCampaignAdsInfoError: null, reportingCampaignAdsInfoStarted: false,
  });
}
export function toggleReportField(key) {
  const current = STATE.reportingSelectedFields || REPORT_FIELD_OPTIONS.map((f) => f.key);
  const set = new Set(current);
  if (set.has(key)) set.delete(key); else set.add(key);
  setState({ reportingSelectedFields: [...set] });
}

// The Reporting stats endpoints (stats-ads etc) only ever return daily rows, never a campaign's
// real flight dates - GET /campaigns?name=... (the actual Campaigns API, not the Reporting one) is
// the only source for that. Substring match, so an exact (case-insensitive) name match is picked
// out of whatever comes back rather than trusting the first hit.
async function loadCampaignMeta(campaignName) {
  setState({ reportingCampaignMetaLoading: true, reportingCampaignMetaError: null });
  try {
    const data = await fetchReportingStats('/campaigns', { name: campaignName });
    const list = Array.isArray(data) ? data : [];
    const match = list.find((c) => String(c.name || '').toLowerCase() === campaignName.toLowerCase()) || list[0] || null;
    setState({
      reportingCampaignMeta: match ? { start: match.start, end: match.end, status: match.status, type: match.type } : null,
      reportingCampaignMetaLoading: false,
    });
  } catch (e) {
    setState({ reportingCampaignMetaLoading: false, reportingCampaignMetaError: e.message || 'Failed to load campaign details' });
  }
}

// Ad (line item) demand_type (direct/programmatic) and loop/cycle config aren't in any Reporting
// response either - only GET /ads/{id} (the Ads API) returns them, and only one at a time (the
// list endpoint returns a reduced id/name/campaign_id-only shape). Fetches every distinct a_id
// seen in the campaign's rows in parallel, capped at 15 to stay well clear of rate limits for
// campaigns with an unusually large number of line items.
const MAX_AD_LOOKUPS = 15;
async function loadCampaignAdsInfo(campaignRows, fields) {
  if (!fields.adId) { setState({ reportingCampaignAdsInfo: [] }); return; }
  const adIds = [...new Set(campaignRows.map((r) => r[fields.adId]).filter((v) => v != null))].slice(0, MAX_AD_LOOKUPS);
  if (!adIds.length) { setState({ reportingCampaignAdsInfo: [] }); return; }
  setState({ reportingCampaignAdsInfoLoading: true, reportingCampaignAdsInfoError: null });
  try {
    const ads = await Promise.all(adIds.map((id) => fetchReportingStats(`/ads/${id}`).catch(() => null)));
    setState({ reportingCampaignAdsInfo: ads.filter(Boolean), reportingCampaignAdsInfoLoading: false });
  } catch (e) {
    setState({ reportingCampaignAdsInfoLoading: false, reportingCampaignAdsInfoError: e.message || 'Failed to load ad details' });
  }
}

// Same GET /campaigns endpoint as loadCampaignMeta, but with no `name` filter - the proxy only
// sets that param when given one (see aioo-reporting-proxy/index.ts), so omitting it returns
// every campaign in one call. Used by the Traffic Data grid to get real flight dates + Status for
// every campaign shown at once, instead of one /campaigns request per campaign row.
// Collapses runs of internal whitespace (not just leading/trailing) before lowercasing, so a
// campaign name that differs from /campaigns' own `name` only by double spaces/tabs/newlines - easy
// to pick up from copy-paste when a campaign is created - still matches instead of silently missing
// Start/End/Days/Status for that row.
function normalizeCampaignName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function loadAllCampaignsMeta() {
  const data = await fetchReportingStats('/campaigns', {});
  const list = Array.isArray(data) ? data : [];
  const map = new Map();
  list.forEach((c) => {
    const name = normalizeCampaignName(c.name);
    if (name) map.set(name, { start: c.start, end: c.end, status: c.status, type: c.type });
  });
  return map;
}

// Loop Count on the Traffic Data grid is the closest AiOO equivalent to Traffic Sheet's per-
// campaign Loop Count: GET /ads/{id}'s `cycle_playouts` (only set when volume_type === 'cycle'),
// looked up per distinct a_id across every campaign currently shown in the grid. Capped the same
// way loadCampaignAdsInfo caps a single campaign's line items (MAX_AD_LOOKUPS), just applied to
// the whole grid's ad-id set instead of one campaign's - the grid can easily have far more
// distinct line items than a single campaign, and this is a live 3rd-party API with real rate
// limits (see MAX_AD_LOOKUPS's own comment).
const MAX_GRID_AD_LOOKUPS = 80;
async function loadGridAdsLoopInfo(adIds) {
  const capped = adIds.slice(0, MAX_GRID_AD_LOOKUPS);
  const ads = await Promise.all(capped.map((id) => fetchReportingStats(`/ads/${id}`).catch(() => null)));
  const map = new Map();
  ads.forEach((a, i) => { if (a) map.set(String(capped[i]), a); });
  return map;
}

// Groups rows by screen (Site + Placement), summing whichever numericKeys are given - shared by
// both the Excel Screen Detail sheet and the PowerPoint's per-site breakdown table so the two
// downloads never disagree with each other.
function aggregateByScreen(rows, fields, numericKeys) {
  const screenMap = new Map();
  rows.forEach((row) => {
    const site = fields.site ? String(row[fields.site] ?? '') : '';
    const placement = fields.placement ? String(row[fields.placement] ?? '') : '';
    const key = site + '|' + placement;
    if (!screenMap.has(key)) {
      const entry = { site, placement, rowCount: 0 };
      numericKeys.forEach((k) => { entry[k] = 0; });
      screenMap.set(key, entry);
    }
    const entry = screenMap.get(key);
    entry.rowCount += 1;
    numericKeys.forEach((k) => { entry[k] += Number(row[fields[k]]) || 0; });
  });
  return [...screenMap.values()].sort((a, b) => a.site.localeCompare(b.site) || a.placement.localeCompare(b.placement));
}

// Generic "group rows by some key, sum some numeric columns" helper - numericFieldMap is
// { outputKey: rawColumnName }, already resolved via detectAllFields (e.g. { playouts:
// fields.playouts, impressions: fields.impressions }). Backs the Creative Split/Day-wise/
// Publisher/Seller breakdowns in Campaign Detail, all of which are "one row per distinct X,
// summed" the same way aggregateByScreen already does for Site+Placement.
function aggregateByKey(rows, getKey, numericFieldMap) {
  const map = new Map();
  rows.forEach((row) => {
    const key = getKey(row);
    if (!key) return;
    if (!map.has(key)) {
      const entry = { key };
      Object.keys(numericFieldMap).forEach((k) => { entry[k] = 0; });
      map.set(key, entry);
    }
    const entry = map.get(key);
    Object.entries(numericFieldMap).forEach(([k, col]) => { entry[k] += Number(row[col]) || 0; });
  });
  return [...map.values()];
}

function renderKeyValueTable(title, desc, rows, keyLabel, numericFieldMap) {
  if (!rows.length) return '';
  const cols = Object.keys(numericFieldMap);
  const colLabel = (c) => (c === 'playouts' ? 'Playouts' : c === 'impressions' ? 'Impressions' : c);
  const body = rows.map((r) => `<tr><td>${esc(r.key)}</td>${cols.map((c) => `<td class="tright">${(r[c] ?? 0).toLocaleString()}</td>`).join('')}</tr>`).join('');
  return `<div class="card">
    <div class="card-head"><h3>${esc(title)}</h3>${desc ? `<div class="desc">${esc(desc)}</div>` : ''}</div>
    <div class="tsheet-wrap"><table class="zebra"><thead><tr><th>${esc(keyLabel)}</th>${cols.map((c) => `<th class="tright">${esc(colLabel(c))}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>
  </div>`;
}

// Resolves the currently selected campaign's rows/fields, shared by both download handlers - null
// (with a toast already shown) if anything required is missing.
function resolveSelectedCampaign() {
  const raw = STATE.reportingAdsStats;
  if (!raw) { toast('Load Ads Stats data first', 'error'); return null; }
  const allRows = extractRows(raw);
  const fields = detectAllFields(allRows);
  if (!fields.campaign) { toast("Can't build a report without a recognizable Campaign column in the response.", 'error'); return null; }
  const campaign = STATE.reportingSelectedCampaign;
  if (!campaign) { toast('Select a campaign first', 'error'); return null; }
  const campaignRows = allRows.filter((r) => String(r[fields.campaign] ?? '') === campaign);
  if (!campaignRows.length) { toast('No rows for that campaign in the current date range', 'error'); return null; }
  const defaults = defaultDateRange();
  const startDate = STATE.reportingStartDate || defaults.start;
  const endDate = STATE.reportingEndDate || defaults.end;
  return { campaign, campaignRows, fields, startDate, endDate };
}

// Builds and downloads the .xlsx: a Report sheet with the selected fields for every row of the
// chosen campaign, and a Screen Detail sheet with those rows aggregated per screen (Site +
// Placement, summing whichever numeric fields were selected - falls back to a plain row count per
// screen if none of the selected fields are numeric, so the sheet is never just a bare list).
export async function downloadCampaignReport() {
  const ctx = resolveSelectedCampaign();
  if (!ctx) return;
  const { campaign, campaignRows, fields, startDate, endDate } = ctx;

  const selected = STATE.reportingSelectedFields || REPORT_FIELD_OPTIONS.map((f) => f.key);
  const activeFields = REPORT_FIELD_OPTIONS.filter((f) => selected.includes(f.key) && fields[f.key]);
  if (!activeFields.length) { toast('Select at least one field to include', 'error'); return; }

  const columns = activeFields.map((f) => ({ label: f.label, value: (row) => row[fields[f.key]] ?? '' }));
  const duration = startDate === endDate ? startDate : `${startDate} to ${endDate}`;

  const screenNumericKeys = activeFields.filter((f) => NUMERIC_REPORT_FIELDS.has(f.key)).map((f) => f.key);
  const rowCountFallback = screenNumericKeys.length === 0;
  const screenRows = aggregateByScreen(campaignRows, fields, screenNumericKeys);
  const screenColumns = [
    ...(fields.site ? [{ label: 'Site', value: (r) => r.site }] : []),
    ...(fields.placement ? [{ label: 'Placement', value: (r) => r.placement }] : []),
    ...screenNumericKeys.map((k) => ({ label: REPORT_FIELD_OPTIONS.find((f) => f.key === k).label, value: (r) => r[k] })),
    ...(rowCountFallback ? [{ label: 'Rows', value: (r) => r.rowCount }] : []),
  ];

  const safeCampaign = campaign.replace(/[\\/?*[\]:]/g, '-').slice(0, 60);
  await exportReportingCampaignExcel(`${safeCampaign}-report-${startDate}_${endDate}.xlsx`, {
    campaignName: campaign, duration, columns, rows: campaignRows, screenColumns, screenRows,
    template: STATE.pageData.reportTemplate?.data,
  });
}

// Builds and downloads the .pptx - modeled on Hypermedia's own reference Campaign Report deck:
// cover, one placeholder slide per site (photos are added afterward, directly in PowerPoint - see
// lib/pptxReport.js), a Performance Report slide with the real Playouts/Impressions totals, the
// per-screen breakdown table and the Direct/Programmatic split, then a closing slide. Uses
// reportingCampaignMeta/reportingCampaignAdsInfo if those lookups have already resolved (they're
// kicked off as soon as a campaign is selected - see ensureCampaignDetailData), but doesn't block
// the download waiting on them - a report with the loaded-range dates and no delivery-type split
// is still useful, and both lookups hit endpoints outside the Reporting API's own guarantees.
export async function downloadCampaignPptxReport() {
  const ctx = resolveSelectedCampaign();
  if (!ctx) return;
  const { campaign, campaignRows, fields, startDate, endDate } = ctx;

  const sites = fields.site ? [...new Set(campaignRows.map((r) => String(r[fields.site] ?? '')))].filter(Boolean).sort() : [];
  const numericKeys = ['playouts', 'impressions'].filter((k) => fields[k]);
  const screenRows = aggregateByScreen(campaignRows, fields, numericKeys);
  const totalImpressions = fields.impressions ? campaignRows.reduce((s, r) => s + (Number(r[fields.impressions]) || 0), 0) : 0;
  const totalPlayouts = fields.playouts ? campaignRows.reduce((s, r) => s + (Number(r[fields.playouts]) || 0), 0) : 0;

  const meta = STATE.reportingCampaignMeta;
  const realStartDate = meta?.start ? new Date(meta.start * 1000).toISOString().slice(0, 10) : null;
  const realEndDate = meta?.end ? new Date(meta.end * 1000).toISOString().slice(0, 10) : null;
  const adsInfo = STATE.reportingCampaignAdsInfo;
  const demandSplit = adsInfo && adsInfo.length
    ? { direct: adsInfo.filter((a) => a.demand_type === 'direct').length, programmatic: adsInfo.filter((a) => a.demand_type === 'programmatic').length }
    : null;

  const safeCampaign = campaign.replace(/[\\/?*[\]:]/g, '-').slice(0, 60);
  try {
    await exportCampaignPptxReport(`${safeCampaign}-report-${startDate}_${endDate}.pptx`, {
      campaignName: campaign,
      locationLabel: sites.join(', ') || '-',
      startDate, endDate, realStartDate, realEndDate,
      totalImpressions, totalPlayouts, screenRows, demandSplit, sites,
      template: STATE.pageData.reportTemplate?.data,
    });
  } catch (e) {
    toast(e.message || 'Failed to build PowerPoint report', 'error');
  }
}

// Download panel is scoped to a single already-selected campaign (no dropdown - see
// renderCampaignDetail) so it only ever needs to ask "which fields", not "which campaign". Photos
// are no longer collected here - see exportCampaignPptxReport's header comment.
function renderReportDownloadPanel(fields) {
  const selectedFields = STATE.reportingSelectedFields || REPORT_FIELD_OPTIONS.map((f) => f.key);
  const availableFields = REPORT_FIELD_OPTIONS.filter((f) => fields[f.key]);

  return `
    <div class="card">
      <div class="card-head"><h3>Download Report</h3><div class="desc">Branded report, modeled on the Hypermedia campaign-report template - Excel (.xlsx) with a Report + Screen Detail sheet, or a PowerPoint (.pptx) with a cover, a placeholder slide per screen (add your own photos in PowerPoint afterward) and a Performance Report summary.</div></div>
      <div class="field"><label>Fields to include (Excel)</label>
        <div style="display:flex;flex-wrap:wrap;gap:14px;">
          ${availableFields.map((f) => `
            <label style="display:flex;align-items:center;gap:6px;font-weight:normal;">
              <input type="checkbox" onchange="App.toggleReportField('${f.key}')" ${selectedFields.includes(f.key) ? 'checked' : ''}> ${esc(f.label)}
            </label>
          `).join('')}
        </div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn-orange" type="button" onclick="App.downloadCampaignReport()">Download Report (.xlsx)</button>
        <button class="btn-outline" type="button" onclick="App.downloadCampaignPptxReport()">Download Report (.pptx)</button>
      </div>
    </div>
  `;
}

function statTile(variant, label, value) {
  return `<div class="bento-stat ${variant}"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(String(value))}</div></div>`;
}

// One row per campaign - name, impression/playout totals, distinct screen count, row count -
// sorted by impressions so the biggest campaigns surface first. Backs the campaign-picker list
// (renderCampaignList) instead of dumping every raw row on the main page.
function campaignSummaries(rows, fields) {
  const map = new Map();
  rows.forEach((r) => {
    const name = String(r[fields.campaign] ?? '');
    if (!name) return;
    if (!map.has(name)) map.set(name, { name, rows: 0, impressions: 0, playouts: 0, sites: new Set() });
    const entry = map.get(name);
    entry.rows += 1;
    if (fields.impressions) entry.impressions += Number(r[fields.impressions]) || 0;
    if (fields.playouts) entry.playouts += Number(r[fields.playouts]) || 0;
    if (fields.site) entry.sites.add(String(r[fields.site] ?? ''));
  });
  return [...map.values()]
    .map((e) => ({ ...e, siteCount: e.sites.size }))
    .sort((a, b) => b.impressions - a.impressions || b.playouts - a.playouts);
}

// Main Ads Stats view: Total Impressions/Total Playouts up front, then a clickable list of
// campaigns (not a giant raw table) - click one to drill into renderCampaignDetail.
function renderCampaignList(rows, fields) {
  const totalImpressions = fields.impressions ? rows.reduce((s, r) => s + (Number(r[fields.impressions]) || 0), 0) : null;
  const totalPlayouts = fields.playouts ? rows.reduce((s, r) => s + (Number(r[fields.playouts]) || 0), 0) : null;
  const campaignCount = fields.campaign ? new Set(rows.map((r) => r[fields.campaign])).size : null;
  const siteCount = fields.site ? new Set(rows.map((r) => r[fields.site])).size : null;

  const heroTiles = `
    <div class="bento-stats">
      ${totalImpressions != null ? statTile('ok', 'Total Impressions', totalImpressions.toLocaleString()) : ''}
      ${totalPlayouts != null ? statTile('ok', 'Total Playouts', totalPlayouts.toLocaleString()) : ''}
      ${campaignCount != null ? statTile('info', 'Campaigns', campaignCount) : ''}
      ${siteCount != null ? statTile('info', 'Sites', siteCount) : ''}
    </div>
  `;

  if (!fields.campaign) {
    // No Campaign column in this response at all - fall back to a raw table so the data is still
    // visible/debuggable rather than just disappearing.
    const columns = Object.keys(rows[0]);
    const tableRows = rows.slice(0, 200).map((r) => `<tr>${columns.map((c) => `<td>${esc(String(r[c] ?? ''))}</td>`).join('')}</tr>`).join('');
    return `${heroTiles}<div class="card"><div class="card-head"><h3>Ads Stats</h3><div class="desc">${rows.length} row(s)${rows.length > 200 ? ' (showing first 200)' : ''} - no Campaign column detected, showing raw rows.</div></div><div class="tsheet-wrap"><table class="zebra"><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table></div></div>`;
  }

  const campaigns = campaignSummaries(rows, fields);
  const bodyRows = campaigns.map((c) => `
    <tr style="cursor:pointer;" onclick="App.setReportCampaign('${jsAttrSq(c.name)}')">
      <td>${esc(c.name)}</td>
      <td class="tright">${c.impressions.toLocaleString()}</td>
      <td class="tright">${c.playouts.toLocaleString()}</td>
      <td class="tright">${c.siteCount}</td>
    </tr>
  `).join('');

  return `
    ${heroTiles}
    <div class="card">
      <div class="card-head"><h3>Campaigns</h3><div class="desc">${campaigns.length} campaign(s) in this date range. Click one for its detail, screen breakdown, and a downloadable report.</div></div>
      <div class="tsheet-wrap">
        <table class="zebra">
          <thead><tr><th>Campaign</th><th class="tright">Impressions</th><th class="tright">Playouts</th><th class="tright">Sites</th></tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

// Kicks off every lookup renderCampaignDetail needs beyond the loaded Ads Stats rows - real flight
// dates (loadCampaignMeta), Direct/Programmatic + loop config per line item (loadCampaignAdsInfo),
// and this same campaign's Programmatic (stats-dsps) rows for the Programmatic Report section -
// once per campaign selection (setReportCampaign resets the Started flags when it changes).
function ensureCampaignDetailData(campaign, campaignRows, fields) {
  if (!STATE.reportingCampaignMetaStarted) {
    STATE.reportingCampaignMetaStarted = true;
    queueMicrotask(() => loadCampaignMeta(campaign));
  }
  if (!STATE.reportingCampaignAdsInfoStarted) {
    STATE.reportingCampaignAdsInfoStarted = true;
    queueMicrotask(() => loadCampaignAdsInfo(campaignRows, fields));
  }
  if (!STATE.reportingDsps && !STATE.reportingDspsLoading && !STATE.reportingDspsStarted) {
    STATE.reportingDspsStarted = true;
    const defaults = defaultDateRange();
    const start = STATE.reportingStartDate || defaults.start;
    const end = STATE.reportingEndDate || defaults.end;
    queueMicrotask(() => loadDateRangeTab('reportingDsps', '/stats-dsps', start, end));
  }
}

// Ads (line items), Publishers (by Site) and Sellers (by DSP / Seat) for this campaign's
// Programmatic (stats-dsps) rows - a separate report from the Direct-side Screen Breakdown/
// Creative Split above since programmatic delivery is sold through DSPs/seats rather than booked
// directly against a screen. "Publisher"/"Seller" aren't terms the API docs define explicitly -
// Publisher is mapped to Site (the venue/screen owner selling the impression) and Seller to DSP +
// Seat (dsp_name/dsp_seat, the buying account on the exchange), the closest fit to those terms
// given what the schema actually has (adv_domain, dsp_id, dsp_name, dsp_seat, s_name, p_name).
function renderProgrammaticReport(campaignDspsRows, dspsFields) {
  if (!campaignDspsRows.length) return '';
  const numericFieldMap = {};
  if (dspsFields.playouts) numericFieldMap.playouts = dspsFields.playouts;
  if (dspsFields.impressions) numericFieldMap.impressions = dspsFields.impressions;

  const byAd = dspsFields.ad ? aggregateByKey(campaignDspsRows, (r) => String(r[dspsFields.ad] ?? ''), numericFieldMap) : [];
  const byPublisher = dspsFields.site ? aggregateByKey(campaignDspsRows, (r) => String(r[dspsFields.site] ?? ''), numericFieldMap) : [];
  const bySeller = aggregateByKey(campaignDspsRows, (r) => {
    const dsp = dspsFields.dsp ? String(r[dspsFields.dsp] ?? '') : '';
    const seat = dspsFields.dspSeat ? String(r[dspsFields.dspSeat] ?? '') : '';
    return [dsp, seat].filter(Boolean).join(' / ');
  }, numericFieldMap);

  const sortDesc = (rows) => rows.sort((a, b) => (b.impressions ?? b.playouts ?? 0) - (a.impressions ?? a.playouts ?? 0));

  return `
    <div class="card-head" style="padding:10px 0 6px;"><h3 style="margin:0;">Programmatic Report</h3><div class="desc">${campaignDspsRows.length} programmatic row(s) for this campaign, from GET /stats-dsps.</div></div>
    ${renderKeyValueTable('Ads', 'Programmatic line items for this campaign.', sortDesc(byAd), 'Ad', numericFieldMap)}
    ${renderKeyValueTable('Publishers', 'By Site - the venue/screen owner selling the impression.', sortDesc(byPublisher), 'Publisher (Site)', numericFieldMap)}
    ${renderKeyValueTable('Sellers', 'By DSP / Seat - the buying account on the exchange.', sortDesc(bySeller), 'Seller (DSP / Seat)', numericFieldMap)}
  `;
}

// Campaign detail view: that campaign's own Impression/Playout totals, its real flight dates, its
// Direct/Programmatic + loop breakdown, its Direct-side screen/creative/day-wise splits, its
// Programmatic Report, and the Download Report panel - everything scoped to just this campaign so
// there's no dropdown or "which campaign" ambiguity left for the download step.
function renderCampaignDetail(campaign, campaignRows, fields) {
  ensureCampaignDetailData(campaign, campaignRows, fields);

  const totalImpressions = fields.impressions ? campaignRows.reduce((s, r) => s + (Number(r[fields.impressions]) || 0), 0) : null;
  const totalPlayouts = fields.playouts ? campaignRows.reduce((s, r) => s + (Number(r[fields.playouts]) || 0), 0) : null;
  const totalRevenue = fields.revenue ? campaignRows.reduce((s, r) => s + (Number(r[fields.revenue]) || 0), 0) : null;
  const siteCount = fields.site ? new Set(campaignRows.map((r) => r[fields.site])).size : null;
  const dates = fields.date ? [...new Set(campaignRows.map((r) => String(r[fields.date] ?? '').slice(0, 10)))].filter(Boolean).sort() : [];
  const loadedRangeLabel = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`) : '';

  // Real campaign flight dates (GET /campaigns) - falls back to the loaded date range, clearly
  // labeled as such, if that lookup is still in flight or came back empty.
  const meta = STATE.reportingCampaignMeta;
  const metaLoading = STATE.reportingCampaignMetaLoading;
  const realStart = meta?.start ? new Date(meta.start * 1000).toISOString().slice(0, 10) : null;
  const realEnd = meta?.end ? new Date(meta.end * 1000).toISOString().slice(0, 10) : null;
  const durationLine = realStart && realEnd
    ? `${realStart} to ${realEnd}${meta.status ? ` (${esc(meta.status)})` : ''}`
    : metaLoading ? 'Loading campaign dates...'
    : loadedRangeLabel ? `${esc(loadedRangeLabel)} (data shown - actual flight dates unavailable)`
    : '';

  // Direct vs Programmatic (GET /ads/{id} per line item) - null while loading/unavailable, [] once
  // resolved with nothing usable (e.g. no adId column in this response).
  const adsInfo = STATE.reportingCampaignAdsInfo;
  const adsLoading = STATE.reportingCampaignAdsInfoLoading;
  const directCount = adsInfo ? adsInfo.filter((a) => a.demand_type === 'direct').length : null;
  const programmaticCount = adsInfo ? adsInfo.filter((a) => a.demand_type === 'programmatic').length : null;
  const lineItemRows = (adsInfo || []).map((a) => `
    <tr>
      <td>${esc(a.name || '')}</td>
      <td class="tcenter"><span class="badge ${a.demand_type === 'programmatic' ? 'b-amber' : 'b-blue'}">${a.demand_type === 'programmatic' ? 'Programmatic' : 'Direct'}</span></td>
      <td>${esc(a.volume_type || '')}</td>
      <td class="tright">${a.volume_type === 'cycle' ? (a.cycle_playouts ?? '') : ''}</td>
    </tr>
  `).join('');

  const numericFieldMap = {};
  if (fields.playouts) numericFieldMap.playouts = fields.playouts;
  if (fields.impressions) numericFieldMap.impressions = fields.impressions;

  // Screen Breakdown - Direct only (this campaign's own stats-ads rows); the campaign name is
  // already the page heading above, so it isn't repeated on every row here.
  const numericKeys = Object.keys(numericFieldMap);
  const screenRows = aggregateByScreen(campaignRows, fields, numericKeys);
  const screenTableRows = screenRows.map((r) => `
    <tr>
      <td>${esc(r.site)}</td>
      <td>${esc(r.placement)}</td>
      ${fields.playouts ? `<td class="tright">${(r.playouts ?? 0).toLocaleString()}</td>` : ''}
      ${fields.impressions ? `<td class="tright">${(r.impressions ?? 0).toLocaleString()}</td>` : ''}
    </tr>
  `).join('');

  const creativeRows = fields.creative
    ? aggregateByKey(campaignRows, (r) => String(r[fields.creative] ?? ''), numericFieldMap).sort((a, b) => (b.impressions ?? b.playouts ?? 0) - (a.impressions ?? a.playouts ?? 0))
    : [];
  const dayRows = fields.date
    ? aggregateByKey(campaignRows, (r) => String(r[fields.date] ?? '').slice(0, 10), numericFieldMap).sort((a, b) => a.key.localeCompare(b.key))
    : [];

  // This campaign's own Programmatic (stats-dsps) rows, if any - reportingDsps is kicked off by
  // ensureCampaignDetailData so it's available here even if the user never opened the Programmatic
  // Stats/Traffic Data tabs directly.
  const dspsRaw = STATE.reportingDsps;
  const dspsRows = dspsRaw ? extractRows(dspsRaw) : [];
  const dspsFields = dspsRows.length ? detectAllFields(dspsRows) : {};
  const campaignDspsRows = dspsFields.campaign ? dspsRows.filter((r) => String(r[dspsFields.campaign] ?? '') === campaign) : [];

  return `
    <div class="toolbar-actions" style="margin-bottom:10px;">
      <button class="btn-sm" type="button" onclick="App.setReportCampaign('')">&larr; Back to all campaigns</button>
    </div>
    <div class="card-head" style="padding:0 0 8px;"><h3 style="margin:0;">${esc(campaign)}</h3><div class="desc">${durationLine}${siteCount != null ? ` - ${siteCount} screen(s)` : ''}</div></div>
    <div class="bento-stats">
      ${totalImpressions != null ? statTile('ok', 'Total Impressions', totalImpressions.toLocaleString()) : ''}
      ${totalPlayouts != null ? statTile('ok', 'Total Playouts', totalPlayouts.toLocaleString()) : ''}
      ${siteCount != null ? statTile('info', 'Screens', siteCount) : ''}
      ${totalRevenue != null ? statTile('info', 'Total Revenue', totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 2 })) : ''}
    </div>
    ${adsLoading || adsInfo?.length ? `
      <div class="card">
        <div class="card-head"><h3>Delivery Type &amp; Line Items</h3><div class="desc">${adsLoading ? 'Loading...' : `Direct: ${directCount}, Programmatic: ${programmaticCount}. "Playouts" (in this table only) only applies to loop/cycle-paced line items.`}</div></div>
        ${adsLoading ? '' : `<div class="tsheet-wrap"><table class="zebra"><thead><tr><th>Ad (Line Item)</th><th class="tcenter">Type</th><th>Volume Type</th><th class="tright">Playouts</th></tr></thead><tbody>${lineItemRows}</tbody></table></div>`}
      </div>
    ` : ''}
    <div class="card">
      <div class="card-head"><h3>Screen Breakdown</h3><div class="desc">${screenRows.length} screen(s), Direct delivery only, for this campaign in the current date range.</div></div>
      <div class="tsheet-wrap">
        <table class="zebra">
          <thead><tr><th>Site</th><th>Placement</th>${fields.playouts ? '<th class="tright">Playouts</th>' : ''}${fields.impressions ? '<th class="tright">Impressions</th>' : ''}</tr></thead>
          <tbody>${screenTableRows}</tbody>
        </table>
      </div>
    </div>
    ${renderKeyValueTable('Creative Split', 'Direct delivery, by Creative.', creativeRows, 'Creative', numericFieldMap)}
    ${renderKeyValueTable('Day by Day', 'Direct delivery, by Date.', dayRows, 'Date', numericFieldMap)}
    ${renderProgrammaticReport(campaignDspsRows, dspsFields)}
    ${renderReportDownloadPanel(fields)}
  `;
}

function renderOverview(rows, fields) {
  if (!rows.length) return '<div class="card"><div class="empty">No data for this date range.</div></div>';

  const selectedCampaign = STATE.reportingSelectedCampaign;
  if (selectedCampaign && fields.campaign) {
    const campaignRows = rows.filter((r) => String(r[fields.campaign] ?? '') === selectedCampaign);
    if (campaignRows.length) return renderCampaignDetail(selectedCampaign, campaignRows, fields);
  }
  return renderCampaignList(rows, fields);
}

export function setTrafficTypeFilter(v) { setState({ reportingTrafficType: v }); }
export function setTrafficCategoryTab(v) { setState({ reportingTrafficCategory: v }); }

// Venue-category classification for Reporting's site names - lets Traffic Data be browsed by
// category the same way the separate Traffic Sheet workspace is, without a venueType/network field
// (the AiOO Reporting API's /stats-ads site names are bare venue names like "Dubai Festival City",
// "Al Rigga", "ENOC Dubai" - confirmed against real data they do NOT carry a "Category - " prefix
// the way IoT device storeName does, so that convention doesn't apply here).
// Asset Inventory's own `category` column (Metro/Malls/In-Store/Outdoor/Petrol Stations - the same
// categorization an admin already maintains for every physical screen) turned out to be a reliable,
// already-populated ground truth for these exact venue names (spot-checked against real Reporting
// site names: "Al Rigga"->Metro, "Burjuman Mall"->Malls, "ENOC Dubai"->Petrol Stations, "Union Coop
// AL WARQA"->In-Store, etc. - near-exact matches). Built as name -> most-common-category (by row
// count) since a handful of venue names legitimately span two physical venues in different
// categories (e.g. "Mall of the Emirates" is both a Metro station and a separate MAF mall - same
// ambiguity trafficSheet.js documents for its own venueType-based matching).
export const REPORTING_SITE_CATEGORIES = ['Metro', 'Malls', 'In-Store', 'Petrol Stations', 'Outdoor', 'Other'];
const CATEGORY_NORMALIZE = { 'in-store': 'In-Store', 'in store': 'In-Store', malls: 'Malls', mall: 'Malls', metro: 'Metro', outdoor: 'Outdoor', 'petrol stations': 'Petrol Stations' };
const REPORTING_RETAIL_CHAIN_KEYWORDS = ['LULU', 'UNION COOP', 'ADCOOP', 'CARREFOUR'];

function buildVenueCategoryMap(assetInventory) {
  const counts = new Map(); // normalized venue name -> Map<category, count>
  (assetInventory || []).forEach((r) => {
    const venue = String(r.venue || '').trim().toLowerCase();
    const category = CATEGORY_NORMALIZE[String(r.category || '').trim().toLowerCase()];
    if (!venue || !category) return;
    if (!counts.has(venue)) counts.set(venue, new Map());
    const byCategory = counts.get(venue);
    byCategory.set(category, (byCategory.get(category) || 0) + 1);
  });
  const map = new Map();
  counts.forEach((byCategory, venue) => {
    let best = null; let bestCount = 0;
    byCategory.forEach((count, category) => { if (count > bestCount) { best = category; bestCount = count; } });
    if (best) map.set(venue, best);
  });
  return map;
}

function reportingSiteCategory(rawName, venueCategoryMap) {
  const name = String(rawName || '').trim();
  if (!name) return 'Other';
  const known = venueCategoryMap.get(name.toLowerCase());
  if (known) return known;
  const upper = name.toUpperCase();
  if (REPORTING_RETAIL_CHAIN_KEYWORDS.some((k) => upper.includes(k))) return 'In-Store';
  if (upper.includes('ENOC')) return 'Petrol Stations';
  return 'Other';
}

function rowMatchesCategory(row, siteField, category, venueCategoryMap) {
  if (category === 'all') return true;
  if (!siteField) return false;
  return reportingSiteCategory(row[siteField], venueCategoryMap) === category;
}

// Site-level rollup: how many distinct campaigns ran on each site (any type), so it's obvious at a
// glance which malls/locations are busiest - matches trafficSheet.js's own location-centric view,
// just built from AiOO stats instead of the AdLive Center feed.
function renderTrafficByLocation(campaigns) {
  const bySite = new Map();
  campaigns.forEach((c) => {
    (c.sites || new Set()).forEach((site) => {
      if (!site) return;
      if (!bySite.has(site)) bySite.set(site, { site, campaignNames: new Set(), playouts: 0, impressions: 0 });
      const entry = bySite.get(site);
      entry.campaignNames.add(c.campaign);
      let total = { playouts: 0, impressions: 0 };
      c.dayMap.forEach((d) => { total.playouts += d.playouts; total.impressions += d.impressions; });
      entry.playouts += total.playouts;
      entry.impressions += total.impressions;
    });
  });
  const rows = [...bySite.values()].sort((a, b) => b.campaignNames.size - a.campaignNames.size);
  if (!rows.length) return '';
  const body = rows.map((r) => `<tr>
    <td>${esc(r.site)}</td>
    <td class="tright">${r.campaignNames.size}</td>
    <td class="tright">${r.playouts.toLocaleString()}</td>
    <td class="tright">${r.impressions.toLocaleString()}</td>
  </tr>`).join('');
  return `<div class="card">
    <div class="card-head"><h3>By Location</h3><div class="desc">${rows.length} location(s) - how many distinct campaigns are running at each, matching the current Type filter.</div></div>
    <div class="tsheet-wrap"><table class="zebra"><thead><tr><th>Site</th><th class="tright">Campaigns</th><th class="tright">Playouts</th><th class="tright">Impressions</th></tr></thead><tbody>${body}</tbody></table></div>
  </div>`;
}

// Per-screen ad coverage: how many distinct campaigns played on each Site+Placement, cross-
// referenced against Placements Stats (the only endpoint that lists a placement even when it had
// zero ad calls) - so a placement that's wired up but never actually serving anything shows up
// clearly instead of just being absent from stats-ads/stats-dsps entirely. Only rendered when
// Placements Stats has been loaded this session (that's the only source for the "no ads at all"
// case - stats-ads/stats-dsps simply don't have a row for a placement with zero activity).
function renderPlacementAdCoverage(directRows, directFields, dspsRows, dspsFields, category, venueCategoryMap) {
  const statsRaw = STATE.reportingPlacementsStats;
  if (!statsRaw) return '<div class="card"><div class="empty">Open Placements Stats first to see which placements have no ads running - stats-ads/stats-dsps only ever include placements that already have activity, so a placement with zero ads never appears there at all.</div></div>';
  let statsRows = extractRows(statsRaw);
  const statsFields = statsRows.length ? detectAllFields(statsRows) : {};
  if (!statsFields.site || !statsFields.placement) return '';
  if (category && category !== 'all') statsRows = statsRows.filter((r) => rowMatchesCategory(r, statsFields.site, category, venueCategoryMap));

  const adCountByScreen = new Map();
  function ingest(rows, fields) {
    if (!fields.site || !fields.placement || !fields.campaign) return;
    rows.forEach((r) => {
      const key = `${r[fields.site] ?? ''}|${r[fields.placement] ?? ''}`;
      if (!adCountByScreen.has(key)) adCountByScreen.set(key, new Set());
      adCountByScreen.get(key).add(String(r[fields.campaign] ?? ''));
    });
  }
  ingest(directRows, directFields);
  ingest(dspsRows, dspsFields);

  const screens = new Map();
  statsRows.forEach((r) => {
    const site = String(r[statsFields.site] ?? '');
    const placement = String(r[statsFields.placement] ?? '');
    const key = `${site}|${placement}`;
    if (screens.has(key)) return;
    const adCount = adCountByScreen.get(key)?.size || 0;
    screens.set(key, { site, placement, adCount });
  });
  const rows = [...screens.values()].sort((a, b) => a.adCount - b.adCount || a.site.localeCompare(b.site));
  const noAdsCount = rows.filter((r) => r.adCount === 0).length;
  const body = rows.slice(0, 200).map((r) => `<tr${r.adCount === 0 ? ' style="background:var(--red-bg);"' : ''}>
    <td>${esc(r.site)}</td>
    <td>${esc(r.placement)}</td>
    <td class="tright">${r.adCount}</td>
    <td>${r.adCount === 0 ? '<span class="badge b-red">No ads</span>' : ''}</td>
  </tr>`).join('');
  return `<div class="card">
    <div class="card-head"><h3>Placements - Ad Coverage</h3><div class="desc">${rows.length} placement(s) from Placements Stats, ${noAdsCount} with no campaigns running (any type) in the current date range.${rows.length > 200 ? ' Showing first 200.' : ''}</div></div>
    <div class="tsheet-wrap"><table class="zebra"><thead><tr><th>Site</th><th>Placement</th><th class="tright">Campaigns Running</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
  </div>`;
}

// Fetches the ad-id set behind the grid's Loop Count column exactly once per distinct set (a
// plain STATE flag, not loadData, since the "key" here is a computed id list rather than a fixed
// cache name) - re-fetches only when the date range/filters actually change which ads are in
// play, not on every render.
function ensureGridAdsLoopInfo(adIds) {
  const key = [...new Set(adIds)].sort().slice(0, MAX_GRID_AD_LOOKUPS).join(',');
  if (STATE.reportingGridAdsLoopKey === key) return;
  STATE.reportingGridAdsLoopKey = key;
  if (!adIds.length) { STATE.reportingGridAdsLoopInfo = new Map(); return; }
  // Deferred to a microtask (not called synchronously here) so the setState calls inside don't
  // re-enter render() from within the current render pass - same pattern ensureCampaignDetailData
  // uses for loadCampaignMeta/loadCampaignAdsInfo.
  queueMicrotask(async () => {
    setState({ reportingGridAdsLoopLoading: true });
    try {
      const map = await loadGridAdsLoopInfo(adIds);
      setState({ reportingGridAdsLoopInfo: map, reportingGridAdsLoopLoading: false });
    } catch (e) {
      setState({ reportingGridAdsLoopLoading: false });
    }
  });
}

// "Traffic Data" - a replica of the separate Traffic Sheet workspace's own day-by-day grid
// (renderDayGrid in trafficSheet.js: Campaign ID, Campaign Name, Start, End, Days, Loop Count,
// Status, then a month-grouped calendar of day cells), built from AiOO's Direct (/stats-ads) and
// Programmatic (/stats-dsps) rows instead of AdLive Center's feed. Two things AiOO's stats rows
// don't carry are filled in with extra lookups so the columns genuinely match:
//   - Start/End/Days/Status: GET /campaigns (no `name` filter fetches every campaign in one call,
//     see loadAllCampaignsMeta) matched locally by campaign name - same data loadCampaignMeta
//     already uses for the single-campaign Campaign Detail view, just fetched once for the whole
//     grid instead of per campaign.
//   - Loop Count: GET /ads/{id}'s `cycle_playouts` (only set when volume_type is 'cycle') is the
//     closest AiOO concept to a per-loop spot count - looked up per distinct line item across
//     every campaign shown, capped the same defensive way loadCampaignAdsInfo caps a single
//     campaign's line items (see ensureGridAdsLoopInfo/MAX_GRID_AD_LOOKUPS).
// Campaign ID itself needs no extra lookup - c_id is already a column on every stats-ads/stats-dsps
// row (see FIELD_CANDIDATES.campaignId).
// Each day cell still shows Playouts on top / Impressions below (AiOO's actual metrics - Traffic
// Sheet's own day cells show a spot count, a concept that doesn't exist in this data source).
// Type (Direct/Programmatic) and total Playouts/Impressions columns are appended after the
// Traffic-Sheet-matching columns since AiOO mixes both delivery types in one feed and Traffic
// Sheet has no equivalent. Also includes a By Location rollup and a Placements ad-coverage check
// (mirrors the "which malls are running how many campaigns" view from the separate Traffic Sheet
// workspace, and flags dead/unused placements) - see the two render functions above.
const TRAFFIC_GRID_META_COLS = 10; // Campaign ID, Campaign Name, Type, Start, End, Days, Loop Count, Status, Playouts, Impressions
function renderAdditionalTrafficSheet(directRowsAll, dspsRowsAll, start, end) {
  const typeFilter = STATE.reportingTrafficType || 'all';
  const categoryFilter = STATE.reportingTrafficCategory || 'all';
  const directFieldsAll = directRowsAll.length ? detectAllFields(directRowsAll) : {};
  const dspsFieldsAll = dspsRowsAll.length ? detectAllFields(dspsRowsAll) : {};

  // Venue-category sub-tabs (Metro/Malls/In-Store/Petrol Stations/Outdoor/Other), same browsing
  // model as the separate Traffic Sheet workspace's venue tabs - see reportingSiteCategory's
  // comment for why this is keyed off Asset Inventory's category column rather than a naming
  // convention. Skipped entirely (no tabs, no filtering) while Asset Inventory is still loading, or
  // if the sync has never run - categorization just isn't possible yet either way.
  // Shares the 'assetInventory' cache entry rather than keeping a private one - same query, same
  // data, and loadData caches per KEY, so a separate key here re-downloaded all 2,258 asset rows
  // that another page had usually already fetched.
  const assetInventory = loadData('assetInventory', listAssetInventory);
  const venueCategoryMap = (assetInventory && !assetInventory.__error) ? buildVenueCategoryMap(assetInventory) : null;

  let categoryTabsUi = '';
  if (venueCategoryMap && (directFieldsAll.site || dspsFieldsAll.site)) {
    // Counts computed against the full (unfiltered) row set so switching tabs never shows a stale count.
    const categoryCounts = { all: directRowsAll.length + dspsRowsAll.length };
    REPORTING_SITE_CATEGORIES.forEach((c) => {
      const dCount = directFieldsAll.site ? directRowsAll.filter((r) => reportingSiteCategory(r[directFieldsAll.site], venueCategoryMap) === c).length : 0;
      const pCount = dspsFieldsAll.site ? dspsRowsAll.filter((r) => reportingSiteCategory(r[dspsFieldsAll.site], venueCategoryMap) === c).length : 0;
      categoryCounts[c] = dCount + pCount;
    });
    categoryTabsUi = renderTabs(
      [{ key: 'all', label: 'All', count: categoryCounts.all }, ...REPORTING_SITE_CATEGORIES.map((c) => ({ key: c, label: c, count: categoryCounts[c] }))],
      categoryFilter,
      'App.setTrafficCategoryTab',
    );
  }

  const activeCategoryFilter = venueCategoryMap ? categoryFilter : 'all';
  const directRows = activeCategoryFilter === 'all' ? directRowsAll : directRowsAll.filter((r) => rowMatchesCategory(r, directFieldsAll.site, activeCategoryFilter, venueCategoryMap));
  const dspsRows = activeCategoryFilter === 'all' ? dspsRowsAll : dspsRowsAll.filter((r) => rowMatchesCategory(r, dspsFieldsAll.site, activeCategoryFilter, venueCategoryMap));
  const directFields = directRows.length ? detectAllFields(directRows) : directFieldsAll;
  const dspsFields = dspsRows.length ? detectAllFields(dspsRows) : dspsFieldsAll;

  const typeFilterUi = `
    <div class="field" style="margin-bottom:12px;max-width:220px;"><label>Type</label>
      <select onchange="App.setTrafficTypeFilter(this.value)">
        <option value="all" ${typeFilter === 'all' ? 'selected' : ''}>Direct + Programmatic</option>
        <option value="direct" ${typeFilter === 'direct' ? 'selected' : ''}>Direct only</option>
        <option value="programmatic" ${typeFilter === 'programmatic' ? 'selected' : ''}>Programmatic only</option>
      </select>
    </div>
  `;
  if (!directRows.length && !dspsRows.length) return `${categoryTabsUi}${typeFilterUi}<div class="card"><div class="empty">No data for this ${activeCategoryFilter === 'all' ? 'date range' : 'category, in this date range'}.</div></div>`;
  if ((!directFields.campaign || !directFields.date) && (!dspsFields.campaign || !dspsFields.date)) {
    return `${categoryTabsUi}${typeFilterUi}<div class="card"><div class="empty">Can't build a day-grid without a recognizable campaign and date column in the response.</div></div>`;
  }

  const dates = [];
  for (let d = new Date(start); d <= new Date(end); d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }

  const byCampaign = new Map();
  function ingest(rows, fields, type) {
    if (!fields.campaign || !fields.date) return;
    if (typeFilter === 'direct' && type !== 'Direct') return;
    if (typeFilter === 'programmatic' && type !== 'Programmatic') return;
    rows.forEach((r) => {
      const campaign = String(r[fields.campaign] ?? '(Unknown Campaign)');
      const date = String(r[fields.date] ?? '').slice(0, 10);
      const site = fields.site ? String(r[fields.site] ?? '') : '';
      const playouts = fields.playouts ? Number(r[fields.playouts]) || 0 : 0;
      const impressions = fields.impressions ? Number(r[fields.impressions]) || 0 : 0;
      const campaignId = fields.campaignId ? String(r[fields.campaignId] ?? '') : '';
      const adId = fields.adId ? r[fields.adId] : null;
      const key = `${type}::${campaign}`;
      if (!byCampaign.has(key)) byCampaign.set(key, { campaign, type, campaignId: '', dayMap: new Map(), sites: new Set(), adIds: new Set() });
      const entry = byCampaign.get(key);
      if (site) entry.sites.add(site);
      if (!entry.campaignId && campaignId) entry.campaignId = campaignId;
      if (adId != null) entry.adIds.add(adId);
      const day = entry.dayMap.get(date) || { playouts: 0, impressions: 0 };
      day.playouts += playouts;
      day.impressions += impressions;
      entry.dayMap.set(date, day);
    });
  }
  ingest(directRows, directFields, 'Direct');
  ingest(dspsRows, dspsFields, 'Programmatic');

  const campaigns = [...byCampaign.values()].sort((a, b) => a.campaign.localeCompare(b.campaign) || a.type.localeCompare(b.type));

  // Start/End/Days/Status, fetched once for every campaign name in play (see loadAllCampaignsMeta) -
  // non-blocking, same pattern as the Asset Inventory category lookup above: render with what's
  // available now, pick up the rest on the next render once the fetch resolves.
  const campaignsMetaEntry = loadData('reportingAllCampaignsMeta', loadAllCampaignsMeta);
  const campaignsMetaError = campaignsMetaEntry?.__error || null;
  const campaignsMeta = (campaignsMetaEntry && !campaignsMetaError) ? campaignsMetaEntry : null;
  const campaignsMetaLoading = campaignsMetaEntry === null;

  // Loop Count, fetched for every distinct line item across every campaign currently shown (see
  // ensureGridAdsLoopInfo) - kicked off here so it starts as soon as this tab renders.
  const allAdIds = [...new Set(campaigns.flatMap((c) => [...c.adIds]))];
  ensureGridAdsLoopInfo(allAdIds);
  const adsLoopInfo = STATE.reportingGridAdsLoopInfo || new Map();
  const adsLoopLoading = STATE.reportingGridAdsLoopLoading;

  // A single-day range (the page's own default) makes a "day-by-day" grid pointless - its one
  // column is just a bare day-of-month number ("09") with zero context, and its value always
  // equals the campaign's own total anyway. Showing both was confusing (reported as "what is 09,
  // this is incorrect data") - so the day columns only render at all once there's more than one
  // day to actually spread across, and even then each header carries the full date as a tooltip.
  const showDayGrid = dates.length > 1;
  const dateGroups = showDayGrid ? groupDatesByMonth(dates) : [];
  function campaignRow(c) {
    let totalPlayouts = 0;
    let totalImpressions = 0;
    c.dayMap.forEach((d) => { totalPlayouts += d.playouts; totalImpressions += d.impressions; });
    const meta = campaignsMeta?.get(normalizeCampaignName(c.campaign));
    const realStart = meta?.start ? new Date(meta.start * 1000).toISOString().slice(0, 10) : '';
    const realEnd = meta?.end ? new Date(meta.end * 1000).toISOString().slice(0, 10) : '';
    const campaignDays = (meta?.start && meta?.end) ? Math.round((meta.end - meta.start) / 86400) + 1 : '';
    const loopValues = [...c.adIds]
      .map((id) => adsLoopInfo.get(String(id)))
      .filter((a) => a && a.volume_type === 'cycle' && a.cycle_playouts != null)
      .map((a) => a.cycle_playouts);
    const loopCount = [...new Set(loopValues)].join(', ');
    const statusCell = meta ? statusBadge(meta.status) : (campaignsMetaLoading ? '<span class="small muted">Loading...</span>' : '');
    return `<tr>
      <td class="tsheet-nowrap">${esc(c.campaignId)}</td>
      <td>${esc(c.campaign)}</td>
      <td class="tcenter"><span class="badge ${c.type === 'Programmatic' ? 'b-amber' : 'b-blue'}">${c.type}</span></td>
      <td class="tsheet-nowrap">${esc(realStart)}</td>
      <td class="tsheet-nowrap">${esc(realEnd)}</td>
      <td class="tcenter">${campaignDays}</td>
      <td class="tcenter">${esc(loopCount)}${!loopCount && adsLoopLoading ? '<span class="small muted">...</span>' : ''}</td>
      <td class="tcenter">${statusCell}</td>
      <td class="tright">${totalPlayouts.toLocaleString()}</td>
      <td class="tright">${totalImpressions.toLocaleString()}</td>
      ${showDayGrid ? dates.map((d) => {
        const day = c.dayMap.get(d);
        return `<td class="tsheet-cell${day ? ' tsheet-active' : ''}" title="${esc(d)}">${day ? `${day.playouts.toLocaleString()}<br><span class="small muted">${day.impressions.toLocaleString()}</span>` : ''}</td>`;
      }).join('') : ''}
    </tr>`;
  }
  // Same FOC/Marketing keyword classification the Traffic Sheet workspace uses (see
  // isFocMarketingCampaign in trafficSheet.js) - split into its own labeled sub-table beneath the
  // regular one so FOC/Marketing bookings are grouped the same way here as they are there, without
  // hiding them from the normal view.
  const regularCampaigns = campaigns.filter((c) => !isFocMarketingCampaign({ campaignName: c.campaign }));
  const focCampaigns = campaigns.filter((c) => isFocMarketingCampaign({ campaignName: c.campaign }));
  const bodyRows = regularCampaigns.map(campaignRow).join('');
  const focBodyRows = focCampaigns.map(campaignRow).join('');
  // Surfaced so a broken/failed name match isn't just silently blank Start/End/Days/Status cells
  // with no clue why - either the whole /campaigns lookup failed (network/auth/API error) or it
  // succeeded but some campaign names here didn't find a match in it (name drifted, campaign
  // deleted/renamed on AiOO's side since, etc).
  const unmatchedCount = campaignsMeta ? campaigns.filter((c) => !campaignsMeta.get(normalizeCampaignName(c.campaign))).length : 0;
  const metaWarning = campaignsMetaError
    ? `<div class="login-error" style="margin-bottom:14px;">Couldn't load Start/End/Days/Status from AiOO's Campaigns API: ${esc(campaignsMetaError)}</div>`
    : (unmatchedCount ? `<div class="login-error" style="margin-bottom:14px;">${unmatchedCount} of ${campaigns.length} campaign(s) below have no Start/End/Days/Status - their name didn't match anything in AiOO's Campaigns API (renamed/deleted there, or a name mismatch).</div>` : '');
  // Same two-row month-then-day header as Traffic Sheet's own renderDayGrid (trafficSheet.js) - a
  // merged "Mon YYYY" row above the per-day columns, so a multi-month range reads the same way here
  // as it does there.
  const monthHeadRow = showDayGrid ? `<tr><th colspan="${TRAFFIC_GRID_META_COLS}"></th>${dateGroups.map((g) => `<th colspan="${g.dates.length}" class="tsheet-month-head">${esc(formatMonthLabel(g.month))}</th>`).join('')}</tr>` : '';
  const dayHeadCells = showDayGrid ? dates.map((d) => `<th class="tsheet-day" title="${esc(d)}">${esc(d.slice(8, 10))}</th>`).join('') : '';
  const tableHead = `<thead>${monthHeadRow}<tr><th>Campaign ID</th><th>Campaign Name</th><th class="tcenter">Type</th><th>Start</th><th>End</th><th class="tcenter">Days</th><th class="tcenter">Loop Count</th><th class="tcenter">Status</th><th class="tright">Playouts</th><th class="tright">Impressions</th>${dayHeadCells}</tr></thead>`;

  return `
    ${categoryTabsUi}
    ${typeFilterUi}
    ${metaWarning}
    <div class="card">
      <div class="card-head"><h3>Traffic Data</h3><div class="desc">${campaigns.length} campaign(s)${showDayGrid ? ', day-by-day. Each day cell shows Playouts on top and Impressions below (hover a date header for the full date)' : ' - totals for'} from ${esc(start)} to ${esc(end)} - ${regularCampaigns.length} regular, ${focCampaigns.length} FOC/Marketing. Start/End/Days/Status come from AiOO's Campaigns API (GET /campaigns) and Loop Count from its Ads API (GET /ads/{id}), both matched to these rows by name/line item.</div></div>
      <div class="tsheet-wrap">
        <table class="tsheet-table zebra">
          ${tableHead}
          <tbody>${bodyRows || `<tr><td colspan="${TRAFFIC_GRID_META_COLS + (showDayGrid ? dates.length : 0)}"><div class="empty">No regular campaigns for this date range.</div></td></tr>`}</tbody>
        </table>
      </div>
    </div>
    ${focCampaigns.length ? `
    <div class="card">
      <div class="card-head"><h3>FOC / Marketing <span class="badge b-amber">${focCampaigns.length}</span></h3><div class="desc">Same FOC/Marketing keyword grouping used on the Traffic Sheet workspace.</div></div>
      <div class="tsheet-wrap">
        <table class="tsheet-table zebra">
          ${tableHead}
          <tbody>${focBodyRows}</tbody>
        </table>
      </div>
    </div>
    ` : ''}
    ${renderTrafficByLocation(campaigns)}
    ${renderPlacementAdCoverage(directRows, directFields, dspsRows, dspsFields, activeCategoryFilter, venueCategoryMap)}
  `;
}

export function setGenericTablePage(scope, page) {
  STATE.genericTablePage = STATE.genericTablePage || {};
  STATE.genericTablePage[scope] = page;
  setState({});
}

const GENERIC_TABLE_PAGE_SIZE = 200;

// Shared renderer for the two other date-range stats endpoints (Programmatic/Placements) and the
// Status Report - dynamic columns exactly as returned, plus optional totals for known numeric
// fields.
// opts.excludeColumns: raw column names to drop from the dynamic column list (e.g. numeric ID
// columns that are just noise once the matching *_name column is already shown).
// opts.highlightRow(row): rows this returns true for get a "no activity" red badge/tint - used by
// Placements Stats to flag placements with zero ad calls.
function renderGenericTable(title, desc, rows, opts = {}) {
  if (!rows || !rows.length) return '<div class="card"><div class="empty">No data.</div></div>';
  const exclude = new Set(opts.excludeColumns || []);
  const columns = Object.keys(rows[0]).filter((c) => !exclude.has(c));
  // Sortable on every column, keyed by the raw column name itself (accessor is just `row[c]`) -
  // generic enough to work regardless of which dynamic columns a given endpoint happens to return.
  // Without this, a large unsorted response (stats-dsps alone can be thousands of rows) shows
  // whatever order the API returned, which is easy to mistake for "every column is 0/blank" when
  // the rows with real activity are just further down - sorting by e.g. Requests/Impressions
  // descending surfaces them immediately instead.
  const accessors = {};
  columns.forEach((c) => { accessors[c] = (r) => r[c]; });
  const sortedRows = applySort(rows, title, accessors);

  // Column widths are computed from the FULL sorted row set (every row, not just the page about to
  // be sliced out below) and the table is rendered with a fixed layout, so a column's width comes
  // only from this one-time calculation - it can't shift every time sorting or paging swaps in a
  // different subset of rows the way an auto-layout table's content-driven sizing would. Capped at
  // 24ch so one freak long value (a stray URL, a long free-text note) can't blow a column out; long
  // values still show in full via the title tooltip and can be read by widening the browser/zooming
  // out, they just don't force every other row onto multiple lines.
  //
  // Tried raising this to 40 to give long site/placement names more room, but a wide endpoint like
  // stats-dsps (17 columns) already has several OTHER genuinely-long text columns (dsp_seat's
  // auction IDs, in particular) - letting every one of them grow past 24 consumed so much width
  // that the flex column below (see flexCol) had nothing left to claim and rendered at 0px,
  // hiding its entire column outright. That's strictly worse than a 24ch ellipsis, so this stays.
  const widths = {};
  columns.forEach((c) => { widths[c] = colWidthCh(sortedRows, (r) => r[c], c, { min: 6, max: 24 }); });
  // Every column above has a specified (capped) width, but table-layout:fixed doesn't stretch
  // specified widths to fill a wider container on its own - the table just ends up narrower than
  // its card on any screen wider than the content actually needs, leaving a large dead gap on the
  // right (confirmed live on a normal desktop width). Leaving the single column with the most
  // genuine content - by UNcapped length, so two columns that both hit the 24ch cap still pick the
  // one that actually needed more room, not just whichever came first - unset fixes this: an unset
  // column under table-layout:fixed always absorbs 100% of whatever space is left over after the
  // other (still-fixed, still full-dataset-derived, still sort/page-stable) columns, so the table
  // fills its container at any width without reintroducing the original column-jump-on-sort issue.
  const rawWidths = {};
  columns.forEach((c) => { rawWidths[c] = colWidthCh(sortedRows, (r) => r[c], c, { min: 6, max: Infinity }); });
  const widest = columns.reduce((best, c) => (rawWidths[c] > rawWidths[best] ? c : best), columns[0]);
  // A wide endpoint (stats-dsps: 17 columns) can need MORE total width across its other, still-
  // fixed columns than a typical card even has to give - confirmed live: leaving p_name unset there
  // didn't widen it, it collapsed to 0px, hiding the column outright, because there was no leftover
  // space at all once every other column claimed its own share. table-layout:fixed can't give a
  // column negative width, so an unset column is only safe when the REST of the row has genuine
  // room to spare. SAFE_FIXED_CH is a conservative estimate of that (comfortably under a normal
  // card's content width even accounting for the sidebar) - past it, every column keeps its own
  // capped width and the table scrolls horizontally instead (already supported via .tsheet-wrap),
  // which is strictly better than one column vanishing.
  const SAFE_FIXED_CH = 110;
  const otherColsCh = columns.filter((c) => c !== widest).reduce((sum, c) => sum + widths[c], 0);
  const flexCol = otherColsCh <= SAFE_FIXED_CH ? widest : null;

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / GENERIC_TABLE_PAGE_SIZE));
  const page = Math.min(STATE.genericTablePage?.[title] || 0, totalPages - 1);
  const pageRows = sortedRows.slice(page * GENERIC_TABLE_PAGE_SIZE, page * GENERIC_TABLE_PAGE_SIZE + GENERIC_TABLE_PAGE_SIZE);

  const tableRows = pageRows.map((r) => {
    const flagged = opts.highlightRow ? opts.highlightRow(r) : false;
    return `<tr${flagged ? ' style="background:var(--red-bg);"' : ''}>${columns.map((c) => {
      const v = String(r[c] ?? '');
      return `<td class="tsheet-ellipsis" title="${esc(v)}">${esc(v)}</td>`;
    }).join('')}${flagged ? '<td><span class="badge b-red">No ad calls</span></td>' : (opts.highlightRow ? '<td></td>' : '')}</tr>`;
  }).join('');
  const tiles = (opts.sumFields || [])
    .filter(({ key }) => columns.includes(key))
    .map(({ key, label }) => statTile('ok', label, rows.reduce((s, r) => s + (Number(r[key]) || 0), 0).toLocaleString(undefined, { maximumFractionDigits: 2 })))
    .join('');
  const flaggedCount = opts.highlightRow ? rows.filter(opts.highlightRow).length : 0;
  return `
    <div class="bento-stats">${statTile('info', 'Rows', rows.length)}${flaggedCount ? statTile('alert', 'No Ad Calls', flaggedCount) : ''}${tiles}</div>
    <div class="card">
      <div class="card-head"><h3>${esc(title)}</h3><div class="desc">${esc(desc)}${totalPages > 1 ? ` - page ${page + 1} of ${totalPages}` : ''}</div></div>
      <div class="tsheet-wrap">
        <table class="zebra" style="${FIXED_TABLE_STYLE}"><thead><tr>${columns.map((c) => sortTh(title, c, c, c === flexCol ? undefined : widths[c])).join('')}${opts.highlightRow ? '<th style="width:14ch;"></th>' : ''}</tr></thead><tbody>${tableRows}</tbody></table>
      </div>
      ${totalPages > 1 ? `<div style="display:flex;justify-content:center;gap:10px;align-items:center;margin-top:10px;">
        <button class="btn-sm" ${page === 0 ? 'disabled' : ''} onclick="App.setGenericTablePage('${jsAttrSq(title)}',${page - 1})">Prev</button>
        <span class="small muted">Page ${page + 1} of ${totalPages} (${sortedRows.length} rows)</span>
        <button class="btn-sm" ${page >= totalPages - 1 ? 'disabled' : ''} onclick="App.setGenericTablePage('${jsAttrSq(title)}',${page + 1})">Next</button>
      </div>` : ''}
    </div>
  `;
}

// /last-playouts's Playout objects only carry ad_id, not a campaign name - this resolves it from
// whichever of Ads Stats/Programmatic Stats is already loaded (a_id -> c_name), rather than firing
// a live GET /ads/{id} per playout row. Only covers ads that happen to already be in loaded stats
// data, so a genuinely stale/rare ad may still show blank - that's noted in the table's own desc.
function adIdToCampaignMap() {
  const map = new Map();
  [STATE.reportingAdsStats, STATE.reportingDsps].forEach((raw) => {
    if (!raw) return;
    const rows = extractRows(raw);
    if (!rows.length) return;
    const fields = detectAllFields(rows);
    if (!fields.adId || !fields.campaign) return;
    rows.forEach((r) => {
      const id = r[fields.adId];
      if (id != null && !map.has(String(id))) map.set(String(id), String(r[fields.campaign] ?? ''));
    });
  });
  return map;
}

// /last-playouts returns { [placementId]: Playout[] } - flatten into rows with the placement ID
// attached, most recent first.
function renderLastPlayouts(data) {
  const placementIds = Object.keys(data || {});
  const rows = [];
  placementIds.forEach((pid) => {
    (data[pid] || []).forEach((p) => rows.push({ placement_id: pid, ...p }));
  });
  if (!rows.length) return '<div class="card"><div class="empty">No playouts found for these filters.</div></div>';
  rows.sort((a, b) => (b.playout_date || 0) - (a.playout_date || 0));
  const campaignByAd = adIdToCampaignMap();
  const columns = ['placement_id', 'campaign', 'playout_date', 'ad_id', 'creative_id', 'advertiser_id', 'impressions', 'impressions_ontarget', 'call_id', 'ip'];
  const tableRows = rows.slice(0, 200).map((r) => `<tr>${columns.map((c) => {
    const v = c === 'campaign' ? (campaignByAd.get(String(r.ad_id)) || '')
      : (c === 'playout_date' && r[c]) ? fmtDateTime(r[c] * 1000) : (r[c] ?? '');
    return `<td>${esc(String(v))}</td>`;
  }).join('')}</tr>`).join('');
  return `
    <div class="card">
      <div class="card-head"><h3>Last Playouts</h3><div class="desc">${rows.length} playout(s) across ${placementIds.length} placement(s)${rows.length > 200 ? ' (showing most recent 200)' : ''}. Campaign is resolved from Ads Stats/Programmatic Stats data already loaded this session - open one of those tabs first if it's showing blank.</div></div>
      <div class="tsheet-wrap">
        <table class="zebra"><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table>
      </div>
    </div>
  `;
}

// The API gives raw counts (playouts/available_playouts, impressions/available_impressions) but
// no single "how booked is this" number - Reserved % = 1 - available/total, computed here the same
// way the API's own per-site/per-day `reserved` ratios are described, just rolled up to an overall
// figure so the top of the page answers "is this inventory actually available" at a glance.
// A site/day is genuinely overbooked - not just "busy" - when more has been committed against it
// than its cycle-length capacity can physically deliver in that window: Reserved and Available are
// independent raw fields from AiOO (not complements of each other, so they don't have to sum to
// 100%), and the vendor's own forecast engine signals overbooking two ways - a Reserved ratio past
// 100%, or Available Playouts/Impressions going negative (how far into the negative it's been
// oversold). Either one alone is enough to flag it.
function isOverbooked(reserved, availPlayouts, availImpressions) {
  return (reserved != null && reserved > 1)
    || (availPlayouts != null && availPlayouts < 0)
    || (availImpressions != null && availImpressions < 0);
}

function renderAvails(data) {
  if (!data) return '<div class="card"><div class="empty">Pick one or more placements above (or enter an Ad ID) and click "Get Forecast".</div></div>';
  const pct = (n) => n == null ? '' : `${Math.round(n * 100)}%`;
  const playoutsReserved = data.playouts ? 1 - (data.available_playouts ?? 0) / data.playouts : null;
  const impressionsReserved = data.impressions ? 1 - (data.available_impressions ?? 0) / data.impressions : null;
  const timelineDates = Object.keys(data.timeline || {}).sort();
  const timelineRows = timelineDates.map((d) => {
    const t = data.timeline[d];
    const overbooked = isOverbooked(t.reserved, t.available_playouts, t.available_impressions);
    return `<tr${overbooked ? ' style="background:var(--red-bg);"' : ''}><td>${esc(d)}</td><td class="tright">${pct(t.reserved)}</td><td class="tright">${(t.available_playouts ?? 0).toLocaleString()}</td><td class="tright">${(t.available_impressions ?? 0).toLocaleString()}</td><td>${overbooked ? '<span class="badge b-red">Overbooked</span>' : ''}</td></tr>`;
  }).join('');
  const overbookedDays = timelineDates.filter((d) => {
    const t = data.timeline[d];
    return isOverbooked(t.reserved, t.available_playouts, t.available_impressions);
  }).length;
  const siteRows = (data.sites || []).map((s) => {
    const overbooked = isOverbooked(s.reserved, s.available_playouts, null);
    return `<tr${overbooked ? ' style="background:var(--red-bg);"' : ''}><td>${esc(s.name)}</td><td class="tright">${s.cycle_length ?? ''}</td><td class="tright">${pct(s.reserved)}</td><td class="tright">${pct(s.available)}</td><td class="tright">${(s.available_playouts ?? 0).toLocaleString()}</td><td>${overbooked ? '<span class="badge b-red">Overbooked</span>' : ''}</td></tr>`;
  }).join('');
  const overbookedSites = (data.sites || []).filter((s) => isOverbooked(s.reserved, s.available_playouts, null)).length;
  return `
    <div class="bento-stats">
      ${statTile('info', 'Sites', data.nb_sites ?? 0)}
      ${statTile('info', 'Placements', data.nb_placements ?? 0)}
      ${statTile('info', 'Forecast Days', data.days ?? 0)}
      ${playoutsReserved != null ? statTile(playoutsReserved > 0.85 ? 'alert' : 'info', 'Playouts Reserved', pct(playoutsReserved)) : ''}
      ${impressionsReserved != null ? statTile(impressionsReserved > 0.85 ? 'alert' : 'info', 'Impressions Reserved', pct(impressionsReserved)) : ''}
      ${statTile('info', 'Total Playouts', (data.playouts ?? 0).toLocaleString())}
      ${statTile('ok', 'Available Playouts', (data.available_playouts ?? 0).toLocaleString())}
      ${statTile('info', 'Total Impressions', (data.impressions ?? 0).toLocaleString())}
      ${statTile('ok', 'Available Impressions', (data.available_impressions ?? 0).toLocaleString())}
      ${overbookedSites ? statTile('alert', 'Overbooked Sites', overbookedSites) : ''}
      ${overbookedDays ? statTile('alert', 'Overbooked Days', overbookedDays) : ''}
    </div>
    <div class="card">
      <div class="card-head"><h3>Per-Site Availability</h3><div class="desc">Sorted by reserved ratio descending. A site is flagged Overbooked when Reserved is past 100% or Avail. Playouts has gone negative - more has been committed against it than its cycle-length capacity can actually deliver.</div></div>
      <div class="tsheet-wrap"><table class="zebra"><thead><tr><th>Site</th><th class="tright">Cycle Length</th><th class="tright">Reserved</th><th class="tright">Available</th><th class="tright">Avail. Playouts</th><th></th></tr></thead><tbody>${siteRows || '<tr><td colspan="6">No sites.</td></tr>'}</tbody></table></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Daily Timeline</h3></div>
      <div class="tsheet-wrap"><table class="zebra"><thead><tr><th>Date</th><th class="tright">Reserved</th><th class="tright">Avail. Playouts</th><th class="tright">Avail. Impressions</th><th></th></tr></thead><tbody>${timelineRows || '<tr><td colspan="5">No data.</td></tr>'}</tbody></table></div>
    </div>
  `;
}

export function renderReporting() {
  const cfg = loadData('reportingApi', () => getSetting('reportingApi'));
  if (cfg === null) return loadingCard();
  if (cfg?.__error) return loadingCard(cfg.__error);
  // Cached for downloadCampaignReport/downloadCampaignPptxReport to read synchronously (via
  // STATE.pageData.reportTemplate?.data) when the user clicks a download button - loaded here so
  // it's already warm by the time those buttons are visible.
  loadData('reportTemplate', () => getSetting('reportTemplate'));

  const configured = !!(cfg?.enabled && cfg?.clientId && cfg?.clientSecret);
  if (!configured) {
    return `<div class="card"><div class="empty">Reporting API isn't configured yet. Ask an admin to set the AiOO Reporting API Client ID/Secret under Settings &gt; Integrations.</div></div>`;
  }

  const tab = STATE.reportingTab || 'adsStats';
  ensureTabData(tab);

  const defaults = defaultDateRange();
  const startDate = STATE.reportingStartDate || defaults.start;
  const endDate = STATE.reportingEndDate || defaults.end;

  let content = '';
  const dtab = DATE_TABS[tab];

  if (dtab) {
    const loading = STATE[`${dtab.key}Loading`];
    const errorMsg = STATE[`${dtab.key}Error`];
    const raw = STATE[dtab.key];
    const rows = raw ? extractRows(raw) : [];
    content += `
      <div class="toolbar">
        <div class="toolbar-actions" style="align-items:flex-end;flex-wrap:wrap;">
          <div class="field" style="margin-bottom:0;"><label>Start Date</label><input type="date" id="reporting-start-date" value="${esc(startDate)}"></div>
          <div class="field" style="margin-bottom:0;"><label>End Date</label><input type="date" id="reporting-end-date" value="${esc(endDate)}"></div>
          <button class="btn btn-orange" type="button" ${loading ? 'disabled' : ''} onclick="App.applyReportingFilter()">${loading ? 'Loading...' : 'Apply Date Filter'}</button>
          ${raw ? `<button class="btn-outline btn-sm" type="button" onclick="App.downloadTabExcel()">Download Excel</button>` : ''}
        </div>
        <div class="desc" style="margin-top:6px;">Defaults to today only (partial, still growing) - a single day can already be 15k+ rows, so widen the range with care.</div>
      </div>
      ${errorMsg ? `<div class="login-error" style="margin-bottom:14px;">${esc(errorMsg)}</div>` : ''}
      ${tab === 'trafficSheet' && STATE.reportingDspsError ? `<div class="login-error" style="margin-bottom:14px;">Programmatic data: ${esc(STATE.reportingDspsError)}</div>` : ''}
    `;
    if (!raw) {
      content += loading ? '<div class="card"><div class="empty">Loading reporting data...</div></div>' : '';
    } else if (tab === 'adsStats') {
      content += renderOverview(rows, detectAllFields(rows));
    } else if (tab === 'trafficSheet') {
      const dspsRows = STATE.reportingDsps ? extractRows(STATE.reportingDsps) : [];
      content += renderAdditionalTrafficSheet(rows, dspsRows, startDate, endDate);
    } else if (tab === 'programmatic') {
      content += renderGenericTable('Programmatic Stats', `${rows.length} row(s) from GET /stats-dsps, ${startDate} to ${endDate}.`, rows, {
        sumFields: DSP_SUM_FIELDS,
        // avg_mulitiplier (the vendor API's own field name/typo) dropped from the on-screen table -
        // not wanted here, same call as the computed Avg Multiplier already removed from Traffic Data.
        excludeColumns: ['adv_id', 'adv_domain', 'c_id', 'c_name', 'a_id', 'a_name', 'd_id', 'd_name', 'avg_mulitiplier'],
      });
    } else if (tab === 'placementsStats') {
      content += renderGenericTable('Placements Stats', `${rows.length} row(s) from GET /stats-placements, ${startDate} to ${endDate}. Placements with zero ad calls are flagged.`, rows, {
        sumFields: [{ key: 'calls', label: 'Ad Calls' }],
        highlightRow: (r) => Number(r.calls) === 0,
      });
    }
  } else if (tab === 'lastPlayouts') {
    const loading = STATE.reportingLastPlayoutsLoading;
    const errorMsg = STATE.reportingLastPlayoutsError;
    content = `
      <div class="toolbar">
        <div class="toolbar-actions" style="align-items:flex-end;flex-wrap:wrap;">
          <div class="field" style="margin-bottom:0;"><label>Placement IDs</label><input id="lp-placement-ids" placeholder="e.g. 1,2,3" value="${esc(STATE.reportingLpPlacementIds || '')}"></div>
          <div class="field" style="margin-bottom:0;"><label>Site ID</label><input id="lp-site-id" placeholder="optional" value="${esc(STATE.reportingLpSiteId || '')}"></div>
          <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;"><input type="checkbox" id="lp-retailers" ${STATE.reportingLpRetailers ? 'checked' : ''}> Retail media only</label>
          <button class="btn btn-orange" type="button" ${loading ? 'disabled' : ''} onclick="App.applyLastPlayoutsFilter()">${loading ? 'Loading...' : 'Apply'}</button>
          ${STATE.reportingLastPlayouts ? `<button class="btn-outline btn-sm" type="button" onclick="App.downloadTabExcel()">Download Excel</button>` : ''}
        </div>
        <div class="desc" style="margin-top:6px;">Leave filters blank to see the latest playout across every screen.</div>
      </div>
      ${errorMsg ? `<div class="login-error" style="margin-bottom:14px;">${esc(errorMsg)}</div>` : ''}
      ${!STATE.reportingLastPlayouts ? (loading ? '<div class="card"><div class="empty">Loading...</div></div>' : '') : renderLastPlayouts(STATE.reportingLastPlayouts)}
    `;
  } else if (tab === 'avails') {
    const loading = STATE.reportingAvailsLoading;
    const errorMsg = STATE.reportingAvailsError;
    const allOptions = availsPlacementOptions();
    const pickedIds = new Set((STATE.reportingAvailsPlacementIds || []).map(String));
    const selectedOptions = allOptions.filter((o) => pickedIds.has(String(o.id)));
    const locationGroups = availsLocationGroups(allOptions);
    const selectedLocation = STATE.reportingAvailsLocation || '';
    const locationOptions = selectedLocation ? allOptions.filter((o) => (o.site || '(No site)') === selectedLocation) : [];
    // Always available, not just past some count threshold - some vendor placement names use
    // ambiguous/inconsistent numbering (confirmed live: Dalma Mall has both "...MPI-1A (11A)..."
    // and plain "...MPI-9A" naming, where which number is authoritative for sort purposes is
    // genuinely unclear) - filtering straight to what you're looking for by typing it is a more
    // reliable way to find an asset than counting on any general sort to read as "correct" for
    // every naming convention this vendor's data happens to use.
    const assetSearch = (STATE.reportingAvailsAssetSearch || '').trim().toLowerCase();
    const matchedAssets = assetSearch
      ? locationOptions.filter((o) => o.placement.toLowerCase().includes(assetSearch))
      : locationOptions;
    content = `
      <div class="toolbar">
        <div style="width:100%;">
        ${allOptions.length ? `
          <div class="field" style="max-width:420px;">
            <label>Location (${locationGroups.length} available)</label>
            <select id="avails-location-select" onchange="App.setAvailsLocation(this.value)" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:8px;">
              <option value="">Select a location...</option>
              ${locationGroups.map((g) => `<option value="${esc(g.site)}" ${selectedLocation === g.site ? 'selected' : ''}>${esc(g.site)} (${g.count})</option>`).join('')}
            </select>
          </div>
          ${selectedOptions.length ? `
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0;">
              ${selectedOptions.map((o) => `
                <span class="badge b-blue" style="cursor:pointer;" onclick="App.toggleAvailsPlacement('${jsAttrSq(String(o.id))}')" title="Click to remove">
                  ${esc(o.site)}${o.site && o.placement ? ' - ' : ''}${esc(o.placement)} &times;
                </span>
              `).join('')}
            </div>
          ` : ''}
          ${selectedLocation ? `
            <div class="field" style="margin-top:10px;max-width:420px;">
              <label>Assets at ${esc(selectedLocation)} (${locationOptions.length})</label>
              <input id="avails-asset-search" placeholder="Filter assets at this location..." value="${esc(STATE.reportingAvailsAssetSearch || '')}" oninput="App.setAvailsAssetSearch(this.value)" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
              <div style="max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;border:1px solid var(--border);border-radius:8px;padding:8px;">
                ${matchedAssets.length ? matchedAssets.map((o) => `
                  <label style="display:flex;align-items:center;gap:8px;font-weight:normal;">
                    <input type="checkbox" style="width:auto;" onchange="App.toggleAvailsPlacement('${jsAttrSq(String(o.id))}')" ${pickedIds.has(String(o.id)) ? 'checked' : ''}>
                    ${esc(o.placement)}
                  </label>
                `).join('') : `<div class="empty">No assets at this location match that filter.</div>`}
              </div>
            </div>
          ` : `<div class="desc" style="margin-top:10px;">Pick a location above to see its assets, or use an Ad ID/manual Placement IDs below.</div>`}
        ` : `<div class="desc">No placements loaded to pick from yet - open Ads Stats or Placements Stats first, or enter Placement IDs manually below.</div>`}
        </div>
        <div class="toolbar-actions" style="align-items:flex-end;flex-wrap:wrap;margin-top:10px;">
          <div class="field" style="margin-bottom:0;"><label>Placement IDs (manual, optional)</label><input id="avails-placement-ids-manual" placeholder="e.g. 123,124"></div>
          <div class="field" style="margin-bottom:0;"><label>or Ad ID</label><input id="avails-ad-id" placeholder="e.g. 1791994057"></div>
          <div class="field" style="margin-bottom:0;"><label>Start (optional)</label><input type="date" id="avails-start"></div>
          <div class="field" style="margin-bottom:0;"><label>End (optional, exclusive)</label><input type="date" id="avails-end"></div>
          <button class="btn btn-orange" type="button" ${loading ? 'disabled' : ''} onclick="App.applyAvailsFilter()">${loading ? 'Loading...' : 'Get Forecast'}</button>
          ${STATE.reportingAvails ? `<button class="btn-outline btn-sm" type="button" onclick="App.downloadTabExcel()">Download Excel</button>` : ''}
        </div>
        <div class="desc" style="margin-top:6px;">Pick a location, then its asset(s) above, or an Ad ID/manual Placement IDs. End date is exclusive (must be after Start) - leave both blank for today through today + 7 days. Selecting a very large number of placements may cause the forecast to fail silently on the vendor's side - narrow it down if nothing comes back.</div>
      </div>
      ${errorMsg ? `<div class="login-error" style="margin-bottom:14px;">${esc(errorMsg)}</div>` : ''}
      ${renderAvails(STATE.reportingAvails)}
    `;
  } else if (tab === 'statusReport') {
    const loading = STATE.reportingStatusReportLoading;
    const errorMsg = STATE.reportingStatusReportError;
    const rows = STATE.reportingStatusReport ? extractRows(STATE.reportingStatusReport) : [];
    content = `
      <div class="toolbar">
        <div class="toolbar-actions">
          <button class="btn btn-orange" type="button" ${loading ? 'disabled' : ''} onclick="App.loadStatusReport()">${loading ? 'Loading...' : (STATE.reportingStatusReport ? 'Reload Report' : 'Load Report')}</button>
          ${STATE.reportingStatusReport ? `<button class="btn-outline btn-sm" type="button" onclick="App.downloadTabExcel()">Download Excel</button>` : ''}
        </div>
      </div>
      ${errorMsg ? `<div class="login-error" style="margin-bottom:14px;">${esc(errorMsg)}</div>` : ''}
      ${!STATE.reportingStatusReport
        ? (loading ? '<div class="card"><div class="empty">Loading...</div></div>' : '<div class="card"><div class="empty">Click "Load Report" to fetch the current placements status snapshot.</div></div>')
        : renderGenericTable('Placements Status Report', 'Full placement status snapshot from GET /placements-status-report.', rows)}
    `;
  }

  return `
    ${renderTabs(REPORTING_TABS, tab, 'App.setReportingTab')}
    ${content}
  `;
}
