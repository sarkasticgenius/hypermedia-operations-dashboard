import { supabase } from '../supabaseClient.js';
import { softDeleteRow, restoreRow, permanentlyDeleteRow, listDeletedRows } from './softDelete.js';

export async function listNetworks() {
  const { data, error } = await supabase.from('networks').select('*').is('deleted_at', null).order('name');
  if (error) throw error;
  return data;
}

export async function ensureNetwork(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const { data: existing } = await supabase.from('networks').select('*').ilike('name', trimmed).is('deleted_at', null).maybeSingle();
  if (existing) return existing;
  const { data, error } = await supabase.from('networks').insert({ name: trimmed }).select().single();
  if (error) throw error;
  return data;
}

export async function renameNetwork(id, name) {
  const { data, error } = await supabase.from('networks').update({ name }).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// asset_inventory_networks rows cascade-delete with the network automatically (FK on delete
// cascade) - this just counts them first so the UI can warn how many screens will be affected.
export async function countNetworkUsage(id) {
  const { count, error } = await supabase.from('asset_inventory_networks').select('*', { count: 'exact', head: true }).eq('network_id', id);
  if (error) throw error;
  return count || 0;
}

export async function deleteNetwork(id) { return softDeleteRow('networks', id); }
export async function restoreNetwork(id) { return restoreRow('networks', id); }
export async function permanentlyDeleteNetwork(id) { return permanentlyDeleteRow('networks', id); }
export async function listDeletedNetworks() { return listDeletedRows('networks'); }
