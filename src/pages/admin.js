import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { PERMISSION_AREAS, PERM_FULL, PERM_NONE } from '../auth.js';
import { listUsers, createUser, updateUserProfile, updateUserPermissions, setUserActive } from '../data/users.js';
import { listClients } from '../data/clients.js';
import { listAuditLog } from '../data/auditLog.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';
import { startImpersonation } from '../impersonate.js';
import { sortTh, applySort } from '../lib/sortableTable.js';
import { renderTabs } from '../lib/tabs.js';

const TABS = [{ key: 'users', label: 'Users' }, { key: 'audit', label: 'Audit Log' }];

export function renderAdmin() {
  const tab = STATE.adminTab || 'users';
  return `${renderTabs(TABS, tab, 'App.setAdminTab')}${tab === 'audit' ? renderAuditTab() : renderUsersTab()}`;
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
        <td>${u.active ? '<span class="badge b-green">Active</span>' : '<span class="badge b-gray">Deactivated</span>'}</td>
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
        <thead><tr>${sortTh('users', 'username', 'Username')}${sortTh('users', 'name', 'Name')}${sortTh('users', 'role', 'Role')}<th>Access</th>${sortTh('users', 'status', 'Status')}<th></th></tr></thead>
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
      <td>${new Date(l.ts).toLocaleString()}</td>
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
        <td>${esc(area)}</td>
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
