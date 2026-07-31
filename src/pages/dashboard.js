import { loadData } from '../state.js';
import { loadingCard } from '../modals.js';
import { listAssets } from '../data/assets.js';
import { listOrders } from '../data/orders.js';
import { listCampaigns } from '../data/campaigns.js';
import { listStaticCampaigns } from '../data/staticCampaigns.js';
import { listTickets } from '../data/tickets.js';
import { esc } from '../lib/format.js';

async function loadHomeData() {
  const [assets, orders, campaigns, staticCampaigns, tickets] = await Promise.all([
    listAssets(), listOrders(), listCampaigns(), listStaticCampaigns(), listTickets(),
  ]);
  return { assets, orders, campaigns, staticCampaigns, tickets };
}

export function renderDashboard() {
  const data = loadData('dashboard', loadHomeData);
  if (data === null) return loadingCard();
  if (data.__error) return loadingCard(data.__error);

  const { assets, orders, campaigns, staticCampaigns, tickets } = data;
  const openTickets = tickets.filter((t) => t.status === 'Open' || t.status === 'In Progress').length;
  const activeCampaigns = campaigns.filter((c) => c.status === 'Online' || c.status === 'Scheduled').length;
  const activeStatic = staticCampaigns.filter((c) => c.status === 'Live' || c.status === 'Scheduled').length;
  const pendingOrders = orders.filter((o) => o.status !== 'Delivered').length;

  const kpis = [
    { label: 'Hardware Assets', value: assets.length, sub: `${assets.filter((a) => a.status === 'Spare' || a.status === 'Deployed').length} in service` },
    { label: 'Open Tickets', value: openTickets, sub: `${tickets.length} total` },
    { label: 'Digital Campaigns', value: activeCampaigns, sub: `${campaigns.length} total` },
    { label: 'Static Campaigns', value: activeStatic, sub: `${staticCampaigns.length} total` },
    { label: 'Pending Orders', value: pendingOrders, sub: `${orders.length} total` },
  ];

  return `
    <div class="banner">A quick daily snapshot across every workspace - counts as of your last page load, not live. For continuously-refreshing operational status (what's open or offline right now), see <a href="#" style="color:var(--brand-orange-dark);font-weight:700;" onclick="event.preventDefault();App.setPage('opsOverview')">Live Ops Overview</a>.</div>
    <div class="kpi-row">
      ${kpis.map((k) => `
        <div class="kpi">
          <div class="label">${esc(k.label)}</div>
          <div class="value">${k.value}</div>
          <div class="sub">${esc(k.sub)}</div>
        </div>
      `).join('')}
    </div>
    <div class="card">
      <div class="card-head"><h3>Recent tickets</h3></div>
      ${tickets.length === 0 ? '<div class="empty">No tickets yet.</div>' : `
        <table>
          <thead><tr><th>Title</th><th>Location</th><th>Status</th><th>Priority</th><th>Reported</th></tr></thead>
          <tbody>
            ${tickets.slice(0, 8).map((t) => `
              <tr>
                <td>${esc(t.title)}</td>
                <td>${esc(t.location || '-')}</td>
                <td><span class="badge ${t.status === 'Closed' ? 'b-gray' : t.status === 'Open' ? 'b-red' : 'b-amber'}">${esc(t.status)}</span></td>
                <td>${esc(t.priority)}</td>
                <td>${esc(t.date_reported || '-')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
}
