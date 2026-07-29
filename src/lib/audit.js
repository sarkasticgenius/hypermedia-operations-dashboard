import { supabase } from '../supabaseClient.js';
import { STATE } from '../state.js';

// Append-only, same as the original app's logAudit(). RLS only lets an active signed-in user
// insert (see audit_log_insert_active policy) and only an admin read it back (Admin page).
export async function logAudit(action, detail) {
  const user = STATE.user;
  if (!user) return;
  try {
    await supabase.from('audit_log').insert({
      user_id: user.id,
      username: user.username,
      name: user.name,
      action,
      detail: detail || '',
    });
  } catch (e) {
    console.warn('audit log insert failed', e);
  }
}
