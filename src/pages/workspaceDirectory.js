import { STATE, loadData, invalidate, toast, setState, openModal, closeModal } from '../state.js';
import { registerModal, loadingCard } from '../modals.js';
import { listWorkspaceDevices, updateWorkspaceDevice, deleteWorkspaceDevice, listGhostWorkspaceDevices, restoreWorkspaceDevice, permanentlyDeleteWorkspaceDevice } from '../data/workspaceDevices.js';
import { listSimCards } from '../data/simCards.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { canEdit, canDelete } from '../auth.js';
import { esc, fmtRelativeTime } from '../lib/format.js';
import { sortTh, applySort, FIXED_TABLE_STYLE } from '../lib/sortableTable.js';
import { logAudit } from '../lib/audit.js';
import { supabase } from '../supabaseClient.js';
import { problemType, problemTypeLabel, visibleProblems } from '../lib/workspaceProblems.js';

// The agent's light heartbeat runs every 20 minutes (see Invoke-Checkin's -Light handling in the
// agent script) specifically so Online/Offline can be this responsive - the separate full 6-hourly
// cycle is only for the heavier inventory fields (installed software etc.), not this. Exactly 20
// minutes here (matching the cycle with zero slack) made genuinely-online screens flap to "Offline"
// on completely ordinary scheduling jitter - a poll landing even a few seconds late is enough to
// cross the line right before its own next check-in fixes it again. 30 minutes (1.5x the cycle)
// keeps this far more responsive than the old 8-hour threshold while giving one cycle's worth of
// real slack, same idea as the original 6h-cycle/8h-threshold ratio.
const STALE_AFTER_MINUTES = 30;

function isOnline(d) {
  if (!d.last_seen) return false;
  return (Date.now() - new Date(d.last_seen).getTime()) / 60000 <= STALE_AFTER_MINUTES;
}

// JSON.stringify escapes backslashes/double-quotes per spec but not single quotes - these payloads
// sit inside single-quoted onclick='...' attributes, so an apostrophe in a location name would
// otherwise break out (same helper as networkPanels.js's jsonAttr).
function jsonAttr(value) {
  return JSON.stringify(value).replace(/'/g, '&#39;');
}

function locationTile(loc, list) {
  const online = list.filter(isOnline).length;
  const offline = list.length - online;
  const onlinePct = list.length ? (online / list.length) * 100 : 0;
  return `<div style="background:#2a3441;border-radius:10px;padding:12px;color:#fff;min-height:96px;display:flex;flex-direction:column;justify-content:space-between;gap:9px;cursor:pointer;" onclick='App.openWorkspaceLocationModal(${jsonAttr(loc)})' title="Click to see devices">
    <div>
      <div style="font-size:13px;font-weight:700;line-height:1.3;">${esc(loc)} <span style="font-weight:400;opacity:.8;">(${list.length})</span></div>
      <div style="font-size:11px;opacity:.85;margin-top:2px;"><span style="color:#5fd88f;">${online} online</span>, <span style="color:#f2857a;">${offline} offline</span></div>
    </div>
    <div style="height:8px;border-radius:4px;overflow:hidden;display:flex;background:rgba(255,255,255,.12);">
      ${online ? `<div style="width:${onlinePct.toFixed(1)}%;background:#1f9d55;"></div>` : ''}
      ${offline ? `<div style="width:${(100 - onlinePct).toFixed(1)}%;background:#c0392b;"></div>` : ''}
    </div>
  </div>`;
}

// AnyDesk/TeamViewer IDs are directly actionable, not just displayed - a Connect link (the
// installed client's own custom protocol handler on whoever's browsing the dashboard) plus a Copy
// button, since not every admin will have the client set as the default handler for that scheme.
function remoteIdChip(tool, id, protocol) {
  if (!id) return '';
  return `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:2px 6px;margin:1px 3px 1px 0;font-size:11px;white-space:nowrap;">
    <b>${esc(tool)}</b> <span style="font-family:monospace;">${esc(id)}</span>
    <a href="${protocol}:${esc(id)}" title="Connect via ${esc(tool)}" style="text-decoration:none;">&#128279;</a>
    <button type="button" class="link-btn" style="padding:0;" title="Copy ID" onclick="App.copyWorkspaceId(event,'${esc(id)}')">&#128203;</button>
  </span>`;
}

// A second/third AnyDesk id (a PC with more than one AnyDesk install - see Get-AllAnyDeskIds)
// still needs a working Connect link, not just a bare id - inferred from the tool name since
// other_remote_ids itself only carries {tool, id}, no protocol.
function protocolForTool(tool) {
  if (/^AnyDesk/i.test(tool)) return 'anydesk';
  if (/^TeamViewer/i.test(tool)) return 'teamviewer10';
  return '';
}

function remoteAccessCell(d) {
  const chips = [
    remoteIdChip('AnyDesk', d.anydesk_id, 'anydesk'),
    remoteIdChip('TeamViewer', d.teamviewer_id, 'teamviewer10'),
    ...(d.other_remote_ids || []).map((r) => remoteIdChip(r.tool, r.id, protocolForTool(r.tool))),
  ].filter(Boolean).join('');
  return chips || '<span class="small muted">-</span>';
}

// One compact button for the table's Remote Access column, same idea (and same picker modal, from
// networkPanels.js's registerModal('remoteAccessPicker')) as the Offline modal's own Remote Access
// button - listing chips inline here would keep growing the column with every extra tool a PC has
// (see Get-AllAnyDeskIds). The Details modal keeps the fuller inline chip display (remoteAccessCell
// above) since it already has the room for it.
function remoteAccessButtonHtml(d) {
  const tools = [];
  if (d.anydesk_id) tools.push({ tool: 'AnyDesk', id: d.anydesk_id, protocol: 'anydesk' });
  if (d.teamviewer_id) tools.push({ tool: 'TeamViewer', id: d.teamviewer_id, protocol: 'teamviewer10' });
  (d.other_remote_ids || []).forEach((r) => {
    const protocol = protocolForTool(r.tool);
    if (protocol) tools.push({ tool: r.tool, id: r.id, protocol });
  });
  if (!tools.length) return '<span class="small muted">-</span>';
  return `<button class="btn-sm" onclick='App.openRemoteAccessPicker(${jsonAttr({ tools, label: d.hostname })})'>Remote Access</button>`;
}

export function copyWorkspaceId(event, id) {
  event.preventDefault();
  navigator.clipboard?.writeText(id).then(() => toast('Copied')).catch(() => {});
}

// Both the per-device Edit modal and the bulk-deploy-to-selected-devices modal share this exact
// same set of preset buttons (winget/choco install/uninstall by ID, diagnostics) - targetId lets
// each modal point the same preset logic at its own textarea/input pair instead of duplicating
// every button.
export function fillWorkspaceCommand(command, targetId) {
  const el = document.getElementById(targetId || 'wd-edit-command');
  if (el) el.value = command;
}

function workspacePackageId(inputId) {
  const id = document.getElementById(inputId || 'wd-edit-pkgid')?.value.trim();
  if (!id) toast('Enter a winget Package ID first', 'error');
  return id || null;
}

export function fillWorkspaceInstallById(inputId, targetId) {
  const id = workspacePackageId(inputId);
  if (id) fillWorkspaceCommand(`winget install -e --id ${id} --silent --accept-package-agreements --accept-source-agreements`, targetId);
}

export function fillWorkspaceUninstallById(inputId, targetId) {
  const id = workspacePackageId(inputId);
  if (id) fillWorkspaceCommand(`winget uninstall -e --id ${id} --silent`, targetId);
}

function workspaceChocoPackageId(inputId) {
  const id = document.getElementById(inputId || 'wd-edit-chocoid')?.value.trim();
  if (!id) toast('Enter a Chocolatey package ID first', 'error');
  return id || null;
}

export function fillWorkspaceChocoInstallById(inputId, targetId) {
  const id = workspaceChocoPackageId(inputId);
  if (id) fillWorkspaceCommand(`choco install ${id} -y`, targetId);
}

export function fillWorkspaceChocoUninstallById(inputId, targetId) {
  const id = workspaceChocoPackageId(inputId);
  if (id) fillWorkspaceCommand(`choco uninstall ${id} -y`, targetId);
}

// Lets a queued Run Command be a full .bat script instead of just a single PowerShell line - the
// agent tells the two apart by an "::BATCH" marker line (a real, valid batch no-op, so no extra
// pending_command_type column is needed) prepended before saving; see Invoke-PendingCommand in the
// installed shell for the executing side. batchType defaults to 'powershell' when not passed (a
// brand new device/blank textarea).
function commandTypeRadiosHtml(targetId, batchType) {
  const name = `${targetId}-type`;
  return `<div class="small" style="display:flex;gap:14px;margin:6px 0;">
    <label style="display:flex;align-items:center;gap:5px;font-weight:400;"><input type="radio" name="${name}" value="powershell" ${batchType === 'batch' ? '' : 'checked'} style="width:auto;"> PowerShell command</label>
    <label style="display:flex;align-items:center;gap:5px;font-weight:400;"><input type="radio" name="${name}" value="batch" ${batchType === 'batch' ? 'checked' : ''} style="width:auto;"> Batch script (.bat)</label>
  </div>`;
}

function commandTypeFor(targetId) {
  return document.querySelector(`input[name="${targetId}-type"]:checked`)?.value || 'powershell';
}

// Strips the leading marker (if present) so the textarea shows the admin's actual script back to
// them, not the internal marker line - paired with commandTypeRadiosHtml pre-selecting Batch.
function stripBatchMarker(command) {
  return (command || '').replace(/^\s*::BATCH\r?\n/, '');
}

// Renders the shared preset-button rows (winget/choco install-by-ID, diagnostics) used by both the
// per-device Edit modal and the bulk-deploy modal, pointed at whichever textarea/input pair belongs
// to that modal.
function commandPresetsHtml(pkgInputId, chocoInputId, targetId) {
  return `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
      <span class="small muted" style="align-self:center;">Install:</span>
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget install -e --id 7zip.7zip --silent --accept-package-agreements --accept-source-agreements', '${targetId}')">7-Zip</button>
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget install -e --id Google.Chrome --silent --accept-package-agreements --accept-source-agreements', '${targetId}')">Chrome</button>
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget install -e --id AnyDeskSoftwareGmbH.AnyDesk --silent --accept-package-agreements --accept-source-agreements', '${targetId}')">AnyDesk</button>
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget install -e --id TeamViewer.TeamViewer --silent --accept-package-agreements --accept-source-agreements', '${targetId}')">TeamViewer</button>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
      <span class="small muted" style="align-self:center;">Uninstall:</span>
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget uninstall -e --id 7zip.7zip --silent', '${targetId}')">7-Zip</button>
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget uninstall -e --id Google.Chrome --silent', '${targetId}')">Chrome</button>
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget uninstall -e --id AnyDeskSoftwareGmbH.AnyDesk --silent', '${targetId}')">AnyDesk</button>
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget uninstall -e --id TeamViewer.TeamViewer --silent', '${targetId}')">TeamViewer</button>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;align-items:center;">
      <span class="small muted">Any winget package:</span>
      <input id="${pkgInputId}" placeholder="Package ID, e.g. VideoLAN.VLC" style="flex:1;min-width:160px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px;">
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceInstallById('${pkgInputId}', '${targetId}')">Install</button>
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceUninstallById('${pkgInputId}', '${targetId}')">Uninstall</button>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;align-items:center;">
      <span class="small muted">Any Chocolatey package:</span>
      <input id="${chocoInputId}" placeholder="Package ID, e.g. vlc" style="flex:1;min-width:160px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px;">
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceChocoInstallById('${chocoInputId}', '${targetId}')">Install</button>
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceChocoUninstallById('${chocoInputId}', '${targetId}')">Uninstall</button>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
      <span class="small muted" style="align-self:center;">Diagnostics:</span>
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('Get-DuDataUsage | ConvertTo-Json', '${targetId}')">Test DU Scrape</button>
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget list', '${targetId}')">List Installed (winget)</button>
      <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('choco list --local-only', '${targetId}')">List Installed (choco)</button>
    </div>`;
}

// Lets an admin queue an actual installer package (not just a script referencing a URL) - uploads
// the file to the private agent-installers bucket, mints a signed URL (expires in 7 days - long
// enough to survive this device's next check-in even at the slow end of its 6-hourly cadence), and
// writes a PowerShell one-liner that downloads and runs it silently. The signed URL is what lets
// the agent's plain Invoke-WebRequest through despite the bucket itself staying private - nothing
// else needs to be public.
function installerUploadHtml(fileInputId, argsInputId, targetId) {
  return `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;align-items:center;">
      <span class="small muted">Deploy an installer (.exe/.msi):</span>
      <input type="file" id="${fileInputId}" accept=".exe,.msi" style="flex:1;min-width:160px;font-size:12px;">
      <input id="${argsInputId}" placeholder="Silent args (.exe only, e.g. /S or /verysilent)" style="flex:1;min-width:160px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px;">
      <button type="button" class="btn-sm" onclick="App.uploadWorkspaceInstaller('${fileInputId}', '${argsInputId}', '${targetId}')">Upload &amp; Queue Install</button>
    </div>
    <div class="small muted" style="margin-bottom:6px;">.msi always installs silently on its own (/qn /norestart) - no args needed. For a .exe, the right silent flag depends on what built the installer: NSIS &rarr; <code>/S</code>, Inno Setup &rarr; <code>/VERYSILENT /SUPPRESSMSGBOXES /NORESTART</code>, InstallShield &rarr; <code>/s /v"/qn"</code>, most others &rarr; <code>/quiet</code> or <code>/silent</code>. Leaving it blank launches the installer's normal on-screen wizard - which nobody can click through, since the agent runs in a background SYSTEM session with no visible desktop at all (not even someone standing at the screen could interact with it). A run with no silent args (or the wrong one) now times out and gets killed after 5 minutes instead of hanging that PC's check-in indefinitely.</div>`;
}

export async function uploadWorkspaceInstaller(fileInputId, argsInputId, targetId) {
  const fileInput = document.getElementById(fileInputId);
  const file = fileInput?.files?.[0];
  if (!file) { toast('Choose a .exe or .msi file first', 'error'); return; }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext !== 'exe' && ext !== 'msi') { toast('Only .exe or .msi files are supported', 'error'); return; }
  const silentArgs = (document.getElementById(argsInputId)?.value || '').trim();
  const path = `installers/${crypto.randomUUID()}-${file.name}`;
  try {
    toast('Uploading...');
    const { error: uploadError } = await supabase.storage.from('agent-installers').upload(path, file, { contentType: 'application/octet-stream' });
    if (uploadError) throw uploadError;
    // 7 days - long enough to survive this device's next check-in even at the slow end of its
    // 6-hourly cadence, or a PC that's been powered off for a few days.
    const { data: signed, error: signError } = await supabase.storage.from('agent-installers').createSignedUrl(path, 604800);
    if (signError) throw signError;
    const localPath = `$env:TEMP\\${file.name}`;
    // -PassThru + WaitForExit(ms) instead of a bare -Wait - a .exe deployed with no silent args (or
    // the wrong one for its installer framework) launches a UI that's invisible and unclickable
    // anyway, since the agent runs in a background SYSTEM session with no desktop - -Wait alone
    // would hang that PC's check-in forever waiting for a window nobody can ever interact with. 5
    // minutes is generous for a real silent install; anything still running past that almost
    // certainly needs a different silent flag, not more time.
    const timeoutMs = 5 * 60 * 1000;
    // A bare string statement (not Write-Warning) so it actually lands in Last Command Output on
    // the dashboard - Invoke-PendingCommand only merges the error stream into its captured output
    // (2>&1), not the separate warning stream Write-Warning writes to.
    const command = ext === 'msi'
      ? `Invoke-WebRequest -Uri "${signed.signedUrl}" -OutFile "${localPath}" -UseBasicParsing; $__p = Start-Process msiexec.exe -ArgumentList '/i "${localPath}" /qn /norestart' -PassThru; if (-not $__p.WaitForExit(${timeoutMs})) { Stop-Process -Id $__p.Id -Force -ErrorAction SilentlyContinue; "Install timed out after 5 minutes" } else { "Install exited with code $($__p.ExitCode)" }; Remove-Item "${localPath}" -Force -ErrorAction SilentlyContinue`
      : `Invoke-WebRequest -Uri "${signed.signedUrl}" -OutFile "${localPath}" -UseBasicParsing; $__p = Start-Process "${localPath}"${silentArgs ? ` -ArgumentList '${silentArgs}'` : ''} -PassThru; if (-not $__p.WaitForExit(${timeoutMs})) { Stop-Process -Id $__p.Id -Force -ErrorAction SilentlyContinue; "Install timed out after 5 minutes - likely missing or incorrect silent install args" } else { "Install exited with code $($__p.ExitCode)" }; Remove-Item "${localPath}" -Force -ErrorAction SilentlyContinue`;
    fillWorkspaceCommand(command, targetId);
    toast(`${file.name} uploaded - review the generated command below, then Save/Queue.`);
  } catch (e) {
    toast(e.message || 'Upload failed', 'error');
  }
}

// Cross-references this PC with the screen it drives in the Broadsign/Grassfish Console, by the
// same Player Box ID those syncs themselves match on (see broadsign-sync/grassfish-sync) - so an
// admin can see "this PC is behind screen X at location Y" without leaving Digital Directory.
function matchedScreenFor(d, assetInventory) {
  if (!Array.isArray(assetInventory)) return null;
  const id = (d.broadsign_player_id || '').trim();
  const gfId = (d.grassfish_box_id || '').trim();
  if (id) {
    const row = assetInventory.find((r) => r.player_type === 'Broadsign' && String(r.player_box_id || '').trim() === id);
    if (row) return { source: 'Broadsign', row };
  }
  if (gfId) {
    const row = assetInventory.find((r) => r.player_type === 'Grassfish' && String(r.player_box_id || '').trim().toLowerCase() === gfId.toLowerCase());
    if (row) return { source: 'Grassfish', row };
  }
  return null;
}

function matchedScreenHtml(matched) {
  if (!matched) return '<span class="small muted">-</span>';
  const { source, row } = matched;
  return `<span class="small">${esc(source)}: <b>${esc(row.name)}</b>${row.venue ? ` @ ${esc(row.venue)}` : ''}</span>`;
}

// A diagonally-striped fill with the percentage centered inside the bar itself, rather than as
// separate text next to a plain fill - used everywhere a single at-a-glance percentage matters
// (a volume's free space, data used vs. plan) so Volumes/Data Usage/Status read consistently.
// min-width is deliberately small (just enough for the "NN%" label to stay legible) rather than a
// comfortable bar width. It used to be 90px, which a fixed-layout table column can't honour: the
// bar sits in a flex row next to a "C:"/"D:" label inside a ~92px cell, so 90px + label + gap
// overflowed by roughly 24px and painted over the neighbouring Status column - a stray green sliver
// next to the Online dot. Callers that have room give the bar a flexible wrapper to fill instead.
function stripedBarHtml(pct, color) {
  const clamped = Math.max(0, Math.min(100, pct));
  return `<div style="position:relative;height:20px;border-radius:5px;overflow:hidden;background:var(--bg);border:1px solid var(--border);min-width:34px;">
    <div style="width:${clamped.toFixed(1)}%;height:100%;background-color:${color};background-image:repeating-linear-gradient(45deg, rgba(255,255,255,.28) 0, rgba(255,255,255,.28) 5px, transparent 5px, transparent 10px);"></div>
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.55);">${clamped.toFixed(0)}%</div>
  </div>`;
}

// Same green/red dot everywhere a device's reachability is shown, instead of each place inventing
// its own Online/Offline treatment. Deliberately dot-only, no word beside it: the colour already
// carries the whole meaning, and in the All Devices table the label was repeating the same two
// words down every row for no added information. The state stays available as a tooltip and to
// screen readers via title, so dropping the visible text loses nothing.
function statusDotHtml(online, labelled) {
  const color = online ? '#1f9d55' : '#c0392b';
  // Bigger in the busy All Devices table (labelled) than on the SIM Data Usage tile above - a plain
  // 10px dot easily gets lost among everything else in a dense table row.
  const size = labelled ? 13 : 10;
  const dot = `<span title="${online ? 'Online' : 'Offline'}" style="display:inline-block;width:${size}px;height:${size}px;border-radius:50%;background:${color};box-shadow:0 0 0 3px ${online ? 'rgba(31,157,85,.2)' : 'rgba(192,57,43,.2)'};flex:none;"></span>`;
  if (!labelled) return dot;
  // Centred in its column, so a scan down the Status column reads as one clean line of dots rather
  // than left-ragged marks. The header cell is centred to match (see the Status th).
  return `<span style="display:flex;justify-content:center;align-items:center;">${dot}</span>`;
}

// Same striped-bar treatment as the Details modal's Volumes table (see registerModal
// 'workspaceDetails' below), one row per drive. This used to collapse to just the single worst-off
// drive, which hid the rest entirely - a PC with a nearly-full D: alongside a healthy C: looked
// identical to a PC that only has a C:, and there was no way to tell from the table which it was.
// Every fixed disk the agent reported now gets its own labelled bar, stacked, since a signage PC
// typically only has one or two and the column has room for them.
function volumeCellHtml(d) {
  const volumes = d.volumes || [];
  if (!volumes.length) return '<span class="small muted">-</span>';
  // Worst-off drive first, so whatever most needs attention is the one nearest the row's baseline
  // rather than depending on whichever order the agent happened to enumerate disks in.
  const sorted = [...volumes].sort((a, b) => {
    const aPct = a.sizeGb > 0 ? a.freeGb / a.sizeGb : 1;
    const bPct = b.sizeGb > 0 ? b.freeGb / b.sizeGb : 1;
    return aPct - bPct;
  });
  const rows = sorted.map((v) => {
    const freePct = v.sizeGb > 0 ? (v.freeGb / v.sizeGb) * 100 : 0;
    const color = freePct <= 10 ? '#c0392b' : freePct <= 25 ? '#e07a2c' : '#1f9d55';
    // Bar fills to the CONSUMED percentage (same convention as the Data Usage bar) - filling it to
    // the free percentage instead reads backwards, since a mostly-full green bar looked like
    // "consuming a lot of space" when it actually meant the opposite (mostly free). Danger color
    // thresholds still key off free space, unchanged.
    // The bar goes in a flexible, shrinkable wrapper (min-width:0 is what actually lets a flex item
    // shrink below its content size) so it fills whatever the label leaves and never spills out of
    // the fixed-width column.
    return `<div style="display:flex;align-items:center;gap:6px;" title="${esc(v.drive)}${v.label ? ` (${esc(v.label)})` : ''} - ${v.freeGb} of ${v.sizeGb} GB free">
      <span class="small muted" style="flex:none;">${esc(v.drive)}</span><div style="flex:1;min-width:0;">${stripedBarHtml(100 - freePct, color)}</div>
    </div>`;
  }).join('');
  return `<div style="display:flex;flex-direction:column;gap:4px;">${rows}</div>`;
}

// Same used/total percentage math as the SIM Data Usage tile above, collapsed to a single striped
// pipe (matching volumeCellHtml's treatment of Volume) so the main table gives an at-a-glance data
// warning without needing to scroll to the tile grid - positioned before Volume since data running
// out is the more time-sensitive of the two (a full disk is rarely urgent; a cut-off SIM is).
function dataUsageCellHtml(d, sim) {
  const { haveDu, allocGb, usedGb, phone } = duUsageInfo(d, sim);
  // The phone number is shown whenever the scrape got far enough to report one, regardless of
  // whether a usable total came with it - previously it only appeared as a fallback for when
  // there was NO bar at all, so it silently disappeared the moment a total showed up (including a
  // bogus one, like an unlimited-plan account whose "total" renders as an oversized placeholder
  // rather than a real figure) - exactly the case where seeing the number matters most.
  const phoneHtml = phone ? `<div class="small muted" style="white-space:nowrap;line-height:1.3;">${esc(phone)}</div>` : '';
  if (!allocGb) {
    // A bare dash is the normal, expected state for a PC that reaches the internet over Wi-Fi or
    // LAN rather than through its DU SIM: mydata.du.ae identifies the subscriber from the
    // connection itself, so off-SIM there is genuinely nothing to read and no amount of retrying
    // will produce a figure. Kept as a dash rather than an error, with the reason in a tooltip so
    // the mark doesn't read as a fault.
    return phoneHtml || '<span class="small muted" title="No DU data - this PC reaches the internet over Wi-Fi/LAN rather than its SIM, so the carrier page has nothing to report for it.">-</span>';
  }
  const pct = Math.min(100, (usedGb / allocGb) * 100);
  const color = pct >= 80 ? '#c0392b' : pct >= 70 ? '#e07a2c' : '#1f9d55';
  return `<div title="${fmtGb(usedGb)} of ${fmtGb(allocGb)} used${haveDu ? ' (DU)' : ''}">${phoneHtml}${stripedBarHtml(pct, color)}</div>`;
}

function deviceRow(d, editOk, deleteOk, assetInventory, selectedIds, sim) {
  const online = isOnline(d);
  const problemCount = visibleProblems(d).length;
  return `<tr>
    ${editOk ? `<td style="width:24px;"><input type="checkbox" ${(selectedIds || new Set()).has(d.id) ? 'checked' : ''} onchange="App.toggleWorkspaceSelection('${d.id}', this.checked)"></td>` : ''}
    <td><b>${esc(d.hostname)}</b></td>
    <td class="small">${esc(d.location || '-')}</td>
    <td class="small" style="white-space:nowrap;">${esc(d.ip_address || '-')}</td>
    <td>${remoteAccessButtonHtml(d)}</td>
    <td>${dataUsageCellHtml(d, sim)}</td>
    <td>${volumeCellHtml(d)}</td>
    <td style="white-space:nowrap;">${statusDotHtml(online, true)}</td>
    <td>${matchedScreenHtml(matchedScreenFor(d, assetInventory))}</td>
    <td class="small">${esc(d.os_name || '-')}${d.os_version ? ` <span class="muted">${esc(d.os_version)}</span>` : ''}</td>
    <td class="small">${esc(d.logged_in_user || '-')}</td>
    <td>${problemCount ? `<span class="badge b-red">${problemCount} issue${problemCount === 1 ? '' : 's'}</span>` : '<span class="badge b-blue">OK</span>'}</td>
    <td class="small">${d.last_seen ? esc(fmtRelativeTime(d.last_seen)) : 'never'}${d.force_checkin_requested ? '<div class="small muted">(pull requested)</div>' : ''}</td>
    <td style="white-space:nowrap;">
      <button class="btn-sm" onclick="App.openWorkspaceDetailsModal('${d.id}')">Details</button>
      ${editOk ? `<button class="btn-sm" onclick="App.openWorkspaceEditModal('${d.id}')">Edit</button>` : ''}
      ${editOk ? `<button class="btn-sm" title="${d.force_checkin_requested ? 'Already requested and still pending - click to re-request' : (d.pending_command ? 'Push the queued Run Command to this PC now' : 'Pull fresh inventory from this PC now')} - within ~20 minutes instead of waiting for its next scheduled cycle" onclick="App.forceWorkspaceInventoryPull('${d.id}')">Force${d.force_checkin_requested ? ' Again' : ''}</button>` : ''}
      ${deleteOk ? `<button class="btn-sm" onclick="App.removeWorkspaceDevice('${d.id}')">Delete</button>` : ''}
    </td>
  </tr>`;
}

// Shared by the Data Usage column, the SIM Data Usage tile, and the Details modal - DU (the
// carrier's own figures, scraped from mydata.du.ae) is preferred whenever present, since the
// network-adapter-counter estimate is only ever an approximation of real billed usage. The phone
// number specifically can show up well before the GB figures do (the scrape's regex for the usage
// bar can fail to match while the phone number - shown in the page's static header - still parses
// fine), so it's returned on its own rather than only alongside a completed total/used pair.
function duUsageInfo(d, sim) {
  const haveDu = !!d.du_scraped_at;
  const allocGb = haveDu && d.du_data_total_gb != null ? Number(d.du_data_total_gb) : (Number(sim?.data_allocation_gb) || 0);
  const usedGb = haveDu && d.du_data_used_gb != null ? Number(d.du_data_used_gb) : (d.data_used_mb_period || 0) / 1024;
  const leftGb = haveDu && d.du_data_left_gb != null ? Number(d.du_data_left_gb) : Math.max(0, allocGb - usedGb);
  const phone = d.du_phone_number || sim?.sim_number || sim?.iccid || '';
  return { haveDu, allocGb, usedGb, leftGb, phone };
}

// Plans across this fleet span five orders of magnitude - 6 GB kiosk SIMs alongside one whose plan
// genuinely reads in the petabytes - so a fixed "N GB" label is unreadable at the top end
// ("10239016 GB" tells nobody anything). Scales to TB/PB only once the number is large enough to
// warrant it, leaving ordinary plan sizes displayed exactly as before.
function fmtGb(gb) {
  const n = Number(gb);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} PB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} TB`;
  // Whole numbers stay whole (a 6 GB plan reads "6 GB", not "6.00 GB"); fractional usage keeps two
  // decimals, which is the precision the DU page itself reports.
  return `${Number.isInteger(n) ? n : n.toFixed(2)} GB`;
}

function dataUsageTile(d, sim) {
  const { haveDu, allocGb, usedGb, leftGb, phone } = duUsageInfo(d, sim);
  const last24hGb = (d.data_used_mb_last_24h || 0) / 1024;
  const pct = allocGb ? Math.min(100, (usedGb / allocGb) * 100) : 0;
  const color = pct >= 80 ? '#c0392b' : pct >= 70 ? '#e07a2c' : '#1f9d55';
  return `<div style="background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <div>
        <div style="font-size:12.5px;font-weight:700;">${esc(d.hostname)}</div>
        <div class="small muted">${esc(d.location || 'Unassigned')}${phone ? ` &middot; ${esc(phone)}` : ''}${haveDu ? ' &middot; <span style="color:#1f9d55;">DU</span>' : ''}</div>
      </div>
      ${statusDotHtml(isOnline(d))}
    </div>
    ${allocGb ? stripedBarHtml(pct, color) : '<div class="small muted">No plan size set - link a SIM Card or wait for a DU scrape.</div>'}
    <div class="small" style="display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;">
      <span class="muted">Total Data</span><span style="text-align:right;">${allocGb ? fmtGb(allocGb) : '&mdash;'}</span>
      <span class="muted">Data Used</span><span style="text-align:right;">${fmtGb(usedGb)}</span>
      <span class="muted">Data Left</span><span style="text-align:right;">${allocGb ? fmtGb(leftGb) : '&mdash;'}</span>
      <span class="muted">Last 24h</span><span style="text-align:right;">${fmtGb(last24hGb)}</span>
      <span class="muted">${haveDu ? 'DU Last Update' : 'Last Update'}</span><span style="text-align:right;">${haveDu ? fmtRelativeTime(d.du_scraped_at) : (d.last_seen ? fmtRelativeTime(d.last_seen) : '&mdash;')}</span>
    </div>
    ${d.notes ? `<div class="small muted" style="border-top:1px solid var(--border);padding-top:6px;white-space:pre-wrap;">${esc(d.notes)}</div>` : ''}
  </div>`;
}

export function renderWorkspaceDirectory() {
  const devices = loadData('workspaceDevices', listWorkspaceDevices);
  const simCards = loadData('simCardsForDirectory', listSimCards);
  // Same cache key other pages (Settings, Gantt) already use for the full Asset Inventory table -
  // reuses whatever's already fetched instead of pulling a second copy of a large table.
  const assetInventory = loadData('assetInventory', listAssetInventory);
  const ghostDevices = loadData('ghostWorkspaceDevices', listGhostWorkspaceDevices);
  if (devices === null || simCards === null || assetInventory === null) return loadingCard();
  if (devices?.__error) return loadingCard(devices.__error);
  if (simCards?.__error) return loadingCard(simCards.__error);
  if (assetInventory?.__error) return loadingCard(assetInventory.__error);
  const ghostHtml = ghostBannerHtml(Array.isArray(ghostDevices) ? ghostDevices : []);

  if (!devices.length) {
    return `${ghostHtml}<div class="card"><div class="empty">No devices have checked in yet. Install the agent (Settings &gt; Integrations &gt; Jstar Agent) on a PC and it'll appear here within a few minutes of install (after that, it checks in every 6 hours).</div></div>`;
  }

  const simById = new Map(simCards.map((s) => [s.id, s]));
  const online = devices.filter(isOnline).length;
  const offline = devices.length - online;
  const withProblems = devices.filter((d) => visibleProblems(d).length).length;

  const byLocation = new Map();
  devices.forEach((d) => {
    const loc = (d.location || '').trim() || 'Unassigned';
    if (!byLocation.has(loc)) byLocation.set(loc, []);
    byLocation.get(loc).push(d);
  });
  const locations = [...byLocation.keys()].sort((a, b) => (a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b)));
  const tiles = locations.map((loc) => locationTile(loc, byLocation.get(loc))).join('');

  const dataDevices = devices.filter((d) => d.sim_card_id || d.du_scraped_at);

  // One summary banner, not a tile per over-limit device - a screen close to running out of SIM
  // data is the kind of thing that needs to be seen the moment the page loads, not discovered by
  // scrolling through every tile in the grid below. Same 80% threshold as dataUsageCellHtml/
  // dataUsageTile's own red coloring, computed once here from the same duUsageInfo() both of those
  // already use, so all three agree on what counts as "over".
  const overLimitDevices = dataDevices
    .map((d) => {
      const { allocGb, usedGb } = duUsageInfo(d, simById.get(d.sim_card_id));
      return { device: d, pct: allocGb ? (usedGb / allocGb) * 100 : 0 };
    })
    .filter((x) => x.pct >= 80)
    .sort((a, b) => b.pct - a.pct);
  const overLimitBannerHtml = overLimitDevices.length
    ? `<div class="banner" style="background:#c0392b;color:#fff;border-color:#c0392b;display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
        <div style="flex:1;min-width:220px;">
          <b>${overLimitDevices.length} device${overLimitDevices.length === 1 ? '' : 's'} over 80% of its SIM data plan</b>
          <div class="small" style="opacity:.9;margin-top:2px;">${overLimitDevices.map((x) => `${esc(x.device.hostname)} (${x.pct.toFixed(0)}%)`).join(', ')}</div>
        </div>
      </div>`
    : '';

  const dataTilesHtml = dataDevices.length
    ? `<div class="card">
        <div class="card-head"><h3>SIM Data Usage</h3><div class="desc">Devices linked to a SIM Card record (Edit &gt; Linked SIM Card), or that have their own DU scrape. A tile marked <span style="color:#1f9d55;">DU</span> is showing du's own carrier-reported figures (scraped from mydata.du.ae once a day, no login - works when that PC's internet actually goes out over the SIM); otherwise Total/Used/Left fall back to an estimate from the PC's network adapter counters against the linked SIM Card's plan size. Last 24h is always the counter-based estimate, recomputed about once a day even though the agent itself checks in every 6 hours. Comments shown below a tile come from that device's Notes (Edit).</div></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;">
          ${dataDevices.map((d) => dataUsageTile(d, simById.get(d.sim_card_id))).join('')}
        </div>
      </div>`
    : '';

  const search = (STATE.workspaceDirectorySearch || '').trim().toLowerCase();
  const filtered = search
    ? devices.filter((d) => `${d.hostname} ${d.location || ''} ${d.ip_address || ''} ${d.anydesk_id || ''} ${d.teamviewer_id || ''} ${d.logged_in_user || ''} ${d.os_name || ''}`.toLowerCase().includes(search))
    : devices;
  const sorted = applySort(filtered, 'workspaceDevices', {
    hostname: (d) => d.hostname || '',
    location: (d) => d.location || '',
    ip: (d) => d.ip_address || '',
    os: (d) => d.os_name || '',
    user: (d) => d.logged_in_user || '',
    problems: (d) => (d.problems || []).length,
    lastSeen: (d) => d.last_seen || '',
  });

  const editOk = canEdit('workspaceDirectory');
  const deleteOk = canDelete('workspaceDirectory');
  const selectedIds = new Set(STATE.workspaceDirectorySelectedIds || []);
  const sortedIds = sorted.map((d) => d.id);
  const allSelected = sortedIds.length > 0 && sortedIds.every((id) => selectedIds.has(id));
  const colCount = editOk ? 14 : 13;
  const rows = sorted.map((d) => deviceRow(d, editOk, deleteOk, assetInventory, selectedIds, simById.get(d.sim_card_id))).join('')
    || `<tr><td colspan="${colCount}"><div class="empty">No devices match "${esc(STATE.workspaceDirectorySearch || '')}".</div></td></tr>`;

  return `
    ${ghostHtml}
    ${overLimitBannerHtml}
    <div class="kpi-row" style="margin-bottom:14px;">
      <div class="kpi"><div class="label">Total Devices</div><div class="value">${devices.length}</div></div>
      <div class="kpi"><div class="label">Online</div><div class="value" style="color:#1f9d55;">${online}</div></div>
      <div class="kpi"><div class="label">Offline</div><div class="value" style="color:#c0392b;">${offline}</div></div>
      <div class="kpi"><div class="label">With Issues</div><div class="value" style="color:${withProblems ? '#c0392b' : 'inherit'};">${withProblems}</div></div>
      <div class="kpi"><div class="label">Locations</div><div class="value">${locations.length}</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>By Location</h3><div class="desc">Click a location to see its devices. Set a device's Location from the Edit button in the table below.</div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;">${tiles}</div>
    </div>
    ${dataTilesHtml}
    ${editOk && selectedIds.size > 0 ? `<div class="banner" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <span><b>${selectedIds.size}</b> device${selectedIds.size === 1 ? '' : 's'} selected</span>
      <div style="display:flex;gap:8px;">
        <button class="btn-sm" title="Pull fresh inventory (or push each one's queued command) within ~20 minutes instead of waiting for its next scheduled cycle" onclick="App.bulkForceWorkspaceInventoryPull()">Force Selected</button>
        <button class="btn-sm" onclick="App.openWorkspaceBulkDeployModal()">Deploy to Selected</button>
        <button class="btn-sm" onclick="App.clearWorkspaceSelection()">Clear Selection</button>
      </div>
    </div>` : ''}
    <div class="card">
      <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div><h3>All Devices</h3><div class="desc">${filtered.length} of ${devices.length} device(s) shown. Offline = no check-in for ${STALE_AFTER_MINUTES}+ minutes (a light check-in runs every 20 minutes; remote-access/OS/antivirus info updates roughly every 6 hours when changed; software/hardware/disk info and the DU data-usage scrape update once a day at 8 AM).${editOk ? ' Tick devices below to deploy a command (install/uninstall software, etc.) to several at once.' : ''}</div></div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <input placeholder="Search hostname, location, IP, remote ID, user..." value="${esc(STATE.workspaceDirectorySearch || '')}" oninput="App.setWorkspaceDirectorySearch(this.value)" style="min-width:240px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;">
          <button class="btn-sm" title="Reload this page's data without refreshing the whole app" onclick="App.refreshWorkspaceDirectory()">&#8635; Refresh</button>
        </div>
      </div>
      <div style="max-height:520px;overflow-y:auto;overflow-x:auto;">
        <table style="${FIXED_TABLE_STYLE}">
          <thead><tr>
            ${editOk ? `<th style="width:24px;"><input type="checkbox" ${allSelected ? 'checked' : ''} onchange='App.toggleWorkspaceSelectAll(this.checked, ${jsonAttr(sortedIds)})' title="Select all shown"></th>` : ''}
            ${sortTh('workspaceDevices', 'hostname', 'Hostname', 14)}
            ${sortTh('workspaceDevices', 'location', 'Location', 12)}
            ${sortTh('workspaceDevices', 'ip', 'IP', 15)}
            <th style="width:15ch;">Remote Access</th>
            <th style="width:14ch;">Data Usage</th>
            <th style="width:14ch;">Volume</th>
            <th style="width:13ch;text-align:center;">Status</th>
            <th style="width:20ch;">Matched Screen</th>
            ${sortTh('workspaceDevices', 'os', 'OS', 16)}
            ${sortTh('workspaceDevices', 'user', 'Logged-in User', 19)}
            ${sortTh('workspaceDevices', 'problems', 'Issues', 10)}
            ${sortTh('workspaceDevices', 'lastSeen', 'Last Seen', 27)}
            <th style="width:18ch;"></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

// Re-fetches just this page's own cached data (devices, SIM cards, asset inventory) instead of a
// full app reload - loadData()'s cache is keyed per data-source, so invalidating only these three
// keys leaves every other page's cache (and the user's current view) untouched.
export function refreshWorkspaceDirectory() {
  invalidate('workspaceDevices');
  invalidate('simCardsForDirectory');
  invalidate('assetInventory');
  setState({});
  toast('Refreshed');
}

export function setWorkspaceDirectorySearch(value) { setState({ workspaceDirectorySearch: value }); }

export function toggleWorkspaceSelection(id, checked) {
  const cur = new Set(STATE.workspaceDirectorySelectedIds || []);
  if (checked) cur.add(id); else cur.delete(id);
  setState({ workspaceDirectorySelectedIds: [...cur] });
}

export function toggleWorkspaceSelectAll(checked, ids) {
  setState({ workspaceDirectorySelectedIds: checked ? ids : [] });
}

export function clearWorkspaceSelection() { setState({ workspaceDirectorySelectedIds: [] }); }

export function openWorkspaceBulkDeployModal() {
  if (!(STATE.workspaceDirectorySelectedIds || []).length) { toast('Select at least one device first', 'error'); return; }
  openModal('workspaceBulkDeploy', {});
}

// Queues the SAME command (pending_command) on every selected device at once, rather than opening
// the per-device Edit modal one at a time - each device still only runs it on its own next
// check-in, exactly like a single Run Command, just fanned out over N devices in parallel.
export async function saveWorkspaceBulkDeploy(event) {
  event.preventDefault();
  const ids = STATE.workspaceDirectorySelectedIds || [];
  const command = document.getElementById('wd-bulk-command').value.trim();
  if (!ids.length) { toast('No devices selected', 'error'); return; }
  if (!command) { toast('Enter a command first', 'error'); return; }
  const stored = commandTypeFor('wd-bulk-command') === 'batch' ? `::BATCH\n${command}` : command;
  try {
    await Promise.all(ids.map((id) => updateWorkspaceDevice(id, { pending_command: stored })));
    await logAudit('Bulk queue Digital Directory command', `${ids.length} device(s): ${command}`);
    invalidate('workspaceDevices');
    closeModal();
    setState({ workspaceDirectorySelectedIds: [] });
    toast(`Queued on ${ids.length} device(s) - each runs it on its own next check-in.`);
  } catch (e) { toast(e.message || 'Failed to queue command', 'error'); }
}

export function openWorkspaceLocationModal(location) {
  openModal('workspaceLocation', { location });
}

export function openWorkspaceDetailsModal(deviceId) {
  openModal('workspaceDetails', { deviceId });
}

export function openWorkspaceEditModal(deviceId) {
  openModal('workspaceEdit', { deviceId });
}

export async function saveWorkspaceEditForm(event, deviceId) {
  event.preventDefault();
  const location = document.getElementById('wd-edit-location').value.trim();
  const notes = document.getElementById('wd-edit-notes').value.trim();
  const simCardId = document.getElementById('wd-edit-sim').value || null;
  const pendingCommand = document.getElementById('wd-edit-command').value.trim();
  const storedCommand = pendingCommand && commandTypeFor('wd-edit-command') === 'batch' ? `::BATCH\n${pendingCommand}` : pendingCommand;
  try {
    await updateWorkspaceDevice(deviceId, { location: location || null, notes: notes || null, sim_card_id: simCardId, pending_command: storedCommand || null });
    await logAudit('Edit workspace device', deviceId);
    invalidate('workspaceDevices');
    closeModal();
    toast(pendingCommand ? 'Device updated - command will run on its next check-in.' : 'Device updated');
    setState({});
  } catch (e) { toast(e.message || 'Failed to update device', 'error'); }
}

export async function clearWorkspacePendingCommand(deviceId) {
  try {
    await updateWorkspaceDevice(deviceId, { pending_command: null });
    invalidate('workspaceDevices');
    toast('Pending command cleared');
    setState({});
  } catch (e) { toast(e.message || 'Failed to clear command', 'error'); }
}

// One button, two effects depending on what's already true of the device - not really "pull" as a
// separate concept from "push": a forced check-in ALWAYS runs Invoke-Checkin, which (per the agent
// shell) executes any pending_command as part of that same check-in before reporting back - so if
// a Run Command is queued, forcing effectively pushes it out now instead of waiting on the device's
// own schedule; if nothing's queued, the same forced check-in just pulls fresh inventory instead.
// The dashboard can never reach OUT to these PCs directly - they're on metered SIMs behind
// NAT/cellular routers with no inbound reachability - so this only ever sets a flag that the
// agent's own hidden poll task (WorkspaceDirectoryAgentPoll, runs as SYSTEM every 20 minutes, no
// UI) picks up and acts on locally. Up to ~20 minutes' latency, not instant, but far faster than
// waiting for the next scheduled 6-hourly check-in - and runs regardless of whether anyone's
// signed into that PC, since it's a SYSTEM task rather than a signed-in-user one.
export async function forceWorkspaceInventoryPull(deviceId) {
  try {
    const devices = STATE.pageData.workspaceDevices?.data || [];
    const hasPending = !!devices.find((d) => d.id === deviceId)?.pending_command;
    await updateWorkspaceDevice(deviceId, { force_checkin_requested: true });
    await logAudit('Force Digital Directory check-in', deviceId);
    invalidate('workspaceDevices');
    toast(hasPending ? 'Queued command will be pushed within ~20 minutes.' : 'Requested - picked up within ~20 minutes.');
    setState({});
  } catch (e) { toast(e.message || 'Failed to request pull', 'error'); }
}

// Same idea as forceWorkspaceInventoryPull above, fanned out over every currently-selected device -
// each one still only gets picked up on its OWN next poll cycle (not simultaneously), same as a
// single-device Force.
export async function bulkForceWorkspaceInventoryPull() {
  const ids = STATE.workspaceDirectorySelectedIds || [];
  if (!ids.length) { toast('Select at least one device first', 'error'); return; }
  try {
    await Promise.all(ids.map((id) => updateWorkspaceDevice(id, { force_checkin_requested: true })));
    await logAudit('Bulk force Digital Directory check-in', `${ids.length} device(s)`);
    invalidate('workspaceDevices');
    toast(`${ids.length} device(s) will be picked up within ~20 minutes.`);
    setState({});
  } catch (e) { toast(e.message || 'Failed to request pull', 'error'); }
}

export async function resetWorkspaceDataUsage(deviceId) {
  if (!confirm('Reset this device\'s tracked data usage back to zero?')) return;
  try {
    await updateWorkspaceDevice(deviceId, { data_used_mb_period: 0, data_used_mb_last_24h: 0, data_usage_computed_at: null });
    await logAudit('Reset workspace device data usage', deviceId);
    invalidate('workspaceDevices');
    toast('Data usage reset');
    setState({});
  } catch (e) { toast(e.message || 'Failed to reset', 'error'); }
}

// Mutes a problem TYPE on this one device only (see visibleProblems/problemType in
// lib/workspaceProblems.js) - the agent's own next check-in still reports the same underlying
// problem text, this just stops it from counting toward Issues/showing in Problems here, until
// someone un-ignores it.
export async function ignoreWorkspaceProblemType(deviceId, type) {
  try {
    const devices = STATE.pageData.workspaceDevices?.data || [];
    const device = devices.find((d) => d.id === deviceId);
    const current = new Set(device?.ignored_problem_types || []);
    current.add(type);
    await updateWorkspaceDevice(deviceId, { ignored_problem_types: [...current] });
    await logAudit('Ignore Digital Directory problem type', `${deviceId}: ${type}`);
    invalidate('workspaceDevices');
    toast('Ignored - won\'t be highlighted as an issue on this screen again');
    setState({});
  } catch (e) { toast(e.message || 'Failed to ignore', 'error'); }
}

export async function unignoreWorkspaceProblemType(deviceId, type) {
  try {
    const devices = STATE.pageData.workspaceDevices?.data || [];
    const device = devices.find((d) => d.id === deviceId);
    const current = (device?.ignored_problem_types || []).filter((t) => t !== type);
    await updateWorkspaceDevice(deviceId, { ignored_problem_types: current });
    await logAudit('Un-ignore Digital Directory problem type', `${deviceId}: ${type}`);
    invalidate('workspaceDevices');
    toast('Un-ignored');
    setState({});
  } catch (e) { toast(e.message || 'Failed to un-ignore', 'error'); }
}

export async function removeWorkspaceDevice(id) {
  if (!confirm('Remove this device from the directory? If its agent is still running, it\'ll show up in a "Removed but still reporting" alert here instead of silently reappearing in the list.')) return;
  try {
    await deleteWorkspaceDevice(id);
    await logAudit('Delete workspace device', id);
    invalidate('workspaceDevices');
    invalidate('ghostWorkspaceDevices');
    closeModal();
    toast('Device removed');
    setState({});
  } catch (e) { toast(e.message || 'Failed to delete device', 'error'); }
}

// -------------------- removed-but-still-reporting ("ghost") devices --------------------
// hostname is unique, so removing a device is otherwise only cosmetic if its agent is still
// installed - the PC just re-creates the same row on its next check-in with no way to tell that
// apart from a genuinely new device. This banner is what actually surfaces that instead of letting
// it silently slip back into the directory.
function ghostBannerHtml(ghostDevices) {
  if (!ghostDevices.length) return '';
  const deleteOk = canDelete('workspaceDirectory');
  const rows = ghostDevices.map((d) => `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:6px 0;border-top:1px solid rgba(0,0,0,.08);">
      <span><b>${esc(d.hostname)}</b> <span class="small muted">checked in ${esc(fmtRelativeTime(d.last_seen))} - removed ${esc(fmtRelativeTime(d.removed_at))}</span></span>
      ${deleteOk ? `<div style="display:flex;gap:6px;">
        <button class="btn-sm" onclick="App.queueRemoteWorkspaceUninstall('${d.id}')">Uninstall Agent</button>
        <button class="btn-sm" onclick="App.restoreGhostWorkspaceDevice('${d.id}')">Restore to Directory</button>
        <button class="btn-sm" style="color:#c0392b;" onclick="App.permanentlyDeleteGhostWorkspaceDevice('${d.id}')">Delete Permanently</button>
      </div>` : ''}
    </div>
  `).join('');
  return `
    <div class="banner" style="border-color:#c0392b;background:rgba(192,57,43,.06);color:var(--text);margin-bottom:14px;">
      <div style="font-weight:600;color:#c0392b;">${ghostDevices.length} device${ghostDevices.length === 1 ? '' : 's'} removed from the directory ${ghostDevices.length === 1 ? 'is' : 'are'} still checking in</div>
      <div class="small muted" style="margin-top:2px;">Its agent (and scheduled tasks) are still running on the physical PC. Uninstall the agent remotely to stop it for good, restore it if it was removed by mistake, or delete it permanently if you don't need it tracked here at all.</div>
      ${rows}
    </div>
  `;
}

// Queues a special ::UNINSTALL marker (see Invoke-PendingCommand in the agent script) instead of
// the normal password-gated -Uninstall flow - that password exists to stop someone with only local/
// physical access to the PC from uninstalling it, which doesn't apply here: queuing this already
// required being signed into the dashboard with delete permission on this exact device, so that
// authentication IS the authorization. Runs on the device's next check-in (light or full, either
// picks up a pending_command) and reports back immediately once done, rather than waiting a second
// cycle like a normal Run Command - there's no "next cycle" to report on once its tasks are gone.
export async function queueRemoteWorkspaceUninstall(id) {
  if (!confirm('Remotely uninstall the Jstar Agent from this PC? Its scheduled tasks and local state will be removed on its next check-in (within ~20 minutes). This cannot be undone from here - the agent would need to be reinstalled locally on that PC to bring it back.')) return;
  try {
    await updateWorkspaceDevice(id, { pending_command: '::UNINSTALL' });
    await logAudit('Queue remote agent uninstall', id);
    invalidate('ghostWorkspaceDevices');
    toast('Uninstall queued - runs on this PC\'s next check-in');
    setState({});
  } catch (e) { toast(e.message || 'Failed to queue uninstall', 'error'); }
}

export async function restoreGhostWorkspaceDevice(id) {
  try {
    await restoreWorkspaceDevice(id);
    await logAudit('Restore workspace device', id);
    invalidate('workspaceDevices');
    invalidate('ghostWorkspaceDevices');
    toast('Restored to the directory');
    setState({});
  } catch (e) { toast(e.message || 'Failed to restore device', 'error'); }
}

export async function permanentlyDeleteGhostWorkspaceDevice(id) {
  if (!confirm('Permanently delete this device? Unlike Remove, this cannot be undone - if the agent is still installed, this hostname would simply reappear as a new device on its next check-in.')) return;
  try {
    await permanentlyDeleteWorkspaceDevice(id);
    await logAudit('Permanently delete workspace device', id);
    invalidate('ghostWorkspaceDevices');
    toast('Deleted permanently');
    setState({});
  } catch (e) { toast(e.message || 'Failed to delete device', 'error'); }
}

registerModal('workspaceLocation', (data) => {
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const assetInventory = STATE.pageData.assetInventory?.data || [];
  const simCards = STATE.pageData.simCardsForDirectory?.data || [];
  const simById = new Map(simCards.map((s) => [s.id, s]));
  const list = devices.filter((d) => ((d.location || '').trim() || 'Unassigned') === data.location);
  const editOk = canEdit('workspaceDirectory');
  const deleteOk = canDelete('workspaceDirectory');
  const selectedIds = new Set(STATE.workspaceDirectorySelectedIds || []);
  const rows = list.map((d) => deviceRow(d, editOk, deleteOk, assetInventory, selectedIds, simById.get(d.sim_card_id))).join('') || `<tr><td colspan="${editOk ? 14 : 13}"><div class="empty">No devices.</div></td></tr>`;
  return `
    <h3>${esc(data.location)} - ${list.length} device(s)</h3>
    <div style="max-height:60vh;overflow-y:auto;overflow-x:auto;">
      <table style="${FIXED_TABLE_STYLE}">
        <thead><tr>${editOk ? '<th style="width:24px;"></th>' : ''}<th style="width:14ch;">Hostname</th><th style="width:12ch;">Location</th><th style="width:15ch;">IP</th><th style="width:15ch;">Remote Access</th><th style="width:14ch;">Data Usage</th><th style="width:14ch;">Volume</th><th style="width:13ch;">Status</th><th style="width:20ch;">Matched Screen</th><th style="width:16ch;">OS</th><th style="width:19ch;">Logged-in User</th><th style="width:10ch;">Issues</th><th style="width:27ch;">Last Seen</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

registerModal('workspaceDetails', (data) => {
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const assetInventory = STATE.pageData.assetInventory?.data || [];
  const simCards = STATE.pageData.simCardsForDirectory?.data || [];
  const d = devices.find((x) => x.id === data.deviceId);
  if (!d) return `<div class="empty">Device not found.</div><div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>`;
  const matched = matchedScreenFor(d, assetInventory);
  const editOk = canEdit('workspaceDirectory');
  const sim = simCards.find((s) => s.id === d.sim_card_id);
  const { haveDu, allocGb, usedGb, leftGb, phone } = duUsageInfo(d, sim);
  const usagePct = allocGb ? Math.min(100, (usedGb / allocGb) * 100) : 0;
  const usageColor = usagePct >= 80 ? '#c0392b' : usagePct >= 70 ? '#e07a2c' : '#1f9d55';
  const dataUsageHtml = !phone && !allocGb
    ? '<div class="empty">No data usage reported yet.</div>'
    : `<div class="small" style="display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;">
        ${phone ? `<span class="muted">Phone Number</span><span style="text-align:right;">${esc(phone)}</span>` : ''}
        <span class="muted">Total Data</span><span style="text-align:right;">${allocGb ? fmtGb(allocGb) : '&mdash;'}</span>
        <span class="muted">Data Used</span><span style="text-align:right;">${allocGb ? fmtGb(usedGb) : '&mdash;'}</span>
        <span class="muted">Data Left</span><span style="text-align:right;">${allocGb ? fmtGb(leftGb) : '&mdash;'}</span>
        <span class="muted">${haveDu ? 'DU Last Update' : 'Last Update'}</span><span style="text-align:right;">${haveDu ? esc(fmtRelativeTime(d.du_scraped_at)) : (d.last_seen ? esc(fmtRelativeTime(d.last_seen)) : '&mdash;')}</span>
      </div>
      ${allocGb ? `<div style="margin-top:8px;">${stripedBarHtml(usagePct, usageColor)}</div>` : '<div class="small muted" style="margin-top:6px;">No plan size set yet - link a SIM Card, or wait for the usage figure to finish scraping.</div>'}`;

  const volumes = d.volumes || [];
  const volumesHtml = volumes.length
    ? `<table><thead><tr><th>Drive</th><th>Label</th><th>Free</th><th>Used %</th></tr></thead><tbody>${volumes.map((v) => {
        const freePct = v.sizeGb > 0 ? (v.freeGb / v.sizeGb) * 100 : 0;
        const color = freePct <= 10 ? '#c0392b' : freePct <= 25 ? '#e07a2c' : '#1f9d55';
        // Bar fills to CONSUMED percentage (same convention as Data Usage) - see volumeCellHtml for
        // why. Danger color thresholds still key off free space, unchanged.
        return `<tr><td>${esc(v.drive)}</td><td class="small">${esc(v.label || '-')}</td><td class="small" style="white-space:nowrap;">${v.freeGb} of ${v.sizeGb} GB</td><td>${stripedBarHtml(100 - freePct, color)}</td></tr>`;
      }).join('')}</tbody></table>`
    : '<div class="empty">No volume data reported.</div>';

  const c = d.components || {};
  const componentsHtml = `<div class="small">
    ${c.cpu ? `<div><b>CPU:</b> ${esc(c.cpu)}</div>` : ''}
    ${c.ramGb ? `<div><b>RAM:</b> ${esc(String(c.ramGb))} GB</div>` : ''}
    ${c.gpu ? `<div><b>GPU:</b> ${esc(c.gpu)}</div>` : ''}
    ${(c.disks || []).length ? `<div><b>Disks:</b> ${c.disks.map(esc).join(', ')}</div>` : ''}
    ${!c.cpu && !c.ramGb && !c.gpu && !(c.disks || []).length ? '<div class="empty">No component data reported.</div>' : ''}
  </div>`;

  const antivirus = d.antivirus || [];
  const antivirusHtml = antivirus.length
    ? antivirus.map((a) => `<span class="badge ${a.enabled ? 'b-blue' : 'b-red'}" style="margin:0 4px 4px 0;">${esc(a.name)} - ${a.enabled ? 'Enabled' : 'Disabled'}</span>`).join('')
    : '<div class="empty">No antivirus data reported.</div>';

  // Ignoring a problem mutes its TYPE (see visibleProblems/problemType) rather than its exact text,
  // since most problem strings embed details that change over time (a disk-space message's exact GB
  // free, a popup message's exact window title) - matching literal text would stop working the
  // moment those details shifted even slightly.
  const shownProblems = visibleProblems(d);
  const ignoredTypes = d.ignored_problem_types || [];
  const problemsHtml = shownProblems.length
    ? `<ul style="margin:0;padding-left:18px;">${shownProblems.map((p) => `<li class="small" style="color:var(--red);display:flex;justify-content:space-between;gap:8px;align-items:center;">
        <span>${esc(p)}</span>
        ${editOk ? `<button type="button" class="link-btn" style="white-space:nowrap;" onclick='App.ignoreWorkspaceProblemType(${jsonAttr(d.id)}, ${jsonAttr(problemType(p))})'>Ignore</button>` : ''}
      </li>`).join('')}</ul>`
    : '<div class="small" style="color:var(--green);">No problems detected.</div>';
  const ignoredProblemsHtml = ignoredTypes.length
    ? `<div class="small muted" style="margin-top:6px;">
        <details><summary style="cursor:pointer;">${ignoredTypes.length} problem type${ignoredTypes.length === 1 ? '' : 's'} ignored on this screen</summary>
          <div style="margin-top:6px;">
            ${ignoredTypes.map((t) => `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:2px 0;">
              <span>${esc(problemTypeLabel(t))}</span>
              ${editOk ? `<button type="button" class="link-btn" style="white-space:nowrap;" onclick='App.unignoreWorkspaceProblemType(${jsonAttr(d.id)}, ${jsonAttr(t)})'>Un-ignore</button>` : ''}
            </div>`).join('')}
          </div>
        </details>
      </div>`
    : '';

  const software = [...(d.software || [])].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const softwareHtml = software.length
    ? `<details><summary style="cursor:pointer;font-size:12.5px;">${software.length} package(s) - click to expand</summary>
        <div style="max-height:260px;overflow-y:auto;margin-top:6px;">
          <table><thead><tr><th>Name</th><th>Version</th><th>Publisher</th><th></th></tr></thead><tbody>${software.map((s) => `<tr><td class="small">${esc(s.name)}</td><td class="small">${esc(s.version || '-')}</td><td class="small">${esc(s.publisher || '-')}</td><td>${editOk && s.uninstallString ? `<button type="button" class="link-btn" style="padding:0;" onclick='App.openWorkspaceEditModal(${jsonAttr(d.id)}); App.fillWorkspaceCommand(${jsonAttr(s.uninstallString)})'>Uninstall</button>` : ''}</td></tr>`).join('')}</tbody></table>
        </div>
      </details>`
    : '<div class="empty small">Not reported yet - shows up after this device\'s next check-in.</div>';

  return `
    <h3>${esc(d.hostname)}</h3>
    <div class="small muted" style="margin-bottom:10px;">${d.last_seen ? `Last check-in ${esc(fmtRelativeTime(d.last_seen))}` : 'Never checked in'} &middot; Agent v${esc(d.agent_version || '-')}</div>

    <div class="card-head" style="margin-top:4px;"><h3 style="font-size:13px;">Remote Access</h3></div>
    <div style="margin-bottom:12px;">${remoteAccessCell(d)}</div>

    <div class="card-head"><h3 style="font-size:13px;">Data Usage</h3></div>
    <div style="margin-bottom:12px;">${dataUsageHtml}</div>

    <div class="card-head"><h3 style="font-size:13px;">Matched Broadsign/Grassfish Screen</h3></div>
    <div class="small" style="margin-bottom:12px;">
      ${matched ? `${esc(matched.source)}: <b>${esc(matched.row.name)}</b>${matched.row.venue ? ` @ ${esc(matched.row.venue)}` : ''}` : `<span class="muted">No match${(d.broadsign_player_id || d.grassfish_box_id) ? ` (ID ${esc(d.broadsign_player_id || d.grassfish_box_id)} not found in Asset Inventory)` : ' - no Broadsign/Grassfish player detected on this PC'}</span>`}
    </div>

    <div class="card-head"><h3 style="font-size:13px;">Problems</h3></div>
    <div style="margin-bottom:12px;">${problemsHtml}${ignoredProblemsHtml}</div>

    <div class="card-head"><h3 style="font-size:13px;">Antivirus</h3></div>
    <div style="margin-bottom:12px;">${antivirusHtml}</div>

    <div class="card-head"><h3 style="font-size:13px;">Components</h3></div>
    <div style="margin-bottom:12px;">${componentsHtml}</div>

    <div class="card-head"><h3 style="font-size:13px;">Volumes</h3></div>
    <div style="margin-bottom:12px;">${volumesHtml}</div>

    <div class="card-head"><h3 style="font-size:13px;">Software</h3></div>
    <div style="margin-bottom:12px;">${softwareHtml}</div>

    ${d.pending_command ? `<div class="card-head"><h3 style="font-size:13px;">Pending Command${/^\s*::BATCH\r?\n/.test(d.pending_command) ? ' (Batch script)' : ''}</h3></div><div class="small" style="margin-bottom:12px;"><code style="white-space:pre-wrap;">${esc(stripBatchMarker(d.pending_command))}</code> - runs on the next check-in.</div>` : ''}
    ${d.last_command_output ? `<div class="card-head"><h3 style="font-size:13px;">Last Command Output</h3></div><div class="small muted" style="margin-bottom:4px;">${d.last_command_at ? esc(fmtRelativeTime(d.last_command_at)) : ''}</div><pre style="max-height:200px;overflow-y:auto;background:var(--bg);padding:8px;border-radius:6px;white-space:pre-wrap;font-size:11.5px;">${esc(d.last_command_output)}</pre>` : ''}

    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

registerModal('workspaceEdit', (data) => {
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const device = devices.find((d) => d.id === data.deviceId);
  if (!device) return `<div class="empty">Device not found.</div><div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>`;
  const simCards = STATE.pageData.simCardsForDirectory?.data || [];
  const simOptions = simCards.map((s) => `<option value="${s.id}" ${device.sim_card_id === s.id ? 'selected' : ''}>${esc(s.sim_number || s.iccid || s.id)}${s.data_allocation_gb ? ` (${s.data_allocation_gb}GB)` : ''}</option>`).join('');
  const pendingIsBatch = /^\s*::BATCH\r?\n/.test(device.pending_command || '');
  return `
    <h3>Edit - ${esc(device.hostname)}</h3>
    <form onsubmit="App.saveWorkspaceEditForm(event, '${device.id}')">
      <div class="field"><label>Location</label><input id="wd-edit-location" value="${esc(device.location || '')}" placeholder="e.g. Yas Mall - Back Office"></div>
      <div class="field"><label>Notes</label><textarea id="wd-edit-notes" rows="3">${esc(device.notes || '')}</textarea></div>
      <div class="field"><label>Linked SIM Card</label>
        <select id="wd-edit-sim"><option value="">None</option>${simOptions}</select>
        <div class="small muted" style="margin-top:4px;">Used to show data used vs. plan size on the Digital Directory's SIM Data Usage tiles.${device.sim_card_id ? ` <button type="button" class="link-btn" onclick="App.resetWorkspaceDataUsage('${device.id}')">Reset usage counter</button>` : ''}</div>
      </div>
      <div class="field"><label>Run Command (runs on this device's next check-in)</label>
        ${installerUploadHtml('wd-edit-installer', 'wd-edit-installer-args', 'wd-edit-command')}
        ${commandPresetsHtml('wd-edit-pkgid', 'wd-edit-chocoid', 'wd-edit-command')}
        ${commandTypeRadiosHtml('wd-edit-command', pendingIsBatch ? 'batch' : 'powershell')}
        <textarea id="wd-edit-command" rows="2" placeholder="e.g. winget install -e --id 7zip.7zip --silent">${esc(stripBatchMarker(device.pending_command))}</textarea>
        <div class="small muted" style="margin-top:4px;">Executes locally with the agent's (SYSTEM) privileges, fully hidden (no window/popup on the signage screen). The winget presets need that PC to already have it (built into Windows 10 21H2+/11); Chocolatey is bootstrapped automatically by the install script on every PC, so those presets work everywhere. Don't know the exact ID? Search <a href="https://community.chocolatey.org/packages" target="_blank" rel="noopener">community.chocolatey.org/packages</a>, or queue <code>winget search &lt;name&gt;</code> as a command first - its results show up in Details after the next check-in - or use the per-item Uninstall button in Details &gt; Software, which queues that program's own registered uninstall command directly. Covers installing/updating/removing software, running a full .bat script, or pulling a log file's contents back - output shows up in Details after the device's next 1-2 check-ins. Leave blank to clear a pending command.</div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Save</button>
      </div>
    </form>
  `;
});

registerModal('workspaceBulkDeploy', () => {
  const ids = STATE.workspaceDirectorySelectedIds || [];
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const names = ids.map((id) => devices.find((d) => d.id === id)?.hostname).filter(Boolean);
  return `
    <h3>Deploy to ${ids.length} device(s)</h3>
    <div class="small muted" style="margin-bottom:10px;">${esc(names.join(', ')) || `${ids.length} device(s)`}</div>
    <form onsubmit="App.saveWorkspaceBulkDeploy(event)">
      <div class="field"><label>Run Command (PowerShell, runs on each selected device's next check-in)</label>
        ${installerUploadHtml('wd-bulk-installer', 'wd-bulk-installer-args', 'wd-bulk-command')}
        ${commandPresetsHtml('wd-bulk-pkgid', 'wd-bulk-chocoid', 'wd-bulk-command')}
        ${commandTypeRadiosHtml('wd-bulk-command', 'powershell')}
        <textarea id="wd-bulk-command" rows="2" placeholder="e.g. winget install -e --id 7zip.7zip --silent"></textarea>
        <div class="small muted" style="margin-top:4px;">Queues the exact same command (or full .bat script) on all ${ids.length} selected device(s) at once - each one still only runs it on its OWN next check-in (not simultaneously), same as a single-device Run Command. Overwrites any pending command already queued individually on these devices.</div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Queue on ${ids.length} device(s)</button>
      </div>
    </form>
  `;
});
