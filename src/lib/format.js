// Ported unchanged from the original app - same output, same call sites.
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function fmtMoney(n) {
  return 'AED ' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function fmtDate(d) {
  if (!d) return '-';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Escapes free text for safe embedding inside a single-quoted HTML onclick='...' attribute
// that itself contains a double-quoted JS string literal - see original app's jsAttr() for the
// same rationale. Still needed here since pages keep the inline onclick="handler('...')" pattern.
export function jsAttr(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, '&#39;')
    .replace(/\r?\n/g, '\\n');
}

export function daysUntilInfo(dateStr) {
  if (!dateStr) return { text: '-', urgent: false, overdue: false };
  const today = new Date(todayISO() + 'T00:00:00');
  const target = new Date(dateStr + 'T00:00:00');
  const diffDays = Math.round((target - today) / 86400000);
  let text;
  if (diffDays < 0) text = `Overdue ${Math.abs(diffDays)}d`;
  else if (diffDays === 0) text = 'Due today';
  else text = `${diffDays}d left`;
  return { text, urgent: diffDays <= 30 && diffDays >= 0, overdue: diffDays < 0 };
}
