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

// "2 days, 4 hours and 16 minutes ago" - deliberately computed at render time from a raw
// timestamp rather than ever being baked into a stored string, so it stays accurate no matter how
// long ago the sync that captured the timestamp actually ran.
// Reports only the single largest unit (days, else hours, else minutes) rather than stacking all
// three ("3 days, 7 hours and 21 minutes ago") - every call site uses this as a quick "how long
// ago" scan in a table cell or inline label, never as an audit-grade duration, and the combined
// form is long enough to wrap across 5-6 lines in a normal fixed-width column (confirmed live: the
// IoT Panel's offline devices, some stale for 12+ days, turned an ~85px-tall cell next to online
// rows' single-line "20 minutes ago" - unreadable, and inconsistent row heights next to each
// other). "3 days ago" is both the GitHub/Twitter convention and enough precision for what every
// caller here actually needs: roughly how stale is this.
export function fmtRelativeTime(iso) {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60000) return 'just now';
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (hours) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
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
