// Client Campaigns Monitor - shows a client only the current month's Traffic Sheet campaigns
// whose venue matches one of the venue names an admin assigned to them (Settings > Clients), lets
// them Approve one, and lets internal Ops (admin, or 'clientCampaigns' edit permission) mark it
// Live once it's actually turned on in Broadsign/Grassfish. Nothing about the live campaign itself
// is stored - only the approval workflow state, in campaign_approvals, keyed by the campaign's
// `contract` id and lazily created the first time a matching campaign is seen.
import { STATE, setState, loadData, invalidate, toast } from '../state.js';
import { loadingCard } from '../modals.js';
import { isAdmin, isClientUser, canEdit } from '../auth.js';
import { esc, jsAttr } from '../lib/format.js';
import { logAudit } from '../lib/audit.js';
import { listClients } from '../data/clients.js';
import { listApprovalsForClient, upsertPendingApproval, approveCampaign, markCampaignLive } from '../data/campaignApprovals.js';
import { notifySlack } from '../data/slack.js';
import { fetchTrafficSheetCampaigns, normalizeVenueText, statusBadge } from './trafficSheet.js';

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

function renderClientPicker(clients, activeId) {
  const options = clients.map((c) => `<option value="${c.id}" ${c.id === activeId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  return `
    <div class="toolbar">
      <div class="toolbar-actions">
        <select onchange="App.setActiveClient(this.value)">
          <option value="">Select a client to preview...</option>
          ${options}
        </select>
      </div>
    </div>
  `;
}

function approvalCell(approval, isClient, canMarkLive, clientName, campaignName) {
  const status = approval?.status || 'pending';
  if (isClient && status === 'pending' && approval) {
    return `<button class="btn-sm btn-orange" onclick="App.approveClientCampaign('${approval.id}','${jsAttr(clientName)}','${jsAttr(campaignName)}')">Approve</button>`;
  }
  if (canMarkLive && status === 'approved' && approval) {
    return `<button class="btn-sm btn-orange" onclick="App.markClientCampaignLive('${approval.id}')">Mark Live</button>`;
  }
  if (status === 'live') return '<span class="badge b-green">Live</span>';
  if (status === 'approved') return '<span class="badge b-blue">Approved - awaiting Ops</span>';
  return '<span class="badge b-amber">Pending client approval</span>';
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
  if (!isClient && !activeClient) {
    return `
      <div class="card">
        <div class="card-head"><h3>Client Campaigns Monitor</h3><div class="desc">Pick a client below to preview exactly what they see.</div></div>
        ${clients.length ? renderClientPicker(clients) : '<div class="empty">No clients configured yet - add one in Settings &gt; Clients.</div>'}
      </div>
    `;
  }

  const cacheKey = `clientMonitor_${activeClient.id}`;
  const data = loadData(cacheKey, () => loadClientMonitorData(activeClient.id, activeClient.venue_names));
  if (data === null) return loadingCard();
  if (data?.__error) return loadingCard(data.__error);

  const canMarkLive = !isClient && (isAdmin() || canEdit('clientCampaigns'));

  const rows = data.map((c) => `
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
    <div class="card">
      <div class="card-head"><h3>${esc(activeClient.name)} - Campaign Monitor</h3><div class="desc">${data.length} campaign(s) this month matched to this client's venues.</div></div>
      <table>
        <thead><tr><th>Campaign Name</th><th>Venue(s)</th><th>Start</th><th>End</th><th>Status</th><th>Approval</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6"><div class="empty">No campaigns matched this client\'s venues this month.</div></td></tr>'}</tbody>
      </table>
    </div>
  `;
}

export function setActiveClient(id) {
  setState({ activeClientId: id || null });
}

export async function approveClientCampaign(approvalId, clientName, campaignName) {
  try {
    await approveCampaign(approvalId);
    await logAudit('Approve campaign', approvalId);
    Object.keys(STATE.pageData).filter((k) => k.startsWith('clientMonitor_')).forEach(invalidate);
    toast('Campaign approved');
    setState({});
    // Best-effort - if Slack isn't configured yet (or the request fails), the approval that
    // already succeeded above shouldn't be undone or reported as a failure to the client.
    notifySlack(`:white_check_mark: *${clientName}* approved campaign *"${campaignName}"* - ready for Ops to take live.`).catch(() => {});
  } catch (e) { toast(e.message, 'error'); }
}

export async function markClientCampaignLive(approvalId) {
  if (!confirm('Mark this campaign as live? Only do this once it is actually turned on in Broadsign/Grassfish.')) return;
  try {
    await markCampaignLive(approvalId);
    await logAudit('Mark campaign live', approvalId);
    Object.keys(STATE.pageData).filter((k) => k.startsWith('clientMonitor_')).forEach(invalidate);
    toast('Campaign marked live');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}
