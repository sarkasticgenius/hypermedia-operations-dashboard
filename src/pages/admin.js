import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { PERMISSION_AREAS, PERM_FULL, PERM_NONE } from '../auth.js';
import { listUsers, createUser, updateUserProfile, updateUserPermissions, setUserActive } from '../data/users.js';
import { listClients } from '../data/clients.js';
import { listAuditLog } from '../data/auditLog.js';
import { listLoginHistory } from '../data/loginHistory.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtDateTime } from '../lib/format.js';
import { summarizeUserAgent } from '../lib/userAgent.js';
import { startImpersonation } from '../impersonate.js';
import { sortTh, applySort } from '../lib/sortableTable.js';
import { renderTabs } from '../lib/tabs.js';

const TABS = [
  { key: 'users', label: 'Users' },
  { key: 'audit', label: 'Audit Log' },
  { key: 'logins', label: 'Login History' },
];

// PERMISSION_AREAS entries are raw camelCase keys ('workspaceDirectory') shared with page routing
// and the DB's area check constraint - this table is the one place they're shown to a user, so it
// needs a friendly name where the raw key wouldn't otherwise match what's shown elsewhere in the
// app (the Digital Directory page/nav label, for instance).
function areaLabel(area) {
  if (area === 'workspaceDirectory') return 'Digital Directory';
  return area;
}

export function renderAdmin() {
  const tab = STATE.adminTab || 'users';
  const body = tab === 'audit' ? renderAuditTab() : tab === 'logins' ? renderLoginHistoryTab() : renderUsersTab();
  return `${renderTabs(TABS, tab, 'App.setAdminTab')}${body}`;
}

export function setAdminTab(tab) {
  setState({ adminTab: tab });
}

function renderUsersTab() {
  const users = loadData('users', listUsers);
  if (users === null) return loadingCard();
  if (users?.__error) return loadingCard(users.__error);

  const sorted = applySort(users, 'users', {
    username: (u) => u.username || '', name: (u) => u.name || '', role: (u) => u.role || '',
    status: (u) => u.active ? 'Active' : 'Deactivated',
  });

  const rows = sorted.map((u) => {
    const summary = u.role === 'admin' ? 'Full access (admin)'
      : u.role === 'client' ? 'Client login'
      : PERMISSION_AREAS.filter((a) => u.permissions[a]?.view).length + ' area(s) with access';
    return `
      <tr>
        <td>${esc(u.username)}</td>
        <td>${esc(u.name)}</td>
        <td>${esc(u.role)}</td>
        <td>${esc(summary)}</td>
        <td class="tcenter">${u.active ? '<span class="badge b-green">Active</span>' : '<span class="badge b-gray">Deactivated</span>'}</td>
        <td>
          <button class="btn-sm" onclick="App.editUser('${u.id}')">Edit</button>
          <button class="btn-sm" onclick="App.toggleUserActive('${u.id}', ${u.active})">${u.active ? 'Deactivate' : 'Activate'}</button>
          ${u.id !== STATE.user?.id && u.active ? `<button class="btn-sm" onclick="App.impersonateUser('${u.id}')">Impersonate</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="toolbar">
      <div></div>
      <div class="toolbar-actions"><button class="btn btn-orange" onclick="App.editUser(null)">+ Add User</button></div>
    </div>
    <div class="card">
      <table>
        <thead><tr>${sortTh('users', 'username', 'Username')}${sortTh('users', 'name', 'Name')}${sortTh('users', 'role', 'Role')}<th>Access</th>${sortTh('users', 'status', 'Status', null, 'center')}<th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderAuditTab() {
  const log = loadData('auditLog', () => listAuditLog(300));
  if (log === null) return loadingCard();
  if (log?.__error) return loadingCard(log.__error);
  const sorted = applySort(log, 'auditLog', {
    time: (l) => l.ts || '', user: (l) => l.username || '', action: (l) => l.action || '', detail: (l) => l.detail || '',
  });
  const rows = sorted.map((l) => `
    <tr>
      <td>${fmtDateTime(l.ts)}</td>
      <td>${esc(l.username || '-')}</td>
      <td>${esc(l.action)}</td>
      <td>${esc(l.detail || '-')}</td>
    </tr>
  `).join('');
  return `
    <div class="card">
      ${log.length === 0 ? '<div class="empty">No activity logged yet.</div>' : `
        <table>
          <thead><tr>${sortTh('auditLog', 'time', 'Time')}${sortTh('auditLog', 'user', 'User')}${sortTh('auditLog', 'action', 'Action')}${sortTh('auditLog', 'detail', 'Detail')}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

// Raw login_history rows are one event (login OR logout) each - paired here into sessions so the
// tab can show a login alongside ITS OWN logout and how long that session actually lasted, instead
// of two disconnected rows the reader has to match up by eye. Paired FIFO per user (oldest open
// login gets the next logout) rather than by exact device/IP match, since nothing here guarantees a
// logout event carries the same IP a login did (a laptop can change networks mid-session) - good
// enough for the common single-session-at-a-time case, and a user genuinely signed in on two
// devices at once just gets two rows, each still individually correct on its own login/logout pair.
// A login with no logout yet (still signed in, or the tab was closed without one) surfaces as
// "Active"; a logout with no open login (predates this feature, or its login row aged out of the
// query's own limit) still shows on its own with a blank Login Time rather than being dropped.
function pairLoginSessions(rows) {
  const byUser = new Map();
  for (const r of [...rows].sort((a, b) => new Date(a.ts) - new Date(b.ts))) {
    const key = r.user_id || r.username || '?';
    if (!byUser.has(key)) byUser.set(key, { open: [], sessions: [] });
    const bucket = byUser.get(key);
    if (r.event === 'login') {
      bucket.open.push(r);
    } else {
      const login = bucket.open.shift() || null;
      bucket.sessions.push({ login, logout: r });
    }
  }
  const sessions = [];
  for (const bucket of byUser.values()) {
    sessions.push(...bucket.sessions);
    for (const stillOpen of bucket.open) sessions.push({ login: stillOpen, logout: null });
  }
  return sessions.sort((a, b) => new Date((b.login || b.logout).ts) - new Date((a.login || a.logout).ts));
}

// "2h 14m" / "38m" / "less than a minute" - an actual elapsed span between two known instants,
// unlike fmtRelativeTime (lib/format.js), which is "how long ago from NOW" and not what a session's
// own login-to-logout duration needs.
function fmtDuration(startIso, endIso) {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!(ms >= 0)) return '-';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return 'less than a minute';
}

function renderLoginHistoryTab() {
  const log = loadData('loginHistory', () => listLoginHistory(500));
  if (log === null) return loadingCard();
  if (log?.__error) return loadingCard(log.__error);

  const sessions = pairLoginSessions(log);
  const rows = sessions.map(({ login, logout }) => {
    const who = login?.username || logout?.username || '-';
    const ip = login?.ip_address || logout?.ip_address || '-';
    const location = login?.location || logout?.location || '-';
    const device = summarizeUserAgent(login?.user_agent || logout?.user_agent);
    return `
      <tr>
        <td>${esc(who)}</td>
        <td>${login ? fmtDateTime(login.ts) : '-'}</td>
        <td>${logout ? fmtDateTime(logout.ts) : '<span class="badge b-green">Active</span>'}</td>
        <td>${login && logout ? fmtDuration(login.ts, logout.ts) : '-'}</td>
        <td>${esc(ip)}</td>
        <td>${esc(location)}</td>
        <td>${esc(device)}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="card">
      ${sessions.length === 0 ? '<div class="empty">No logins recorded yet.</div>' : `
        <table>
          <thead><tr><th>User</th><th>Login Time</th><th>Logout Time</th><th>Duration</th><th>IP Address</th><th>Location</th><th>Device</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export function editUser(id) {
  const users = STATE.pageData.users?.data || [];
  const row = id ? users.find((u) => u.id === id) : null;
  openModal('user', row || { permissions: Object.fromEntries(PERMISSION_AREAS.map((a) => [a, { ...PERM_NONE }])) });
}

export async function toggleUserActive(id, currentlyActive) {
  const active = !(currentlyActive === true || currentlyActive === 'true');
  if (!confirm(`${active ? 'Activate' : 'Deactivate'} this user?`)) return;
  try {
    await setUserActive(id, active);
    await logAudit(active ? 'Activate user' : 'Deactivate user', id);
    invalidate('users');
    toast('User updated');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function impersonateUser(id) {
  if (!confirm("Impersonate this user? You'll see and use the app exactly as they do, with their permissions, until you return to your admin session.")) return;
  try {
    await startImpersonation(id);
    toast('Now viewing as this user - use "Return to Admin" at the top to switch back');
  } catch (e) { toast(e.message, 'error'); }
}

export function togglePermCheckbox(area, field) {
  const modal = STATE.modal;
  if (!modal) return;
  const perms = modal.data.permissions || {};
  perms[area] = perms[area] || { ...PERM_NONE };
  perms[area][field] = !perms[area][field];
  modal.data.permissions = perms;
  setState({});
}

// Direct DOM show/hide (same pattern as onAssetCategoryChange in assets.js) - the Permissions
// table only applies to 'team', the Client picker only to 'client', neither to 'admin'.
export function onUserRoleChange(value) {
  const clientGroup = document.getElementById('u-client-group');
  const permsGroup = document.getElementById('u-perms-group');
  if (clientGroup) clientGroup.style.display = value === 'client' ? 'block' : 'none';
  if (permsGroup) permsGroup.style.display = value === 'team' ? 'block' : 'none';
}

export async function saveUserForm(event) {
  event.preventDefault();
  const id = document.getElementById('u-id').value || null;
  const username = document.getElementById('u-username').value.trim();
  const name = document.getElementById('u-name').value.trim();
  const title = document.getElementById('u-title').value.trim();
  const role = document.getElementById('u-role').value;
  const clientId = role === 'client' ? document.getElementById('u-client-id').value : null;
  const permissions = STATE.modal?.data?.permissions || {};

  try {
    if (id) {
      await updateUserProfile(id, { name, title, role, clientId });
      if (role === 'team') await updateUserPermissions(id, permissions);
      await logAudit('Edit user', username);
    } else {
      const email = document.getElementById('u-email').value.trim();
      const password = document.getElementById('u-password').value;
      await createUser({ email, password, username, name, title, role, clientId, permissions: role === 'team' ? permissions : null });
      await logAudit('Add user', username);
    }
    invalidate('users');
    closeModal();
    toast('User saved');
  } catch (e) {
    toast(e.message, 'error');
  }
}

registerModal('user', (data) => {
  const isNew = !data.id;
  const role = data.role || 'team';
  const clients = loadData('clients', listClients) || [];
  const clientOptions = clients.map((c) => `<option value="${c.id}" ${data.client_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const permissions = data.permissions || {};
  const permRows = PERMISSION_AREAS.map((area) => {
    const p = permissions[area] || { ...PERM_NONE };
    return `
      <tr>
        <td>${esc(areaLabel(area))}</td>
        ${['view', 'add', 'edit', 'delete', 'export'].map((f) => `
          <td style="text-align:center;">
            <input type="checkbox" ${p[f] ? 'checked' : ''} onchange="App.togglePermCheckbox('${area}','${f}')">
          </td>
        `).join('')}
      </tr>
    `;
  }).join('');

  return `
    <h3>${isNew ? 'Add' : 'Edit'} User</h3>
    <form onsubmit="App.saveUserForm(event)">
      <input type="hidden" id="u-id" value="${esc(data.id || '')}">
      ${isNew ? `
        <div class="field"><label>Email (used to sign in)</label><input id="u-email" type="email" required></div>
        <div class="field"><label>Temporary Password</label><input id="u-password" type="password" minlength="8" required></div>
      ` : ''}
      <div class="grid2">
        <div class="field"><label>Username</label><input id="u-username" value="${esc(data.username || '')}" required ${isNew ? '' : 'disabled'}></div>
        <div class="field"><label>Role</label>
          <select id="u-role" onchange="App.onUserRoleChange(this.value)">
            <option value="team" ${role === 'team' ? 'selected' : ''}>Team</option>
            <option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin</option>
            <option value="client" ${role === 'client' ? 'selected' : ''}>Client (restricted login)</option>
          </select>
        </div>
      </div>
      <div class="grid2">
        <div class="field"><label>Name</label><input id="u-name" value="${esc(data.name || '')}" required></div>
        <div class="field"><label>Title</label><input id="u-title" value="${esc(data.title || '')}"></div>
      </div>
      <div class="field" id="u-client-group" style="display:${role === 'client' ? 'block' : 'none'};">
        <label>Client</label>
        <select id="u-client-id">
          <option value="">Select a client...</option>
          ${clientOptions}
        </select>
        <div class="small muted" style="margin-top:4px;">This login will only ever see this client's Campaign Monitor - nothing else in the app.</div>
      </div>
      <div class="field" id="u-perms-group" style="display:${role === 'team' ? 'block' : 'none'};">
        <label>Permissions</label>
        <div style="overflow-x:auto;">
          <table>
            <thead><tr><th>Area</th><th>View</th><th>Add</th><th>Edit</th><th>Delete</th><th>Export</th></tr></thead>
            <tbody>${permRows}</tbody>
          </table>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Save</button>
      </div>
    </form>
  `;
});
