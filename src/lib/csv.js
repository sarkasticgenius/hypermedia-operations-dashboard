import * as XLSX from 'xlsx';

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

// Bulk-import date cells arrive as almost anything: an Excel serial number (date-formatted
// cells come back as raw numbers since parseSpreadsheetFile doesn't set cellDates), a
// DD/MM/YYYY or MM/DD/YYYY text string, a two-digit year, or already-ISO text. Postgres `date`
// columns only accept ISO, so every bulk importer with a date field needs this before saving -
// without it, one bad cell throws "invalid input syntax for type date" and can abort the import.
// Ambiguous DD/MM vs MM/DD (both parts <=12) defaults to MM/DD - confirmed against a real Metro
// PIC export where every date (e.g. "6/23/2026") was unambiguously US-formatted.
export function parseImportDate(value) {
  if (value === '' || value == null) return undefined;
  if (value instanceof Date) {
    return isNaN(value) ? undefined : value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    const d = new Date(Math.round((value - 25569) * 86400 * 1000));
    return isNaN(d) ? undefined : d.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (!s) return undefined;

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3];
    const [day, month] = a > 12 ? [a, b] : [b, a];
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const yy = Number(m[3]);
    const year = yy < 70 ? 2000 + yy : 1900 + yy;
    const [day, month] = a > 12 ? [a, b] : [b, a];
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const parsed = new Date(s);
  return isNaN(parsed) ? undefined : parsed.toISOString().slice(0, 10);
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
