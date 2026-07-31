import { supabase } from '../supabaseClient.js';
import { softDeleteRow, restoreRow, permanentlyDeleteRow, listDeletedRows } from './softDelete.js';

export async function listDashboardSections() {
  const { data, error } = await supabase
    .from('dashboard_sections')
    .select('*, dashboards(*)')
    .order('sort_order');
  if (error) throw error;
  // dashboards(*) is an embedded resource - filtering it inline via PostgREST's dotted-path
  // syntax isn't worth the fragility here, so soft-deleted links are just dropped client-side.
  return data.map((s) => ({ ...s, dashboards: (s.dashboards || []).filter((d) => !d.deleted_at) }));
}

export async function addDashboardSection(name, navGroup) {
  const { data, error } = await supabase
    .from('dashboard_sections')
    .insert({ name, nav_group: navGroup || 'dashboards', locked: false })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteDashboardSection(id) {
  const { error } = await supabase.from('dashboard_sections').delete().eq('id', id);
  if (error) throw error;
}

export async function addDashboardLink(sectionId, name, url) {
  const { data, error } = await supabase
    .from('dashboards')
    .insert({ section_id: sectionId, name, url })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function saveDashboardLink(id, name, url) {
  const { error } = await supabase.from('dashboards').update({ name, url }).eq('id', id);
  if (error) throw error;
}

export async function deleteDashboardLink(id) { return softDeleteRow('dashboards', id); }
export async function restoreDashboardLink(id) { return restoreRow('dashboards', id); }
export async function permanentlyDeleteDashboardLink(id) { return permanentlyDeleteRow('dashboards', id); }
export async function listDeletedDashboardLinks() { return listDeletedRows('dashboards'); }
