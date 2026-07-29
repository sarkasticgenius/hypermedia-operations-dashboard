import { loadData } from '../state.js';
import { loadingCard } from '../modals.js';
import { listLocations } from '../data/locations.js';
import { listTickets } from '../data/tickets.js';
import { listPermits, permitStatus } from '../data/permits.js';
import { listMetroPics } from '../data/metroPics.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { esc, fmtDate } from '../lib/format.js';

async function loadOverview() {
  const [locations, tickets, permits, metroPics, assetInventory] = await Promise.all([
    listLocations(), listTickets(), listPermits(), listMetroPics(), listAssetInventory(),
  ]);
  return { locations, tickets, permits, metroPics, assetInventory };
}

export function renderOpsOverview() {
  const data = loadData('opsOverview', loadOverview);
  if (data === null) return loadingCard();
  if (data.__error) return loadingCard(data.__error);

  const { locations, tickets, permits, metroPics, assetInventory } = data;
  const installed = locations.filter((l) => l.type === 'Installed').length;
  const openTickets = tickets.filter((t) => t.status !== 'Closed').length;
  const criticalTickets = tickets.filter((t) => t.status !== 'Closed' && t.priority === 'Critical').length;
  const compliance = [
    ...permits.filter((p) => permitStatus(p) !== 'Active').map((p) => ({ label: p.title, type: 'Permit', status: permitStatus(p), date: p.expiry_date })),
    ...metroPics.filter((m) => {
      if (!m.validity_end) return false;
      const days = Math.round((new Date(m.validity_end) - new Date()) / 86400000);
      return days <= 30;
    }).map((m) => ({ label: `${m.station} PIC`, type: 'Metro PIC', status: 'Expiring', date: m.validity_end })),
  ];

  return `
    <div class="banner"><span class="live-pulse-dot"></span>Live overview - refreshes each time you visit this page.</div>
    <div class="kpi-row">
      <div class="kpi"><div class="label">Installed Locations</div><div class="value">${installed}</div><div class="sub">${locations.length} total</div></div>
      <div class="kpi"><div class="label">Deployed Screens</div><div class="value">${assetInventory.length}</div><div class="sub">Asset Inventory</div></div>
      <div class="kpi"><div class="label">Open Tickets</div><div class="value">${openTickets}</div><div class="sub">${criticalTickets} critical</div></div>
      <div class="kpi"><div class="label">Compliance Due</div><div class="value">${compliance.length}</div><div class="sub">Permits + Metro PIC</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Compliance Due</h3><div class="desc">Permits and Metro PIC authorizations expiring within 30 days (or already expired)</div></div>
      ${compliance.length === 0 ? '<div class="empty">Nothing expiring soon.</div>' : `
        <table>
          <thead><tr><th>Item</th><th>Type</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            ${compliance.map((c) => `
              <tr>
                <td>${esc(c.label)}</td>
                <td>${esc(c.type)}</td>
                <td><span class="badge ${c.status === 'Expired' ? 'b-red' : 'b-amber'}">${esc(c.status)}</span></td>
                <td>${fmtDate(c.date)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
}
