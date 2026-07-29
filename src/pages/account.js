import { STATE, setState, toast } from '../state.js';
import { supabase } from '../supabaseClient.js';
import { changeOwnPassword } from '../auth.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';

export function renderAccount() {
  const u = STATE.user;
  return `
    <div class="card">
      <div class="card-head"><h3>Profile</h3></div>
      <form onsubmit="App.saveAccountProfile(event)">
        <div class="grid2">
          <div class="field"><label>Name</label><input id="acct-name" value="${esc(u.name || '')}" required></div>
          <div class="field"><label>Title</label><input id="acct-title" value="${esc(u.title || '')}"></div>
        </div>
        <div class="field"><label>Username</label><input value="${esc(u.username || '')}" disabled></div>
        <button class="btn btn-orange" type="submit">Save profile</button>
      </form>
    </div>
    <div class="card">
      <div class="card-head"><h3>Change password</h3></div>
      <form onsubmit="App.saveAccountPassword(event)">
        <div class="field"><label>New password</label><input id="acct-password" type="password" minlength="8" required></div>
        <button class="btn btn-orange" type="submit">Update password</button>
      </form>
    </div>
  `;
}

export async function saveAccountProfile(event) {
  event.preventDefault();
  const name = document.getElementById('acct-name').value.trim();
  const title = document.getElementById('acct-title').value.trim();
  const { error } = await supabase.from('profiles').update({ name, title }).eq('id', STATE.user.id);
  if (error) { toast(error.message, 'error'); return; }
  await logAudit('Edit own profile', '');
  setState({ user: { ...STATE.user, name, title } });
  toast('Profile updated');
}

export async function saveAccountPassword(event) {
  event.preventDefault();
  const password = document.getElementById('acct-password').value;
  try {
    await changeOwnPassword(password);
    toast('Password updated');
    setState({});
  } catch (e) {
    toast(e.message || 'Failed to update password', 'error');
  }
}
