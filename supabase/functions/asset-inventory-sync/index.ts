// Generic, vendor-agnostic Asset Inventory sync: fetches a configured JSON API endpoint
// server-side (so any auth stays out of the browser, same rationale as
// broadsign-sync/grassfish-sync), applies an admin-configured field mapping, and upserts into
// asset_inventory keyed on source_asset_id (falls back to name+venue when the source has no
// numeric id). Config lives in app_settings.assetInventoryApi:
//   { baseUrl, dataPath, authHeaderName, authHeaderValue,
//     clientId, clientSecret, tokenPath, venuesPath, locationsPath, networksPath,
//     fieldMapping: {ourColumn: "source.field.path"}, enabled, lastSync, lastSyncSummary, lastError }
// fieldMapping values support simple dot-paths (e.g. "attributes.venue") into each item of the
// response array (or response.data / response.items / response.results if the top level is an
// object rather than a bare array).
// Auth: if clientId + clientSecret are set, does an OAuth2 client-credentials style handshake -
// POST {baseUrl}{tokenPath || /identity/oauth2} with {client_id, client_secret} JSON body,
// reads response.access_token, sends it as "Authorization: Bearer <token>" on the data request.
// Otherwise falls back to a single static header (authHeaderName/authHeaderValue), or no auth.
// The data request hits {baseUrl}{dataPath} (dataPath defaults to '', i.e. baseUrl itself).
// Venue/location joins: some vendors (e.g. Inventory MS) return assets with venue_id/location_id
// FKs instead of names. If fieldMapping references "_venue.<field>" or "_location.<field>", this
// fetches {baseUrl}{venuesPath || /inventory/venues} and {baseUrl}{locationsPath || /inventory/locations},
// indexes each by "id", and attaches the matched object as item._venue / item._location (matched via
// item.venue_id / item.location_id) before field mapping runs.
// Networks join: networks are a many-to-many relationship in our schema (asset_inventory_networks),
// not a plain column, so they're resolved separately from the ALLOWED_COLUMNS field-mapping loop.
// fieldMapping.networks (reserved key, not written to asset_inventory directly) controls how a
// row's network name(s) are found:
//   - "_network.<field>" - single network_id FK on the item (same shape as venue_id/location_id),
//     resolved against {baseUrl}{networksPath || /inventory/networks}.
//   - "_networks" - item carries a network_ids array (multiple networks per asset); each id is
//     resolved against the same networks list.
//   - anything else (a plain dot-path, no "_network" prefix) - the vendor already puts the
//     network name(s) directly on the item (string, or an array of strings) - no join needed.
// Whichever name(s) resolve are matched case-insensitively against our own `networks` table
// (creating any that don't exist yet, same as the app's own "add network" flow) and linked via
// asset_inventory_networks - idempotent (ON CONFLICT DO NOTHING on the (asset_inventory_id,
// network_id) primary key), so re-running a sync never duplicates a link.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function getPath(obj: any, path: string) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function joinUrl(base: string, path?: string) {
  if (!path) return base;
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

// Vendor gateways that silently drop (rather than reject) traffic they don't like would otherwise
// hang until Supabase's ~150s hard execution limit kills the whole function. Fail fast instead so
// the caller gets a clear, actionable error.
const FETCH_TIMEOUT_MS = 15_000;

function fetchOnce(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer)).catch((err) => {
    if (err?.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${FETCH_TIMEOUT_MS / 1000}s (no response - likely a network/firewall block).`);
    }
    throw err;
  });
}

// This vendor's gateway has shown intermittent behavior - some requests hang or come back with a
// bare 400 for no discernible reason (confirmed the same request/credentials succeed reliably from
// outside Supabase's egress network), while a retry moments later goes through fine. One retry
// after a short pause smooths over that flakiness without masking a genuinely broken config.
async function fetchWithRetry(url: string, init?: RequestInit) {
  try {
    const res = await fetchOnce(url, init);
    if (res.ok) return res;
    await new Promise((resolve) => setTimeout(resolve, 800));
    return await fetchOnce(url, init);
  } catch (_err) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return await fetchOnce(url, init);
  }
}

// A bare status code ("Source API returned 400") is nearly undiagnosable on its own - vendor
// gateways almost always put the actual reason (missing/invalid param, bad auth, rate limit) in
// the response body. Truncated so one huge HTML error page doesn't blow up lastError.
async function bodyPreview(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text ? `: ${text.slice(0, 500)}` : '';
  } catch (_err) {
    return '';
  }
}

const ALLOWED_COLUMNS = new Set([
  'source_asset_id', 'name', 'venue', 'location', 'category', 'pdooh_ready', 'format',
  'width', 'height', 'screens', 'faces', 'special_render', 'anydesk_id', 'teamviewer_id',
  'sensor_id', 'lat', 'lng', 'multiplier', 'position', 'player_box_id', 'ad_duration',
  'player_type', 'managed_by_hm', 'source_created_at',
]);

// Inventory MS's player_type_id enum (confirmed by the customer): 1 = Grassfish, 2 = Broadsign.
// Our asset_inventory.player_type column stores the readable name (matched against by the
// grassfish-sync/broadsign-sync functions), so a numeric id mapped to "player_type" is translated
// here rather than stored as-is.
const PLAYER_TYPE_MAP: Record<number, string> = { 1: 'Grassfish', 2: 'Broadsign' };

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
const CHUNK_SIZE = 400;

type Mapped = { row: Record<string, unknown>; networkNames: string[]; assetId?: string };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const authHeader = req.headers.get('Authorization') || '';

    const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) throw new Error('Not authenticated');

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile } = await adminClient.from('profiles').select('active').eq('id', caller.id).single();
    if (!profile?.active) throw new Error('Inactive account');

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'assetInventoryApi').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.baseUrl) {
      throw new Error('Asset Inventory API sync is not configured (baseUrl, enabled).');
    }
    const mapping = cfg.fieldMapping && typeof cfg.fieldMapping === 'object' ? cfg.fieldMapping : {};
    if (!mapping.name && !mapping.source_asset_id) {
      throw new Error('fieldMapping must map at least "name" or "source_asset_id" to a source field.');
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cfg.clientId && cfg.clientSecret) {
      const tokenUrl = joinUrl(cfg.baseUrl, cfg.tokenPath || '/identity/oauth2');
      const tokenRes = await fetchWithRetry(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret }),
      });
      if (!tokenRes.ok) throw new Error(`OAuth token request failed: ${tokenRes.status}${await bodyPreview(tokenRes)}`);
      const tokenBody = await tokenRes.json();
      if (!tokenBody.access_token) throw new Error('OAuth token response had no access_token field.');
      headers.Authorization = `Bearer ${tokenBody.access_token}`;
    } else if (cfg.authHeaderName && cfg.authHeaderValue) {
      headers[cfg.authHeaderName] = cfg.authHeaderValue;
    }

    const res = await fetchWithRetry(joinUrl(cfg.baseUrl, cfg.dataPath), { headers });
    if (!res.ok) throw new Error(`Source API returned ${res.status}${await bodyPreview(res)}`);
    const body = await res.json();
    const items: any[] = Array.isArray(body) ? body : (body.data || body.items || body.results || []);
    if (!Array.isArray(items)) throw new Error('Response was not an array (or data/items/results array).');

    const mappingValues = Object.values(mapping);
    const needsVenueJoin = mappingValues.some((v) => typeof v === 'string' && v.startsWith('_venue.'));
    const needsLocationJoin = mappingValues.some((v) => typeof v === 'string' && v.startsWith('_location.'));
    const networksMapping = typeof mapping.networks === 'string' ? mapping.networks : null;
    const needsNetworkJoin = !!networksMapping && networksMapping.startsWith('_network');

    async function fetchById(path: string): Promise<Map<unknown, any>> {
      const listRes = await fetchWithRetry(joinUrl(cfg.baseUrl, path), { headers });
      if (!listRes.ok) throw new Error(`Join request to ${path} returned ${listRes.status}${await bodyPreview(listRes)}`);
      const listBody = await listRes.json();
      const list: any[] = Array.isArray(listBody) ? listBody : (listBody.data || listBody.items || listBody.results || []);
      return new Map(list.map((row) => [row.id, row]));
    }

    const venuesById = needsVenueJoin ? await fetchById(cfg.venuesPath || '/inventory/venues') : null;
    const locationsById = needsLocationJoin ? await fetchById(cfg.locationsPath || '/inventory/locations') : null;
    const networksById = needsNetworkJoin ? await fetchById(cfg.networksPath || '/inventory/networks') : null;
    if (venuesById || locationsById || networksById) {
      for (const item of items) {
        if (venuesById && item.venue_id != null) item._venue = venuesById.get(item.venue_id);
        if (locationsById && item.location_id != null) item._location = locationsById.get(item.location_id);
        if (networksById) {
          if (item.network_id != null) item._network = networksById.get(item.network_id);
          if (Array.isArray(item.network_ids)) item._networks = item.network_ids.map((id: unknown) => networksById.get(id)).filter(Boolean);
        }
      }
    }

    function resolveNetworkNames(item: any): string[] {
      if (!networksMapping) return [];
      if (networksMapping === '_networks') {
        return ((item._networks || []) as any[]).map((n) => n?.name).filter((n): n is string => !!n);
      }
      if (networksMapping.startsWith('_network.')) {
        const v = getPath(item, networksMapping);
        return v ? [String(v)] : [];
      }
      const v = getPath(item, networksMapping);
      if (Array.isArray(v)) return v.filter(Boolean).map(String);
      return v != null && v !== '' ? [String(v)] : [];
    }

    const mapped: Mapped[] = items.map((item) => {
      const row: Record<string, unknown> = { source: 'api-sync' };
      for (const [column, sourcePath] of Object.entries(mapping)) {
        if (!ALLOWED_COLUMNS.has(column)) continue;
        let value = getPath(item, sourcePath as string);
        if (column === 'player_type' && PLAYER_TYPE_MAP[value as number] !== undefined) {
          value = PLAYER_TYPE_MAP[value as number];
        }
        if (value !== undefined) row[column] = value;
      }
      return { row, networkNames: resolveNetworkNames(item) };
    }).filter((m) => m.row.name || m.row.source_asset_id);

    // --- Batch upsert asset_inventory (one round-trip per chunk instead of two sequential
    // SELECTs + one INSERT/UPDATE per row - the old per-row loop was hitting Supabase's ~150s
    // execution limit on large syncs; confirmed in production logs as a 546 timeout). ---
    const withId = mapped.filter((m) => m.row.source_asset_id != null);
    const withoutId = mapped.filter((m) => m.row.source_asset_id == null);

    const existingSourceIds = new Set<string>();
    for (const c of chunk(withId.map((m) => String(m.row.source_asset_id)), 1000)) {
      if (!c.length) continue;
      const { data } = await adminClient.from('asset_inventory').select('source_asset_id').in('source_asset_id', c);
      (data || []).forEach((r: any) => existingSourceIds.add(String(r.source_asset_id)));
    }

    let inserted = 0;
    let updated = 0;
    for (const rows of chunk(withId, CHUNK_SIZE)) {
      const { data, error } = await adminClient.from('asset_inventory').upsert(rows.map((m) => m.row), { onConflict: 'source_asset_id' }).select('id, source_asset_id');
      if (error) throw new Error(`Upsert failed: ${error.message}`);
      const idBySrc = new Map((data || []).map((r: any) => [String(r.source_asset_id), r.id]));
      rows.forEach((m) => {
        const src = String(m.row.source_asset_id);
        m.assetId = idBySrc.get(src);
        if (existingSourceIds.has(src)) updated++; else inserted++;
      });
    }

    // Fallback matching for rows with no source_asset_id: by (name, venue), same as before.
    if (withoutId.length) {
      const names = [...new Set(withoutId.filter((m) => m.row.name && m.row.venue).map((m) => m.row.name as string))];
      const idByNameVenue = new Map<string, string>();
      for (const c of chunk(names, 200)) {
        if (!c.length) continue;
        const { data } = await adminClient.from('asset_inventory').select('id, name, venue').in('name', c);
        (data || []).forEach((r: any) => idByNameVenue.set(`${r.name}|${r.venue}`, r.id));
      }
      const toInsert = withoutId.filter((m) => !idByNameVenue.has(`${m.row.name}|${m.row.venue}`));
      const toUpdate = withoutId.filter((m) => idByNameVenue.has(`${m.row.name}|${m.row.venue}`));
      toUpdate.forEach((m) => { m.assetId = idByNameVenue.get(`${m.row.name}|${m.row.venue}`); });
      for (const rows of chunk(toInsert, CHUNK_SIZE)) {
        const { data, error } = await adminClient.from('asset_inventory').insert(rows.map((m) => m.row)).select('id');
        if (error) throw new Error(`Insert failed: ${error.message}`);
        // A single multi-row INSERT...RETURNING preserves input order in Postgres - relied on here
        // since these rows have no source_asset_id to re-match against unambiguously afterward.
        (data || []).forEach((r: any, i: number) => { if (rows[i]) rows[i].assetId = r.id; });
        inserted += rows.length;
      }
      for (const rows of chunk(toUpdate, CHUNK_SIZE)) {
        const { error } = await adminClient.from('asset_inventory').upsert(rows.map((m) => ({ ...m.row, id: m.assetId })), { onConflict: 'id' });
        if (error) throw new Error(`Update failed: ${error.message}`);
        updated += rows.length;
      }
    }

    // --- Link networks (many-to-many) for every row that resolved at least one network name ---
    let networksLinked = 0;
    const withNetworks = mapped.filter((m) => m.assetId && m.networkNames.length);
    if (withNetworks.length) {
      const allNames = [...new Set(withNetworks.flatMap((m) => m.networkNames))];
      const { data: existingNetworks, error: netErr } = await adminClient.from('networks').select('id, name').is('deleted_at', null);
      if (netErr) throw new Error(`Reading networks failed: ${netErr.message}`);
      const networkIdByName = new Map<string, string>();
      (existingNetworks || []).forEach((n: any) => networkIdByName.set(String(n.name).toLowerCase(), n.id));
      const toCreate = allNames.filter((n) => !networkIdByName.has(n.toLowerCase()));
      if (toCreate.length) {
        const { data: created, error } = await adminClient.from('networks').insert(toCreate.map((name) => ({ name }))).select('id, name');
        if (error) throw new Error(`Creating network(s) failed: ${error.message}`);
        (created || []).forEach((n: any) => networkIdByName.set(String(n.name).toLowerCase(), n.id));
      }
      const links: { asset_inventory_id: string; network_id: string }[] = [];
      withNetworks.forEach((m) => {
        m.networkNames.forEach((name) => {
          const networkId = networkIdByName.get(name.toLowerCase());
          if (networkId) links.push({ asset_inventory_id: m.assetId as string, network_id: networkId });
        });
      });
      for (const rows of chunk(links, CHUNK_SIZE)) {
        const { error } = await adminClient.from('asset_inventory_networks').upsert(rows, { onConflict: 'asset_inventory_id,network_id', ignoreDuplicates: true });
        if (error) throw new Error(`Linking network(s) failed: ${error.message}`);
      }
      networksLinked = links.length;
    }

    const nowIso = new Date().toISOString();
    const summary = `Synced ${mapped.length} row(s): ${inserted} new, ${updated} updated${networksLinked ? `, ${networksLinked} network link(s)` : ''}.`;
    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '' },
      updated_at: nowIso,
    }).eq('key', 'assetInventoryApi');

    return new Response(JSON.stringify({ summary, inserted, updated, networksLinked, total: mapped.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      const adminClient = createClient(supabaseUrl, serviceRoleKey);
      const { data: row } = await adminClient.from('app_settings').select('value').eq('key', 'assetInventoryApi').single();
      if (row) {
        await adminClient.from('app_settings').update({ value: { ...row.value, lastError: message } }).eq('key', 'assetInventoryApi');
      }
    } catch (_) { /* best-effort error record */ }
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
