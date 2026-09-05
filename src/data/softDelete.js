import { supabase } from '../supabaseClient.js';
import { STATE } from '../state.js';
import { fetchAllPages } from '../lib/pagedFetch.js';

// Shared soft-delete primitives reused by every entity's delete/restore functions, so "delete"
// never removes a row outright - it's recoverable from the Recycle Bin until an admin purges it
// for good. `deleteX(id)` call sites/signatures across the app are unchanged; only what happens
// underneath changed from a real DELETE to this.
export async function softDeleteRow(table, id) {
  const { error } = await supabase.from(table)
    .update({ deleted_at: new Date().toISOString(), deleted_by: STATE.user?.id || null })
    .eq('id', id);
  if (error) throw error;
}

export async function restoreRow(table, id) {
  const { error } = await supabase.from(table).update({ deleted_at: null, deleted_by: null }).eq('id', id);
  if (error) throw error;
}

// The real DELETE - only ever called from the Recycle Bin's "Delete Permanently" action.
export async function permanentlyDeleteRow(table, id) {
  const { error } = await supabase.from(table).delete().eq('id', id);
  if (error) throw error;
}

export async function listDeletedRows(table, select) {
  return fetchAllPages((withCount) => supabase.from(table)
    .select(select || '*', withCount ? { count: 'exact' } : undefined)
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false }));
}
