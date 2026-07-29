import { supabase } from '../supabaseClient.js';
import { uploadAttachment } from '../lib/storage.js';

export async function listOrders() {
  const { data, error } = await supabase.from('orders').select('*').order('order_date', { ascending: false });
  if (error) throw error;
  return data;
}

export async function saveOrder(row, deliveryNoteFile) {
  const payload = {
    asset_id: row.assetId || null, asset_name: row.assetName || null, qty: row.qty || 1,
    order_date: row.orderDate || null, destination: row.destination || null,
    status: row.status || 'Ordered',
  };
  if (deliveryNoteFile) {
    const uploaded = await uploadAttachment('delivery-notes', deliveryNoteFile);
    payload.delivery_note_path = uploaded.path;
    payload.delivery_note_filename = uploaded.filename;
    payload.delivery_note_uploaded_at = new Date().toISOString();
  }
  if (row.id) {
    const { data, error } = await supabase.from('orders').update(payload).eq('id', row.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('orders').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deleteOrder(id) {
  const { error } = await supabase.from('orders').delete().eq('id', id);
  if (error) throw error;
}
