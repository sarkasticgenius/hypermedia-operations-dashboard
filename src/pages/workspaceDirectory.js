import { STATE, loadData, invalidate, toast, setState, openModal, closeModal } from '../state.js';
import { registerModal, loadingCard } from '../modals.js';
import { listWorkspaceDevices, updateWorkspaceDevice, deleteWorkspaceDevice, listGhostWorkspaceDevices, restoreWorkspaceDevice, permanentlyDeleteWorkspaceDevice } from '../data/workspaceDevices.js';
import { listSimCards } from '../data/simCards.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { canEdit, canDelete } from '../auth.js';
import { AGENT_CANARY_HOSTNAMES, defaultOptimizerScript } from './settings.js';
import { remoteAccessUrl } from '../lib/remoteAccess.js';
import { esc, fmtRelativeTime } from '../lib/format.js';
import { sortTh, applySort, FIXED_TABLE_STYLE } from '../lib/sortableTable.js';
import { renderTabs } from '../lib/tabs.js';
import { logAudit } from '../lib/audit.js';
import { supabase } from '../supabaseClient.js';
import { problemType, problemTypeLabel, visibleProblems } from '../lib/workspaceProblems.js';
import { isMafRow, normalizeVenueText, assetInventoryForLocation } from '../data/locationStats.js';

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

// AnyDesk/TeamViewer IDs are directly actionable, not just displayed - a Connect link (the
// installed client's own custom protocol handler on whoever's browsing the dashboard) plus a Copy
// button, since not every admin will have the client set as the default handler for that scheme.
function remoteIdChip(tool, id) {
  if (!id) return '';
  const url = remoteAccessUrl(tool, id);
  return `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:2px 6px;margin:1px 3px 1px 0;font-size:11px;white-space:nowrap;">
    <b>${esc(tool)}</b> <span style="font-family:monospace;">${esc(id)}</span>
    ${url ? `<a href="${url}" title="Connect via ${esc(tool)}" style="text-decoration:none;">&#128279;</a>` : ''}
    <button type="button" class="link-btn" style="padding:0;" title="Copy ID" onclick="App.copyWorkspaceId(event,'${esc(id)}')">&#128203;</button>
  </span>`;
}

function remoteAccessCell(d) {
  const chips = [
    remoteIdChip('AnyDesk', d.anydesk_id),
    remoteIdChip('TeamViewer', d.teamviewer_id),
    ...(d.other_remote_ids || []).map((r) => remoteIdChip(r.tool, r.id)),
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
  if (d.anydesk_id) tools.push({ tool: 'AnyDesk', id: d.anydesk_id, url: remoteAccessUrl('AnyDesk', d.anydesk_id) });
  if (d.teamviewer_id) tools.push({ tool: 'TeamViewer', id: d.teamviewer_id, url: remoteAccessUrl('TeamViewer', d.teamviewer_id) });
  (d.other_remote_ids || []).forEach((r) => {
    const url = remoteAccessUrl(r.tool, r.id);
    if (url) tools.push({ tool: r.tool, id: r.id, url });
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
    // The download path is resolved ONCE into $__pkg rather than repeated inline at each use. The
    // .msi branch used to pass its path inside a SINGLE-quoted -ArgumentList, and PowerShell does
    // not expand variables in single quotes - so msiexec received the literal text
    // "$env:TEMP\Whatever.msi" as the package name, could not open a file by that name, and failed
    // with 1619 (ERROR_INSTALL_PACKAGE_OPEN_FAILED) on every single MSI deploy. The file itself had
    // downloaded perfectly well; only the path handed to msiexec was wrong, which is exactly why
    // this looked like a broken/corrupt package rather than a quoting bug. Confirmed live.
    // The inner `" quotes around $__pkg stay (now inside a DOUBLE-quoted string, so they survive as
    // real quotes in the argument msiexec parses) because installer filenames routinely contain
    // spaces - without them msiexec reads only the first word as the package path.
    const command = ext === 'msi'
      ? `$__pkg = "${localPath}"; Invoke-WebRequest -Uri "${signed.signedUrl}" -OutFile $__pkg -UseBasicParsing; $__p = Start-Process msiexec.exe -ArgumentList "/i \`"$__pkg\`" /qn /norestart" -PassThru; if (-not $__p.WaitForExit(${timeoutMs})) { Stop-Process -Id $__p.Id -Force -ErrorAction SilentlyContinue; "Install timed out after 5 minutes" } else { "Install exited with code $($__p.ExitCode)" }; Remove-Item $__pkg -Force -ErrorAction SilentlyContinue`
      : `$__pkg = "${localPath}"; Invoke-WebRequest -Uri "${signed.signedUrl}" -OutFile $__pkg -UseBasicParsing; $__p = Start-Process $__pkg${silentArgs ? ` -ArgumentList '${silentArgs}'` : ''} -PassThru; if (-not $__p.WaitForExit(${timeoutMs})) { Stop-Process -Id $__p.Id -Force -ErrorAction SilentlyContinue; "Install timed out after 5 minutes - likely missing or incorrect silent install args" } else { "Install exited with code $($__p.ExitCode)" }; Remove-Item $__pkg -Force -ErrorAction SilentlyContinue`;
    fillWorkspaceCommand(command, targetId);
    toast(`${file.name} uploaded - review the generated command below, then Save/Queue.`);
  } catch (e) {
    toast(e.message || 'Upload failed', 'error');
  }
}

// Cross-references this PC with the screen it drives in the Broadsign/Grassfish Console, by the
// same Player Box ID those syncs themselves match on (see broadsign-sync/grassfish-sync) - so an
// admin can see "this PC is behind screen X at location Y" without leaving Digital Directory.
function matchedScreensFor(d, assetInventory) {
  if (!Array.isArray(assetInventory)) return [];
  const matches = [];
  const id = (d.broadsign_player_id || '').trim();
  const gfId = (d.grassfish_box_id || '').trim();
  // BOTH consoles are checked, not just the first that hits. This used to return on the Broadsign
  // match, so a PC running both players only ever reported Broadsign and its Grassfish box was
  // invisible even though the agent had collected it - confirmed on HM-OFFICE-TEST, which carries
  // a Broadsign player id AND grassfish box "Follower2".
  if (id) {
    // filter, not find: one player box commonly drives MANY screens (DR2-FOODCOURT's single
    // Broadsign id maps to 17 rows), and naming one arbitrary panel misrepresents the rest.
    const rows = assetInventory.filter((r) => r.player_type === 'Broadsign' && String(r.player_box_id || '').trim() === id);
    if (rows.length) matches.push({ source: 'Broadsign', rows });
  }
  if (gfId) {
    const rows = assetInventory.filter((r) => r.player_type === 'Grassfish' && String(r.player_box_id || '').trim().toLowerCase() === gfId.toLowerCase());
    if (rows.length) matches.push({ source: 'Grassfish', rows });
  }
  return matches;
}

// Same 9 venue categories Traffic Sheet groups campaigns into (see TAB_DEFS in trafficSheet.js),
// plus "Unassigned" for a PC with no resolvable venue at all, and two cross-cutting views
// ("With Issues", "Data Check Failed") that aren't venue categories - they filter the whole fleet
// by device health instead. 'all' first so the default view is unfiltered.
export const WD_TAB_DEFS = [
  { key: 'all', label: 'All' },
  { key: 'shzBridges', label: 'SHZ Bridges' },
  { key: 'metro', label: 'Dubai Metro' },
  { key: 'malls', label: 'Malls' },
  { key: 'mafMalls', label: 'MAF Malls' },
  { key: 'stores', label: 'In-Stores' },
  { key: 'royals', label: 'Royals' },
  { key: 'gems', label: 'Gems' },
  { key: 'hologram', label: 'Hologram' },
  { key: 'enoc', label: 'ENOC' },
  { key: 'outdoor', label: 'Outdoor' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'withIssues', label: 'With Issues' },
  { key: 'dataCheckFailed', label: 'Data Check Failed' },
];

// Exact venue names of the physical Metro pedestrian-bridge screens - started from a real Traffic
// Sheet "Venue Type = Metro Outdoor" pull (confirmed live, 17 rows), then corrected against actual
// Digital Directory PCs: "Discovery Garden(s) Outdoor" carries that Metro Outdoor venueType in the
// Traffic Sheet feed (an AD-SALES category) but is confirmed to be Metro for PC/IT-monitoring
// purposes here - real example R71-LINKBRIDGE- (screen "R71-LBO-L-LBO2", a pedestrian link bridge
// that's operationally part of the station, not an SHZ outdoor-bridge placement) - so it's
// deliberately excluded from this list even though the Traffic Sheet feed tags it Metro Outdoor.
// A handful of the remaining exact base names (Business Bay, Financial Centre, World Trade Centre,
// Al Khail, Jebel/Jabel Ali, Mall of (the) Emirates, Dubai Internet City, Danube, Energy, Equiti/
// Equity, Emirates Towers) are ALSO used by a real in-station Metro screen with the SAME base name
// and no distinguishing suffix - confirmed against Asset Inventory, which carries both a plain
// "Business Bay"/"Al Khail (AL FARDAN)"/"Jebel Ali" (the in-station screen) and a separately
// suffixed "BUSINESS BAY AUH"/"ALKHAIL (AL FARDAN) AUH"/"JABEL ALI DXB" row (the bridge) for the
// same physical area. So this MUST be an exact match on the full suffixed name, never a substring/
// prefix check - a substring match on "AL KHAIL" or "BUSINESS BAY" alone previously mis-tagged
// real in-station PCs (e.g. hostname ALKHAIL-CONCOUR, matched to the plain unsuffixed "Al Khail
// (AL FARDAN)" venue) as SHZ Bridges. Emirates Towers and Financial Centre are the two confirmed
// exceptions with no AUH/DXB suffix at all in the real Metro Outdoor pull, so they're listed bare.
// Both "Jabel"/"Jebel" and "Equity"/"Equiti" spellings are listed since Asset Inventory's own
// suffixed bridge rows and the vendor feed don't always agree on which spelling to use.
const SHZ_BRIDGE_VENUE_NAMES = [
  'Al Khail (Al Fardan) AUH', 'Alkhail (Al Fardan) AUH',
  'Burj Khalifa-Dubai Mall DXB',
  'Business Bay AUH', 'Business Bay DXB',
  'Danube DXB',
  'Dubai Internet City AUH', 'Dubai Internet City DXB',
  'Emirates Towers',
  'Energy DXB',
  'Equity AUH', 'Equiti AUH',
  'Financial Centre',
  'Jabel Ali AUH', 'Jabel Ali DXB', 'Jebel Ali AUH', 'Jebel Ali DXB',
  'Mall of Emirates AUH', 'Mall of Emirates DXB', 'Mall of the Emirates AUH', 'Mall of the Emirates DXB',
  'World Trade Centre AUH',
];
const SHZ_BRIDGE_VENUE_SET = new Set(SHZ_BRIDGE_VENUE_NAMES.map(normalizeVenueText));

// A handful of Asset Inventory rows have a blank/null category (a data-entry gap, not a real
// "uncategorized" venue) - confirmed live: YAS-LED-05's venue is "YAS Mall" same as its other 31
// screens, every one of which IS tagged Malls, but this one row's own category was never filled
// in, which otherwise sent its PC straight to Unassigned. Backfills a blank category from whatever
// category that same venue name most commonly carries on its OTHER rows, so a single missing field
// doesn't hide a device whose venue is perfectly categorized everywhere else it appears.
function venueCategoryFallback(assetInventory) {
  const counts = new Map();
  for (const r of assetInventory) {
    const venue = (r.venue || '').trim().toLowerCase();
    const category = (r.category || '').trim();
    if (!venue || !category) continue;
    if (!counts.has(venue)) counts.set(venue, new Map());
    const byCategory = counts.get(venue);
    byCategory.set(category, (byCategory.get(category) || 0) + 1);
  }
  const map = new Map();
  counts.forEach((byCategory, venue) => {
    let best = null; let bestCount = 0;
    byCategory.forEach((count, category) => { if (count > bestCount) { best = category; bestCount = count; } });
    if (best) map.set(venue, best);
  });
  return map;
}

// Which WD_TAB_DEFS venue-category key a single Asset Inventory row belongs to, or null if it
// doesn't match any of them (e.g. a blank/unrecognized category) - mirrors venueMatchesTab in
// trafficSheet.js, but keyed off Asset Inventory's own `category`/`networkNames`/`venue` fields
// (this app's own data) rather than the Traffic Sheet vendor feed's venueType/network, which
// Digital Directory's PCs have no access to. Royals/Gems/Hologram are checked first since Asset
// Inventory files all three under category "Malls"/"Outdoor" alongside ordinary screens - it's the
// network, not the category, that actually marks them out as their own thing.
function assetCategoryTab(r, venueCategoryFallbackMap) {
  const networks = (r.networkNames || []).map((n) => n.toUpperCase());
  if (networks.some((n) => n.includes('ROYALS'))) return 'royals';
  if (networks.some((n) => n.includes('GEMS'))) return 'gems';
  if (networks.some((n) => n.includes('HOLOGRAM'))) return 'hologram';
  const category = (r.category || '').trim() || venueCategoryFallbackMap.get((r.venue || '').trim().toLowerCase()) || '';
  if (category === 'Petrol Stations') return 'enoc';
  if (category === 'Malls') return isMafRow({ ...r, category }) ? 'mafMalls' : 'malls';
  if (category === 'Metro') {
    return SHZ_BRIDGE_VENUE_SET.has(normalizeVenueText(r.venue)) ? 'shzBridges' : 'metro';
  }
  if (/^in-?store$/i.test(category)) return 'stores';
  if (category === 'Outdoor') return 'outdoor';
  return null;
}

// Hostnames confirmed by ops to have NO matching Asset Inventory row at all (a mismatched/missing
// Broadsign Player ID, or the screen was never entered into Asset Inventory) - Digital Directory
// has nothing in its own data to derive a category from for these, so they're recorded here from
// direct confirmation rather than guessed from the hostname text (e.g. "MALL" or "TOTEM" appearing
// in a name isn't a reliable enough signal on its own to generalize into a keyword rule). A device
// that later gets a real Player ID match isn't affected - this is only consulted as a last resort.
const HOSTNAME_CATEGORY_OVERRIDES = {
  'DALMA-MALL-AUH-': 'malls',
  'DALMA-MALL-TWO-': 'malls',
  'ALWSL-TOTEM2B-E': 'outdoor',
  'DCCHLGPC01': 'hologram',
  'MOEHLGPC02': 'hologram',
};

// A device's venue category, resolved the same way its Location cell is (see locationCellHtml):
// prefer the venue of the screen it actually drives (matched by Broadsign/Grassfish Player Box ID)
// since that's set on almost every device, falling back to a venue match on the rarely-populated
// manual Location field. 'unassigned' when neither resolves to a category.
function deviceCategoryTab(d, assetInventory, venueCategoryFallbackMap) {
  for (const { rows } of matchedScreensFor(d, assetInventory)) {
    for (const r of rows) {
      const tab = assetCategoryTab(r, venueCategoryFallbackMap);
      if (tab) return tab;
    }
  }
  if (d.location) {
    for (const r of assetInventoryForLocation(d.location, assetInventory)) {
      const tab = assetCategoryTab(r, venueCategoryFallbackMap);
      if (tab) return tab;
    }
  }
  if (HOSTNAME_CATEGORY_OVERRIDES[d.hostname]) return HOSTNAME_CATEGORY_OVERRIDES[d.hostname];
  // Last resort for a device with no matched screen AND no manual Location at all (nothing in
  // Asset Inventory to check a category against) - Hologram PCs are specialized display hardware
  // that isn't always wired into Broadsign/Grassfish, so the hostname is the only signal left.
  // Confirmed real example: BURJUMAN-HOLOGR (Windows' 15-character NetBIOS limit truncates
  // "-HOLOGRAM" to "-HOLOGR"), which has neither a player id nor a Location set.
  if (/HOLOGR/i.test(d.hostname || '')) return 'hologram';
  return 'unassigned';
}

// "Failed on that day" only counts a device that's known to actually have a SIM behind it (a
// stored du phone number, or a past successful scrape) - a Wi-Fi/LAN device with no SIM at all
// legitimately has nothing to report every single day, and that is not a failure (see the
// 'nodata'-with-no-knownSim branch of dataUsageCellHtml/duScrapeStatusHtml, which this mirrors).
function dataCheckFailedToday(d) {
  const attemptedAt = d.du_scrape_attempted_at;
  if (!attemptedAt) return false;
  const attempted = new Date(attemptedAt);
  const now = new Date();
  const isToday = attempted.getFullYear() === now.getFullYear() && attempted.getMonth() === now.getMonth() && attempted.getDate() === now.getDate();
  if (!isToday) return false;
  if (d.du_scrape_outcome === 'nobrowser' || d.du_scrape_outcome === 'error') return true;
  const knownSim = !!(d.du_phone_number || d.du_scraped_at);
  return d.du_scrape_outcome === 'nodata' && knownSim;
}

// Asset Inventory indexed by the Player Box ID each console matches on. matchedScreensFor scans
// the whole ~2,300-row table per call, which is fine for the couple of dozen rows actually being
// rendered but not for building a search index across the entire fleet on every keystroke - this
// turns that into one map lookup per device. Broadsign and Grassfish get SEPARATE keyspaces, not
// one shared map, because they match differently (Broadsign exactly, Grassfish case-insensitively)
// and sharing would let a Grassfish box id collide with a Broadsign player id that differs only in
// case.
function assetRowsByBoxId(assetInventory) {
  const broadsign = new Map();
  const grassfish = new Map();
  for (const r of assetInventory) {
    const id = String(r.player_box_id || '').trim();
    if (!id) continue;
    const [map, key] = r.player_type === 'Broadsign' ? [broadsign, id]
      : r.player_type === 'Grassfish' ? [grassfish, id.toLowerCase()]
      : [null, null];
    if (!map) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return { broadsign, grassfish };
}

// Everything the Matched Screen and Location cells can DISPLAY for a device, flattened to text for
// the search box. Both cells routinely show something that exists nowhere on the device row itself:
// Matched Screen is resolved entirely from Asset Inventory, and Location falls back to the matched
// screen's venue on the overwhelming majority of devices, because the manual `location` field is a
// curated one almost nobody fills in (see locationCellHtml). Searching only the stored columns
// therefore could not find the text that was plainly on screen - typing a venue you could read in
// the Location column returned "No devices match".
//
// Every matched screen's own name is included rather than matchedScreenLabel's collapsed
// "17 screens @ venue" summary, so searching an individual panel still finds the PC driving it -
// which is the whole point on a box like DR2-FOODCOURT's, where 17 names are hidden behind one
// count. Venues are de-duplicated because those 17 rows nearly always repeat a single venue.
function matchedScreenSearchText(d, index) {
  const parts = [];
  const venues = new Set();
  const bs = index.broadsign.get(String(d.broadsign_player_id || '').trim());
  const gf = index.grassfish.get(String(d.grassfish_box_id || '').trim().toLowerCase());
  for (const rows of [bs, gf]) {
    if (!rows) continue;
    for (const r of rows) {
      if (r.name) parts.push(r.name);
      if (r.venue) venues.add(r.venue);
    }
  }
  return [...parts, ...venues].join(' ');
}

function deviceMatchesTab(d, tabKey, categoryByDeviceId) {
  if (tabKey === 'all') return true;
  if (tabKey === 'withIssues') return visibleProblems(d).length > 0;
  if (tabKey === 'dataCheckFailed') return dataCheckFailedToday(d);
  return categoryByDeviceId.get(d.id) === tabKey;
}

// One console's worth of matches as text: the screen name when a player drives exactly one, or a
// count plus venue when it drives several - listing seventeen names would swamp the cell.
function matchedScreenLabel({ source, rows }) {
  if (rows.length === 1) {
    const r = rows[0];
    return `${source}: ${r.name}${r.venue ? ` @ ${r.venue}` : ''}`;
  }
  const venues = [...new Set(rows.map((r) => r.venue).filter(Boolean))];
  const where = venues.length === 1 ? venues[0] : `${venues.length} venues`;
  return `${source}: ${rows.length} screens @ ${where}`;
}

// Location, preferring what an admin typed but falling back to the venue of the screen this PC
// actually drives (matched by Broadsign/Grassfish Player Box ID - see matchedScreensFor).
//
// Almost no device has the manual Location set, because it is a curated field nobody fills in,
// while the matched screen already knows exactly where the machine is - DESKTOP-8S3G9M2 showed "-"
// on a PC sitting in Palm Dubai Ruby. Marked as inferred rather than shown as if it were entered,
// so a wrong Broadsign match reads as a wrong match instead of as a wrong address.
function locationCellHtml(d, matches) {
  if (d.location) return esc(d.location);
  const first = (matches || [])[0];
  const venue = first?.rows?.[0]?.venue;
  if (!venue) return '-';
  return `<span title="From the matched ${esc(first.source)} screen, not set manually">${esc(venue)}</span>`;
}

// HTML rendering of a match, with the screen name (or count) bolded so it's the thing the eye
// catches first in a scan-heavy column - the source/venue stay plain. Kept separate from
// matchedScreenLabel rather than embedding markup there, since that plain-text version also feeds
// the Screen column's sort key - esc()'d before display, which would turn real <b> tags into
// literal "&lt;b&gt;" text instead of rendering them.
function matchedScreenHtmlLabel({ source, rows }) {
  if (rows.length === 1) {
    const r = rows[0];
    return `${esc(source)}: <b>${esc(r.name)}</b>${r.venue ? ` @ ${esc(r.venue)}` : ''}`;
  }
  const venues = [...new Set(rows.map((r) => r.venue).filter(Boolean))];
  const where = venues.length === 1 ? venues[0] : `${venues.length} venues`;
  return `${esc(source)}: <b>${rows.length} screens</b> @ ${esc(where)}`;
}

function matchedScreenHtml(matches) {
  if (!matches || !matches.length) return '<span class="small muted">-</span>';
  return matches.map((m) => `<div class="small">${matchedScreenHtmlLabel(m)}</div>`).join('');
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
  const label = `${clamped.toFixed(0)}%`;
  const labelBase = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;white-space:nowrap;pointer-events:none;';
  // The label is drawn TWICE, identically positioned, and the white copy is clipped to exactly the
  // filled region. A single white label was unreadable on any bar under ~50%: it is centred, so
  // most of it sat over the pale unfilled track as white-on-near-white. Rather than move the label
  // out of the bar (which costs horizontal space this table does not have), the dark copy shows
  // through wherever the bar is empty and the white copy takes over wherever it is filled - so the
  // digits stay legible at 5% and at 95%, in both themes. currentColor for the dark copy means it
  // inherits the table's own text colour and follows dark mode without a second declaration.
  return `<div style="position:relative;height:20px;border-radius:5px;overflow:hidden;background:var(--bg);border:1px solid var(--border);min-width:34px;">
    <div style="width:${clamped.toFixed(1)}%;height:100%;background-color:${color};background-image:repeating-linear-gradient(45deg, rgba(255,255,255,.28) 0, rgba(255,255,255,.28) 5px, transparent 5px, transparent 10px);"></div>
    <div style="${labelBase}color:currentColor;">${label}</div>
    <div style="position:absolute;inset:0;clip-path:inset(0 ${(100 - clamped).toFixed(1)}% 0 0);">
      <div style="${labelBase}color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.45);">${label}</div>
    </div>
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
    // A drive reporting size 0 is one the agent could not MEASURE, not one that is full. WMI hands
    // back Win32_LogicalDisk's static properties (DeviceID, VolumeName) even when a provider failure
    // leaves the dynamic Size/FreeSpace null, and `$null / 1GB` rounds to 0 in PowerShell - so a
    // failed read arrives here looking exactly like a real zero. Running it through the maths below
    // turned "unknown" into 0% free, which coloured red and filled the bar to 100 - 0 = 100%: a
    // confident "disk full" for a drive nobody actually managed to look at.
    //
    // Confirmed live on DESKTOP-OMM99EM, 1 Sep 2026: both C: and D: drew solid red 100% bars while
    // the PC itself had 381 of 411 GB and 519 of 520 GB free, and its stored volumes carried the
    // real drive letters and labels ("Windows11", "New Volume") alongside sizeGb/freeGb of 0. The
    // Volume sort key and the agent's own low-disk-space check both already guard `sizeGb > 0`,
    // which is why that same device sorted to the very TOP of an ascending Volume sort (scored 0%
    // used) while the cell beside it drew a full bar. This was the one place that didn't guard.
    if (!(v.sizeGb > 0)) {
      return `<div style="display:flex;align-items:center;gap:6px;" title="${esc(v.drive)}${v.label ? ` (${esc(v.label)})` : ''} - the last check-in didn't report a size for this drive, so how full it is isn't known. It is not necessarily full.">
        <span class="small muted" style="flex:none;">${esc(v.drive)}</span><span class="small muted">&mdash;</span>
      </div>`;
    }
    const freePct = (v.freeGb / v.sizeGb) * 100;
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
    // Two very different situations both end up here, and they must not be labelled the same way:
    //   - The scrape RAN and found no SIM behind the connection (du identifies the subscriber from
    //     the connection itself, so a Wi-Fi/LAN machine genuinely has nothing to report, ever).
    //   - The scrape has never successfully run at all, so nothing is known either way.
    // du_scraped_at is what separates them: it is only ever set when a scrape actually reported
    // something. Calling the second case "Wi-Fi / LAN" would be a confident claim about a device we
    // know nothing about - and was wrong in practice on a real device that turned out to have a
    // perfectly good SIM, it just had not scraped yet.
    // du_scrape_outcome (agent 3.1+) is what finally makes that distinction, rather than leaving it
    // to be inferred from an absence: 'nodata' means the page was loaded and answered with nothing,
    // which for these PCs IS the answer - no du SIM behind the connection, so it's on Wi-Fi or the
    // mall LAN. A FAULT ('nobrowser'/'error') is not that, and must not borrow the same label: it
    // says nothing about the connection, only that we failed to ask. 'pending' means an attempt
    // started and never reported back, which is likewise not an answer.
    // ...but a device we hold a du phone number for is NOT an unknown - see duScrapeStatusHtml for
    // the live case this guards against. Without allocGb there is no bar to draw, so it falls
    // through to the fault branch below rather than claiming a connection type we have evidence
    // against.
    if ((d.du_scraped_at || d.du_scrape_outcome === 'nodata') && !d.du_phone_number) {
      const when = d.du_scrape_attempted_at || d.du_scraped_at;
      return phoneHtml || `<span class="small muted" title="No SIM behind this PC - the scrape ran${when ? ` ${fmtRelativeTime(when)}` : ''} and du had no carrier data for this connection, so it reaches the internet over Wi-Fi/LAN.">Wi-Fi / LAN</span>`;
    }
    if (d.du_scrape_outcome === 'nobrowser' || d.du_scrape_outcome === 'error') {
      // Deliberately loud rather than muted, and deliberately NOT "Wi-Fi / LAN" - this is a fault
      // on the PC that someone has to go and fix, and the whole reason the column exists is that a
      // silently-failing check used to be invisible here for days at a time.
      const detail = d.du_scrape_note || 'The scrape could not be completed.';
      return phoneHtml || `<span class="small" style="color:#c0392b;" title="${esc(detail)}${d.du_scrape_attempted_at ? ` (last tried ${esc(fmtRelativeTime(d.du_scrape_attempted_at))})` : ''}">Check failed</span>`;
    }
    return phoneHtml || '<span class="small muted" title="This PC has not been checked for a SIM yet - the scrape runs once a day, in this PC\'s own slot between 03:00 and 08:00 local time. Once it has run, this becomes a usage bar, Wi-Fi / LAN, or Check failed.">Not checked</span>';
  }
  const pct = Math.min(100, (usedGb / allocGb) * 100);
  const color = pct >= 80 ? '#c0392b' : pct >= 70 ? '#e07a2c' : '#1f9d55';
  return `<div title="${fmtGb(usedGb)} of ${fmtGb(allocGb)} used${haveDu ? ' (DU)' : ''}">${phoneHtml}${stripedBarHtml(pct, color)}</div>`;
}

// One line in the Details modal saying what the once-a-day mydata.du.ae check last did, so the
// reason a device has no usage figures is readable here instead of only in the agent log on the PC
// itself. Older agents (pre-3.1) never reported attempts, so they have no outcome to show and get
// the same "hasn't reported one yet" line as a genuinely new install - correct either way, since
// from the dashboard's point of view nothing has been reported.
function duScrapeStatusHtml(d) {
  const when = d.du_scrape_attempted_at ? ` ${fmtRelativeTime(d.du_scrape_attempted_at)}` : '';
  switch (d.du_scrape_outcome) {
    case 'ok':
      return `<div class="small muted" style="margin-top:6px;">SIM check ran${when} and du reported these figures.</div>`;
    case 'nodata': {
      // "du reported nothing" only means "there is no SIM here" when nothing we already hold says
      // otherwise. A stored phone number, or figures from an earlier successful scrape, is direct
      // evidence this PC DOES have a du SIM - so the same empty result means the check failed, not
      // that the SIM vanished. Confirmed live: PC-E89C258BBD2F showed its own number
      // (+971581309074) and 11.72 of 43 GB in this very panel, immediately above a line claiming
      // it had no SIM and was on Wi-Fi/LAN. Reporting a known-wrong conclusion is worse than
      // reporting an unexplained failure, so the contradiction is resolved in favour of the
      // evidence rather than the latest outcome.
      const knownSim = d.du_phone_number || d.du_scraped_at;
      if (knownSim) {
        const lastGood = d.du_scraped_at ? ` The figures above are from the last successful check, ${fmtRelativeTime(d.du_scraped_at)}.` : '';
        return `<div class="small" style="margin-top:6px;color:#c0392b;">SIM check ran${when} but du returned nothing, even though this PC has a known du SIM - so the check itself is failing, not the connection.${esc(lastGood)}</div>`;
      }
      return `<div class="small muted" style="margin-top:6px;">SIM check ran${when} and du reported nothing for this connection - no du SIM behind this PC, so it reaches the internet over Wi-Fi/LAN.</div>`;
    }
    case 'nobrowser':
    case 'error':
      return `<div class="small" style="margin-top:6px;color:#c0392b;">SIM check failed${when}: ${esc(d.du_scrape_note || 'no reason reported')}</div>`;
    case 'pending':
      return `<div class="small muted" style="margin-top:6px;">SIM check started${when} but never reported an outcome - it was interrupted before it finished.</div>`;
    default:
      return '<div class="small muted" style="margin-top:6px;">This PC has not reported a SIM check yet. It runs once a day, on the first check-in after this PC\'s own slot between 03:00 and 08:00 local time.</div>';
  }
}

function deviceRow(d, editOk, deleteOk, assetInventory, selectedIds, sim) {
  const online = isOnline(d);
  const problemCount = visibleProblems(d).length;
  // Resolved once and reused by both the Location and Matched Screen cells below.
  const matches = matchedScreensFor(d, assetInventory);
  // The whole row opens Details. Handled on the <tr> rather than by styling the hostname as a link,
  // so the name keeps its plain bold treatment and the target is the entire row instead of a few
  // characters of text. The handler ignores clicks that landed on a control (see
  // openWorkspaceDetailsFromRow) so the checkbox and the row's own buttons still do their own jobs.
  return `<tr style="cursor:pointer;" onclick="App.openWorkspaceDetailsFromRow(event, '${d.id}')">
    ${editOk ? `<td style="width:24px;"><input type="checkbox" ${(selectedIds || new Set()).has(d.id) ? 'checked' : ''} onchange="App.toggleWorkspaceSelection('${d.id}', this.checked)"></td>` : ''}
    <!-- nowrap because these names are full of hyphens and browsers treat a hyphen as a legal
         break point - "DRAGONMART-FOOD" was splitting across two lines purely on that, making
         rows taller and the column ragged. Ellipsis + title keeps an unusually long name from
         spilling into the next column while still being readable on hover. -->
    <td style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(d.hostname)}"><b>${esc(d.hostname)}</b></td>
    <td>${volumeCellHtml(d)}</td>
    <td class="small">${locationCellHtml(d, matches)}</td>
    <td class="small" style="white-space:nowrap;">${esc(d.ip_address || '-')}</td>
    <td>${remoteAccessButtonHtml(d)}</td>
    <td>${dataUsageCellHtml(d, sim)}</td>
    <td style="white-space:nowrap;">${statusDotHtml(online, true)}</td>
    <td>${matchedScreenHtml(matches)}</td>
    <td class="small">${esc(d.os_name || '-')}${d.os_version ? ` <span class="muted">${esc(d.os_version)}</span>` : ''}</td>
    <td class="small">${esc(d.logged_in_user || '-')}</td>
    <td>${problemCount ? `<span class="badge b-red">${problemCount} issue${problemCount === 1 ? '' : 's'}</span>` : '<span class="badge b-blue">OK</span>'}</td>
    <td class="small">${d.last_seen ? esc(fmtRelativeTime(d.last_seen)) : 'never'}${d.force_checkin_requested ? '<div class="small muted">(pull requested)</div>' : ''}</td>
    <td class="actions-cell" style="white-space:nowrap;">${rowActionsCellHtml(d, editOk, deleteOk)}</td>
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

// (The SIM Data Usage tile grid that used to live here was removed - the same figures are in the
// All Devices table's Data Usage column and the Details modal, so the tiles only repeated them at
// the cost of a screen's worth of vertical space above the table. The over-80% banner still
// surfaces the one case that genuinely needs attention without scrolling.)

// 10 by default (same idea as Asset Inventory's own page-size select) rather than a fixed 25 - most
// visits are checking on a handful of specific PCs via the search box above, not reading straight
// down the list, so a shorter default page loads/scans faster and 25 or 50 is one click away for
// whoever actually wants the longer view.
const WD_PAGE_SIZE_OPTIONS = [10, 25, 50];
const WD_DEFAULT_PAGE_SIZE = 10;
function currentWdPageSize() {
  return WD_PAGE_SIZE_OPTIONS.includes(STATE.wdPageSize) ? STATE.wdPageSize : WD_DEFAULT_PAGE_SIZE;
}

// Numbered pager, rendered both above and below the table so a long page doesn't force a scroll
// back to the top to change page. Collapses to first / last / a window around the current page once
// there are more pages than fit comfortably, rather than printing every number.
function wdPagerHtml(curPage, totalPages, totalRows, pageSize) {
  const summary = `<span class="small muted">${totalRows} device${totalRows === 1 ? '' : 's'}${totalPages > 1 ? ` &middot; page ${curPage} of ${totalPages}` : ''}</span>`;
  const pageSizeSelect = `<select onchange="App.setWorkspaceDirectoryPageSize(this.value)" title="Devices per page" style="padding:5px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--card-bg);color:var(--text);">${WD_PAGE_SIZE_OPTIONS.map((n) => `<option value="${n}" ${pageSize === n ? 'selected' : ''}>${n} / page</option>`).join('')}</select>`;
  if (totalPages <= 1) {
    return `<div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:8px 4px;">${summary}${pageSizeSelect}</div>`;
  }

  const numbers = [];
  const push = (n) => { if (!numbers.includes(n)) numbers.push(n); };
  push(1);
  for (let n = curPage - 2; n <= curPage + 2; n++) if (n > 1 && n < totalPages) push(n);
  push(totalPages);
  numbers.sort((a, b) => a - b);

  let buttons = '';
  let previous = 0;
  for (const n of numbers) {
    // A gap in the sequence becomes an ellipsis rather than a misleadingly adjacent number.
    if (n - previous > 1) buttons += '<span class="small muted" style="padding:0 2px;">&hellip;</span>';
    const isCurrent = n === curPage;
    buttons += `<button class="btn-sm" ${isCurrent ? 'disabled' : ''} style="${isCurrent ? 'font-weight:700;opacity:1;' : ''}min-width:32px;" onclick="App.setWorkspaceDirectoryPage(${n})">${n}</button>`;
    previous = n;
  }

  return `<div style="display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:8px 4px;flex-wrap:wrap;">
    ${summary}
    ${pageSizeSelect}
    <button class="btn-sm" ${curPage <= 1 ? 'disabled' : ''} onclick="App.setWorkspaceDirectoryPage(${curPage - 1})">Prev</button>
    ${buttons}
    <button class="btn-sm" ${curPage >= totalPages ? 'disabled' : ''} onclick="App.setWorkspaceDirectoryPage(${curPage + 1})">Next</button>
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

  // Resolved once per device up front (each call walks that device's matched screens) and reused
  // for every tab's count plus the active filter below, rather than recomputing per tab.
  const venueCategoryFallbackMap = venueCategoryFallback(assetInventory);
  const categoryByDeviceId = new Map(devices.map((d) => [d.id, deviceCategoryTab(d, assetInventory, venueCategoryFallbackMap)]));
  // Built once per render for the whole fleet, same as the categories above, so the search filter
  // below stays a string test per device instead of re-resolving matched screens on every keystroke.
  const assetIndex = assetRowsByBoxId(assetInventory);
  const screenTextByDeviceId = new Map(devices.map((d) => [d.id, matchedScreenSearchText(d, assetIndex)]));
  const activeTab = WD_TAB_DEFS.some((t) => t.key === STATE.workspaceDirectoryTab) ? STATE.workspaceDirectoryTab : 'all';
  const tabsWithCounts = WD_TAB_DEFS.map((t) => ({ ...t, count: devices.filter((d) => deviceMatchesTab(d, t.key, categoryByDeviceId)).length }));
  const tabsHtml = renderTabs(tabsWithCounts, activeTab, 'App.setWorkspaceDirectoryTab');

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

  const tabFiltered = devices.filter((d) => deviceMatchesTab(d, activeTab, categoryByDeviceId));
  const search = (STATE.workspaceDirectorySearch || '').trim().toLowerCase();
  const filtered = search
    ? tabFiltered.filter((d) => `${d.hostname} ${d.location || ''} ${d.ip_address || ''} ${d.anydesk_id || ''} ${d.teamviewer_id || ''} ${d.logged_in_user || ''} ${d.os_name || ''} ${screenTextByDeviceId.get(d.id) || ''}`.toLowerCase().includes(search))
    : tabFiltered;
  const sorted = applySort(filtered, 'workspaceDevices', {
    hostname: (d) => d.hostname || '',
    location: (d) => d.location || '',
    ip: (d) => d.ip_address || '',
    os: (d) => d.os_name || '',
    user: (d) => d.logged_in_user || '',
    problems: (d) => (d.problems || []).length,
    lastSeen: (d) => d.last_seen || '',
    // Offline sorts ahead of online ascending, so one click on Status brings whatever needs
    // attention to the top rather than burying it under the healthy majority.
    status: (d) => (isOnline(d) ? 1 : 0),
    // Sorted by percentage consumed, not raw GB - the whole point is finding SIMs close to their
    // limit, and a 5GB-of-6GB plan matters far more than 80GB of a petabyte. A device with no plan
    // figure at all sorts to the bottom rather than pretending to be 0%.
    dataUsage: (d) => {
      const { allocGb, usedGb } = duUsageInfo(d, simById.get(d.sim_card_id));
      return allocGb ? (usedGb / allocGb) * 100 : -1;
    },
    // Same idea for disks: the fullest drive on each PC drives its sort position.
    // Unmeasured drives (size 0 - see volumeCellHtml) are filtered out rather than scored 0%, so a
    // device whose drives ALL failed to report falls back to the same -1 "nothing is known" sentinel
    // as a device carrying no volume data at all, instead of being ranked among genuinely near-empty
    // disks. Same convention as the dataUsage key below: unknown groups with unknown, which parks it
    // at the bottom of the descending (fullest-first) sort rather than pretending to be 0% used.
    volume: (d) => {
      const vols = (d.volumes || []).filter((v) => v.sizeGb > 0);
      if (!vols.length) return -1;
      return Math.max(...vols.map((v) => ((v.sizeGb - v.freeGb) / v.sizeGb) * 100));
    },
    screen: (d) => matchedScreensFor(d, assetInventory).map(matchedScreenLabel).join(' '),
  });

  const editOk = canEdit('workspaceDirectory');
  const deleteOk = canDelete('workspaceDirectory');
  const selectedIds = new Set(STATE.workspaceDirectorySelectedIds || []);
  // Select-all still spans the whole filtered set, not just the visible page - ticking the header
  // box then paging away and acting on the selection should mean what it looked like it meant.
  const sortedIds = sorted.map((d) => d.id);
  const allSelected = sortedIds.length > 0 && sortedIds.every((id) => selectedIds.has(id));

  const wdPageSize = currentWdPageSize();
  const totalPages = Math.max(1, Math.ceil(sorted.length / wdPageSize));
  // Clamped rather than trusted: a search that shrinks the result set can leave the stored page
  // number past the end, which would otherwise render an empty table with no obvious way back.
  const curPage = Math.min(Math.max(1, STATE.wdPage || 1), totalPages);
  const pageRows = sorted.slice((curPage - 1) * wdPageSize, curPage * wdPageSize);
  const pagerHtml = wdPagerHtml(curPage, totalPages, sorted.length, wdPageSize);

  const colCount = editOk ? 14 : 13;
  const rows = pageRows.map((d) => deviceRow(d, editOk, deleteOk, assetInventory, selectedIds, simById.get(d.sim_card_id))).join('')
    || `<tr><td colspan="${colCount}"><div class="empty">No devices match "${esc(STATE.workspaceDirectorySearch || '')}".</div></td></tr>`;

  return `
    ${ghostHtml}
    ${overLimitBannerHtml}
    <div class="kpi-row" style="margin-bottom:14px;">
      <div class="kpi"><div class="label">Total Devices</div><div class="value">${devices.length}</div></div>
      <div class="kpi"><div class="label">Online</div><div class="value" style="color:#1f9d55;">${online}</div></div>
      <div class="kpi"><div class="label">Offline</div><div class="value" style="color:#c0392b;">${offline}</div></div>
      <div class="kpi"><div class="label">With Issues</div><div class="value" style="color:${withProblems ? '#c0392b' : 'inherit'};">${withProblems}</div></div>
    </div>
    ${tabsHtml}
    ${editOk && selectedIds.size > 0 ? `<div class="banner" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <span><b>${selectedIds.size}</b> device${selectedIds.size === 1 ? '' : 's'} selected</span>
      <div style="display:flex;gap:8px;">
        <button class="btn-sm" title="Pull fresh inventory (or push each one's queued command) within ~20 minutes instead of waiting for its next scheduled cycle" onclick="App.bulkForceWorkspaceInventoryPull()">Force Selected</button>
        <button class="btn-sm" onclick="App.openWorkspaceBulkDeployModal()">Deploy to Selected</button>
        <button class="btn-sm" title="Hold these PCs at the agent version they are running now - no self-update until re-enabled" onclick="App.bulkToggleWorkspaceDeviceUpdates(true)">Disable Updates</button>
        <button class="btn-sm" title="Let these PCs self-update again - each jumps straight to the latest published version, not through the ones it missed" onclick="App.bulkToggleWorkspaceDeviceUpdates(false)">Enable Updates</button>
        <button class="btn-sm" onclick="App.clearWorkspaceSelection()">Clear Selection</button>
      </div>
    </div>` : ''}
    <div class="card">
      <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div><h3>All Devices</h3><div class="desc">${filtered.length} of ${devices.length} device(s) shown. Offline = no check-in for ${STALE_AFTER_MINUTES}+ minutes (a light check-in runs every 20 minutes; remote-access/OS/antivirus info updates roughly every 6 hours when changed; software/hardware/disk info and the DU data-usage scrape update once a day, in each PC's own slot between 3 AM and 8 AM).${editOk ? ' Tick devices below to deploy a command (install/uninstall software, etc.) to several at once.' : ''}</div></div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <input placeholder="Search hostname, screen, venue, location, IP, remote ID, user..." value="${esc(STATE.workspaceDirectorySearch || '')}" oninput="App.setWorkspaceDirectorySearch(this.value)" style="min-width:240px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;">
          <button class="btn-sm" title="Reload this page's data without refreshing the whole app" onclick="App.refreshWorkspaceDirectory()">&#8635; Refresh</button>
        </div>
      </div>
      ${pagerHtml}
      <div style="overflow-x:auto;">
        <!-- text-align:center on the table itself rather than per-cell: text-align inherits, so one
             declaration centres every header and every body cell together and they can't drift out
             of step as columns are added later. Volume is 21ch against Data Usage's 18ch on purpose,
             not by accident: its cell also carries a "C:"/"D:" label and gap (~15.6px measured),
             which comes straight off the bar's width. The extra 3ch buys that back so both columns'
             bars render at the same size instead of Volume's looking squashed beside it.
             No max-height/vertical scroll any more: with 25 rows to a page the table is a bounded
             length on its own, and an inner scrollbar on top of pagination means two competing ways
             to move through the same list. -->
        <table class="zebra" style="${FIXED_TABLE_STYLE}text-align:center;">
          <thead><tr>
            ${editOk ? `<th style="width:24px;"><input type="checkbox" ${allSelected ? 'checked' : ''} onchange='App.toggleWorkspaceSelectAll(this.checked, ${jsonAttr(sortedIds)})' title="Select all shown"></th>` : ''}
            ${sortTh('workspaceDevices', 'hostname', 'Hostname', 22, 'center')}
            ${sortTh('workspaceDevices', 'volume', 'Volume', 21, 'center')}
            ${sortTh('workspaceDevices', 'location', 'Location', 14, 'center')}
            ${sortTh('workspaceDevices', 'ip', 'IP', 15, 'center')}
            <th style="width:15ch;">Remote Access</th>
            ${sortTh('workspaceDevices', 'dataUsage', 'Data Usage', 18, 'center')}
            ${sortTh('workspaceDevices', 'status', 'Status', 13, 'center')}
            ${sortTh('workspaceDevices', 'screen', 'Matched Screen', 20, 'center')}
            ${sortTh('workspaceDevices', 'os', 'OS', 16, 'center')}
            ${sortTh('workspaceDevices', 'user', 'Logged-in User', 19, 'center')}
            ${sortTh('workspaceDevices', 'problems', 'Issues', 10, 'center')}
            ${sortTh('workspaceDevices', 'lastSeen', 'Last Seen', 27, 'center')}
            <!-- Was 18ch, sized for the old six-pill row - one icon button needs a fraction of
                 that, and the reclaimed width is exactly the point of the kebab-menu redesign. -->
            <th style="width:44px;"></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${pagerHtml}
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

// Any new search starts from page 1 - keeping the old page number would land on an empty or
// unrelated slice of a result set the user has just changed underneath themselves.
export function setWorkspaceDirectorySearch(value) { setState({ workspaceDirectorySearch: value, wdPage: 1 }); }

// Same page-1 reset as a new search - switching category also changes which rows are in play.
export function setWorkspaceDirectoryTab(key) { setState({ workspaceDirectoryTab: key, wdPage: 1 }); }

export function setWorkspaceDirectoryPage(page) { setState({ wdPage: Math.max(1, Number(page) || 1) }); }
export function setWorkspaceDirectoryPageSize(size) { setState({ wdPageSize: Number(size), wdPage: 1 }); }

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

// Row-level click-through to Details. Anything the user aimed at a real control - the select
// checkbox, the row's own kebab menu, a Remote Access link, the copy-ID button inside the remote
// chips - must keep doing only its own thing, so those are filtered out before opening. Text
// selection is also respected: dragging to highlight a hostname or IP shouldn't be punished with a
// modal on mouse-up.
export function openWorkspaceDetailsFromRow(event, deviceId) {
  if (event.target.closest('button, a, input, select, textarea, label')) return;
  const selection = window.getSelection();
  if (selection && String(selection).length > 0) return;
  openModal('workspaceDetails', { deviceId });
}

// Small inline icon set for the per-row kebab menu (see rowActionsCellHtml) - kept as plain SVG
// strings rather than an icon font/library so a row's actions cost nothing beyond this file.
const ROW_ACTION_ICONS = {
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>',
  force: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>',
  optimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  kebab: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>',
};

// Replaces what used to be up to six equal-weight pills per row (Details/Edit/Rename/Force/
// Restart/Delete) with one icon button. Details is dropped entirely rather than moved into the
// menu - clicking anywhere on the row already opens it (see openWorkspaceDetailsFromRow above), so
// it was a second control doing the same thing the row itself already does.
//
// The menu's real markup lives in an inert <template> here, not in a sibling <div> - a <template>'s
// content is never laid out or painted, so it can't be clipped by the table's own
// "overflow-x:auto" wrapper (a plain hidden div nested in that wrapper would be). toggleWorkspaceRowMenu
// below clones it into a position:fixed element appended straight to <body> instead, which sidesteps
// that clipping and any table-scroll clipping entirely.
function rowActionsCellHtml(d, editOk, deleteOk) {
  if (!editOk && !deleteOk) return '';
  const items = [
    editOk && `<button onclick="App.openWorkspaceEditModal('${d.id}')">${ROW_ACTION_ICONS.edit}Edit</button>`,
    editOk && `<button title="Rename the Windows computer name on this PC - it applies the change and restarts itself" onclick="App.openWorkspaceRenameModal('${d.id}')">${ROW_ACTION_ICONS.rename}Rename</button>`,
    editOk && `<button title="${d.force_checkin_requested ? 'Already requested and still pending - click to re-request' : (d.pending_command ? 'Push the queued Run Command to this PC now' : 'Pull fresh inventory from this PC now')} - within ~20 minutes instead of waiting for its next scheduled cycle" onclick="App.forceWorkspaceInventoryPull('${d.id}')">${ROW_ACTION_ICONS.force}Force${d.force_checkin_requested ? ' Again' : ''}</button>`,
    editOk && `<button title="Restart this PC now - no one needs to be there, it comes back on its own within a minute or two" onclick="App.restartWorkspaceDevice('${d.id}')">${ROW_ACTION_ICONS.restart}Restart</button>`,
    editOk && `<button title="Run the Signage PC Optimizer Script on this PC now (Defender CPU limit, temp/Windows Update cache cleanup, quick scan) - runs as SYSTEM, no elevation prompt. Edit the script itself from Settings." onclick="App.optimizeWorkspaceDevice('${d.id}')">${ROW_ACTION_ICONS.optimize}Optimize</button>`,
  ].filter(Boolean);
  return `
    <button class="icon-btn" title="More actions" onclick="App.toggleWorkspaceRowMenu(event, '${d.id}')">${ROW_ACTION_ICONS.kebab}</button>
    <template id="rowmenu-tpl-${d.id}">
      ${items.join('')}
      ${deleteOk ? `${items.length ? '<hr>' : ''}<button class="danger" onclick="App.removeWorkspaceDevice('${d.id}')">${ROW_ACTION_ICONS.delete}Delete</button>` : ''}
    </template>`;
}

// Body-appended (not inline in the row - see rowActionsCellHtml above) so it can never be clipped
// by the table's scroll wrapper, and so exactly one can ever be open regardless of which row's
// button was clicked. Closed on the next click anywhere (including a click on one of its own
// items - the item's own onclick already ran by the time the bubble reaches here), on any scroll
// (capture:true - the table's own scroll container doesn't bubble scroll events to document at
// all), and on resize, so it can never end up floating over the wrong spot after the page moves.
function closeWorkspaceRowMenu() {
  const existing = document.getElementById('workspace-row-menu-active');
  if (existing) existing.remove();
}
document.addEventListener('click', closeWorkspaceRowMenu);
document.addEventListener('scroll', closeWorkspaceRowMenu, true);
window.addEventListener('resize', closeWorkspaceRowMenu);

export function toggleWorkspaceRowMenu(event, deviceId) {
  event.stopPropagation();
  const reopening = document.getElementById('workspace-row-menu-active')?.dataset.forDevice === deviceId;
  closeWorkspaceRowMenu();
  if (reopening) return;
  const tpl = document.getElementById(`rowmenu-tpl-${deviceId}`);
  if (!tpl) return;
  const btnRect = event.currentTarget.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.id = 'workspace-row-menu-active';
  menu.className = 'row-menu';
  menu.dataset.forDevice = deviceId;
  menu.innerHTML = tpl.innerHTML;
  menu.style.top = `${btnRect.bottom + 4}px`;
  menu.style.right = `${window.innerWidth - btnRect.right}px`;
  document.body.appendChild(menu);
  // Flips above the button instead of below it only when it would otherwise run off the bottom of
  // the viewport - checked after appending since the menu's real height depends on how many items
  // this row actually has (Edit/Rename/Force/Restart are each permission-gated).
  const menuRect = menu.getBoundingClientRect();
  if (menuRect.bottom > window.innerHeight) {
    menu.style.top = `${btnRect.top - menuRect.height - 4}px`;
  }
}

export function openWorkspaceAnyDeskPasswordModal(deviceId) {
  openModal('workspaceAnyDeskPassword', { deviceId });
}

// Sends a new AnyDesk password to ONE device.
//
// The value goes into agent_secret_deliveries, never into pending_command. A queued Run Command
// would leave a live remote-access credential in three long-lived clear-text places - the device's
// pending_command, the audit_log detail for queueing it, and afterwards last_command_output - all
// readable by anyone with dashboard or database access. agent_secret_deliveries has no SELECT
// policy at all, so a password can be sent and never read back, and the row is destroyed the moment
// the agent confirms it applied.
//
// The audit entry deliberately records only that a change was sent, and to which host.
export async function saveWorkspaceAnyDeskPassword(event, deviceId) {
  event.preventDefault();
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const device = devices.find((d) => d.id === deviceId);
  if (!device) { toast('Device not found', 'error'); return; }
  const targetId = document.getElementById('wd-anydesk-target')?.value || '';
  if (!targetId) { toast('Choose which AnyDesk installation to set the password on.', 'error'); return; }
  const pw = document.getElementById('wd-anydesk-pw').value || '';
  const pw2 = document.getElementById('wd-anydesk-pw2').value || '';
  if (pw !== pw2) { toast('The two passwords do not match.', 'error'); return; }
  // AnyDesk itself accepts short passwords; refusing them here is a deliberate floor, since these
  // machines are reachable by anyone who knows the ID.
  if (pw.length < 8) { toast('Use at least 8 characters - this password grants remote control of the PC.', 'error'); return; }
  try {
    const { error } = await supabase.from('agent_secret_deliveries')
      .insert({ hostname: device.hostname, kind: 'anydeskPassword', secret: pw, target: targetId });
    if (error) throw error;
    // Records WHICH install was targeted, never the password itself.
    await logAudit('Send AnyDesk password', `${device.hostname} (AnyDesk ${targetId})`);
    closeModal();
    toast(`Password sent to ${device.hostname} for AnyDesk ${targetId} - it applies within a minute or two.`);
    setState({});
  } catch (e) {
    toast(e.message || 'Could not send the password', 'error');
  }
}

export function openWorkspaceRenameModal(deviceId) {
  openModal('workspaceRename', { deviceId });
}

// Windows computer-name rules, checked here so an invalid name is refused before it is ever queued
// rather than failing minutes later on the device: 1-15 characters, letters/digits/hyphens only,
// and never entirely numeric. The agent re-checks all of this independently before touching the
// machine - this copy exists to give immediate feedback, not to be the only guard.
function invalidComputerNameReason(name) {
  if (!name) return 'Enter a name.';
  if (name.length > 15) return `Windows allows at most 15 characters - this is ${name.length}.`;
  if (!/^[A-Za-z0-9-]+$/.test(name)) return 'Only letters, digits and hyphens are allowed.';
  if (/^[0-9]+$/.test(name)) return 'A computer name cannot be entirely numeric.';
  return null;
}

export async function saveWorkspaceRename(event, deviceId) {
  event.preventDefault();
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const device = devices.find((d) => d.id === deviceId);
  if (!device) { toast('Device not found', 'error'); return; }
  const newName = (document.getElementById('wd-rename-name').value || '').trim();
  const problem = invalidComputerNameReason(newName);
  if (problem) { toast(problem, 'error'); return; }
  if (newName.toUpperCase() === (device.hostname || '').toUpperCase()) {
    toast('That is already this PC\'s name.', 'error');
    return;
  }
  if (devices.some((d) => d.id !== deviceId && (d.hostname || '').toUpperCase() === newName.toUpperCase())) {
    toast(`Another device is already called "${newName}" - pick a different name.`, 'error');
    return;
  }
  try {
    await updateWorkspaceDevice(deviceId, { pending_command: `::RENAME ${newName}` });
    await logAudit('Rename workspace device', `${device.hostname} -> ${newName}`);
    invalidate('workspaceDevices');
    closeModal();
    toast(`Rename to "${newName}" queued - the PC applies it and restarts on its next check-in.`);
    setState({});
  } catch (e) { toast(e.message || 'Failed to queue the rename', 'error'); }
}

export async function clearWorkspacePendingCommand(deviceId) {
  try {
    await updateWorkspaceDevice(deviceId, { pending_command: null });
    invalidate('workspaceDevices');
    toast('Pending command cleared');
    setState({});
  } catch (e) { toast(e.message || 'Failed to clear command', 'error'); }
}

// Holds one PC at the agent version it is running, or lets it move again. Aimed per-device rather
// than fleet-wide because most of these machines drive signage in malls nobody can walk up to, so
// "which PCs are allowed to move" is a different question from "which build is published" - the
// canary/stable split answers the second, this answers the first.
//
// Pins to whatever version that device's channel is serving right now, since that is what it is
// running. Stored on the device rather than derived later so the pin cannot drift when someone
// publishes again - that drift is exactly what this switch exists to prevent.
//
// Re-enabling does not replay anything it missed: the agent compares what it has against what is
// published now and fetches that one build, so it jumps straight to the latest.
export async function toggleWorkspaceDeviceUpdates(deviceId, disable) {
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const device = devices.find((x) => x.id === deviceId);
  const settings = STATE.pageData.settings?.data || {};
  const isTestPc = AGENT_CANARY_HOSTNAMES.some((h) => h.toUpperCase() === String(device?.hostname || '').toUpperCase());
  const channelVersion = isTestPc
    ? (settings.workspaceDirectoryAgentShellCanary?.version || settings.workspaceDirectoryAgentShell?.version || null)
    : (settings.workspaceDirectoryAgentShell?.version || null);
  try {
    await updateWorkspaceDevice(deviceId, {
      updates_disabled: !!disable,
      updates_pinned_version: disable ? channelVersion : null,
    });
    await logAudit(disable ? 'Disable agent updates for device' : 'Enable agent updates for device', `${device?.hostname || deviceId}${disable && channelVersion ? ` (pinned at v${channelVersion})` : ''}`);
    invalidate('workspaceDevices');
    toast(disable
      ? `${device?.hostname || 'Device'} held${channelVersion ? ` at v${channelVersion}` : ''} - it will not update until re-enabled.`
      : `${device?.hostname || 'Device'} will pick up the latest published version on its next check-in.`);
    setState({});
  } catch (e) { toast(e.message || 'Could not change the update setting', 'error'); }
}

// Same hold, applied to every currently-selected device at once - the practical way to freeze a
// whole venue or an entire network before trying a build, without clicking through them one by one.
export async function bulkToggleWorkspaceDeviceUpdates(disable) {
  const ids = STATE.workspaceDirectorySelectedIds || [];
  if (!ids.length) { toast('Select at least one device first', 'error'); return; }
  const settings = STATE.pageData.settings?.data || {};
  const devices = STATE.pageData.workspaceDevices?.data || [];
  try {
    await Promise.all(ids.map((id) => {
      const d = devices.find((x) => x.id === id);
      const isTestPc = AGENT_CANARY_HOSTNAMES.some((h) => h.toUpperCase() === String(d?.hostname || '').toUpperCase());
      const channelVersion = isTestPc
        ? (settings.workspaceDirectoryAgentShellCanary?.version || settings.workspaceDirectoryAgentShell?.version || null)
        : (settings.workspaceDirectoryAgentShell?.version || null);
      return updateWorkspaceDevice(id, { updates_disabled: !!disable, updates_pinned_version: disable ? channelVersion : null });
    }));
    await logAudit(disable ? 'Disable agent updates (bulk)' : 'Enable agent updates (bulk)', `${ids.length} device(s)`);
    invalidate('workspaceDevices');
    toast(disable ? `Updates held on ${ids.length} device(s).` : `Updates resumed on ${ids.length} device(s) - each picks up the latest version.`);
    setState({ workspaceDirectorySelectedIds: [] });
  } catch (e) { toast(e.message || 'Could not change the update setting', 'error'); }
}

// "Check Now" on a device's Data Usage panel - re-runs that PC's mydata.du.ae check on demand
// rather than waiting for its next daily slot, which is the difference between answering "what
// is this PC using right now" in twenty minutes and answering it tomorrow.
//
// Queued as the ::DUCHECK marker rather than as a literal "Get-DuDataUsage" Run Command, because
// only the marker's agent-side handler posts the result back as a real check-in payload - a plain
// Run Command would print the figures into Last Command Output and leave this very panel unchanged.
// Paired with force_checkin_requested for the same reason the Force button sets it: nothing here
// can reach out to these PCs, so the fastest path is the agent's own 20-minute poll noticing.
//
// Refuses on a device that already has an unrelated command queued instead of silently discarding
// it - there is only one pending_command slot per device, and quietly dropping someone's queued
// install to service a usage check is not a trade this button gets to make on its own.
export async function checkWorkspaceDataUsage(deviceId) {
  try {
    const devices = STATE.pageData.workspaceDevices?.data || [];
    const device = devices.find((x) => x.id === deviceId);
    const queued = device?.pending_command;
    if (queued && queued !== '::DUCHECK') {
      toast('This PC already has a different command queued - clear it first, then check data usage.', 'error');
      return;
    }
    await updateWorkspaceDevice(deviceId, { pending_command: '::DUCHECK', force_checkin_requested: true });
    await logAudit('Check Digital Directory data usage', device?.hostname || deviceId);
    invalidate('workspaceDevices');
    toast('Data usage check queued - this PC reports back within ~20 minutes.');
    setState({});
  } catch (e) { toast(e.message || 'Failed to queue data usage check', 'error'); }
}

// A plain queued Run Command rather than a dedicated marker (unlike ::DUCHECK) - a restart has no
// figures to fold into a check-in payload, so there is nothing here for a special handler to do
// that a Run Command doesn't already do on its own: SYSTEM always has the rights to restart the
// machine it runs on, no elevation prompt to worry about the way an interactive user would hit one.
//
// -Force rather than a plain restart - these are unattended kiosks, so there is no one at the
// keyboard to click through an app asking to save its work, and a restart that silently waits on
// that forever is worse than one that just happens. Confirmed client-side first: this is the one
// button here disruptive enough (drops whatever is on screen, however briefly) that a stray click
// deserves a chance to back out, the same treatment "Roll Out to All PCs" already gets.
export async function restartWorkspaceDevice(deviceId) {
  try {
    const devices = STATE.pageData.workspaceDevices?.data || [];
    const device = devices.find((x) => x.id === deviceId);
    if (!confirm(`Restart ${device?.hostname || 'this PC'} now?\n\nIt will drop offline briefly and come back on its own - no one needs to be there.`)) return;
    const queued = device?.pending_command;
    if (queued) {
      toast('This PC already has a different command queued - clear it first, then restart.', 'error');
      return;
    }
    await updateWorkspaceDevice(deviceId, { pending_command: 'Restart-Computer -Force', force_checkin_requested: true });
    await logAudit('Restart Digital Directory device', device?.hostname || deviceId);
    invalidate('workspaceDevices');
    toast('Restart queued - this PC picks it up within ~20 minutes.');
    setState({});
  } catch (e) { toast(e.message || 'Failed to queue restart', 'error'); }
}

// Same "plain queued Run Command" shape as restartWorkspaceDevice above, just with the Signage PC
// Optimizer Script (see Settings -> Jstar Agent) as the body instead of a single Restart-Computer
// line - editing and saving that script is how this button picks up a new/changed optimization
// step, no code change or reinstall needed. Runs as SYSTEM like any Run Command (see
// Invoke-PendingCommand in the agent shell), so the script's own "Run as Administrator" comment is
// already satisfied automatically.
export async function optimizeWorkspaceDevice(deviceId) {
  try {
    const devices = STATE.pageData.workspaceDevices?.data || [];
    const device = devices.find((x) => x.id === deviceId);
    const settings = STATE.pageData.settings?.data || {};
    const script = settings.workspaceDirectoryOptimizerScript?.script || defaultOptimizerScript();
    if (!confirm(`Run the Signage PC Optimizer Script on ${device?.hostname || 'this PC'} now?\n\nSets the Defender scan CPU limit, cleans temp/Windows Update cache, and runs a Defender quick scan.`)) return;
    const queued = device?.pending_command;
    if (queued) {
      toast('This PC already has a different command queued - clear it first, then optimize.', 'error');
      return;
    }
    await updateWorkspaceDevice(deviceId, { pending_command: script, force_checkin_requested: true });
    await logAudit('Optimize Digital Directory device', device?.hostname || deviceId);
    invalidate('workspaceDevices');
    toast('Optimizer script queued - this PC picks it up within ~20 minutes.');
    setState({});
  } catch (e) { toast(e.message || 'Failed to queue optimizer script', 'error'); }
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

registerModal('workspaceDetails', (data) => {
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const assetInventory = STATE.pageData.assetInventory?.data || [];
  const simCards = STATE.pageData.simCardsForDirectory?.data || [];
  const d = devices.find((x) => x.id === data.deviceId);
  if (!d) return `<div class="empty">Device not found.</div><div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>`;
  const matches = matchedScreensFor(d, assetInventory);
  const editOk = canEdit('workspaceDirectory');
  const sim = simCards.find((s) => s.id === d.sim_card_id);
  const { haveDu, allocGb, usedGb, leftGb, phone } = duUsageInfo(d, sim);
  const usagePct = allocGb ? Math.min(100, (usedGb / allocGb) * 100) : 0;
  const usageColor = usagePct >= 80 ? '#c0392b' : usagePct >= 70 ? '#e07a2c' : '#1f9d55';
  // "No data usage reported yet" was the whole story this panel could tell before the agent
  // reported its attempts, and it was the wrong one for every device that had been trying and
  // getting nowhere. Says which of the four states this device is actually in instead.
  const duStatusHtml = duScrapeStatusHtml(d);
  const dataUsageHtml = !phone && !allocGb
    ? `<div class="empty">No data usage reported yet.</div>${duStatusHtml}`
    : `<div class="small" style="display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;">
        ${phone ? `<span class="muted">Phone Number</span><span style="text-align:right;">${esc(phone)}</span>` : ''}
        <span class="muted">Total Data</span><span style="text-align:right;">${allocGb ? fmtGb(allocGb) : '&mdash;'}</span>
        <span class="muted">Data Used</span><span style="text-align:right;">${allocGb ? fmtGb(usedGb) : '&mdash;'}</span>
        <span class="muted">Data Left</span><span style="text-align:right;">${allocGb ? fmtGb(leftGb) : '&mdash;'}</span>
        <span class="muted">${haveDu ? 'DU Last Update' : 'Last Update'}</span><span style="text-align:right;">${haveDu ? esc(fmtRelativeTime(d.du_scraped_at)) : (d.last_seen ? esc(fmtRelativeTime(d.last_seen)) : '&mdash;')}</span>
      </div>
      ${allocGb ? `<div style="margin-top:8px;">${stripedBarHtml(usagePct, usageColor)}</div>` : '<div class="small muted" style="margin-top:6px;">No plan size set yet - link a SIM Card, or wait for the usage figure to finish scraping.</div>'}
      ${duStatusHtml}`;

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
    ${editOk ? `<div class="small" style="margin-bottom:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span>${anyDeskInstallsFor(d).length
        ? anyDeskInstallsFor(d).map((a) => `AnyDesk <b>${esc(a.id)}</b> - ${esc(anyDeskInstallLabel(a).split(' - ')[1])}`).join('<br>')
          + (d.anydesk_password_set_at ? `<div class="small muted">Last changed from here ${esc(fmtRelativeTime(d.anydesk_password_set_at))}.</div>` : '')
        : 'No AnyDesk detected on this PC.'}</span>
      ${anyDeskInstallsFor(d).length ? `<button class="btn-sm" onclick="App.openWorkspaceAnyDeskPasswordModal('${d.id}')">Set AnyDesk Password</button>` : ''}
    </div>` : ''}
    ${editOk ? `<div class="small" style="margin-bottom:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;${d.updates_disabled ? 'padding:8px 10px;border-radius:6px;background:var(--row-alt);border-left:3px solid #c0392b;' : ''}">
      <span>${d.updates_disabled
        ? `<b>Agent updates held</b>${d.updates_pinned_version ? ` at v${d.updates_pinned_version}` : ''} - this PC will not self-update until re-enabled.`
        : 'Agent updates enabled - this PC self-updates to whatever version is published for it.'}</span>
      <button class="btn-sm" onclick="App.toggleWorkspaceDeviceUpdates('${d.id}', ${d.updates_disabled ? 'false' : 'true'})">${d.updates_disabled ? 'Enable Updates' : 'Disable Updates'}</button>
    </div>` : ''}

    <div class="card-head" style="margin-top:4px;"><h3 style="font-size:13px;">Remote Access</h3></div>
    <div style="margin-bottom:12px;">${remoteAccessCell(d)}</div>

    <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <h3 style="font-size:13px;">Data Usage</h3>
      ${editOk ? `<button class="btn-sm" title="Re-run this PC's mydata.du.ae check now instead of waiting for tomorrow morning - picked up within ~20 minutes, and it uses up today's automatic check." onclick="App.checkWorkspaceDataUsage('${d.id}')">Check Now</button>` : ''}
    </div>
    <div style="margin-bottom:12px;">${dataUsageHtml}</div>

    <div class="card-head"><h3 style="font-size:13px;">Matched Broadsign/Grassfish Screen</h3></div>
    <div class="small" style="margin-bottom:12px;">
      ${matches.length
        ? matches.map((m) => `<div>${matchedScreenHtmlLabel(m)}</div>`).join('')
        : `<span class="muted">No match${(d.broadsign_player_id || d.grassfish_box_id) ? ` (ID ${esc([d.broadsign_player_id, d.grassfish_box_id].filter(Boolean).join(', '))} not found in Asset Inventory)` : ' - no Broadsign/Grassfish player detected on this PC'}</span>`}
      ${(d.broadsign_player_id || d.grassfish_box_id) ? `<div class="small muted" style="margin-top:4px;">${[d.broadsign_player_id ? `Broadsign player: ${esc(d.broadsign_player_id)}` : '', d.grassfish_box_id ? `Grassfish box: ${esc(d.grassfish_box_id)}` : ''].filter(Boolean).join(' &middot; ')}</div>` : ''}
    </div>

    <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <h3 style="font-size:13px;">Problems</h3>
      ${editOk ? `<button class="btn-sm" title="Restart this PC now - the same thing clicking Restart on a Windows Security/Update prompt would do, without needing to be physically there or remoted in" onclick="App.restartWorkspaceDevice('${d.id}')">Restart PC</button>` : ''}
    </div>
    <div style="margin-bottom:12px;">${problemsHtml}${ignoredProblemsHtml}</div>

    <div class="card-head"><h3 style="font-size:13px;">Antivirus</h3></div>
    <div style="margin-bottom:12px;">${antivirusHtml}</div>

    <div class="card-head"><h3 style="font-size:13px;">Components</h3></div>
    <div style="margin-bottom:12px;">${componentsHtml}</div>

    <div class="card-head"><h3 style="font-size:13px;">Volumes</h3></div>
    <div style="margin-bottom:12px;">${volumesHtml}</div>

    <div class="card-head"><h3 style="font-size:13px;">Software</h3></div>
    <div style="margin-bottom:12px;">${softwareHtml}</div>

    ${d.pending_command === '::DUCHECK'
      // Not a command anyone typed, so showing it as one (a bare "::DUCHECK" in a code block) would
      // read like a glitch rather than like the Check Now button they just pressed.
      ? '<div class="card-head"><h3 style="font-size:13px;">Pending Command</h3></div><div class="small muted" style="margin-bottom:12px;">Data usage check - runs on the next check-in.</div>'
      : d.pending_command ? `<div class="card-head"><h3 style="font-size:13px;">Pending Command${/^\s*::BATCH\r?\n/.test(d.pending_command) ? ' (Batch script)' : ''}</h3></div><div class="small" style="margin-bottom:12px;"><code style="white-space:pre-wrap;">${esc(stripBatchMarker(d.pending_command))}</code> - runs on the next check-in.</div>` : ''}
    ${d.last_command_output ? `<div class="card-head"><h3 style="font-size:13px;">Last Command Output</h3></div><div class="small muted" style="margin-bottom:4px;">${d.last_command_at ? esc(fmtRelativeTime(d.last_command_at)) : ''}</div><pre style="max-height:200px;overflow-y:auto;background:var(--bg);padding:8px;border-radius:6px;white-space:pre-wrap;font-size:11.5px;">${esc(d.last_command_output)}</pre>` : ''}

    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

// The AnyDesk installations on a device, each with whether an unattended password is set.
//
// Falls back to the bare ids the agent has always reported when anydesk_installs is absent - a
// device that has not checked in since this shipped still gets a usable picker, just without the
// password indicator, rather than an empty dialog that makes the feature look broken.
function anyDeskInstallsFor(d) {
  const detailed = Array.isArray(d.anydesk_installs) ? d.anydesk_installs.filter((a) => a && a.id) : [];
  if (detailed.length) return detailed;
  const ids = [];
  if (d.anydesk_id) ids.push(String(d.anydesk_id));
  (d.other_remote_ids || []).forEach((r) => {
    if (/^AnyDesk/i.test(r.tool || '') && r.id) ids.push(String(r.id));
  });
  return [...new Set(ids)].map((id) => ({ id, passwordSet: null }));
}

function anyDeskInstallLabel(a) {
  // null (rather than false) means "this device predates the indicator" - saying "no password set"
  // there would be a claim the data does not support.
  const state = a.passwordSet === true ? 'password set'
    : a.passwordSet === false ? 'no password set'
    : 'password state unknown';
  return `${a.id} - ${state}`;
}

registerModal('workspaceAnyDeskPassword', (data) => {
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const device = devices.find((d) => d.id === data.deviceId);
  if (!device) return `<div class="empty">Device not found.</div><div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>`;
  const setAt = device.anydesk_password_set_at ? fmtRelativeTime(device.anydesk_password_set_at) : null;
  return `
    <h3>Set AnyDesk Password - ${esc(device.hostname)}</h3>
    <form onsubmit="App.saveWorkspaceAnyDeskPassword(event, '${device.id}')" autocomplete="off">
      <div class="field">
        <label>Which AnyDesk installation</label>
        <select id="wd-anydesk-target" required>
          ${anyDeskInstallsFor(device).map((a) => `<option value="${esc(a.id)}">${esc(anyDeskInstallLabel(a))}</option>`).join('')}
        </select>
        <div class="small muted" style="margin-top:4px;">This PC runs ${anyDeskInstallsFor(device).length} AnyDesk installation(s) - a standard install and a custom-branded build each answer on their own ID, so the password has to be set against one of them specifically.</div>
      </div>
      <div class="field">
        <label>New AnyDesk password</label>
        <input id="wd-anydesk-pw" type="password" autocomplete="new-password" spellcheck="false" required>
        <div class="small muted" style="margin-top:4px;">This sets the unattended-access password AnyDesk asks for when connecting to this PC.</div>
      </div>
      <div class="field">
        <label>Confirm password</label>
        <input id="wd-anydesk-pw2" type="password" autocomplete="new-password" spellcheck="false" required>
      </div>
      <div class="small" style="border-left:3px solid #e07a2c;padding:8px 12px;margin:12px 0;background:var(--bg);">
        The password is sent to that one PC and destroyed as soon as it confirms the change. It is
        never stored in the device's command history, never written to the audit log, and cannot be
        read back from this dashboard by anyone - <b>including you</b>. Note it down somewhere safe
        before sending, because nothing here can show it to you again.
        ${setAt ? `<div style="margin-top:6px;">Last changed from here <b>${esc(setAt)}</b>.</div>` : ''}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn-sm">Send to this PC</button>
      </div>
    </form>`;
});

registerModal('workspaceRename', (data) => {
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const device = devices.find((d) => d.id === data.deviceId);
  if (!device) return `<div class="empty">Device not found.</div><div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>`;
  return `
    <h3>Rename PC - ${esc(device.hostname)}</h3>
    <form onsubmit="App.saveWorkspaceRename(event, '${device.id}')">
      <div class="field">
        <label>New computer name</label>
        <input id="wd-rename-name" value="${esc(device.hostname || '')}" maxlength="15" autocomplete="off" spellcheck="false" required>
        <div class="small muted" style="margin-top:4px;">Up to 15 characters. Letters, digits and hyphens only, and not all digits - these are Windows' own rules for a computer name.</div>
      </div>
      <div class="small" style="border-left:3px solid #e07a2c;padding:8px 12px;margin:12px 0;background:var(--bg);">
        This renames Windows itself on that PC, not just the label here. The agent applies the
        rename and then <b>restarts the PC</b> to make it take effect - nothing is shown on the
        screen while it happens. Expect that device to drop off and come back under its new name a
        few minutes later, keeping its Location, Notes, linked SIM Card and history.
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn-sm">Queue rename &amp; restart</button>
      </div>
    </form>`;
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
