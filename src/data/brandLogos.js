import { supabase } from '../supabaseClient.js';

export async function listBrandLogos() {
  const { data, error } = await supabase.from('brand_logos').select('*');
  if (error) throw error;
  return data;
}

// Runs the Brandfetch search server-side (Edge Function holds the API key) and upserts results
// into brand_logos - returns { summary, results: [{name, logo_url, domain, error}] }.
export async function lookupBrandLogos(names) {
  const { data, error } = await supabase.functions.invoke('brandfetch-lookup', { body: { names } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}
