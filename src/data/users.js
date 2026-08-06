import { supabase } from '../supabaseClient.js';
import { PERMISSION_AREAS } from '../auth.js';

export async function listUsers() {
  const { data, error } = await supabase.from('profiles').select('*, user_permissions(*)').order('username');
  if (error) throw error;
  return data.map((u) => ({
    ...u,
    permissions: Object.fromEntries(PERMISSION_AREAS.map((area) => {
      const row = (u.user_permissions || []).find((p) => p.area === area);
      return [area, row
        ? { view: row.can_view, add: row.can_add, edit: row.can_edit, delete: row.can_delete, export: row.can_export }
        : { view: false, add: false, edit: false, delete: false, export: false }];
    })),
  }));
}

// Creates a brand-new auth user + profile via the admin-create-user Edge Function - the anon
// key alone cannot call auth.admin.createUser, so this has to go through the server-side
// function that holds the service role key.
export async function createUser({ email, password, username, name, title, role, permissions, clientId }) {
  const { data, error } = await supabase.functions.invoke('admin-create-user', {
    body: { email, password, username, name, title, role, permissions, clientId, origin: window.location.origin },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function updateUserProfile(id, { name, title, role, clientId }) {
  const { error } = await supabase.from('profiles')
    .update({ name, title, role, client_id: role === 'client' ? (clientId || null) : null })
    .eq('id', id);
  if (error) throw error;
}

export async function updateUserPermissions(id, permissions) {
  const rows = PERMISSION_AREAS.map((area) => ({
    user_id: id, area,
    can_view: !!permissions[area]?.view, can_add: !!permissions[area]?.add,
    can_edit: !!permissions[area]?.edit, can_delete: !!permissions[area]?.delete,
    can_export: !!permissions[area]?.export,
  }));
  const { error } = await supabase.from('user_permissions').upsert(rows, { onConflict: 'user_id,area' });
  if (error) throw error;
}

export async function setUserActive(id, active) {
  const { error } = await supabase.from('profiles').update({ active }).eq('id', id);
  if (error) throw error;
}
