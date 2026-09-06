// Slack Events API receiver for the interactive "ask the dashboard a question" bot. Unlike
// slack-notify (a one-way Incoming Webhook - can only push, never receive), this is a real Slack
// App with a bot user: Slack calls THIS endpoint whenever a message lands in a channel the bot has
// been invited to, and a reply (if any) is posted back via a SEPARATE chat.postMessage call using
// the bot token - the HTTP response to Slack's own event delivery is just an ack, never the answer
// itself. See the "Slack Bot Q&A" card in Settings (src/pages/settings.js) for where the Bot Token/
// Signing Secret are entered - deliberately typed there by the admin's own browser, never through
// this codebase or this conversation, since a bot token is a bearer credential no different from
// the Incoming Webhook URL slack-notify already treats as one.
//
// Config lives in app_settings under key 'slackBotQa' ({ botToken, signingSecret, enabled }) - same
// arbitrary-key-in-a-jsonb-column pattern every other integration here already uses (see
// src/data/settings.js's saveSetting/getAllSettings), not a Supabase Edge Function secret via
// Deno.env.get - this app has no existing precedent for that, and the app_settings route is what
// the Settings page's generic integrationField()/saveIntegrationForm() already wire up for free.
//
// The place/category/counting logic below is a deliberate duplicate of src/data/locationStats.js
// (effectiveLocations, sourceStats, guessEmirate/EMIRATES_KEYWORDS) rather than a shared import -
// same reasoning as buildLabelFor in workspace-directory-alert-scan and
// STATUS_SUMMARY_STALE_MINUTES in settings.js: this runs in a completely separate Deno deployment
// that cannot import browser-bundle source, so a small duplicated function costs nothing. If those
// functions' rules ever change, this needs the same edit made twice.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-slack-signature, x-slack-request-timestamp, x-slack-retry-num',
};

// Slack's own replay-protection window - a signature is only meaningful if the timestamp it was
// computed over is recent, otherwise a captured request could be replayed indefinitely.
const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time-ish compare - not performance critical here (short hex strings, low request
// volume), but there's no reason to give a timing oracle away for free when a simple loop avoids it.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySlackSignature(rawBody: string, timestamp: string, signature: string, signingSecret: string): Promise<boolean> {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_TIMESTAMP_SKEW_SECONDS) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`));
  return safeEqual(`v0=${toHex(mac)}`, signature);
}

// ---------------------------------------------------------------------------------------------
// Fixed-intent parsing - see the plan's own reasoning: a small set of reliable patterns rather
// than open-ended LLM parsing, so a phrasing outside this set stays silent instead of guessing.
// ---------------------------------------------------------------------------------------------
type Status = 'offline' | 'online' | null;

function parseQuestion(rawText: string): { status: Status; place: string | null } | null {
  // Strips a leading bot-mention token ("<@U123ABC> how many...") - Slack renders a mention as this
  // literal token regardless of where in the channel history the message came from.
  const text = rawText.replace(/^<@[A-Z0-9]+>\s*/i, '').trim();
  if (!/\bscreens?\b/i.test(text)) return null;
  if (!/\bhow many\b|\bcount\b|\bnumber of\b/i.test(text)) return null;

  const status: Status = /\boffline\b/i.test(text) ? 'offline' : /\bonline\b/i.test(text) ? 'online' : null;
  const placeMatch = text.match(/\b(?:in|at|for)\s+(.+?)\s*\??$/i);
  const place = placeMatch ? placeMatch[1].replace(/^the\s+/i, '').trim() : null;
  return { status, place: place || null };
}

// ---------------------------------------------------------------------------------------------
// Place resolution - venue name, then category alias, then chain, then emirate, then whole fleet.
// ---------------------------------------------------------------------------------------------
const CATEGORY_ALIASES: Record<string, string> = {
  mall: 'Malls', malls: 'Malls',
  enoc: 'Petrol Stations', 'petrol station': 'Petrol Stations', 'petrol stations': 'Petrol Stations', 'gas station': 'Petrol Stations', 'gas stations': 'Petrol Stations',
  outdoor: 'Outdoor',
  instore: 'In-Store', 'in-store': 'In-Store', 'in store': 'In-Store',
};

// "Metro" is its own special case, checked BEFORE the generic category-alias path above: asset_
// inventory's Metro-category rows carry bare station names ("Financial Centre", "Business Bay"),
// while the matching `locations` rows are named "Metro Station - Financial Centre" / "Metro Bridge
// - Business Bay" - a real, pre-existing naming-drift gap (same one manual_asset_inventory_ids
// exists elsewhere in this app to paper over, see locationStats.js's assetInventoryForLocationFull
// comment) that makes the venue-text match below silently resolve to ZERO metro locations.
// `chain` doesn't have that problem: every metro station/bridge location is tagged with one of
// these four values (confirmed live: `select distinct chain from locations` returns exactly these
// plus 'Nakheel Pavilions'), same set as METRO_RAIL_CHAINS in locationStats.js:11.
const METRO_RAIL_CHAINS = new Set(['Red Line', 'Green Line', 'Metro Bridges', 'Expo Line']);
const METRO_KEYWORDS = new Set(['metro', 'dubai metro', 'the metro']);

// Duplicate of EMIRATES_KEYWORDS/guessEmirate (src/data/locationStats.js:381-399).
const EMIRATES_KEYWORDS: Record<string, string[]> = {
  'Abu Dhabi': ['abu dhabi', 'auh', 'yas island', 'saadiyat', 'khalifa city', 'mussafah', 'musaffah', 'corniche'],
  Dubai: ['dubai', 'dxb', 'deira', 'jumeirah', 'marina', 'jbr', 'downtown', 'business bay'],
  Sharjah: ['sharjah', 'shj'],
  Ajman: ['ajman'],
  Fujairah: ['fujairah'],
  'Ras Al Khaimah': ['ras al khaimah', 'rak'],
  'Umm Al Quwain': ['umm al quwain', 'uaq'],
};

type LocationRow = {
  id: string; name: string; chain: string | null; emirate: string | null; address: string | null;
  is_combined: boolean; combined_members: string[] | null;
  broadsign_healthy_count: number | null; grassfish_healthy_count: number | null;
  manual_asset_inventory_ids: string[] | null;
};

function guessEmirateFor(loc: LocationRow): string {
  if (loc.emirate) return loc.emirate;
  const text = `${loc.name} ${loc.address || ''}`.toLowerCase();
  for (const [emirate, keywords] of Object.entries(EMIRATES_KEYWORDS)) {
    if (keywords.some((k) => text.includes(k))) return emirate;
  }
  return 'Unspecified';
}

// Resolves a free-text "place" phrase to the set of `locations` rows it refers to, and a label to
// name it by in the reply. Returns null if the phrase matched nothing at all.
async function resolvePlace(
  adminClient: any, place: string | null,
): Promise<{ label: string; locations: LocationRow[] } | null> {
  const cols = 'id, name, chain, emirate, address, is_combined, combined_members, broadsign_healthy_count, grassfish_healthy_count, manual_asset_inventory_ids';
  if (!place) {
    const { data } = await adminClient.from('locations').select(cols).is('deleted_at', null);
    return { label: 'the whole fleet', locations: (data || []) as LocationRow[] };
  }
  const normalized = place.toLowerCase().trim();

  // 1) Venue name substring.
  const { data: byName } = await adminClient.from('locations').select(cols).is('deleted_at', null).ilike('name', `%${place}%`);
  if ((byName || []).length) {
    const label = byName.length === 1 ? byName[0].name : `${byName.length} locations matching "${place}"`;
    return { label, locations: byName as LocationRow[] };
  }

  // 2) Metro special case - see METRO_RAIL_CHAINS' own comment for why this can't go through the
  // generic category-alias path below.
  if (METRO_KEYWORDS.has(normalized)) {
    const { data: allLocs } = await adminClient.from('locations').select(cols).is('deleted_at', null);
    const matched = ((allLocs || []) as LocationRow[]).filter((l) => l.chain && METRO_RAIL_CHAINS.has(l.chain));
    if (matched.length) return { label: 'Dubai Metro', locations: matched };
  }

  // 3) Category alias, via asset_inventory.venue -> locations.name (same lowercase match
  // assetInventoryForLocation uses, locationStats.js:263-266) PLUS the manual_asset_inventory_ids
  // link locations.js's own screen pickers already fall back to for exactly this naming-drift
  // reason (assetInventoryForLocationFull, locationStats.js:356-367) - venue text alone matched
  // only 16 of the ~50+ real Malls-category locations in this fleet (confirmed live), the manual
  // link recovers the rest of what's actually configured.
  const category = CATEGORY_ALIASES[normalized];
  if (category) {
    const { data: invRows } = await adminClient.from('asset_inventory').select('id, venue').eq('category', category);
    const rows = (invRows || []) as any[];
    const venues = new Set(rows.map((r) => (r.venue || '').trim().toLowerCase()).filter(Boolean));
    const invIds = new Set(rows.map((r) => r.id));
    const { data: allLocs } = await adminClient.from('locations').select(cols).is('deleted_at', null);
    const matched = ((allLocs || []) as LocationRow[]).filter((l) =>
      venues.has((l.name || '').trim().toLowerCase()) || (l.manual_asset_inventory_ids || []).some((id) => invIds.has(id)));
    if (matched.length) return { label: category, locations: matched };
  }

  // 4) Chain substring.
  const { data: byChain } = await adminClient.from('locations').select(cols).is('deleted_at', null).ilike('chain', `%${place}%`);
  if ((byChain || []).length) return { label: byChain[0].chain || place, locations: byChain as LocationRow[] };

  // 5) Emirate keyword.
  const emirateHit = Object.keys(EMIRATES_KEYWORDS).find((e) => e.toLowerCase() === normalized || EMIRATES_KEYWORDS[e].some((k) => normalized.includes(k)));
  if (emirateHit) {
    const { data: allLocs } = await adminClient.from('locations').select(cols).is('deleted_at', null);
    const matched = ((allLocs || []) as LocationRow[]).filter((l) => guessEmirateFor(l) === emirateHit);
    if (matched.length) return { label: emirateHit, locations: matched };
  }

  return null;
}

// Duplicate of resolveMembers/effectiveLocations (locationStats.js:74-104).
function effectiveLocations(loc: LocationRow, allById: Map<string, LocationRow>, allByChain: Map<string, LocationRow[]>): LocationRow[] {
  if (loc.is_combined) {
    const members = (loc.combined_members || []).map((id) => allById.get(id)).filter(Boolean) as LocationRow[];
    const chainMembers = loc.chain ? (allByChain.get(loc.chain) || []).filter((l) => !l.is_combined) : [];
    const resolved = members.length ? members : chainMembers;
    return resolved.length ? resolved : [loc];
  }
  return [loc];
}

const BOX_ID_PATTERN = /(?:Broadsign ID|Grassfish Box ID|IoT Device ID):\s*(.+)$/;

// Duplicate of sourceStats' dedup logic (locationStats.js:171-211), combined across BOTH
// broadsign+grassfish sources - a Slack question about "screens" doesn't care which vendor drives
// them, unlike the dedicated network console panels this logic originally serves.
async function countScreens(adminClient: any, locations: LocationRow[]): Promise<{ offline: number; total: number }> {
  if (!locations.length) return { offline: 0, total: 0 };
  const byId = new Map(locations.map((l) => [l.id, l]));
  const byChain = new Map<string, LocationRow[]>();
  for (const l of locations) { if (l.chain) { const arr = byChain.get(l.chain) || []; arr.push(l); byChain.set(l.chain, arr); } }

  const expandedIds = new Set<string>();
  for (const loc of locations) for (const l of effectiveLocations(loc, byId, byChain)) expandedIds.add(l.id);

  const { data: subAssets } = await adminClient.from('location_sub_assets')
    .select('location_id, status, notes, source').in('location_id', [...expandedIds]).in('source', ['broadsign', 'grassfish']);

  let offline = 0;
  let total = 0;
  const seenBoxIds = new Set<string>();
  for (const sa of (subAssets || []) as any[]) {
    const boxIdMatch = BOX_ID_PATTERN.exec(sa.notes || '');
    const boxId = boxIdMatch ? boxIdMatch[1].trim() : null;
    if (boxId && seenBoxIds.has(boxId)) continue;
    if (boxId) seenBoxIds.add(boxId);
    total++;
    if (sa.status === 'Offline') offline++;
  }
  // Pads the total with each location's own healthy-count columns, same as locationOfflineStats.
  for (const l of locations) {
    if (l.broadsign_healthy_count) total += l.broadsign_healthy_count;
    if (l.grassfish_healthy_count) total += l.grassfish_healthy_count;
  }
  return { offline, total };
}

function formatReply(label: string, status: Status, counts: { offline: number; total: number }): string {
  const { offline, total } = counts;
  if (!total) return `*${label}*: no networked screens found.`;
  if (status === 'offline') return `${offline ? ':red_circle:' : ':large_green_circle:'} *${label}*: ${offline} of ${total} screens offline.`;
  if (status === 'online') return `:large_green_circle: *${label}*: ${total - offline} of ${total} screens online.`;
  return `*${label}*: ${total} screens${offline ? `, ${offline} offline` : ', all online'}.`;
}

async function postSlackReply(botToken: string, channel: string, threadTs: string, text: string): Promise<void> {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${botToken}` },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const rawBody = await req.text();
  let payload: any;
  try { payload = JSON.parse(rawBody); } catch { return new Response('ok', { headers: corsHeaders, status: 200 }); }

  // Slack's one-time handshake when the Request URL is first saved in Event Subscriptions - must
  // work with no config loaded yet, since this fires before app_settings.slackBotQa necessarily
  // has real values in it.
  if (payload.type === 'url_verification') {
    return new Response(JSON.stringify({ challenge: payload.challenge }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'slackBotQa').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.botToken || !cfg.signingSecret) {
      return new Response(JSON.stringify({ ok: true, skipped: 'not configured' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    const signature = req.headers.get('x-slack-signature') || '';
    const timestamp = req.headers.get('x-slack-request-timestamp') || '';
    if (!(await verifySlackSignature(rawBody, timestamp, signature, cfg.signingSecret))) {
      // Never let Slack retry an auth failure - a bad signature stays bad on retry too.
      return new Response(JSON.stringify({ ok: true, skipped: 'bad signature' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    // A retried delivery (Slack didn't get a fast-enough ack, or the first attempt errored) - skip
    // reprocessing rather than risk posting the same answer twice.
    if (req.headers.get('x-slack-retry-num')) {
      return new Response(JSON.stringify({ ok: true, skipped: 'retry' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    const event = payload.event || {};
    if (event.type !== 'message' || event.subtype || event.bot_id || !event.text) {
      return new Response(JSON.stringify({ ok: true, skipped: 'not a plain user message' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    const parsed = parseQuestion(event.text);
    if (!parsed) {
      // Reads as noise otherwise - this bot sees every message in the channel (not mention-only),
      // so anything that doesn't clearly look like a recognized question stays silent rather than
      // replying "I don't understand" to ordinary chat.
      return new Response(JSON.stringify({ ok: true, skipped: 'no match' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    const resolved = await resolvePlace(adminClient, parsed.place);
    const text = resolved
      ? formatReply(resolved.label, parsed.status, await countScreens(adminClient, resolved.locations))
      : `Couldn't find a venue matching "${parsed.place}".`;

    await postSlackReply(cfg.botToken, event.channel, event.ts, text);
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Still 200 - a 4xx/5xx here makes Slack retry, and a bug in our own handling won't fix itself
    // on retry any more than a bad signature would.
    return new Response(JSON.stringify({ ok: false, error: message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
  }
});
