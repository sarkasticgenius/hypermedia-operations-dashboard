import { supabase } from '../supabaseClient.js';
import { softDeleteRow, restoreRow, permanentlyDeleteRow, listDeletedRows } from './softDelete.js';

export async function listCategories() {
  const { data, error } = await supabase.from('categories').select('*').is('deleted_at', null).order('name');
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

export async function updateCategory(id, name, isRental) {
  const { data, error } = await supabase
    .from('categories')
    .update({ name, is_rental: !!isRental })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteCategory(id) { return softDeleteRow('categories', id); }
export async function restoreCategory(id) { return restoreRow('categories', id); }
export async function permanentlyDeleteCategory(id) { return permanentlyDeleteRow('categories', id); }
export async function listDeletedCategories() { return listDeletedRows('categories'); }
