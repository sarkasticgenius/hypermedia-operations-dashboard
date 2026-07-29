import { supabase } from '../supabaseClient.js';
import { uploadAttachment } from '../lib/storage.js';

export async function listMetroPics() {
  const { data, error } = await supabase
    .from('metro_pics')
    .select('*, metro_pic_renewals(*)')
    .order('validity_end');
  if (error) throw error;
  return data;
}

export function metroPicStatus(m) {
  if (!m.validity_end) return 'Active';
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00');
  const end = new Date(m.validity_end + 'T00:00:00');
  const diffDays = Math.round((end - today) / 86400000);
  if (diffDays < 0) return 'Expired';
  if (diffDays <= 30) return 'Expiring Soon';
  return 'Active';
}

export async function saveMetroPic(row, eidFile) {
  const payload = {
    station: row.station, pic_name: row.picName || null, designation: row.designation || null,
    phone: row.phone || null, email: row.email || null, validity_start: row.validityStart || null,
    validity_end: row.validityEnd || null, eid_number: row.eidNumber || null, notes: row.notes || null,
  };
  if (eidFile) {
    const uploaded = await uploadAttachment('metro-pic-eids', eidFile);
    payload.eid_document_path = uploaded.path;
    payload.eid_document_filename = uploaded.filename;
  }
  if (row.id) {
    const { data, error } = await supabase.from('metro_pics').update(payload).eq('id', row.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('metro_pics').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function renewMetroPic(id, current, next, renewedBy) {
  await supabase.from('metro_pic_renewals').insert({
    metro_pic_id: id, validity_start: current.validity_start, validity_end: current.validity_end,
    pic_name: current.pic_name, designation: current.designation, phone: current.phone,
    email: current.email, eid_number: current.eid_number, eid_document_path: current.eid_document_path,
    eid_document_filename: current.eid_document_filename, renewed_on: new Date().toISOString().slice(0, 10),
    renewed_by: renewedBy, notes: current.notes,
  });
  const { data, error } = await supabase.from('metro_pics').update({
    validity_start: next.validityStart, validity_end: next.validityEnd,
    pic_name: next.picName, designation: next.designation, phone: next.phone,
    email: next.email, eid_number: next.eidNumber, notes: next.notes,
  }).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteMetroPic(id) {
  const { error } = await supabase.from('metro_pics').delete().eq('id', id);
  if (error) throw error;
}
