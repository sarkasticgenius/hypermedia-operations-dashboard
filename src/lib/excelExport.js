import ExcelJS from 'exceljs';

// Traffic Sheet's download needs real cell borders and a merged month header row (a plain CSV
// can't do either) - this builds a styled .xlsx matching the customer's own reference export
// exactly: Contract, Campaign Name, Start, End, Campaign Days, Loop Count, Status, then one merged
// "Mon YYYY" header per month spanning its day-number ("01".."31") sub-columns, active-day cells
// filled yellow, and a trailing TOTAL / "Number of Campaigns" row. The plain `xlsx` package used
// elsewhere in this app (lib/csv.js, for reading uploads) can read cell styles but silently drops
// them on write - confirmed by a round-trip test - so this uses ExcelJS instead, the only one of
// the two that actually persists fills/borders/merges to a real file.
const META_COLUMNS = [
  { label: 'Contract', width: 21, value: (c) => c.contract || '' },
  { label: 'Campaign Name', width: 45, value: (c) => c.campaignName || '' },
  { label: 'Start', width: 13, value: (c) => c.startDate || '' },
  { label: 'End', width: 13, value: (c) => c.endDate || '' },
  { label: 'Campaign Days', width: 16, value: (c) => c.campaignDays ?? '' },
  { label: 'Loop Count', width: 13, value: (c) => c.loopCount ?? '' },
  { label: 'Status', width: 16, value: (c) => statusWithEmoji(c.status) },
];

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
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

// campaigns: array of Traffic Sheet campaign objects ({ contract, campaignName, startDate,
// endDate, campaignDays, loopCount, status, days: [{date, spots}] }).
// dates: sorted array of ISO date strings (the day columns to render) - already computed by the
// caller (collectDates()/date-range narrowing already applied there).
// dateGroups: [{ month: 'YYYY-MM', dates: [...] }] - already computed by the caller
// (groupDatesByMonth()) for the merged month header.
export async function exportTrafficSheetExcel(filename, { campaigns, dates, dateGroups, monthLabel }) {
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

  // Data rows.
  campaigns.forEach((c, rIdx) => {
    const r = 3 + rIdx;
    META_COLUMNS.forEach((mc, i) => { ws.getCell(r, i + 1).value = mc.value(c); });
    const dayMap = {};
    (c.days || []).forEach((d) => { dayMap[d.date] = d.spots; });
    dates.forEach((d, i) => {
      const spots = dayMap[d];
      if (spots) {
        const cell = ws.getCell(r, metaCount + 1 + i);
        cell.value = spots;
        cell.fill = ACTIVE_FILL;
        cell.alignment = { horizontal: 'center' };
      }
    });
  });

  // TOTAL row - per-day count of campaigns active that day.
  const totalRowIdx = 3 + campaigns.length;
  ws.getCell(totalRowIdx, 1).value = 'TOTAL';
  ws.getCell(totalRowIdx, 2).value = 'Number of Campaigns';
  dates.forEach((d, i) => {
    const count = campaigns.filter((c) => (c.days || []).some((x) => x.date === d)).length;
    const cell = ws.getCell(totalRowIdx, metaCount + 1 + i);
    if (count) { cell.value = count; cell.alignment = { horizontal: 'center' }; }
  });
  ws.getRow(totalRowIdx).font = { bold: true };

  // Header fill + bold on rows 1-2, borders across the whole used range.
  for (let c = 1; c <= totalCols; c++) {
    ws.getCell(1, c).fill = HEADER_FILL;
    ws.getCell(2, c).fill = HEADER_FILL;
    ws.getCell(2, c).font = { bold: true };
    if (dates.length) ws.getCell(2, c).alignment = { horizontal: c > metaCount ? 'center' : 'left' };
  }
  for (let r = 1; r <= totalRowIdx; r++) {
    for (let c = 1; c <= totalCols; c++) ws.getCell(r, c).border = ALL_BORDERS;
  }

  META_COLUMNS.forEach((mc, i) => { ws.getColumn(i + 1).width = mc.width; });
  for (let i = 0; i < dates.length; i++) ws.getColumn(metaCount + 1 + i).width = 4;
  ws.views = [{ state: 'frozen', ySplit: 2 }];

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
