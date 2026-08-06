// Posts a plain-text message to a Slack Incoming Webhook. Runs server-side so the webhook URL
// never reaches the browser, same reasoning as every other integration in this app (Brandfetch,
// Traffic Sheet, Broadsign/Grassfish/IoT) - a webhook URL is a bearer credential (anyone holding it
// can post into the channel), even though it isn't a classic "API key" header.
//
// Deliberately generic: the caller builds the message text (e.g. Client Campaigns Monitor's
// Approve button), this function just delivers it - keeps campaign-specific copy out of the edge
// function so any future feature can reuse the same notify path without redeploying it.
//
// Runs two ways, same pattern as brandfetch-lookup/traffic-sheet-proxy:
//   1. From the app - authenticated user JWT, body is { text }.
//   2. A future server-side trigger - x-cron-secret instead of a user session.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

async function isAuthorized(req: Request, adminClient: any, supabaseUrl: string, anonKey: string): Promise<boolean> {
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret) {
    const { data: secretRow } = await adminClient.from('app_settings').select('value').eq('key', '_cronSecret').single();
    return !!(secretRow?.value?.secret && cronSecret === secretRow.value.secret);
  }
  const authHeader = req.headers.get('Authorization') || '';
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: { user: caller } } = await callerClient.auth.getUser();
  if (!caller) return false;
  const { data: profile } = await adminClient.from('profiles').select('active').eq('id', caller.id).single();
  return !!profile?.active;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!(await isAuthorized(req, adminClient, supabaseUrl, anonKey))) throw new Error('Not authenticated');

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'slackNotify').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.webhookUrl) {
      throw new Error('Slack integration is not fully configured (Webhook URL, Enabled).');
    }

    const body = await req.json().catch(() => ({}));
    // Falls back to a canned message so the generic "Test" button (which invokes with an empty
    // body) actually sends something real to the channel, same as every other integration's Test.
    const text = String(body.text || 'Test message from Hypermedia Operations Dashboard.').trim();

    const nowIso = new Date().toISOString();
    const res = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const message = `Slack webhook returned HTTP ${res.status}`;
      await adminClient.from('app_settings').update({ value: { ...cfg, lastError: message } }).eq('key', 'slackNotify');
      throw new Error(message);
    }

    const summary = `Sent: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`;
    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '' },
      updated_at: nowIso,
    }).eq('key', 'slackNotify');

    return new Response(JSON.stringify({ summary }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
  }
});
