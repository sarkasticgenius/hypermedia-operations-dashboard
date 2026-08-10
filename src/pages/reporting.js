// Reporting workspace - live data from the AiOO Reporting API (ads.aiootech.com), a completely
// separate system from the AdLive Center Traffic Sheet API this app already integrates with (see
// trafficSheet.js). Nothing here is synced into a table, same "live proxy, nothing persisted"
// shape as Traffic Sheet - see supabase/functions/aioo-reporting-proxy.
//
// IMPORTANT caveat: the API's own docs (https://ads.aiootech.com/docs/api#tag/Reporting) show no
// response sample for GET /stats-ads's JSON format - only that it's "broken down by advertiser,
// campaign, ad, creative, site and placement". Column detection below is therefore defensive: it
// inspects whatever keys the real response actually has (trying a few likely names per logical
// field - date/day, campaign/campaign_name, etc.) rather than assuming an exact shape, and always
// shows the raw response as a fallback so a mismatch is visible/debuggable rather than silently
// blank. Expect to adjust FIELD_CANDIDATES once real data has been seen.
import { STATE, setState, loadData } from '../state.js';
import { loadingCard } from '../modals.js';
import { supabase } from '../supabaseClient.js';
import { getSetting } from '../data/settings.js';
import { renderTabs } from '../lib/tabs.js';
import { esc } from '../lib/format.js';

const REPORTING_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'trafficSheet', label: 'Additional Traffic Sheet' },
];

function defaultDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 29);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

async function fetchReportingStats(endpoint, start, end) {
  const { data, error } = await supabase.functions.invoke('aioo-reporting-proxy', { body: { endpoint, start, end } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export function setReportingTab(tab) { setState({ reportingTab: tab }); }
export function setReportingStartDate(v) { setState({ reportingStartDate: v }); }
export function setReportingEndDate(v) { setState({ reportingEndDate: v }); }

export async function applyReportingFilter() {
  const startEl = document.getElementById('reporting-start-date');
  const endEl = document.getElementById('reporting-end-date');
  const start = startEl?.value || defaultDateRange().start;
  const end = endEl?.value || defaultDateRange().end;
  setState({ reportingStartDate: start, reportingEndDate: end, reportingLoading: true, reportingError: null });
  try {
    const data = await fetchReportingStats('/stats-ads', start, end);
    setState({ reportingData: data, reportingLoading: false });
  } catch (e) {
    setState({ reportingLoading: false, reportingError: e.message || 'Failed to load reporting data' });
  }
}

// Normalizes whatever the API actually returns (an array of rows, or {rows:[...]}/{data:[...]})
// into a plain row array - the documented response has no sample, so this stays lenient rather
// than assuming one exact wrapper shape.
function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

// Tries a short list of likely key names per logical field, case-insensitively, against whatever
// keys a real row actually has - see file header caveat.
const FIELD_CANDIDATES = {
  date: ['date', 'day', 'stat_date', 'created'],
  advertiser: ['advertiser', 'advertiser_name'],
  campaign: ['campaign', 'campaign_name'],
  ad: ['ad', 'ad_name'],
  creative: ['creative', 'creative_name'],
  site: ['site', 'site_name'],
  placement: ['placement', 'placement_name'],
  impressions: ['impressions', 'plays', 'playouts', 'count'],
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
  const campaignCount = distinctCount('campaign');
  const siteCount = distinctCount('site');
  const advertiserCount = distinctCount('advertiser');
  const totalImpressions = fields.impressions ? rows.reduce((s, r) => s + (Number(r[fields.impressions]) || 0), 0) : null;

  const columns = Object.keys(rows[0]);
  const tableRows = rows.slice(0, 200).map((r) => `<tr>${columns.map((c) => `<td>${esc(String(r[c] ?? ''))}</td>`).join('')}</tr>`).join('');

  return `
    <div class="bento-stats">
      ${statTile('info', 'Rows', rows.length)}
      ${campaignCount != null ? statTile('info', 'Campaigns', campaignCount) : ''}
      ${siteCount != null ? statTile('info', 'Sites', siteCount) : ''}
      ${advertiserCount != null ? statTile('info', 'Advertisers', advertiserCount) : ''}
      ${totalImpressions != null ? statTile('ok', 'Total Impressions', totalImpressions.toLocaleString()) : ''}
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
    return `<div class="card"><div class="empty">Can't build a day-grid without a recognizable campaign and date column in the response - see the Overview tab for the raw columns actually returned.</div></div>`;
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

export function renderReporting() {
  const cfg = loadData('reportingApi', () => getSetting('reportingApi'));
  if (cfg === null) return loadingCard();
  if (cfg?.__error) return loadingCard(cfg.__error);

  const configured = !!(cfg?.enabled && cfg?.clientId && cfg?.clientSecret);
  if (!configured) {
    return `<div class="card"><div class="empty">Reporting API isn't configured yet. Ask an admin to set the AiOO Reporting API Client ID/Secret under Settings &gt; Integrations.</div></div>`;
  }

  const defaults = defaultDateRange();
  const startDate = STATE.reportingStartDate || defaults.start;
  const endDate = STATE.reportingEndDate || defaults.end;
  const tab = STATE.reportingTab || 'overview';
  const loading = STATE.reportingLoading;
  const error = STATE.reportingError;
  const data = STATE.reportingData;

  if (!data && !loading && !STATE.reportingAutoFetchStarted) {
    STATE.reportingAutoFetchStarted = true;
    queueMicrotask(applyReportingFilter);
  }

  const rows = data ? extractRows(data) : [];
  const fields = rows.length ? detectAllFields(rows) : {};

  return `
    ${renderTabs(REPORTING_TABS, tab, 'App.setReportingTab')}
    <div class="toolbar">
      <div class="toolbar-actions" style="align-items:flex-end;flex-wrap:wrap;">
        <div class="field" style="margin-bottom:0;"><label>Start Date</label><input type="date" id="reporting-start-date" value="${esc(startDate)}"></div>
        <div class="field" style="margin-bottom:0;"><label>End Date</label><input type="date" id="reporting-end-date" value="${esc(endDate)}"></div>
        <button class="btn btn-orange" type="button" ${loading ? 'disabled' : ''} onclick="App.applyReportingFilter()">${loading ? 'Loading...' : 'Apply Date Filter'}</button>
      </div>
    </div>
    ${error ? `<div class="login-error" style="margin-bottom:14px;">${esc(error)}</div>` : ''}
    ${!data ? (loading ? '<div class="card"><div class="empty">Loading reporting data...</div></div>' : '') : (
      tab === 'trafficSheet' ? renderAdditionalTrafficSheet(rows, fields, startDate, endDate) : renderOverview(rows, fields)
    )}
  `;
}
