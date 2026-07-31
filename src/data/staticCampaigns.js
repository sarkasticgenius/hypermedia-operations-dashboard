import { supabase } from '../supabaseClient.js';
import { uploadAttachment } from '../lib/storage.js';
import { softDeleteRow, restoreRow, permanentlyDeleteRow, listDeletedRows } from './softDelete.js';

export async function listStaticCampaigns() {
  const { data, error } = await supabase
    .from('static_campaigns')
    .select('*, static_installations(*)')
    .is('deleted_at', null)
    .order('start_date', { ascending: false });
  if (error) throw error;
  return data;
}

export async function saveStaticCampaign(row) {
  const payload = {
    name: row.name, client: row.client || null, format: row.format || null,
    locations: row.locations || null, start_date: row.startDate || null, end_date: row.endDate || null,
    budget: row.budget || null, status: row.status || 'Scheduled', notes: row.notes || null,
  };
  if (row.id) {
    const { data, error } = await supabase.from('static_campaigns').update(payload).eq('id', row.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('static_campaigns').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deleteStaticCampaign(id) { return softDeleteRow('static_campaigns', id); }
export async function restoreStaticCampaign(id) { return restoreRow('static_campaigns', id); }
export async function permanentlyDeleteStaticCampaign(id) { return permanentlyDeleteRow('static_campaigns', id); }
export async function listDeletedStaticCampaigns() { return listDeletedRows('static_campaigns'); }

export async function saveInstallation(row, installFile, roadClosureFile) {
  const payload = {
    static_campaign_id: row.staticCampaignId, location: row.location || null,
    print_house: row.printHouse || null, install_permit_expiry: row.installPermitExpiry || null,
    road_closure_needed: !!row.roadClosureNeeded, road_closure_permit_expiry: row.roadClosurePermitExpiry || null,
    notes: row.notes || null,
  };
  if (installFile) {
    const uploaded = await uploadAttachment('static-installations', installFile);
    payload.install_permit_path = uploaded.path;
    payload.install_permit_filename = uploaded.filename;
  }
  if (roadClosureFile) {
    const uploaded = await uploadAttachment('static-installations', roadClosureFile);
    payload.road_closure_permit_path = uploaded.path;
    payload.road_closure_permit_filename = uploaded.filename;
  }
  if (row.id) {
    const { error } = await supabase.from('static_installations').update(payload).eq('id', row.id);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from('static_installations').insert(payload);
  if (error) throw error;
}

export async function deleteInstallation(id) {
  const { error } = await supabase.from('static_installations').delete().eq('id', id);
  if (error) throw error;
}

export async function listStaticMachines() {
  const { data, error } = await supabase.from('static_machines').select('*').is('deleted_at', null).order('name');
  if (error) throw error;
  return data;
}

export async function saveStaticMachine(row) {
  const payload = { name: row.name, category: row.category || null, contractor_id: row.contractorId || null, status: row.status || 'Available', notes: row.notes || null };
  if (row.id) {
    const { data, error } = await supabase.from('static_machines').update(payload).eq('id', row.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('static_machines').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deleteStaticMachine(id) { return softDeleteRow('static_machines', id); }
export async function restoreStaticMachine(id) { return restoreRow('static_machines', id); }
export async function permanentlyDeleteStaticMachine(id) { return permanentlyDeleteRow('static_machines', id); }
export async function listDeletedStaticMachines() { return listDeletedRows('static_machines'); }

export async function listStaticBookings() {
  const { data, error } = await supabase.from('static_bookings').select('*').is('deleted_at', null).order('start_date');
  if (error) throw error;
  return data;
}

export function staticBookingConflict(bookings, machineId, startDate, endDate, excludeId) {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  return bookings.some((b) => {
    if (b.machine_id !== machineId || b.id === excludeId) return false;
    const bStart = new Date(b.start_date).getTime();
    const bEnd = new Date(b.end_date).getTime();
    return start <= bEnd && end >= bStart;
  });
}

export async function saveStaticBooking(row) {
  const payload = {
    machine_id: row.machineId, campaign_id: row.campaignId || null, installation_id: row.installationId || null,
    start_date: row.startDate, end_date: row.endDate, booked_by: row.bookedBy || null, notes: row.notes || null,
  };
  if (row.id) {
    const { data, error } = await supabase.from('static_bookings').update(payload).eq('id', row.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('static_bookings').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deleteStaticBooking(id) { return softDeleteRow('static_bookings', id); }
export async function restoreStaticBooking(id) { return restoreRow('static_bookings', id); }
export async function permanentlyDeleteStaticBooking(id) { return permanentlyDeleteRow('static_bookings', id); }
export async function listDeletedStaticBookings() { return listDeletedRows('static_bookings'); }
