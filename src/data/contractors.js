import { supabase } from '../supabaseClient.js';

export async function listContractors() {
  const { data, error } = await supabase.from('contractors').select('*').order('name');
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

export async function deleteContractor(id) {
  const { error } = await supabase.from('contractors').delete().eq('id', id);
  if (error) throw error;
}
