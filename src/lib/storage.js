import { supabase } from '../supabaseClient.js';

const BUCKET = 'attachments';

// Replaces the original app's pattern of embedding files as base64 data URLs inside the DB
// JSON blob. folder groups files by entity (e.g. 'permits', 'tickets', 'delivery-notes') so
// they're easy to find/clean up in the Storage browser.
export async function uploadAttachment(folder, file) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false });
  if (error) throw error;
  return { path, filename: file.name };
}

export async function getSignedUrl(path, expiresInSeconds) {
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, expiresInSeconds || 3600);
  if (error) throw error;
  return data.signedUrl;
}

export async function removeAttachment(path) {
  if (!path) return;
  await supabase.storage.from(BUCKET).remove([path]);
}
