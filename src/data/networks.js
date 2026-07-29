import { supabase } from '../supabaseClient.js';

export async function listNetworks() {
  const { data, error } = await supabase.from('networks').select('*').order('name');
  if (error) throw error;
  return data;
}

export async function ensureNetwork(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const { data: existing } = await supabase.from('networks').select('*').ilike('name', trimmed).maybeSingle();
  if (existing) return existing;
  const { data, error } = await supabase.from('networks').insert({ name: trimmed }).select().single();
  if (error) throw error;
  return data;
}
