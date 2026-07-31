import { supabase } from '../supabaseClient.js';
import { softDeleteRow, restoreRow, permanentlyDeleteRow, listDeletedRows } from './softDelete.js';

export async function listContractors() {
  const { data, error } = await supabase.from('contractors').select('*').is('deleted_at', null).order('name');
  if (error) throw error;
  return data;
}

export async function saveContractor(row) {
  const payload = {
    name: row.name, company: row.company || null, emails: row.emails || [],
    phone: row.phone || null, notes: row.notes || null,
  };
  if (row.id) {
    const { data, error } = await supabase.from('contractors').update(payload).eq('id', row.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('contractors').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deleteContractor(id) { return softDeleteRow('contractors', id); }
export async function restoreContractor(id) { return restoreRow('contractors', id); }
export async function permanentlyDeleteContractor(id) { return permanentlyDeleteRow('contractors', id); }
export async function listDeletedContractors() { return listDeletedRows('contractors'); }
