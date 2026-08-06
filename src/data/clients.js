import { supabase } from '../supabaseClient.js';
import { softDeleteRow, restoreRow, permanentlyDeleteRow, listDeletedRows } from './softDelete.js';

export async function listClients() {
  const { data, error } = await supabase.from('clients').select('*').is('deleted_at', null).order('name');
  if (error) throw error;
  return data;
}

export async function saveClient(row) {
  const payload = { name: row.name, venue_names: row.venue_names || [] };
  if (row.id) {
    const { data, error } = await supabase.from('clients').update(payload).eq('id', row.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('clients').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deleteClient(id) { return softDeleteRow('clients', id); }
export async function restoreClient(id) { return restoreRow('clients', id); }
export async function permanentlyDeleteClient(id) { return permanentlyDeleteRow('clients', id); }
export async function listDeletedClients() { return listDeletedRows('clients'); }
