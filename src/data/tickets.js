import { supabase } from '../supabaseClient.js';
import { uploadAttachment } from '../lib/storage.js';
import { softDeleteRow, restoreRow, permanentlyDeleteRow, listDeletedRows } from './softDelete.js';

export async function listTickets() {
  const { data, error } = await supabase.from('tickets').select('*').is('deleted_at', null).order('date_reported', { ascending: false }).range(0, 9999);
  if (error) throw error;
  return data;
}

export async function saveTicket(row, photoFile) {
  const payload = {
    type: row.type || 'Issue', title: row.title, location: row.location || null,
    asset_id: row.assetId || null, asset_name: row.assetName || null,
    asset_inv_id: row.assetInvId || null, asset_inv_label: row.assetInvLabel || null,
    description: row.description || null, status: row.status || 'Open',
    priority: row.priority || 'Medium', root_cause: row.rootCause || null,
    extra_emails: row.extraEmails || [], reported_by: row.reportedBy || null,
    date_reported: row.dateReported || null, date_closed: row.dateClosed || null,
  };
  if (photoFile) {
    const uploaded = await uploadAttachment('tickets', photoFile);
    payload.photo_path = uploaded.path;
  }
  if (row.id) {
    const { data, error } = await supabase.from('tickets').update(payload).eq('id', row.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('tickets').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deleteTicket(id) { return softDeleteRow('tickets', id); }
export async function restoreTicket(id) { return restoreRow('tickets', id); }
export async function permanentlyDeleteTicket(id) { return permanentlyDeleteRow('tickets', id); }
export async function listDeletedTickets() { return listDeletedRows('tickets'); }
