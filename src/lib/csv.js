import * as XLSX from 'xlsx';

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// columns: [{label, value(row) => cell}]
export function exportToCsv(filename, columns, rows) {
  const lines = [columns.map((c) => csvEscape(c.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(c.value(row))).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function parseSpreadsheetFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json(sheet, { defval: '' }));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

// fieldAliases: { fieldName: ['Header One', 'Alt Header', ...] } - header matching ignores
// case/spacing/punctuation, so "Unit Price" and "unit-price" both hit the same alias.
export function mapImportRow(row, fieldAliases) {
  const normRow = {};
  for (const k of Object.keys(row)) normRow[normKey(k)] = row[k];
  const mapped = {};
  for (const [field, aliases] of Object.entries(fieldAliases)) {
    for (const alias of aliases) {
      const v = normRow[normKey(alias)];
      if (v !== undefined && v !== '') {
        mapped[field] = v;
        break;
      }
    }
  }
  return mapped;
}
