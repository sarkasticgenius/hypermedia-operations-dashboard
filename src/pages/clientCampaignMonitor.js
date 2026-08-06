// Client Campaigns Monitor - shows a client only the current month's Traffic Sheet campaigns
// whose venue matches one of the venue names an admin assigned to them (Settings > Clients), lets
// them Approve one (with an optional comment, shown on Slack), and lets internal Ops (admin, or
// 'clientCampaigns' edit permission) mark it Live once it's actually turned on in Broadsign/
// Grassfish. Nothing about the live campaign itself is stored - only the approval workflow state,
// in campaign_approvals, keyed by the campaign's `contract` id and lazily created the first time a
// matching campaign is seen.
import { STATE, setState, loadData, invalidate, toast, openModal, closeModal } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { isAdmin, isClientUser, canEdit } from '../auth.js';
import { esc, jsAttr } from '../lib/format.js';
import { logAudit } from '../lib/audit.js';
import { listClients } from '../data/clients.js';
import { listApprovalsForClient, upsertPendingApproval, approveCampaign, markCampaignLive } from '../data/campaignApprovals.js';
import { notifySlack } from '../data/slack.js';
import { fetchTrafficSheetCampaigns, normalizeVenueText, statusBadge, renderDayGrid } from './trafficSheet.js';

const ALL_CLIENTS_KEY = '__all__';
const PENDING_ALERT_MINUTES = 15;
const AUTO_REFRESH_MS = 10 * 60 * 1000;

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Fetches + joins in one loader so render() stays pure - loadData() only ever runs this once per
// cache key, so it's the right place for the lazy "create a pending row for anything new" write,
// not inside render itself.
async function loadClientMonitorData(clientId, venueNames) {
  const month = currentMonth();
  const [sheet, approvals] = await Promise.all([
    fetchTrafficSheetCampaigns(month, month),
    listApprovalsForClient(clientId),
  ]);

  const venueSet = new Set((venueNames || []).map((v) => normalizeVenueText(v)));
  const matched = (sheet.campaigns || [])
    .map((c) => {
      const matchedVenues = (c.venues || []).filter((v) => venueSet.has(normalizeVenueText(v.venue)));
      return matchedVenues.length ? { ...c, __matchedVenues: matchedVenues } : null;
    })
    .filter(Boolean);

  const approvalByContract = new Map(approvals.map((a) => [a.contract, a]));
  const missing = matched.filter((c) => !approvalByContract.has(c.contract));
  if (missing.length) {
    await Promise.all(missing.map((c) => upsertPendingApproval(c.contract, clientId, c.campaignName)));
    const refreshed = await listApprovalsForClient(clientId);
    refreshed.forEach((a) => approvalByContract.set(a.contract, a));
  }

  return matched.map((c) => ({ ...c, __approval: approvalByContract.get(c.contract) || null }));
}

// Admin/staff "All Clients" view - every client's own matched campaigns run in parallel and
// flattened into one list, each row tagged with which client it belongs to.
async function loadCombinedClientMonitorData(clients) {
  const perClient = await Promise.all(
    clients.map(async (c) => (await loadClientMonitorData(c.id, c.venue_names)).map((row) => ({ ...row, __clientName: c.name })))
  );
  return perClient.flat();
}

// Newest-first by default - the closest available "when did we first see this campaign" signal,
// since AdLive doesn't expose a created/booked timestamp of its own; campaign_approvals.created_at
// (set the first time this page ever saw the campaign, see loadClientMonitorData) is what's left.
function sortNewestFirst(rows) {
  return [...rows].sort((a, b) => new Date(b.__approval?.created_at || 0) - new Date(a.__approval?.created_at || 0));
}

function renderClientPicker(clients, activeId) {
  const options = clients.map((c) => `<option value="${c.id}" ${c.id === activeId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  return `
    <div class="toolbar">
      <div class="toolbar-actions">
        <select onchange="App.setActiveClient(this.value)">
          <option value="">Select a client to preview...</option>
          <option value="${ALL_CLIENTS_KEY}" ${activeId === ALL_CLIENTS_KEY ? 'selected' : ''}>All Clients (combined)</option>
          ${options}
        </select>
      </div>
    </div>
  `;
}

function approvalCell(approval, isClient, canMarkLive, clientName, campaignName) {
  const status = approval?.status || 'pending';
  if (isClient && status === 'pending' && approval) {
    return `<button class="btn-sm btn-orange" onclick="App.openApproveCampaignModal('${approval.id}','${jsAttr(clientName)}','${jsAttr(campaignName)}')">Approve</button>`;
  }
  if (canMarkLive && status === 'approved' && approval) {
    return `<button class="btn-sm btn-orange" onclick="App.markClientCampaignLive('${approval.id}')">Mark Live</button>`;
  }
  // A client sees their own approved-and-turned-on campaign as "Completed", not "Live" - "Live" is
  // Ops-facing language about the screen state; from the client's side the workflow is just done.
  // The stored status (and Slack/audit wording) stays 'live' either way, only this label differs.
  if (status === 'live') return isClient ? '<span class="badge b-green">Completed</span>' : '<span class="badge b-green">Live</span>';
  if (status === 'approved') return '<span class="badge b-blue">Approved - awaiting Ops</span>';
  return '<span class="badge b-amber">Pending client approval</span>';
}

// sessionStorage-backed "already notified" set, keyed by approval id - survives a manual page
// refresh (which the 10-minute auto-refresh and a real browser reload both trigger) without
// re-firing a push notification for something still sitting pending, only for genuinely new items.
function getNotifiedIds() {
  try { return new Set(JSON.parse(sessionStorage.getItem('notifiedPendingApprovals') || '[]')); }
  catch (_) { return new Set(); }
}
function markNotified(id) {
  const ids = getNotifiedIds();
  ids.add(id);
  try { sessionStorage.setItem('notifiedPendingApprovals', JSON.stringify([...ids])); } catch (_) { /* best-effort */ }
}

// Fires a real browser push notification (not just an in-page banner) for any pending approval
// that's crossed the 15-minute mark and hasn't been notified about yet this session - only runs
// when the client has actually granted permission (see renderNotifyBanner/enableNotifications
// below - never prompted automatically on load).
function checkPendingNotifications(data) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const notified = getNotifiedIds();
  const cutoff = Date.now() - PENDING_ALERT_MINUTES * 60 * 1000;
  data.forEach((c) => {
    const approval = c.__approval;
    if (!approval || approval.status !== 'pending') return;
    if (notified.has(approval.id)) return;
    const createdAt = new Date(approval.created_at || 0).getTime();
    if (createdAt && createdAt <= cutoff) {
      try {
        new Notification('Campaign awaiting your approval', {
          body: `"${c.campaignName || 'A campaign'}" has been pending for over ${PENDING_ALERT_MINUTES} minutes.`,
        });
      } catch (_) { /* best-effort - a browser blocking/erroring on this must not break the page */ }
      markNotified(approval.id);
    }
  });
}

function renderNotifyBanner() {
  if (typeof Notification === 'undefined' || Notification.permission === 'granted') return '';
  if (Notification.permission === 'denied') return '';
  return `
    <div class="banner" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
      <span>Get a browser notification if a campaign sits pending your approval for more than ${PENDING_ALERT_MINUTES} minutes.</span>
      <button class="btn-sm" onclick="App.enableClientMonitorNotifications()">Enable Notifications</button>
    </div>
  `;
}

export function enableClientMonitorNotifications() {
  if (typeof Notification === 'undefined') { toast('Notifications are not supported in this browser', 'error'); return; }
  Notification.requestPermission().then(() => setState({}));
}

// Starts the 10-minute background refresh exactly once per session for a client-role user -
// guarded the same way trafficSheet.js's own auto-fetch guards against re-arming on every render.
function ensureAutoRefresh(clientId) {
  if (STATE.clientMonitorAutoRefreshStarted) return;
  STATE.clientMonitorAutoRefreshStarted = true;
  setInterval(() => {
    invalidate(`clientMonitor_${clientId}`);
    setState({});
  }, AUTO_REFRESH_MS);
}

export function renderClientCampaignMonitor() {
  const clients = loadData('clients', listClients);
  if (clients === null) return loadingCard();
  if (clients?.__error) return loadingCard(clients.__error);

  const isClient = isClientUser();
  const clientId = isClient ? STATE.user?.client_id : STATE.activeClientId;
  const activeClient = clients.find((c) => c.id === clientId);

  if (isClient && !activeClient) {
    return '<div class="card"><div class="empty">Your account isn\'t linked to a client yet - contact your account manager.</div></div>';
  }
  if (isClient) ensureAutoRefresh(clientId);

  if (!isClient && clientId === ALL_CLIENTS_KEY) {
    return renderCombinedView(clients);
  }
  if (!isClient && !activeClient) {
    return `
      <div class="card">
        <div class="card-head"><h3>Client Campaigns Monitor</h3><div class="desc">Pick a client below to preview exactly what they see, or view every client combined.</div></div>
        ${clients.length ? renderClientPicker(clients) : '<div class="empty">No clients configured yet - add one in Settings &gt; Clients.</div>'}
      </div>
    `;
  }

  const cacheKey = `clientMonitor_${activeClient.id}`;
  const data = loadData(cacheKey, () => loadClientMonitorData(activeClient.id, activeClient.venue_names));
  if (data === null) return loadingCard();
  if (data?.__error) return loadingCard(data.__error);

  if (isClient) checkPendingNotifications(data);
  const sorted = sortNewestFirst(data);
  const canMarkLive = !isClient && (isAdmin() || canEdit('clientCampaigns'));
  const view = STATE.clientMonitorView || 'list';

  const rows = sorted.map((c) => `
    <tr>
      <td>${esc(c.campaignName || '')}</td>
      <td>${esc((c.__matchedVenues || []).map((v) => v.venue).join(', '))}</td>
      <td class="tsheet-nowrap">${esc(c.startDate || '')}</td>
      <td class="tsheet-nowrap">${esc(c.endDate || '')}</td>
      <td>${statusBadge(c.status)}</td>
      <td>${approvalCell(c.__approval, isClient, canMarkLive, activeClient.name, c.campaignName)}</td>
    </tr>
  `).join('');

  return `
    ${!isClient ? renderClientPicker(clients, activeClient.id) : ''}
    ${isClient ? renderNotifyBanner() : ''}
    <div class="card">
      <div class="card-head" style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;">
        <div><h3>${esc(activeClient.name)} - Campaign Monitor</h3><div class="desc">${data.length} campaign(s) this month matched to this client's venues.</div></div>
        <div class="toolbar-actions" style="margin:0;">
          <button class="btn-sm ${view === 'list' ? 'btn-orange' : ''}" onclick="App.setClientMonitorView('list')">List</button>
          <button class="btn-sm ${view === 'calendar' ? 'btn-orange' : ''}" onclick="App.setClientMonitorView('calendar')">Calendar</button>
        </div>
      </div>
      ${view === 'calendar' ? renderDayGrid(sorted, '', '') : `
        <table>
          <thead><tr><th>Campaign Name</th><th>Venue(s)</th><th>Start</th><th>End</th><th>Status</th><th>Approval</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6"><div class="empty">No campaigns matched this client\'s venues this month.</div></td></tr>'}</tbody>
        </table>
      `}
    </div>
  `;
}

function renderCombinedView(clients) {
  if (!clients.length) {
    return `${renderClientPicker(clients)}<div class="card"><div class="empty">No clients configured yet - add one in Settings &gt; Clients.</div></div>`;
  }
  const data = loadData('clientMonitor_all', () => loadCombinedClientMonitorData(clients));
  if (data === null) return loadingCard();
  if (data?.__error) return loadingCard(data.__error);

  const canMarkLive = isAdmin() || canEdit('clientCampaigns');
  const sorted = sortNewestFirst(data);
  const rows = sorted.map((c) => `
    <tr>
      <td>${esc(c.__clientName || '')}</td>
      <td>${esc(c.campaignName || '')}</td>
      <td>${esc((c.__matchedVenues || []).map((v) => v.venue).join(', '))}</td>
      <td class="tsheet-nowrap">${esc(c.startDate || '')}</td>
      <td class="tsheet-nowrap">${esc(c.endDate || '')}</td>
      <td>${statusBadge(c.status)}</td>
      <td>${approvalCell(c.__approval, false, canMarkLive, c.__clientName, c.campaignName)}</td>
    </tr>
  `).join('');

  return `
    ${renderClientPicker(clients, ALL_CLIENTS_KEY)}
    <div class="card">
      <div class="card-head"><h3>All Clients - Campaign Monitor</h3><div class="desc">${data.length} campaign(s) this month across ${clients.length} client(s).</div></div>
      <table>
        <thead><tr><th>Client</th><th>Campaign Name</th><th>Venue(s)</th><th>Start</th><th>End</th><th>Status</th><th>Approval</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7"><div class="empty">No campaigns matched any client\'s venues this month.</div></td></tr>'}</tbody>
      </table>
    </div>
  `;
}

export function setActiveClient(id) {
  setState({ activeClientId: id || null });
}

export function setClientMonitorView(view) {
  setState({ clientMonitorView: view });
}

function invalidateClientMonitorCaches() {
  Object.keys(STATE.pageData).filter((k) => k.startsWith('clientMonitor_')).forEach(invalidate);
}

export function openApproveCampaignModal(approvalId, clientName, campaignName) {
  openModal('approveCampaignComment', { approvalId, clientName, campaignName });
}

registerModal('approveCampaignComment', (data) => `
  <h3>Approve Campaign</h3>
  <p class="small muted">"${esc(data.campaignName || '')}"</p>
  <form onsubmit="App.submitApproveCampaign(event,'${data.approvalId}','${jsAttr(data.clientName)}','${jsAttr(data.campaignName)}')">
    <div class="field"><label>Comments (optional)</label>
      <textarea id="approve-comment" rows="3" placeholder="Anything Ops should know before taking this live?"></textarea>
      <div class="small muted" style="margin-top:4px;">Shown alongside the Slack notification this sends to Ops.</div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Approve</button>
    </div>
  </form>
`);

export async function submitApproveCampaign(event, approvalId, clientName, campaignName) {
  event.preventDefault();
  const comment = document.getElementById('approve-comment').value.trim();
  try {
    await approveCampaign(approvalId, comment);
    await logAudit('Approve campaign', approvalId);
    invalidateClientMonitorCaches();
    closeModal();
    toast('Campaign approved');
    setState({});
    // Best-effort - if Slack isn't configured yet (or the request fails), the approval that
    // already succeeded above shouldn't be undone or reported as a failure to the client.
    const commentLine = comment ? `\n> ${comment}` : '';
    notifySlack(`:white_check_mark: *${clientName}* approved campaign *"${campaignName}"* - ready for Ops to take live.${commentLine}`).catch(() => {});
  } catch (e) { toast(e.message, 'error'); }
}

export async function markClientCampaignLive(approvalId) {
  if (!confirm('Mark this campaign as live? Only do this once it is actually turned on in Broadsign/Grassfish.')) return;
  try {
    await markCampaignLive(approvalId);
    await logAudit('Mark campaign live', approvalId);
    invalidateClientMonitorCaches();
    toast('Campaign marked live');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}
