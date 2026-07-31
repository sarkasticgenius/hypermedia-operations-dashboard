import { supabase } from '../supabaseClient.js';
import { softDeleteRow, restoreRow, permanentlyDeleteRow, listDeletedRows } from './softDelete.js';

export async function listCampaigns() {
  const { data, error } = await supabase.from('campaigns').select('*').is('deleted_at', null).order('start_date', { ascending: false });
  if (error) throw error;
  return data;
}

export async function saveCampaign(row) {
  const payload = {
    name: row.name, client: row.client || null, locations: row.locations || null,
    start_date: row.startDate || null, end_date: row.endDate || null, budget: row.budget || null,
    status: row.status || 'Scheduled', notes: row.notes || null,
  };
  if (row.id) {
    const { data, error } = await supabase.from('campaigns').update(payload).eq('id', row.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('campaigns').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deleteCampaign(id) { return softDeleteRow('campaigns', id); }
export async function restoreCampaign(id) { return restoreRow('campaigns', id); }
export async function permanentlyDeleteCampaign(id) { return permanentlyDeleteRow('campaigns', id); }
export async function listDeletedCampaigns() { return listDeletedRows('campaigns'); }
