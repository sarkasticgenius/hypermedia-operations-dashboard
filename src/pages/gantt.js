import { STATE, loadData, setState } from '../state.js';
import { loadingCard } from '../modals.js';
import { listCampaigns } from '../data/campaigns.js';
import { esc } from '../lib/format.js';

const COLORS = ['#e8951f', '#2563eb', '#1f9d55', '#b45309', '#c0392b', '#8b5e34'];

export function renderGantt() {
  const campaigns = loadData('campaigns', listCampaigns);
  if (campaigns === null) return loadingCard();
  if (campaigns?.__error) return loadingCard(campaigns.__error);

  const month = STATE.ganttMonth || new Date().toISOString().slice(0, 7);
  const [year, mon] = month.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const monthStart = new Date(year, mon - 1, 1);
  const monthEnd = new Date(year, mon - 1, daysInMonth);

  const inMonth = campaigns.filter((c) => {
    if (!c.start_date || !c.end_date) return false;
    const s = new Date(c.start_date);
    const e = new Date(c.end_date);
    return s <= monthEnd && e >= monthStart;
  });

  const dayLabels = Array.from({ length: daysInMonth }, (_, i) => `<div>${i + 1}</div>`).join('');

  const rows = inMonth.map((c, idx) => {
    const s = new Date(Math.max(new Date(c.start_date), monthStart));
    const e = new Date(Math.min(new Date(c.end_date), monthEnd));
    const startDay = s.getDate();
    const endDay = e.getDate();
    const leftPct = ((startDay - 1) / daysInMonth) * 100;
    const widthPct = ((endDay - startDay + 1) / daysInMonth) * 100;
    const color = COLORS[idx % COLORS.length];
    return `
      <div class="gantt-flexrow gantt-body-row">
        <div class="gantt-name-col">${esc(c.name)}</div>
        <div class="gantt-track" style="--days:${daysInMonth};">
          <div class="gantt-bar" style="left:${leftPct}%;width:${widthPct}%;background:${color};" title="${esc(c.name)}">${esc(c.name)}</div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="toolbar">
      <div class="field" style="margin:0;">
        <input type="month" value="${month}" onchange="App.setGanttMonth(this.value)">
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Campaign Calendar</h3><div class="desc">${inMonth.length} campaign(s) running this month</div></div>
      ${inMonth.length === 0 ? '<div class="empty">No campaigns running this month.</div>' : `
        <div class="gantt-wrap">
          <div class="gantt-grid" style="--days:${daysInMonth};">
            <div class="gantt-flexrow">
              <div class="gantt-name-col"></div>
              <div class="gantt-daylabels" style="--days:${daysInMonth};">${dayLabels}</div>
            </div>
            ${rows}
          </div>
        </div>
      `}
    </div>
  `;
}

export function setGanttMonth(value) {
  setState({ ganttMonth: value });
}
