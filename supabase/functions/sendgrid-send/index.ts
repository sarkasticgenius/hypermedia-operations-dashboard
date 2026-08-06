// Sends a transactional email via SendGrid's REST API (POST /v3/mail/send). Runs server-side so
// the API key never reaches the browser, same reasoning as every other integration in this app.
//
// Deliberately generic: the caller builds the subject/body (welcome emails from admin-create-user,
// password-reset emails from request-password-reset), this function just delivers it - keeps
// account-flow-specific copy out of the edge function so either caller (or a future one) can reuse
// this same path without redeploying it.
//
// Runs two ways, same pattern as brandfetch-lookup/traffic-sheet-proxy/slack-notify:
//   1. From the app or another edge function - authenticated user JWT, body is { to, subject, text }.
//   2. A future server-side trigger - x-cron-secret instead of a user session.
//
// { to } omitted (the generic Settings "Test" button, which invokes with an empty body) - since
// there's no single obvious recipient to send a real test email to the way Slack's canned test
// message can just post to the configured channel, this instead calls SendGrid's GET /v3/scopes to
// verify the API key actually works without sending anything.
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

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'sendgridEmail').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.apiKey || !cfg.fromEmail) {
      throw new Error('SendGrid integration is not fully configured (API Key, From Email, Enabled).');
    }

    const body = await req.json().catch(() => ({}));
    const nowIso = new Date().toISOString();

    if (!body.to) {
      const res = await fetch('https://api.sendgrid.com/v3/scopes', {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      });
      if (!res.ok) {
        const message = `SendGrid API key check failed (HTTP ${res.status})`;
        await adminClient.from('app_settings').update({ value: { ...cfg, lastError: message } }).eq('key', 'sendgridEmail');
        throw new Error(message);
      }
      const summary = 'API key verified - no email sent (Test has no recipient to send to).';
      await adminClient.from('app_settings').update({
        value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '' }, updated_at: nowIso,
      }).eq('key', 'sendgridEmail');
      return new Response(JSON.stringify({ summary }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    const to = String(body.to).trim();
    const subject = String(body.subject || 'Notification').trim();
    const text = String(body.text || '').trim();
    if (!to || !text) throw new Error('to and text are required');

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: cfg.fromEmail, name: cfg.fromName || undefined },
        subject,
        content: [{ type: 'text/plain', value: text }],
      }),
    });
    // SendGrid returns 202 with an empty body on success, and a JSON {errors:[...]} body on failure.
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const errBody = await res.json();
        if (errBody?.errors?.length) detail = errBody.errors.map((e: any) => e.message).join('; ');
      } catch (_) { /* body wasn't JSON */ }
      const message = `SendGrid send failed: ${detail}`;
      await adminClient.from('app_settings').update({ value: { ...cfg, lastError: message } }).eq('key', 'sendgridEmail');
      throw new Error(message);
    }

    const summary = `Sent to ${to}: "${subject}"`;
    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '' }, updated_at: nowIso,
    }).eq('key', 'sendgridEmail');

    return new Response(JSON.stringify({ summary }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
  }
});
