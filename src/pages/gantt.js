// Campaign Calendar - combines our own internal Digital Campaigns (campaigns table) with live
// Traffic Sheet data from the AdLive Center API into one landing page:
//   1. Internal Digital Campaigns gantt (unchanged from before, one bar per campaign).
//   2. Traffic Sheet Campaigns gantt - one bar per venue category (not per individual campaign;
//      a real month regularly has 200+ live campaigns, so per-campaign bars here would be
//      unreadable) spanning that category's earliest start to latest end this month, clickable
//      through to the matching Traffic Sheet tab.
//   3. Leftover Inventory - Total screens (Asset Inventory) vs. screens booked by a live campaign
//      this month, per category, as a grouped bar chart.
//   4. Top Ideas - the categories with the most unbooked inventory this month, as clickable
//      suggestion cards.
//
// Sections 2-4 need Traffic Sheet configured (Settings > Integrations > Traffic Sheet API) and
// show a placeholder otherwise; section 1 always works regardless.
//
// Leftover Inventory deliberately excludes SHZ Bridges: Asset Inventory's `category` is 'Metro'
// for both bridge screens and regular in-station screens, with no further split and the same ad
// networks (12 SHEET, The Massive, etc.) shared across both - there's no reliable signal in our
// own inventory data to isolate bridge screens specifically, unlike the other 6 categories which
// each have a clean category/network signal (confirmed via a real query against asset_inventory).
import { STATE, loadData, setState } from '../state.js';
import { loadingCard } from '../modals.js';
import { listCampaigns } from '../data/campaigns.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { getAllSettings } from '../data/settings.js';
import { MAF_MALL_VENUE_KEYWORDS } from '../data/locationStats.js';
import { TAB_DEFS, VENUE_CATEGORY_KEYS, venueMatchesTab, mergeVenueName } from './trafficSheet.js';
import { supabase } from '../supabaseClient.js';
import { svgGroupedBarChart } from '../lib/charts.js';
import { esc } from '../lib/format.js';

const COLORS = ['#e8951f', '#2563eb', '#1f9d55', '#b45309', '#c0392b', '#8b5e34'];
const TAB_LABELS = Object.fromEntries(TAB_DEFS.map((t) => [t.key, t.label]));
const LEFTOVER_CATEGORY_KEYS = VENUE_CATEGORY_KEYS.filter((k) => k !== 'shzBridges');

function dayLabelsHtml(daysInMonth) {
  return Array.from({ length: daysInMonth }, (_, i) => `<div>${i + 1}</div>`).join('');
}

// Same 6-category signal used for the Leftover Inventory comparison, computed independently on
// each side (our own Asset Inventory here, AdLive's venue data via venueMatchesTab on the Traffic
// Sheet side) rather than trying to name-match individual venues across the two systems, which
// would hit the same spelling/formatting mismatches already found and fixed inside Traffic Sheet
// itself (US/UK spelling, hyphens, etc.) - category-level totals sidestep all of that.
function categorizeAssetInventoryRow(row) {
  const category = (row.category || '').toUpperCase();
  const networkNames = (row.networkNames || []).map((n) => n.toUpperCase());
  const venue = (row.venue || '').toUpperCase().replace(/CENTER/g, 'CENTRE');
  const hasNet = (kw) => networkNames.some((n) => n.includes(kw));

  if (hasNet('MAF') || (category === 'MALLS' && MAF_MALL_VENUE_KEYWORDS.some((k) => venue.includes(k)))) return 'mafMalls';
  if (category === 'MALLS') return 'malls';
  if (hasNet('ROYAL')) return 'royals';
  if (hasNet('GEMS') || hasNet('FAIROUZ')) return 'gems';
  if (category === 'PETROL STATIONS' || venue.includes('ENOC') || hasNet('ENOC')) return 'enoc';
  if (category === 'IN-STORE') return 'stores';
  return null;
}

function totalScreensByCategory(assetInventory) {
  const totals = {};
  LEFTOVER_CATEGORY_KEYS.forEach((k) => { totals[k] = 0; });
  (assetInventory || []).forEach((row) => {
    const cat = categorizeAssetInventoryRow(row);
    if (cat && totals[cat] !== undefined) totals[cat] += row.screens || 1;
  });
  return totals;
}

// Distinct-venue screens (max, not sum, per venue - same reasoning as Traffic Sheet's own
// locationSummary: the same physical venue showing up in several campaigns shouldn't multiply its
// screen count), booked by at least one live campaign this month.
function bookedScreensByCategory(trafficSheetData) {
  const maps = {};
  LEFTOVER_CATEGORY_KEYS.forEach((k) => { maps[k] = new Map(); });
  (trafficSheetData?.campaigns || []).forEach((c) => {
    (c.venues || []).forEach((v) => {
      LEFTOVER_CATEGORY_KEYS.forEach((k) => {
        if (venueMatchesTab(v, k)) {
          const name = mergeVenueName(v.venue);
          const m = maps[k];
          m.set(name, Math.max(m.get(name) || 0, v.screens || 0));
        }
      });
    });
  });
  const out = {};
  LEFTOVER_CATEGORY_KEYS.forEach((k) => { out[k] = [...maps[k].values()].reduce((a, b) => a + b, 0); });
  return out;
}

// Per venue-category (all 7, including SHZ Bridges - this section is just about campaign activity
// spans, not the inventory-total comparison, so the Bridges/regular-Metro ambiguity above doesn't
// apply here): campaign count (deduped by contract) plus earliest start / latest end this month.
function trafficSheetCategoryBars(trafficSheetData) {
  const byCat = {};
  const seen = {};
  VENUE_CATEGORY_KEYS.forEach((k) => { byCat[k] = { count: 0, minStart: null, maxEnd: null }; seen[k] = new Set(); });
  (trafficSheetData?.campaigns || []).forEach((c) => {
    VENUE_CATEGORY_KEYS.forEach((k) => {
      if (!(c.venues || []).some((v) => venueMatchesTab(v, k))) return;
      const info = byCat[k];
      if (!seen[k].has(c.contract)) { seen[k].add(c.contract); info.count++; }
      if (c.startDate && (!info.minStart || c.startDate < info.minStart)) info.minStart = c.startDate;
      if (c.endDate && (!info.maxEnd || c.endDate > info.maxEnd)) info.maxEnd = c.endDate;
    });
  });
  return byCat;
}

function renderTrafficSheetGanttRow(key, info, monthStart, monthEnd, daysInMonth, color) {
  if (!info.count || !info.minStart || !info.maxEnd) return '';
  const s = new Date(Math.max(new Date(info.minStart), monthStart));
  const e = new Date(Math.min(new Date(info.maxEnd), monthEnd));
  const startDay = s.getDate();
  const endDay = e.getDate();
  const leftPct = ((startDay - 1) / daysInMonth) * 100;
  const widthPct = Math.max(2, ((endDay - startDay + 1) / daysInMonth) * 100);
  const label = TAB_LABELS[key] || key;
  return `
    <div class="gantt-flexrow gantt-body-row" style="cursor:pointer;" onclick="App.goToTrafficSheetCategory('${key}')" title="View ${esc(label)} in Traffic Sheet">
      <div class="gantt-name-col">${esc(label)} <span class="tab-count">${info.count}</span></div>
      <div class="gantt-track" style="--days:${daysInMonth};">
        <div class="gantt-bar" style="left:${leftPct}%;width:${widthPct}%;background:${color};">${info.count} campaign(s)</div>
      </div>
    </div>
  `;
}

async function fetchGanttTrafficSheet(month) {
  setState({ ganttTsLoading: true, ganttTsError: null });
  try {
    const { data, error } = await supabase.functions.invoke('traffic-sheet-proxy', { body: { startMonth: month, endMonth: month } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    setState({ ganttTsData: data, ganttTsMonth: month, ganttTsLoading: false });
  } catch (e) {
    setState({ ganttTsLoading: false, ganttTsError: e.message || 'Failed to load Traffic Sheet data' });
  }
}

// Jumps to the Traffic Sheet page with a specific venue-category tab pre-selected (and the
// Location filter cleared, since it was scoped to whatever tab was last active there) - used by
// every clickable row/card in the Traffic Sheet sections below.
export function goToTrafficSheetCategory(key) {
  setState({ page: 'trafficSheet', trafficSheetTab: key, trafficSheetLocation: '', modal: null });
}

function renderTrafficSheetSections(tsConfigured, month, monthStart, monthEnd, daysInMonth, assetInventory) {
  if (!tsConfigured) {
    return `
      <div class="card" style="margin-top:16px;">
        <div class="empty">Traffic Sheet isn't configured yet, so live campaigns, leftover inventory, and suggested ideas aren't available here. Configure it under Settings &gt; Integrations &gt; Traffic Sheet API.</div>
      </div>
    `;
  }

  if (STATE.ganttTsMonth !== month && !STATE.ganttTsLoading && STATE.ganttTsFetchingMonth !== month) {
    STATE.ganttTsFetchingMonth = month;
    queueMicrotask(() => fetchGanttTrafficSheet(month));
  }

  if (STATE.ganttTsError) {
    return `<div class="card" style="margin-top:16px;"><div class="login-error">${esc(STATE.ganttTsError)}</div></div>`;
  }

  const tsData = STATE.ganttTsMonth === month ? STATE.ganttTsData : null;
  if (!tsData) {
    return `<div class="card" style="margin-top:16px;"><div class="empty">Loading Traffic Sheet campaigns for this month...</div></div>`;
  }

  const byCat = trafficSheetCategoryBars(tsData);
  const ganttRows = VENUE_CATEGORY_KEYS.map((k, i) => renderTrafficSheetGanttRow(k, byCat[k], monthStart, monthEnd, daysInMonth, COLORS[i % COLORS.length])).join('');
  const totalCampaigns = tsData.campaignCount ?? (tsData.campaigns || []).length;

  const totals = totalScreensByCategory(assetInventory);
  const booked = bookedScreensByCategory(tsData);
  const catLabels = LEFTOVER_CATEGORY_KEYS.map((k) => TAB_LABELS[k]);
  const bookedValues = LEFTOVER_CATEGORY_KEYS.map((k) => Math.min(booked[k] || 0, totals[k] || 0));
  const availableValues = LEFTOVER_CATEGORY_KEYS.map((k, i) => Math.max(0, (totals[k] || 0) - bookedValues[i]));
  const leftoverChart = svgGroupedBarChart(catLabels, [
    { name: 'Booked', color: '#c0392b', values: bookedValues },
    { name: 'Available', color: '#1f9d55', values: availableValues },
  ], { width: 680, height: 240 });

  const ideas = LEFTOVER_CATEGORY_KEYS
    .map((k, i) => ({ key: k, label: TAB_LABELS[k], available: availableValues[i], total: totals[k] || 0 }))
    .filter((idea) => idea.available > 0)
    .sort((a, b) => b.available - a.available)
    .slice(0, 3);

  return `
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Traffic Sheet Campaigns</h3><div class="desc">${totalCampaigns} live campaign(s) this month across every venue category. Click a row to jump to that tab in Traffic Sheet.</div></div>
      ${ganttRows ? `
        <div class="gantt-wrap">
          <div class="gantt-grid" style="--days:${daysInMonth};">
            <div class="gantt-flexrow"><div class="gantt-name-col"></div><div class="gantt-daylabels" style="--days:${daysInMonth};">${dayLabelsHtml(daysInMonth)}</div></div>
            ${ganttRows}
          </div>
        </div>
      ` : '<div class="empty">No live campaigns this month.</div>'}
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Leftover Inventory - Not Booked</h3><div class="desc">Total screens (Asset Inventory) vs. screens booked by a live campaign this month, by category. SHZ Bridges isn't included - Asset Inventory can't reliably separate bridge screens from regular Metro station screens by category alone.</div></div>
      ${leftoverChart}
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Top Ideas</h3><div class="desc">Categories with the most unbooked inventory this month - click one to jump straight to that tab in Traffic Sheet.</div></div>
      ${ideas.length ? `
        <div class="kpi-row">
          ${ideas.map((idea) => `
            <div class="kpi" style="cursor:pointer;border-left:4px solid #1f9d55;" onclick="App.goToTrafficSheetCategory('${idea.key}')" title="View ${esc(idea.label)} in Traffic Sheet">
              <div class="label">${esc(idea.label)}</div>
              <div class="value">${idea.available}</div>
              <div class="sub">available of ${idea.total} total</div>
            </div>
          `).join('')}
        </div>
      ` : '<div class="empty">Every category is fully booked this month.</div>'}
    </div>
  `;
}

export function renderGantt() {
  const campaigns = loadData('campaigns', listCampaigns);
  const assetInventory = loadData('assetInventory', listAssetInventory);
  const settings = loadData('settings', getAllSettings);
  if (campaigns === null || assetInventory === null || settings === null) return loadingCard();
  if (campaigns?.__error) return loadingCard(campaigns.__error);
  if (assetInventory?.__error) return loadingCard(assetInventory.__error);
  if (settings?.__error) return loadingCard(settings.__error);

  const tsCfg = settings.trafficSheetApi || {};
  const tsConfigured = !!(tsCfg.enabled && tsCfg.apiKey);

  const month = STATE.ganttMonth || new Date().toISOString().slice(0, 7);
  const [year, mon] = month.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const monthStart = new Date(year, mon - 1, 1);
  const monthEnd = new Date(year, mon - 1, daysInMonth);

  const inMonth = campaigns.filter((c) => {
    if (!c.start_date || !c.end_date) return false;
    const s = new Date(c.start_date);
    const e = new Date(c.end_date);
    return s <= monthEnd && e >= monthStart;
  });

  const rows = inMonth.map((c, idx) => {
    const s = new Date(Math.max(new Date(c.start_date), monthStart));
    const e = new Date(Math.min(new Date(c.end_date), monthEnd));
    const startDay = s.getDate();
    const endDay = e.getDate();
    const leftPct = ((startDay - 1) / daysInMonth) * 100;
    const widthPct = ((endDay - startDay + 1) / daysInMonth) * 100;
    const color = COLORS[idx % COLORS.length];
    return `
      <div class="gantt-flexrow gantt-body-row">
        <div class="gantt-name-col">${esc(c.name)}</div>
        <div class="gantt-track" style="--days:${daysInMonth};">
          <div class="gantt-bar" style="left:${leftPct}%;width:${widthPct}%;background:${color};" title="${esc(c.name)}">${esc(c.name)}</div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="toolbar">
      <div class="field" style="margin:0;">
        <input type="month" value="${month}" onchange="App.setGanttMonth(this.value)">
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Internal Digital Campaigns</h3><div class="desc">${inMonth.length} campaign(s) running this month</div></div>
      ${inMonth.length === 0 ? '<div class="empty">No campaigns running this month.</div>' : `
        <div class="gantt-wrap">
          <div class="gantt-grid" style="--days:${daysInMonth};">
            <div class="gantt-flexrow">
              <div class="gantt-name-col"></div>
              <div class="gantt-daylabels" style="--days:${daysInMonth};">${dayLabelsHtml(daysInMonth)}</div>
            </div>
            ${rows}
          </div>
        </div>
      `}
    </div>
    ${renderTrafficSheetSections(tsConfigured, month, monthStart, monthEnd, daysInMonth, assetInventory)}
  `;
}

export function setGanttMonth(value) {
  setState({ ganttMonth: value });
}
