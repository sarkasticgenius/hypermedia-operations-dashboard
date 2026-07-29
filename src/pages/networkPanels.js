import { STATE, loadData, invalidate, toast, setState } from '../state.js';
import { loadingCard } from '../modals.js';
import { getSetting } from '../data/settings.js';
import { supabase } from '../supabaseClient.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';

function renderPanel(key, title, fnName) {
  const cfg = loadData(key, () => getSetting(key));
  if (cfg === null) return loadingCard();
  if (cfg?.__error) return loadingCard(cfg.__error);
  const c = cfg || {};
  return `
    <div class="card">
      <div class="card-head"><h3>${esc(title)}</h3></div>
      <div class="grid2">
        <div><div class="label muted small">Status</div><div>${c.enabled ? '<span class="badge b-green">Enabled</span>' : '<span class="badge b-gray">Disabled</span>'}</div></div>
        <div><div class="label muted small">Last Sync</div><div>${esc(c.lastSync || 'Never')}</div></div>
      </div>
      ${c.lastSyncSummary ? `<p class="small muted">${esc(c.lastSyncSummary)}</p>` : ''}
      ${c.lastError ? `<div class="login-error">${esc(c.lastError)}</div>` : ''}
      <button class="btn btn-orange" onclick="App.runNetworkSync('${key}','${fnName}')" ${STATE.syncing === key ? 'disabled' : ''}>
        ${STATE.syncing === key ? 'Syncing...' : 'Sync Now'}
      </button>
      <p class="small muted" style="margin-top:10px;">Configure the base URL / API key on the Settings &gt; Integrations tab.</p>
    </div>
  `;
}

export function renderBroadsignPanel() {
  return renderPanel('broadsignApi', 'Broadsign Console', 'broadsign-sync');
}

export function renderGrassfishPanel() {
  return renderPanel('grassfishApi', 'Grassfish Console', 'grassfish-sync');
}

export async function runNetworkSync(settingKey, functionName) {
  setState({ syncing: settingKey });
  try {
    const { data, error } = await supabase.functions.invoke(functionName, { body: {} });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    await logAudit(`${functionName} sync`, data?.summary || '');
    invalidate(settingKey);
    toast(data?.summary || 'Sync complete');
  } catch (e) {
    toast(e.message || 'Sync failed', 'error');
  } finally {
    setState({ syncing: null });
  }
}
