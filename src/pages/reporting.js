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

const REPORTING_TABS = [
  { key: 'adsStats', label: 'Ads Stats' },
  { key: 'trafficSheet', label: 'Additional Traffic Sheet' },
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
function ensureTabData(tab) {
  const defaults = defaultDateRange();
  const start = STATE.reportingStartDate || defaults.start;
  const end = STATE.reportingEndDate || defaults.end;
  const dtab = DATE_TABS[tab];
  if (dtab && !STATE[dtab.key] && !STATE[`${dtab.key}Loading`] && !STATE[`${dtab.key}Started`]) {
    STATE[`${dtab.key}Started`] = true;
    queueMicrotask(() => loadDateRangeTab(dtab.key, dtab.endpoint, start, end));
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
  await loadDateRangeTab(dtab.key, dtab.endpoint, start, end);
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

export async function applyAvailsFilter() {
  const placementIdsEl = document.getElementById('avails-placement-ids');
  const adIdEl = document.getElementById('avails-ad-id');
  const startEl = document.getElementById('avails-start');
  const endEl = document.getElementById('avails-end');
  const placementIds = placementIdsEl?.value.trim();
  const adId = adIdEl?.value.trim();
  if (!placementIds && !adId) { toast('Enter Placement IDs or an Ad ID', 'error'); return; }
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
  creative: ['cr_name', 'creative', 'creative_name'],
  site: ['s_name', 'site', 'site_name'],
  placement: ['p_name', 'placement', 'placement_name'],
  playouts: ['playouts'],
  impressions: ['impressions', 'plays', 'count'],
  impressionsOntarget: ['impressions_ontarget'],
  revenue: ['revenue'],
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

function statTile(variant, label, value) {
  return `<div class="bento-stat ${variant}"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(String(value))}</div></div>`;
}

function renderOverview(rows, fields) {
  if (!rows.length) return '<div class="card"><div class="empty">No data for this date range.</div></div>';

  const distinctCount = (field) => fields[field] ? new Set(rows.map((r) => r[fields[field]])).size : null;
  const sumField = (field) => fields[field] ? rows.reduce((s, r) => s + (Number(r[fields[field]]) || 0), 0) : null;
  const campaignCount = distinctCount('campaign');
  const siteCount = distinctCount('site');
  const advertiserCount = distinctCount('advertiser');
  const totalImpressions = sumField('impressions');
  const totalPlayouts = sumField('playouts');
  const totalRevenue = sumField('revenue');

  const columns = Object.keys(rows[0]);
  const tableRows = rows.slice(0, 200).map((r) => `<tr>${columns.map((c) => `<td>${esc(String(r[c] ?? ''))}</td>`).join('')}</tr>`).join('');

  return `
    <div class="bento-stats">
      ${statTile('info', 'Rows', rows.length)}
      ${campaignCount != null ? statTile('info', 'Campaigns', campaignCount) : ''}
      ${siteCount != null ? statTile('info', 'Sites', siteCount) : ''}
      ${advertiserCount != null ? statTile('info', 'Advertisers', advertiserCount) : ''}
      ${totalImpressions != null ? statTile('ok', 'Total Impressions', totalImpressions.toLocaleString()) : ''}
      ${totalPlayouts != null ? statTile('ok', 'Total Playouts', totalPlayouts.toLocaleString()) : ''}
      ${totalRevenue != null ? statTile('info', 'Total Revenue', totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 2 })) : ''}
    </div>
    <div class="card">
      <div class="card-head"><h3>Ads Stats</h3><div class="desc">${rows.length} row(s)${rows.length > 200 ? ' (showing first 200)' : ''} from GET /stats-ads. Columns shown exactly as returned by the API.</div></div>
      <div class="tsheet-wrap">
        <table><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table>
      </div>
    </div>
  `;
}

// "Additional Traffic Sheet" - the same stats-ads rows, pivoted into a day-by-day grid per
// campaign (one column per date in range, cell = that day's impression/play count), matching the
// visual convention of the app's other Traffic Sheet page even though the underlying API/data
// shape is completely different.
function renderAdditionalTrafficSheet(rows, fields, start, end) {
  if (!rows.length) return '<div class="card"><div class="empty">No data for this date range.</div></div>';
  if (!fields.campaign || !fields.date) {
    return `<div class="card"><div class="empty">Can't build a day-grid without a recognizable campaign and date column in the response - see the Ads Stats tab for the raw columns actually returned.</div></div>`;
  }

  const dates = [];
  for (let d = new Date(start); d <= new Date(end); d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }

  const byCampaign = new Map();
  rows.forEach((r) => {
    const campaign = String(r[fields.campaign] ?? '(Unknown Campaign)');
    const date = String(r[fields.date] ?? '').slice(0, 10);
    const value = fields.impressions ? Number(r[fields.impressions]) || 0 : 1;
    if (!byCampaign.has(campaign)) byCampaign.set(campaign, new Map());
    const dayMap = byCampaign.get(campaign);
    dayMap.set(date, (dayMap.get(date) || 0) + value);
  });

  const campaigns = [...byCampaign.keys()].sort();
  const bodyRows = campaigns.map((campaign) => {
    const dayMap = byCampaign.get(campaign);
    const total = [...dayMap.values()].reduce((s, n) => s + n, 0);
    return `<tr>
      <td>${esc(campaign)}</td>
      <td class="tright">${total.toLocaleString()}</td>
      ${dates.map((d) => {
        const v = dayMap.get(d);
        return `<td class="tsheet-cell${v ? ' tsheet-active' : ''}">${v ? v.toLocaleString() : ''}</td>`;
      }).join('')}
    </tr>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-head"><h3>Additional Traffic Sheet</h3><div class="desc">${campaigns.length} campaign(s), day-by-day${fields.impressions ? ' (value = ' + fields.impressions + ')' : ' (value = row count)'} from ${esc(start)} to ${esc(end)}.</div></div>
      <div class="tsheet-wrap">
        <table class="tsheet-table">
          <thead><tr><th>Campaign</th><th class="tright">Total</th>${dates.map((d) => `<th class="tsheet-day">${esc(d.slice(8, 10))}</th>`).join('')}</tr></thead>
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

function renderAvails(data) {
  if (!data) return '<div class="card"><div class="empty">Enter Placement IDs or an Ad ID above and click "Get Forecast".</div></div>';
  const pct = (n) => n == null ? '' : `${Math.round(n * 100)}%`;
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
      ${statTile('info', 'Days', data.days ?? 0)}
      ${statTile('ok', 'Total Playouts', (data.playouts ?? 0).toLocaleString())}
      ${statTile('ok', 'Available Playouts', (data.available_playouts ?? 0).toLocaleString())}
      ${statTile('info', 'Total Impressions', (data.impressions ?? 0).toLocaleString())}
      ${statTile('info', 'Available Impressions', (data.available_impressions ?? 0).toLocaleString())}
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
    `;
    if (!raw) {
      content += loading ? '<div class="card"><div class="empty">Loading reporting data...</div></div>' : '';
    } else if (tab === 'adsStats') {
      content += renderOverview(rows, detectAllFields(rows));
    } else if (tab === 'trafficSheet') {
      content += renderAdditionalTrafficSheet(rows, detectAllFields(rows), startDate, endDate);
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
    content = `
      <div class="toolbar">
        <div class="toolbar-actions" style="align-items:flex-end;flex-wrap:wrap;">
          <div class="field" style="margin-bottom:0;"><label>Placement IDs</label><input id="avails-placement-ids" placeholder="e.g. 123,124"></div>
          <div class="field" style="margin-bottom:0;"><label>or Ad ID</label><input id="avails-ad-id" placeholder="e.g. 1791994057"></div>
          <div class="field" style="margin-bottom:0;"><label>Start (optional)</label><input type="date" id="avails-start"></div>
          <div class="field" style="margin-bottom:0;"><label>End (optional)</label><input type="date" id="avails-end"></div>
          <button class="btn btn-orange" type="button" ${loading ? 'disabled' : ''} onclick="App.applyAvailsFilter()">${loading ? 'Loading...' : 'Get Forecast'}</button>
        </div>
        <div class="desc" style="margin-top:6px;">Provide Placement IDs or an Ad ID. Dates default to today through today + 7 days.</div>
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
