import { supabase } from '../supabaseClient.js';

export async function listCategories() {
  const { data, error } = await supabase.from('categories').select('*').order('name');
  if (error) throw error;
  return data;
}

export async function isRentalCategory(categories, name) {
  const c = categories.find((c) => c.name.toLowerCase() === String(name || '').toLowerCase());
  return !!c?.is_rental;
}

export async function addCategory(name, isRental) {
  const { data, error } = await supabase
    .from('categories')
    .insert({ name, is_rental: !!isRental })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteCategory(id) {
  const { error } = await supabase.from('categories').delete().eq('id', id);
  if (error) throw error;
}
