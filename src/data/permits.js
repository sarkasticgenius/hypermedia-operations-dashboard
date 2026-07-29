import { supabase } from '../supabaseClient.js';
import { uploadAttachment } from '../lib/storage.js';

export async function listPermits() {
  const { data, error } = await supabase.from('permits').select('*').order('expiry_date');
  if (error) throw error;
  return data;
}

export function permitStatus(p) {
  if (!p.expiry_date) return 'Active';
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00');
  const expiry = new Date(p.expiry_date + 'T00:00:00');
  const diffDays = Math.round((expiry - today) / 86400000);
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

export async function deletePermit(id) {
  const { error } = await supabase.from('permits').delete().eq('id', id);
  if (error) throw error;
}
