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
