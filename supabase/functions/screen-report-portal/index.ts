// Backs the no-login screen-issue-report portal (app opens this at ?portal=report&asset=<id>,
// scanned from a QR code stuck on the physical screen - no Supabase session exists). Runs entirely
// on the service role so an anonymous visitor can look up one asset's public-safe display info and
// submit exactly one report against it, without any broader table access - same isolation pattern
// as close-ticket-portal.
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
    const { action, assetId } = body || {};
    if (!assetId) throw new Error('assetId is required');

    const { data: asset, error: fetchErr } = await adminClient
      .from('asset_inventory')
      .select('id, name, venue, location, category')
      .eq('id', assetId)
      .maybeSingle();
    if (fetchErr || !asset) throw new Error('Screen not found - the QR code may be for a retired or removed asset.');

    if (action === 'get') {
      return new Response(JSON.stringify({ asset }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
      });
    }

    if (action === 'submit') {
      const { description, reporterName, media } = body;
      if (!description) throw new Error('description is required');

      const mediaPaths: string[] = [];
      for (const item of (media || []).slice(0, 5)) {
        try {
          const { bytes, contentType } = decodeBase64(item.dataUrl);
          const ext = (item.name || 'file').split('.').pop();
          const path = `screen-reports/${assetId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
          const { error: uploadErr } = await adminClient.storage.from('attachments').upload(path, bytes, { contentType });
          if (!uploadErr) mediaPaths.push(path);
        } catch (_) { /* skip a bad file, don't fail the whole report */ }
      }

      const { error: insertErr } = await adminClient.from('screen_reports').insert({
        asset_id: assetId,
        description,
        reporter_name: reporterName || null,
        media_paths: mediaPaths,
      });
      if (insertErr) throw insertErr;

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
