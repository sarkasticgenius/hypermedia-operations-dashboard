// Backs the no-login contractor ticket-closing portal (app opens this at
// ?portal=close&ticket=<id>, no Supabase session exists). Runs entirely on the service role so
// an anonymous visitor can look up and close exactly one ticket by id, without any broader table
// access - the original app achieved the same isolation via an external webhook relay; this
// replaces that relay with a function that talks to the DB directly.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function decodeBase64(dataUrl: string): { bytes: Uint8Array; contentType: string } {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  const contentType = match ? match[1] : 'application/octet-stream';
  const base64 = match ? match[2] : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, contentType };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json();
    const { action, ticketId } = body || {};
    if (!ticketId) throw new Error('ticketId is required');

    const { data: ticket, error: fetchErr } = await adminClient
      .from('tickets')
      .select('id, title, location, description, status, priority, date_reported')
      .eq('id', ticketId)
      .maybeSingle();
    if (fetchErr || !ticket) throw new Error('Ticket not found');

    if (action === 'get') {
      return new Response(JSON.stringify({ ticket }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
      });
    }

    if (action === 'close') {
      if (ticket.status === 'Closed') throw new Error('This ticket is already closed.');
      const { rootCause, closedBy, media } = body;
      if (!rootCause || !closedBy) throw new Error('rootCause and closedBy are required');

      const mediaPaths: string[] = [];
      for (const item of (media || []).slice(0, 5)) {
        try {
          const { bytes, contentType } = decodeBase64(item.dataUrl);
          const ext = (item.name || 'file').split('.').pop();
          const path = `ticket-closures/${ticketId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
          const { error: uploadErr } = await adminClient.storage.from('attachments').upload(path, bytes, { contentType });
          if (!uploadErr) mediaPaths.push(path);
        } catch (_) { /* skip a bad file, don't fail the whole closure */ }
      }

      const { error: updateErr } = await adminClient
        .from('tickets')
        .update({
          status: 'Closed',
          root_cause: rootCause,
          closed_by_contractor: closedBy,
          date_closed: new Date().toISOString().slice(0, 10),
          closure_media: mediaPaths,
        })
        .eq('id', ticketId);
      if (updateErr) throw updateErr;

      await adminClient.from('audit_log').insert({
        user_id: null, username: 'contractor-portal', name: closedBy,
        action: 'Close ticket (contractor portal)', detail: ticket.title,
      });

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
      });
    }

    throw new Error('Unknown action');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
