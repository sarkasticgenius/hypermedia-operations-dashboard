import ExcelJS from 'exceljs';

// Traffic Sheet's download needs real cell borders and a merged month header row (a plain CSV
// can't do either) - this builds a styled .xlsx matching the customer's own reference export:
// Campaign Name, Start, End, Campaign Days, Loop Count, Status, then one merged "Mon YYYY" header
// per month spanning its day-number ("01".."31") sub-columns, active-day cells filled yellow, and
// a trailing TOTAL / "Number of Campaigns" row per section. No Contract column - explicitly not
// wanted in the download even though the customer's own reference sample happened to have one.
// Campaigns are split into two labeled sections (Active Campaigns / FOC / Marketing), same
// division already shown on-screen in Today's Active Campaigns (see isFocMarketingCampaign in
// trafficSheet.js), each with its own subtotal row. The plain `xlsx` package used elsewhere in
// this app (lib/csv.js, for reading uploads) can read cell styles but silently drops them on
// write - confirmed by a round-trip test - so this uses ExcelJS instead, the only one of the two
// that actually persists fills/borders/merges to a real file.
const META_COLUMNS = [
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
  const metaCount = META_COLUMNS.length;
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
  META_COLUMNS.forEach((c, i) => { ws.getCell(2, i + 1).value = c.label; });
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

    campaigns.forEach((c) => {
      const row = r++;
      META_COLUMNS.forEach((mc, i) => { ws.getCell(row, i + 1).value = mc.value(c); });
      const dayMap = {};
      (c.days || []).forEach((d) => { dayMap[d.date] = d.spots; });
      dates.forEach((d, i) => {
        const spots = dayMap[d];
        if (spots) {
          const cell = ws.getCell(row, metaCount + 1 + i);
          cell.value = spots;
          cell.fill = ACTIVE_FILL;
          cell.alignment = { horizontal: 'center' };
        }
      });
    });

    const totalRow = r++;
    ws.getCell(totalRow, 1).value = 'TOTAL';
    ws.getCell(totalRow, 2).value = 'Number of Campaigns';
    dates.forEach((d, i) => {
      const count = campaigns.filter((c) => (c.days || []).some((x) => x.date === d)).length;
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

  META_COLUMNS.forEach((mc, i) => { ws.getColumn(i + 1).width = mc.width; });
  for (let i = 0; i < dates.length; i++) ws.getColumn(metaCount + 1 + i).width = 4;
  ws.views = [{ state: 'frozen', ySplit: 2 }];

  await downloadWorkbook(wb, filename);
}
