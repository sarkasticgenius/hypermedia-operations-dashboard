// Ported unchanged from the original app - same output, same call sites.
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function fmtMoney(n) {
  return 'AED ' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// A plain calendar date ("2026-09-01" out of a date column) is not a moment - it means that day,
// everywhere. Parsed and rendered as UTC so it always prints the day it says: as local midnight it
// was one Date object whose rendered day depended on the reader, and a browser east of Dubai
// printed the DAY BEFORE the one stored.
export function fmtDate(d) {
  if (!d) return '-';
  const dt = new Date(d + 'T00:00:00Z');
  if (Number.isNaN(dt.getTime())) return '-';
  return dt.toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
}

// Every stored timestamp in this app is an instant in UTC, and everything it describes lives in
// one place: the PCs, the screens, the sites, and the people reading this are all in Dubai. Left to
// the browser's own zone, the dashboard told different viewers different things - the same
// check-in reading 21:03 on a laptop in Dubai and 17:03 on one set to UTC, with nothing on screen
// to say which you were looking at. On a page whose whole job is "when did this last happen", that
// ambiguity is the bug. Pinned here so there is exactly one answer, deliberately neither the
// viewer's zone nor UTC.
//
// Only ever applied to a real INSTANT (a stored timestamptz). Dates assembled from calendar parts -
// the month headers built as new Date(y, m - 1, 1) in tickets/trafficSheet - are labels, not
// moments, and pinning those would shift the month itself for a viewer east of Dubai.
export const OPS_TIME_ZONE = 'Asia/Dubai';

// "01 Sep 2026, 21:03" - the everyday stamp for a moment something happened.
export function fmtDateTime(value) {
  if (!value) return '-';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return '-';
  return dt.toLocaleString('en-GB', {
    timeZone: OPS_TIME_ZONE,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// "21:03:49" - clock time alone, for a live "updated at" line where the date is already obvious.
export function fmtTime(value) {
  if (!value) return '-';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return '-';
  return dt.toLocaleTimeString('en-GB', {
    timeZone: OPS_TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
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

// The mirror image of jsAttr(), for the far more common shape in this codebase:
// onclick="App.foo('...')" - a double-quoted HTML attribute wrapping a single-quoted JS string
// literal. Plain esc() is NOT safe here even though it looks like it should be: esc() turns a
// literal ' into the HTML entity &#39;, but the browser decodes attribute text back to literal
// characters BEFORE running it as the onclick handler's JS, so the &#39; becomes a real ' again
// right before execution and still closes the JS string early. Confirmed exploitable via
// workspace_devices.anydesk_id/teamviewer_id/other_remote_ids (self-reported by the kiosk agent)
// and the IoT panel's vendor-sourced deviceId - both are strings this app doesn't fully control
// the content of, rendered straight into an admin's browser as executable JS via that gap.
// Escapes the JS string boundary at the JS level (backslash-escaped, not HTML-entity-escaped, so
// it can't be decoded back into a live quote) and only THEN HTML-escapes & and " for the outer
// attribute - order matters, since HTML-escaping first would leave the JS-level backslash/quote
// untouched but HTML-escaping after is a no-op on those characters, so the two passes don't fight.
export function jsAttrSq(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
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

// The Jstar Agent's real version is a plain incrementing integer - v1, v2, v90, v101 - because
// that is all Invoke-SelfUpdate's own numeric comparison needs, and every already-installed agent
// out in the fleet compares against that same raw number. This is ONLY a display convention on top
// of it, for humans looking at a build that is now well past 90 publishes: every full hundred is a
// major version, the remainder is the minor - v89 reads as 0.89, v100 as 1.0, v101 as 1.1, v199 as
// 1.99, v200 as 2.0. Never feed this back into a version comparison; the integer is still the only
// thing that matters there.
export function formatAgentVersion(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `${Math.floor(n / 100)}.${n % 100}`;
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
