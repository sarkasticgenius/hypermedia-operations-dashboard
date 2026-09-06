// One place that knows how to turn a remote-access tool + id into a clickable "connect" URL.
//
// This used to be a protocolForTool() returning just a scheme, with both call sites building the
// href as `${protocol}:${id}` themselves - which works only because AnyDesk and TeamViewer happen
// to share that exact shape. RustDesk does not: it wants rustdesk://connection/new/<id>, so a
// scheme alone cannot express it. Returning the finished URL keeps every tool's own quirks here
// instead of leaking them into each caller.
//
// It also collapses a real duplicate: the same tool-name-to-scheme logic existed separately in
// workspaceDirectory.js and networkPanels.js, so adding a tool meant remembering both.
//
// Tool names are matched by PREFIX because other_remote_ids carries display names, not identifiers
// - a PC with two AnyDesk installs reports "AnyDesk (2)" (see Get-AllAnyDeskIds in the agent), and
// that second id still needs a working link.
export function remoteAccessUrl(tool, id) {
  if (!tool || !id) return '';
  const name = String(tool);
  if (/^AnyDesk/i.test(name)) return `anydesk:${id}`;
  if (/^TeamViewer/i.test(name)) return `teamviewer10:${id}`;
  if (/^RustDesk/i.test(name)) return `rustdesk://connection/new/${id}`;
  // Unknown tool: the id is still worth showing and copying, there is just nothing to launch.
  return '';
}

// Border for the compact "Remote Access" button, colored after whichever tool(s) it actually
// launches - AnyDesk's own brand red and TeamViewer's own brand blue (see --anydesk-red/
// --teamviewer-blue in styles.css), split diagonally (border-image gradient) when a PC has both so
// neither tool's color dominates. Falls back to the brand-orange treatment when the PC only has
// something else (RustDesk, etc.) so the button still stands out from plain btn-sm. Text stays the
// normal body color throughout - only the border carries the brand color, since colored text on
// top of a colored border read as harder to scan than a plain black/white label.
export function remoteAccessButtonStyle(hasAnyDesk, hasTeamViewer) {
  if (hasAnyDesk && hasTeamViewer) {
    return 'border:2px solid transparent;border-image:linear-gradient(135deg, var(--anydesk-red) 50%, var(--teamviewer-blue) 50%) 1;color:var(--text);font-weight:700;';
  }
  if (hasAnyDesk) return 'border:1.5px solid var(--anydesk-red);color:var(--text);font-weight:700;';
  if (hasTeamViewer) return 'border:1.5px solid var(--teamviewer-blue);color:var(--text);font-weight:700;';
  return 'border:1.5px solid var(--brand-orange);color:var(--brand-orange-dark);font-weight:700;';
}
