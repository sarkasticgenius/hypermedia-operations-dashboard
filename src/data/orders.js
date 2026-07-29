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

// Marks an order Delivered and rolls the received quantity into the linked asset's warehouse
// stock - matches the original's confirmReceive() (qty received bumps asset.stockAvailable; the
// order's own `qty` stays as originally ordered, only its status flips).
export async function receiveOrder(id, qtyReceived, deliveryNoteFile) {
  const { data: order, error: fetchErr } = await supabase.from('orders').select('asset_id').eq('id', id).single();
  if (fetchErr) throw fetchErr;

  const payload = { status: 'Delivered' };
  if (deliveryNoteFile) {
    const uploaded = await uploadAttachment('delivery-notes', deliveryNoteFile);
    payload.delivery_note_path = uploaded.path;
    payload.delivery_note_filename = uploaded.filename;
    payload.delivery_note_uploaded_at = new Date().toISOString();
  }
  const { error } = await supabase.from('orders').update(payload).eq('id', id);
  if (error) throw error;

  if (order.asset_id && qtyReceived) {
    const { data: asset } = await supabase.from('assets').select('stock_available').eq('id', order.asset_id).single();
    if (asset) {
      await supabase.from('assets').update({ stock_available: (asset.stock_available || 0) + qtyReceived }).eq('id', order.asset_id);
    }
  }
}

// Standalone "Upload/Replace Delivery Note" action - attaches a file without touching status.
export async function uploadOrderDeliveryNote(id, file) {
  const uploaded = await uploadAttachment('delivery-notes', file);
  const { error } = await supabase.from('orders').update({
    delivery_note_path: uploaded.path, delivery_note_filename: uploaded.filename,
    delivery_note_uploaded_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw error;
}
