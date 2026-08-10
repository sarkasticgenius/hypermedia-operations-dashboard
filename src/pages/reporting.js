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
// One day of /stats-ads alone can be 15k+ rows, so date-range tabs default to yesterday only
// (not the API's own 30-day default) to keep the initial load fast - a 30-day pull that size
// risks the edge function or browser choking on the response, which is what silently produced an
// empty Reporting page even after the API connection itself was confirmed working.
import { STATE, setState, loadData, toast } from '../state.js';
import { loadingCard } from '../modals.js';
import { supabase } from '../supabaseClient.js';
import { getSetting } from '../data/settings.js';
import { renderTabs } from '../lib/tabs.js';
import { esc } from '../lib/format.js';
import { exportReportingCampaignExcel } from '../lib/excelExport.js';
import { exportCampaignPptxReport } from '../lib/pptxReport.js';

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
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterday = d.toISOString().slice(0, 10);
  return { start: yesterday, end: yesterday };
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
    seen.set(pid, { id: pid, placement: String(r[fields.placement] ?? ''), site: fields.site ? String(r[fields.site] ?? '') : '' });
  });
  return [...seen.values()].sort((a, b) => a.site.localeCompare(b.site) || a.placement.localeCompare(b.placement));
}

export function toggleAvailsPlacement(id) {
  const current = new Set((STATE.reportingAvailsPlacementIds || []).map(String));
  const key = String(id);
  if (current.has(key)) current.delete(key); else current.add(key);
  setState({ reportingAvailsPlacementIds: [...current] });
}

export async function applyAvailsFilter() {
  const manualIdsEl = document.getElementById('avails-placement-ids-manual');
  const adIdEl = document.getElementById('avails-ad-id');
  const startEl = document.getElementById('avails-start');
  const endEl = document.getElementById('avails-end');
  const pickedIds = STATE.reportingAvailsPlacementIds || [];
  const manualIds = (manualIdsEl?.value.trim() || '').split(',').map((s) => s.trim()).filter(Boolean);
  const placementIds = [...new Set([...pickedIds.map(String), ...manualIds])].join(',');
  const adId = adIdEl?.value.trim();
  if (!placementIds && !adId) { toast('Pick at least one placement above, or enter Placement IDs/an Ad ID manually', 'error'); return; }
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
  const colLabel = (c) => (c === 'playouts' ? 'Loop Playouts' : c === 'impressions' ? 'Impressions' : c);
  const body = rows.map((r) => `<tr><td>${esc(r.key)}</td>${cols.map((c) => `<td class="tright">${(r[c] ?? 0).toLocaleString()}</td>`).join('')}</tr>`).join('');
  return `<div class="card">
    <div class="card-head"><h3>${esc(title)}</h3>${desc ? `<div class="desc">${esc(desc)}</div>` : ''}</div>
    <div class="tsheet-wrap"><table><thead><tr><th>${esc(keyLabel)}</th>${cols.map((c) => `<th class="tright">${esc(colLabel(c))}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>
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
    return `${heroTiles}<div class="card"><div class="card-head"><h3>Ads Stats</h3><div class="desc">${rows.length} row(s)${rows.length > 200 ? ' (showing first 200)' : ''} - no Campaign column detected, showing raw rows.</div></div><div class="tsheet-wrap"><table><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table></div></div>`;
  }

  const campaigns = campaignSummaries(rows, fields);
  const bodyRows = campaigns.map((c) => `
    <tr style="cursor:pointer;" onclick="App.setReportCampaign('${esc(c.name)}')">
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
        <table>
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
      <td><span class="badge ${a.demand_type === 'programmatic' ? 'b-amber' : 'b-blue'}">${a.demand_type === 'programmatic' ? 'Programmatic' : 'Direct'}</span></td>
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
        <div class="card-head"><h3>Delivery Type &amp; Line Items</h3><div class="desc">${adsLoading ? 'Loading...' : `Direct: ${directCount}, Programmatic: ${programmaticCount}. "Loop Playouts" only applies to loop/cycle-paced line items.`}</div></div>
        ${adsLoading ? '' : `<div class="tsheet-wrap"><table><thead><tr><th>Ad (Line Item)</th><th>Type</th><th>Volume Type</th><th class="tright">Loop Playouts</th></tr></thead><tbody>${lineItemRows}</tbody></table></div>`}
      </div>
    ` : ''}
    <div class="card">
      <div class="card-head"><h3>Screen Breakdown</h3><div class="desc">${screenRows.length} screen(s), Direct delivery only, for this campaign in the current date range.</div></div>
      <div class="tsheet-wrap">
        <table>
          <thead><tr><th>Site</th><th>Placement</th>${fields.playouts ? '<th class="tright">Loop Playouts</th>' : ''}${fields.impressions ? '<th class="tright">Impressions</th>' : ''}</tr></thead>
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

// "Additional Traffic Sheet" - merges Direct (/stats-ads) and Programmatic (/stats-dsps) rows into
// one day-by-day grid per campaign, each tagged with a Type badge - previously this only ever
// pivoted stats-ads, so any programmatic campaign was silently absent from the calendar with no
// indication it was missing. Each day cell shows Playouts and Impressions (previously just one
// number, defaulting to a meaningless row count whenever the impressions column wasn't detected).
// "Avg Multiplier" (Impressions / Playouts) is the closest concept the API exposes to a per-loop
// multiplier - stats-dsps documents this exact ratio as `avg_mulitiplier`; computed the same way
// here for Direct campaigns too, for a consistent column across both types.
function renderAdditionalTrafficSheet(directRows, dspsRows, start, end) {
  const directFields = directRows.length ? detectAllFields(directRows) : {};
  const dspsFields = dspsRows.length ? detectAllFields(dspsRows) : {};
  if (!directRows.length && !dspsRows.length) return '<div class="card"><div class="empty">No data for this date range.</div></div>';
  if ((!directFields.campaign || !directFields.date) && (!dspsFields.campaign || !dspsFields.date)) {
    return `<div class="card"><div class="empty">Can't build a day-grid without a recognizable campaign and date column in the response.</div></div>`;
  }

  const dates = [];
  for (let d = new Date(start); d <= new Date(end); d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }

  const byCampaign = new Map();
  function ingest(rows, fields, type) {
    if (!fields.campaign || !fields.date) return;
    rows.forEach((r) => {
      const campaign = String(r[fields.campaign] ?? '(Unknown Campaign)');
      const date = String(r[fields.date] ?? '').slice(0, 10);
      const playouts = fields.playouts ? Number(r[fields.playouts]) || 0 : 0;
      const impressions = fields.impressions ? Number(r[fields.impressions]) || 0 : 0;
      const key = `${type}::${campaign}`;
      if (!byCampaign.has(key)) byCampaign.set(key, { campaign, type, dayMap: new Map() });
      const entry = byCampaign.get(key);
      const day = entry.dayMap.get(date) || { playouts: 0, impressions: 0 };
      day.playouts += playouts;
      day.impressions += impressions;
      entry.dayMap.set(date, day);
    });
  }
  ingest(directRows, directFields, 'Direct');
  ingest(dspsRows, dspsFields, 'Programmatic');

  const campaigns = [...byCampaign.values()].sort((a, b) => a.campaign.localeCompare(b.campaign) || a.type.localeCompare(b.type));
  const bodyRows = campaigns.map((c) => {
    let totalPlayouts = 0;
    let totalImpressions = 0;
    c.dayMap.forEach((d) => { totalPlayouts += d.playouts; totalImpressions += d.impressions; });
    const avgMultiplier = totalPlayouts ? totalImpressions / totalPlayouts : null;
    return `<tr>
      <td>${esc(c.campaign)}</td>
      <td><span class="badge ${c.type === 'Programmatic' ? 'b-amber' : 'b-blue'}">${c.type}</span></td>
      <td class="tright">${totalPlayouts.toLocaleString()}</td>
      <td class="tright">${totalImpressions.toLocaleString()}</td>
      <td class="tright">${avgMultiplier != null ? `${avgMultiplier.toFixed(1)}x` : ''}</td>
      ${dates.map((d) => {
        const day = c.dayMap.get(d);
        return `<td class="tsheet-cell${day ? ' tsheet-active' : ''}">${day ? `${day.playouts.toLocaleString()}<br><span class="small muted">${day.impressions.toLocaleString()}</span>` : ''}</td>`;
      }).join('')}
    </tr>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-head"><h3>Traffic Data</h3><div class="desc">${campaigns.length} campaign(s) (Direct + Programmatic combined), day-by-day. Each day cell shows Playouts on top and Impressions below. "Avg Multiplier" = Impressions &divide; Playouts. From ${esc(start)} to ${esc(end)}.</div></div>
      <div class="tsheet-wrap">
        <table class="tsheet-table">
          <thead><tr><th>Campaign</th><th>Type</th><th class="tright">Playouts</th><th class="tright">Impressions</th><th class="tright">Avg Multiplier</th>${dates.map((d) => `<th class="tsheet-day">${esc(d.slice(8, 10))}</th>`).join('')}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

// Shared renderer for the two other date-range stats endpoints (Programmatic/Placements) and the
// Status Report - dynamic columns exactly as returned, plus optional totals for known numeric
// fields.
function renderGenericTable(title, desc, rows, opts = {}) {
  if (!rows || !rows.length) return '<div class="card"><div class="empty">No data.</div></div>';
  const columns = Object.keys(rows[0]);
  const tableRows = rows.slice(0, 200).map((r) => `<tr>${columns.map((c) => `<td>${esc(String(r[c] ?? ''))}</td>`).join('')}</tr>`).join('');
  const tiles = (opts.sumFields || [])
    .filter(({ key }) => columns.includes(key))
    .map(({ key, label }) => statTile('ok', label, rows.reduce((s, r) => s + (Number(r[key]) || 0), 0).toLocaleString(undefined, { maximumFractionDigits: 2 })))
    .join('');
  return `
    <div class="bento-stats">${statTile('info', 'Rows', rows.length)}${tiles}</div>
    <div class="card">
      <div class="card-head"><h3>${esc(title)}</h3><div class="desc">${esc(desc)}${rows.length > 200 ? ' (showing first 200)' : ''}</div></div>
      <div class="tsheet-wrap">
        <table><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table>
      </div>
    </div>
  `;
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
  const columns = ['placement_id', 'playout_date', 'ad_id', 'creative_id', 'advertiser_id', 'impressions', 'impressions_ontarget', 'call_id', 'ip'];
  const tableRows = rows.slice(0, 200).map((r) => `<tr>${columns.map((c) => {
    const v = (c === 'playout_date' && r[c]) ? new Date(r[c] * 1000).toLocaleString() : (r[c] ?? '');
    return `<td>${esc(String(v))}</td>`;
  }).join('')}</tr>`).join('');
  return `
    <div class="card">
      <div class="card-head"><h3>Last Playouts</h3><div class="desc">${rows.length} playout(s) across ${placementIds.length} placement(s)${rows.length > 200 ? ' (showing most recent 200)' : ''}.</div></div>
      <div class="tsheet-wrap">
        <table><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table>
      </div>
    </div>
  `;
}

// The API gives raw counts (playouts/available_playouts, impressions/available_impressions) but
// no single "how booked is this" number - Reserved % = 1 - available/total, computed here the same
// way the API's own per-site/per-day `reserved` ratios are described, just rolled up to an overall
// figure so the top of the page answers "is this inventory actually available" at a glance.
function renderAvails(data) {
  if (!data) return '<div class="card"><div class="empty">Pick one or more placements above (or enter an Ad ID) and click "Get Forecast".</div></div>';
  const pct = (n) => n == null ? '' : `${Math.round(n * 100)}%`;
  const playoutsReserved = data.playouts ? 1 - (data.available_playouts ?? 0) / data.playouts : null;
  const impressionsReserved = data.impressions ? 1 - (data.available_impressions ?? 0) / data.impressions : null;
  const timelineDates = Object.keys(data.timeline || {}).sort();
  const timelineRows = timelineDates.map((d) => {
    const t = data.timeline[d];
    return `<tr><td>${esc(d)}</td><td class="tright">${pct(t.reserved)}</td><td class="tright">${(t.available_playouts ?? 0).toLocaleString()}</td><td class="tright">${(t.available_impressions ?? 0).toLocaleString()}</td></tr>`;
  }).join('');
  const siteRows = (data.sites || []).map((s) => `<tr><td>${esc(s.name)}</td><td class="tright">${s.cycle_length ?? ''}</td><td class="tright">${pct(s.reserved)}</td><td class="tright">${pct(s.available)}</td><td class="tright">${(s.available_playouts ?? 0).toLocaleString()}</td></tr>`).join('');
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
    </div>
    <div class="card">
      <div class="card-head"><h3>Per-Site Availability</h3><div class="desc">Sorted by reserved ratio descending.</div></div>
      <div class="tsheet-wrap"><table><thead><tr><th>Site</th><th class="tright">Cycle Length</th><th class="tright">Reserved</th><th class="tright">Available</th><th class="tright">Avail. Playouts</th></tr></thead><tbody>${siteRows || '<tr><td colspan="5">No sites.</td></tr>'}</tbody></table></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Daily Timeline</h3></div>
      <div class="tsheet-wrap"><table><thead><tr><th>Date</th><th class="tright">Reserved</th><th class="tright">Avail. Playouts</th><th class="tright">Avail. Impressions</th></tr></thead><tbody>${timelineRows || '<tr><td colspan="4">No data.</td></tr>'}</tbody></table></div>
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
        </div>
        <div class="desc" style="margin-top:6px;">Defaults to yesterday only - a single day can already be 15k+ rows, so widen the range with care.</div>
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
      content += renderGenericTable('Programmatic Stats', `${rows.length} row(s) from GET /stats-dsps, ${startDate} to ${endDate}.`, rows, { sumFields: DSP_SUM_FIELDS });
    } else if (tab === 'placementsStats') {
      content += renderGenericTable('Placements Stats', `${rows.length} row(s) from GET /stats-placements, ${startDate} to ${endDate}.`, rows, { sumFields: [{ key: 'calls', label: 'Ad Calls' }] });
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
        </div>
        <div class="desc" style="margin-top:6px;">Leave filters blank to see the latest playout across every screen.</div>
      </div>
      ${errorMsg ? `<div class="login-error" style="margin-bottom:14px;">${esc(errorMsg)}</div>` : ''}
      ${!STATE.reportingLastPlayouts ? (loading ? '<div class="card"><div class="empty">Loading...</div></div>' : '') : renderLastPlayouts(STATE.reportingLastPlayouts)}
    `;
  } else if (tab === 'avails') {
    const loading = STATE.reportingAvailsLoading;
    const errorMsg = STATE.reportingAvailsError;
    const options = availsPlacementOptions();
    const pickedIds = new Set((STATE.reportingAvailsPlacementIds || []).map(String));
    content = `
      <div class="toolbar">
        ${options.length ? `
          <div class="field"><label>Pick placement(s) from loaded data (${options.length} available)</label>
            <div style="max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;border:1px solid var(--border);border-radius:8px;padding:8px;">
              ${options.map((o) => `
                <label style="display:flex;align-items:center;gap:8px;font-weight:normal;">
                  <input type="checkbox" onchange="App.toggleAvailsPlacement('${esc(String(o.id))}')" ${pickedIds.has(String(o.id)) ? 'checked' : ''}>
                  ${esc(o.site)}${o.site && o.placement ? ' - ' : ''}${esc(o.placement)}
                </label>
              `).join('')}
            </div>
          </div>
        ` : `<div class="desc">No placements loaded to pick from yet - open Ads Stats or Placements Stats first, or enter Placement IDs manually below.</div>`}
        <div class="toolbar-actions" style="align-items:flex-end;flex-wrap:wrap;margin-top:10px;">
          <div class="field" style="margin-bottom:0;"><label>Placement IDs (manual, optional)</label><input id="avails-placement-ids-manual" placeholder="e.g. 123,124"></div>
          <div class="field" style="margin-bottom:0;"><label>or Ad ID</label><input id="avails-ad-id" placeholder="e.g. 1791994057"></div>
          <div class="field" style="margin-bottom:0;"><label>Start (optional)</label><input type="date" id="avails-start"></div>
          <div class="field" style="margin-bottom:0;"><label>End (optional, exclusive)</label><input type="date" id="avails-end"></div>
          <button class="btn btn-orange" type="button" ${loading ? 'disabled' : ''} onclick="App.applyAvailsFilter()">${loading ? 'Loading...' : 'Get Forecast'}</button>
        </div>
        <div class="desc" style="margin-top:6px;">Pick placements above, or an Ad ID/manual Placement IDs. End date is exclusive (must be after Start) - leave both blank for today through today + 7 days.</div>
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
