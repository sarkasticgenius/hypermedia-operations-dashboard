import { supabase } from '../supabaseClient.js';
import { uploadAttachment } from '../lib/storage.js';
import { softDeleteRow, restoreRow, permanentlyDeleteRow, listDeletedRows } from './softDelete.js';

export async function listPermits() {
  const { data, error } = await supabase.from('permits').select('*').is('deleted_at', null).order('expiry_date');
  if (error) throw error;
  return data;
}

// Whole days between today and expiry_date (negative once expired), or null with no expiry_date
// set at all - shared by permitStatus below and the Permits list's own "Days to Expire" column so
// the two never disagree about what counts as expired/expiring-soon.
export function permitDaysToExpire(p) {
  if (!p.expiry_date) return null;
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00');
  const expiry = new Date(p.expiry_date + 'T00:00:00');
  return Math.round((expiry - today) / 86400000);
}

export function permitStatus(p) {
  const diffDays = permitDaysToExpire(p);
  if (diffDays == null) return 'Active';
  if (diffDays < 0) return 'Expired';
  if (diffDays <= 30) return 'Expiring Soon';
  return 'Active';
}

export async function savePermit(row, file) {
  const payload = {
    title: row.title, type: row.type || null, location: row.location || null,
    issued_by: row.issuedBy || null, issue_date: row.issueDate || null,
    expiry_date: row.expiryDate || null, notes: row.notes || null,
  };
  if (file) {
    const uploaded = await uploadAttachment('permits', file);
    payload.document_path = uploaded.path;
    payload.document_filename = uploaded.filename;
  }
  if (row.id) {
    const { data, error } = await supabase.from('permits').update(payload).eq('id', row.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('permits').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deletePermit(id) { return softDeleteRow('permits', id); }
export async function restorePermit(id) { return restoreRow('permits', id); }
export async function permanentlyDeletePermit(id) { return permanentlyDeleteRow('permits', id); }
export async function listDeletedPermits() { return listDeletedRows('permits'); }
