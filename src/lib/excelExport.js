import ExcelJS from 'exceljs';

// Traffic Sheet's downloads need real cell borders and a merged month header row (a plain CSV
// can't do either) - this builds a styled .xlsx matching the customer's own reference export:
// Campaign Name, Start, End, Campaign Days, Loop Count, Status, then one merged "Mon YYYY" header
// per month spanning its day-number ("01".."31") sub-columns, active-day cells filled yellow, and
// a trailing TOTAL / "Number of Campaigns" row per section. Includes a Campaign ID column (the
// campaign's internal `contract` id from AdLive) matching the on-screen tables in trafficSheet.js.
// Campaigns are split into two labeled sections (Active Campaigns / FOC / Marketing), same
// division already shown on-screen in Today's Active Campaigns (see isFocMarketingCampaign in
// trafficSheet.js), each with its own subtotal row. The plain `xlsx` package used elsewhere in
// this app (lib/csv.js, for reading uploads) can read cell styles but silently drops them on
// write - confirmed by a round-trip test - so this uses ExcelJS instead, the only one of the two
// that actually persists fills/borders/merges to a real file.
const META_COLUMNS = [
  { label: 'Campaign ID', width: 16, value: (c) => c.contract || '' },
  { label: 'Campaign Name', width: 45, value: (c) => c.campaignName || '' },
  { label: 'Start', width: 13, value: (c) => c.startDate || '' },
  { label: 'End', width: 13, value: (c) => c.endDate || '' },
  { label: 'Campaign Days', width: 16, value: (c) => c.campaignDays ?? '' },
  { label: 'Loop Count', width: 13, value: (c) => c.loopCount ?? '' },
  { label: 'Status', width: 16, value: (c) => statusWithEmoji(c.status) },
];

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
const SECTION_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
const ACTIVE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
const THIN = { style: 'thin', color: { argb: 'FFB0B0B0' } };
const ALL_BORDERS = { top: THIN, bottom: THIN, left: THIN, right: THIN };

// Matches the emoji the customer's own reference export already uses for status text - purely
// cosmetic, falls back to the plain status text unchanged for anything not recognized.
function statusWithEmoji(status) {
  const s = String(status || '');
  const upper = s.toUpperCase();
  if (upper.includes('RUNNING') || upper.includes('LIVE')) return `🏃 ${s}`;
  if (upper.includes('COMPLETE')) return `✔️ ${s}`;
  if (upper.includes('PENDING') || upper.includes('SCHEDULED')) return `🕒 ${s}`;
  if (upper.includes('PAUSED') || upper.includes('STOPPED')) return `⏸️ ${s}`;
  return s || 'Unknown';
}

async function downloadWorkbook(wb, filename) {
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Generic styled-Excel export for simple flat tables (Assets, Locations, Tickets, Campaigns,
// Permits, Procurement, SIM Cards, Metro PIC, Asset Inventory) - replaces the app's old CSV
// exports (same {label, value(row)} column shape lib/csv.js's now-removed exportToCsv used), just
// written as a real .xlsx with a bold/filled header row, borders, and auto-sized columns instead
// of plain comma-separated text.
export async function exportToExcel(filename, columns, rows, sheetName = 'Sheet1') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  const totalCols = columns.length;

  columns.forEach((c, i) => { ws.getCell(1, i + 1).value = c.label; });
  rows.forEach((row, rIdx) => {
    columns.forEach((c, i) => { ws.getCell(rIdx + 2, i + 1).value = c.value(row) ?? ''; });
  });

  for (let c = 1; c <= totalCols; c++) {
    const cell = ws.getCell(1, c);
    cell.fill = HEADER_FILL;
    cell.font = { bold: true };
  }
  const totalRows = rows.length + 1;
  for (let r = 1; r <= totalRows; r++) {
    for (let c = 1; c <= totalCols; c++) ws.getCell(r, c).border = ALL_BORDERS;
  }
  columns.forEach((c, i) => {
    const maxLen = rows.reduce((m, row) => Math.max(m, String(c.value(row) ?? '').length), c.label.length);
    ws.getColumn(i + 1).width = Math.min(Math.max(maxLen + 2, 10), 50);
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  await downloadWorkbook(wb, filename);
}

// Writes the standard Traffic Sheet table - merged month header, day-number header row, an
// "Active Campaigns" section and (if non-empty) a "FOC / Marketing" section each with their own
// TOTAL/"Number of Campaigns" row, borders, column widths - into a given worksheet. Shared by
// exportTrafficSheetExcel (single tab/location download) and exportOverallTrafficSheetExcel (the
// multi-sheet "All Venues" + one-per-venue download) so the actual cell-writing logic only exists
// once.
//
// extraColumns (optional): extra {label, width, value(row)} columns prepended before the normal
// Campaign Name/Start/.../Status columns - used by the "All Venues" sheet to show Venue/Venue Type
// per row, since a row there can belong to a different venue than the one above it (nothing else
// needs this, so it defaults to empty).
//
// regularCampaigns/focCampaigns: row objects each carrying at minimum campaignName/startDate/
// endDate/campaignDays/loopCount/status/days (plus whatever extraColumns' value() functions read
// off them, e.g. venue/venueType) - already split by isFocMarketingCampaign at the call site.
// dates/dateGroups/monthLabel: as computed by the caller (collectDates()/groupDatesByMonth()).
function writeTrafficSheetTable(ws, { regularCampaigns, focCampaigns, dates, dateGroups, monthLabel, extraColumns = [] }) {
  const columns = [...extraColumns, ...META_COLUMNS];
  const metaCount = columns.length;
  const totalCols = metaCount + dates.length;

  // Row 1: merged month header(s), starting right after the metadata columns.
  let col = metaCount + 1;
  dateGroups.forEach((g) => {
    const startCol = col;
    const endCol = col + g.dates.length - 1;
    if (endCol > startCol) ws.mergeCells(1, startCol, 1, endCol);
    const cell = ws.getCell(1, startCol);
    cell.value = monthLabel(g.month);
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.font = { bold: true };
    col = endCol + 1;
  });

  // Row 2: column headers - metadata labels, then day numbers ("01".."31").
  columns.forEach((c, i) => { ws.getCell(2, i + 1).value = c.label; });
  dates.forEach((d, i) => { ws.getCell(2, metaCount + 1 + i).value = d.slice(8, 10); });

  let r = 3;

  // Writes one labeled section (header row + data rows + a per-section TOTAL row) starting at the
  // current row cursor `r`. Skipped entirely when empty - matches the on-screen behavior, where
  // the FOC/Marketing sub-table only appears when there's actually something in it.
  function writeSection(label, campaigns) {
    if (!campaigns.length) return;

    const headerRow = r++;
    if (totalCols > 1) ws.mergeCells(headerRow, 1, headerRow, totalCols);
    const hc = ws.getCell(headerRow, 1);
    hc.value = `${label} (${campaigns.length})`;
    hc.font = { bold: true };
    hc.alignment = { vertical: 'middle' };

    campaigns.forEach((row) => {
      const rowIdx = r++;
      columns.forEach((c, i) => { ws.getCell(rowIdx, i + 1).value = c.value(row); });
      const dayMap = {};
      (row.days || []).forEach((d) => { dayMap[d.date] = d.spots; });
      dates.forEach((d, i) => {
        const spots = dayMap[d];
        if (spots) {
          const cell = ws.getCell(rowIdx, metaCount + 1 + i);
          cell.value = spots;
          cell.fill = ACTIVE_FILL;
          cell.alignment = { horizontal: 'center' };
        }
      });
    });

    const totalRow = r++;
    ws.getCell(totalRow, extraColumns.length + 1).value = 'TOTAL';
    ws.getCell(totalRow, extraColumns.length + 2).value = 'Number of Campaigns';
    dates.forEach((d, i) => {
      const count = campaigns.filter((row) => (row.days || []).some((x) => x.date === d)).length;
      const cell = ws.getCell(totalRow, metaCount + 1 + i);
      if (count) { cell.value = count; cell.alignment = { horizontal: 'center' }; }
    });
    ws.getRow(totalRow).font = { bold: true };
    for (let c = 1; c <= totalCols; c++) ws.getCell(headerRow, c).fill = SECTION_FILL;
  }

  writeSection('Active Campaigns', regularCampaigns);
  writeSection('FOC / Marketing', focCampaigns);
  const lastRow = r - 1;

  // Header fill + bold on rows 1-2, borders across the whole used range.
  for (let c = 1; c <= totalCols; c++) {
    ws.getCell(1, c).fill = HEADER_FILL;
    ws.getCell(2, c).fill = HEADER_FILL;
    ws.getCell(2, c).font = { bold: true };
    if (dates.length) ws.getCell(2, c).alignment = { horizontal: c > metaCount ? 'center' : 'left' };
  }
  for (let row = 1; row <= lastRow; row++) {
    for (let c = 1; c <= totalCols; c++) ws.getCell(row, c).border = ALL_BORDERS;
  }

  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
  for (let i = 0; i < dates.length; i++) ws.getColumn(metaCount + 1 + i).width = 4;
  ws.views = [{ state: 'frozen', ySplit: 2 }];
}

// regularCampaigns/focCampaigns: arrays of Traffic Sheet campaign objects ({ campaignName,
// startDate, endDate, campaignDays, loopCount, status, days: [{date, spots}] }), already split by
// isFocMarketingCampaign at the call site.
// dates: sorted array of ISO date strings (the day columns to render) - already computed by the
// caller (collectDates()/date-range narrowing already applied there), shared across both sections.
// dateGroups: [{ month: 'YYYY-MM', dates: [...] }] - already computed by the caller
// (groupDatesByMonth()) for the merged month header.
export async function exportTrafficSheetExcel(filename, { regularCampaigns, focCampaigns, dates, dateGroups, monthLabel }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Worksheet');
  writeTrafficSheetTable(ws, { regularCampaigns, focCampaigns, dates, dateGroups, monthLabel });
  await downloadWorkbook(wb, filename);
}

const BRAND_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1C1F' } };
const BRAND_ORANGE = 'FFF7941D';
const BRAND_TEAL = 'FF14B8C4';
const REPORT_HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F5F6' } };

let cachedLogoBuffer = null;
async function getLogoBuffer() {
  if (!cachedLogoBuffer) {
    const res = await fetch(`${import.meta.env.BASE_URL}logo.png`);
    cachedLogoBuffer = await res.arrayBuffer();
  }
  return cachedLogoBuffer;
}

// Fallback branding if the caller doesn't pass a template (or a field in it is blank) - matches
// Settings > Integrations > Campaign Report Template's own defaults (settings.js
// REPORT_TEMPLATE_DEFAULTS) so an unconfigured template still looks right out of the box.
const DEFAULT_TEMPLATE = { companyName: 'Hypermedia', tagline: 'Creators of Impact' };

// Writes the brand banner (logo + wordmark + tagline) + Campaign Name/Duration meta rows + a
// bordered data table starting at row 7 - shared by both sheets of exportReportingCampaignExcel
// (Report / Screen Detail) so the report header stays visually identical whichever sheet you're
// looking at.
function writeReportSheet(ws, { campaignName, duration, columns, rows, logoImageId, template }) {
  const t = { ...DEFAULT_TEMPLATE, ...template };
  const totalCols = Math.max(columns.length, 2);

  ws.mergeCells(1, 1, 1, totalCols);
  const brandCell = ws.getCell(1, 1);
  brandCell.value = t.companyName;
  brandCell.font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } };
  brandCell.fill = BRAND_FILL;
  brandCell.alignment = { vertical: 'middle', indent: 5 };
  ws.getRow(1).height = 34;
  if (logoImageId != null) {
    ws.addImage(logoImageId, { tl: { col: 0.15, row: 0.12 }, ext: { width: 28, height: 28 } });
  }

  ws.mergeCells(2, 1, 2, totalCols);
  const taglineCell = ws.getCell(2, 1);
  taglineCell.value = t.tagline || '';
  taglineCell.font = { italic: true, size: 10, color: { argb: BRAND_TEAL } };
  taglineCell.alignment = { vertical: 'middle', indent: 5 };
  ws.getRow(2).height = 16;

  ws.getCell(4, 1).value = 'Campaign Name:';
  ws.getCell(4, 1).font = { bold: true };
  ws.getCell(4, 2).value = campaignName;
  ws.getCell(5, 1).value = 'Duration:';
  ws.getCell(5, 1).font = { bold: true };
  ws.getCell(5, 2).value = duration;

  const headerRow = 7;
  columns.forEach((c, i) => { ws.getCell(headerRow, i + 1).value = c.label; });
  rows.forEach((row, rIdx) => {
    columns.forEach((c, i) => { ws.getCell(headerRow + 1 + rIdx, i + 1).value = c.value(row) ?? ''; });
  });
  const lastRow = headerRow + rows.length;
  for (let r = headerRow; r <= lastRow; r++) {
    for (let c = 1; c <= columns.length; c++) ws.getCell(r, c).border = ALL_BORDERS;
  }
  for (let c = 1; c <= columns.length; c++) {
    const cell = ws.getCell(headerRow, c);
    cell.fill = REPORT_HEADER_FILL;
    cell.font = { bold: true };
    cell.border = { ...ALL_BORDERS, bottom: { style: 'medium', color: { argb: BRAND_ORANGE } } };
  }
  columns.forEach((c, i) => {
    const maxLen = rows.reduce((m, row) => Math.max(m, String(c.value(row) ?? '').length), c.label.length);
    ws.getColumn(i + 1).width = Math.min(Math.max(maxLen + 2, 10), 50);
  });
  ws.views = [{ state: 'frozen', ySplit: headerRow }];
}

// Reporting workspace's per-campaign download (Ads Stats tab): a "Hypermedia"-branded report with
// Campaign Name/Duration on both sheets - a Report sheet with the raw rows (only the fields the
// user selected) and a Screen Detail sheet with those same rows aggregated per screen (Site +
// Placement, summed across whichever numeric fields were selected).
export async function exportReportingCampaignExcel(filename, { campaignName, duration, columns, rows, screenColumns, screenRows, template }) {
  const wb = new ExcelJS.Workbook();
  let logoImageId = null;
  try {
    logoImageId = wb.addImage({ buffer: await getLogoBuffer(), extension: 'png' });
  } catch (_) { /* logo is cosmetic - report still works without it */ }
  writeReportSheet(wb.addWorksheet('Report'), { campaignName, duration, columns, rows, logoImageId, template });
  writeReportSheet(wb.addWorksheet('Screen Detail'), { campaignName, duration, columns: screenColumns, rows: screenRows, logoImageId, template });
  await downloadWorkbook(wb, filename);
}

const INVALID_SHEET_NAME_CHARS = /[\\/?*[\]:]/g;
// Excel worksheet names: max 31 chars, can't contain \ / ? * [ ] :, and must be unique within the
// workbook - a real risk here specifically, since several distinct raw venue names can canonicalize
// to the same merged display name (that's the whole point of mergeVenueName) and would otherwise
// collide on the sheet name.
function safeSheetName(name, used) {
  const base = (String(name || 'Sheet').replace(INVALID_SHEET_NAME_CHARS, '-').trim() || 'Sheet').slice(0, 31);
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
    n++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// sheets: [{ name, regularRows, focRows, extraColumns? }] - one workbook, one worksheet per entry,
// each written via writeTrafficSheetTable above. The "All Venues" overall-summary sheet is just
// the first entry with a Venue/Venue Type extraColumns pair; every other entry is one venue's own
// campaigns with no extraColumns, matching the reference "Overall Traffic Sheet" export this is
// modeled on (one combined sheet + one sheet per venue/mall).
export async function exportOverallTrafficSheetExcel(filename, { sheets, dates, dateGroups, monthLabel }) {
  const wb = new ExcelJS.Workbook();
  const usedNames = new Set();
  sheets.forEach((sheet) => {
    const ws = wb.addWorksheet(safeSheetName(sheet.name, usedNames));
    writeTrafficSheetTable(ws, {
      regularCampaigns: sheet.regularRows,
      focCampaigns: sheet.focRows,
      dates, dateGroups, monthLabel,
      extraColumns: sheet.extraColumns || [],
    });
  });
  await downloadWorkbook(wb, filename);
}
