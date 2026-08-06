import { supabase } from '../supabaseClient.js';

export async function notifySlack(text) {
  const { data, error } = await supabase.functions.invoke('slack-notify', { body: { text } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}
