// Shared aggregation math for Locations / Live Ops Overview / the Broadsign &
// Grassfish console panels. The original app recomputed chain/combined-member
// resolution independently in ~4 places; here it's centralized.
import { fmtRelativeTime } from '../lib/format.js';

// Metro Rail station/bridge locations (each named "Metro Station - <stop>" or "Metro Bridge -
// <bridge>") are individually meaningless as brand-lookup names - Brandfetch's search has nothing
// to match "Metro Station - Energy" against, so every one of them burns a lookup that always
// fails. They're all the same real-world brand (Dubai Metro, run by RTA), so route every one to a
// single shared lookup name instead - one cached result covers the whole network.
const METRO_RAIL_CHAINS = new Set(['Red Line', 'Green Line', 'Metro Bridges', 'Expo Line']);

// Uppercases + normalizes spelling/separator quirks seen in the real API data (US "CENTER" vs UK
// "CENTRE", hyphens vs spaces) so keyword/prefix matches don't need a variant per quirk. Shared by
// canonicalChainBrandName below and by Traffic Sheet's own venue-grouping logic (trafficSheet.js),
// which is why this lives here rather than in that file - Locations needed the exact same text
// normalization and importing it the other way around (trafficSheet.js -> here) would have been
// backwards, since trafficSheet.js already imports MAF_MALL_VENUE_KEYWORDS from this file.
export function normalizeVenueText(s) {
  return (s || '').toUpperCase().replace(/CENTER/g, 'CENTRE').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Multi-branch retail chains where the individual branch name (e.g. "Union Coop AL BARSHA") has no
// logo of its own cached - only the chain's own name does - so every branch needs to resolve to
// that ONE canonical name for the brand-logo lookup to ever succeed. Originally only applied to
// Traffic Sheet's venue names; Locations never got the same treatment, which is exactly why a chain
// branch's logo could show correctly on Traffic Sheet while showing bare initials on Locations for
// the identical real-world store.
const LOGO_CHAIN_PREFIXES = ['LULU', 'UNION COOP', 'ADCOOP', 'ENOC', 'CARREFOUR', 'NAKHEEL PAVILION'];
const LOGO_CHAIN_NAMES = { LULU: 'LULU', 'UNION COOP': 'Union Coop', ADCOOP: 'ADCOOP', ENOC: 'ENOC', CARREFOUR: 'Carrefour', 'NAKHEEL PAVILION': 'Nakheel Pavilion' };

// Returns the canonical chain brand name if `name` belongs to one of the chains above, or null if
// it doesn't (a plain mall/venue name that should just be looked up as-is by the caller).
export function canonicalChainBrandName(name) {
  const normalized = normalizeVenueText(name);
  for (const prefix of LOGO_CHAIN_PREFIXES) {
    if (normalized.startsWith(prefix)) return LOGO_CHAIN_NAMES[prefix];
  }
  // Majid Al Futtaim malls are entered in Locations with a "MAF-"/"MAF- " prefix (a grouping/
  // labeling convenience) that a Brandfetch lookup was never actually run against - only the plain
  // mall name (e.g. "Ajman City Centre") is cached with a real logo; the "MAF-..." variant is
  // cached as a confirmed FAILED search. Stripping the prefix here reuses the already-good cache
  // entry instead of needing a fresh Brandfetch search for every MAF property.
  const mafStripped = normalized.replace(/^MAF\s+/, '');
  if (mafStripped !== normalized) {
    // The one MAF entry that isn't just a stray prefix - "Mall of Emirates" (missing "the") is
    // cached under "Mall of the Emirates" specifically.
    return mafStripped === 'MALL OF EMIRATES' ? 'Mall of the Emirates' : mafStripped;
  }
  return null;
}

export function brandNameForLocation(loc) {
  if (loc.chain && METRO_RAIL_CHAINS.has(loc.chain)) return 'Dubai Metro Rail';
  return canonicalChainBrandName(loc.name) || loc.name;
}

export function resolveMembers(loc, allLocations) {
  if (loc.combined_members && loc.combined_members.length) {
    const ids = new Set(loc.combined_members);
    return allLocations.filter((l) => ids.has(l.id));
  }
  if (loc.chain) {
    return allLocations.filter((l) => l.chain === loc.chain && !l.is_combined);
  }
  return [];
}

// Locations that are folded into a combined/chain wrapper tile and should be
// hidden from the top-level venue grid/list/heatmap (still reachable via the
// wrapper's "View Members").
export function hiddenMemberIds(allLocations) {
  const hidden = new Set();
  for (const loc of allLocations) {
    if (loc.is_combined) {
      for (const m of resolveMembers(loc, allLocations)) hidden.add(m.id);
    }
  }
  return hidden;
}

function effectiveLocations(loc, allLocations) {
  if (loc.is_combined) {
    const members = resolveMembers(loc, allLocations);
    return members.length ? members : [loc];
  }
  return [loc];
}

// Offline/online tally including Broadsign/Grassfish health-count padding on
// the total (matches the original's locationOfflineStats - used for the
// Network Health donut, not the per-page heatmap).
export function locationOfflineStats(loc, allLocations) {
  let offline = 0;
  let total = 0;
  for (const l of effectiveLocations(loc, allLocations)) {
    for (const sa of l.location_sub_assets || []) {
      total++;
      if (sa.status === 'Offline') offline++;
    }
    // Both networks' online counts pad the total - this used to only add broadsign_healthy_count,
    // so every Grassfish-online screen was silently missing from Network Health entirely.
    if (l.broadsign_healthy_count) total += l.broadsign_healthy_count;
    if (l.grassfish_healthy_count) total += l.grassfish_healthy_count;
  }
  return { offline, total };
}

// Same shape, but excludes Broadsign/Grassfish-sourced sub-assets - this is
// what the Locations page heatmap and card badges use (network-panel health
// is a separate concern, shown on the dedicated Broadsign/Grassfish pages).
export function locationManualStats(loc, allLocations) {
  let offline = 0;
  let total = 0;
  const offlineItems = [];
  for (const l of effectiveLocations(loc, allLocations)) {
    const subs = (l.location_sub_assets || []).filter((sa) => sa.source !== 'broadsign' && sa.source !== 'grassfish');
    for (const sa of subs) {
      total++;
      if (sa.status === 'Offline') {
        offline++;
        offlineItems.push({ location: l.name, name: sa.name, detail: sa.notes || '' });
      }
    }
  }
  return { offline, total, offlineItems };
}

// Same shape, filtered to one source only ('broadsign' | 'grassfish') - used
// by the dedicated network console panels. Also tallies offlineFaces (sum of each offline row's
// faces, defaulting to 1 for historical rows synced before that column existed) so callers can
// show a faces-based count alongside the plain screen count without a second pass.
export function sourceStats(loc, allLocations, source, healthyField) {
  let offline = 0;
  let total = 0;
  let offlineFaces = 0;
  const offlineItems = [];
  for (const l of effectiveLocations(loc, allLocations)) {
    const subs = (l.location_sub_assets || []).filter((sa) => sa.source === source);
    for (const sa of subs) {
      total++;
      offline++;
      offlineFaces += sa.faces || 1;
      // status_label ('Missing in Action' | 'Offline') and poll_last_utc are set at sync time;
      // the relative-time portion is always computed fresh here at render time, never stored, so
      // it stays accurate no matter how long ago the sync actually ran. Falls back to `notes` for
      // rows synced before these columns existed.
      const label = sa.status_label || (source === 'broadsign' || source === 'grassfish' ? 'Offline' : null);
      const pollText = sa.poll_last_utc ? `Last poll: ${fmtRelativeTime(sa.poll_last_utc)}` : '';
      const detail = [label, pollText].filter(Boolean).join(' - ') || sa.notes || '';
      // broadsign-sync/grassfish-sync/iot-sync all stamp the vendor's own id into notes as
      // "Broadsign ID: <id>" / "Grassfish Box ID: <id>" / "IoT Device ID: <id>" - parsed back out
      // here (rather than a dedicated column) so the console pages can cross-reference this screen
      // against a Digital Directory device reporting the same id, without a schema change.
      const boxIdMatch = /(?:Broadsign ID|Grassfish Box ID|IoT Device ID):\s*(.+)$/.exec(sa.notes || '');
      const boxId = boxIdMatch ? boxIdMatch[1].trim() : null;
      offlineItems.push({ location: l.name, name: sa.name, detail, statusLabel: label, pollLastUtc: sa.poll_last_utc, boxId });
    }
    if (l[healthyField]) total += l[healthyField];
  }
  return { offline, total, offlineFaces, offlineItems };
}

// Offline-ratio thresholds, ported exactly from the original's heatmapColor().
export function heatmapColor(stats) {
  if (stats.total === 0) return '#f4f3f0';
  if (stats.offline === 0) return '#1f9d55';
  const ratio = stats.offline / stats.total;
  if (ratio <= 0.25) return '#e0a13a';
  if (ratio <= 0.5) return '#e07a2c';
  return '#c0392b';
}

// Linear RGB interpolation (light blue -> dark blue) scaled to the busiest
// venue on screen, ported exactly from the original's screenDensityColor().
export function screenDensityColor(count, maxCount) {
  if (!count) return '#f4f3f0';
  const ratio = Math.min(1, count / Math.max(1, maxCount));
  const start = [190, 222, 247];
  const end = [21, 67, 122];
  const rgb = start.map((s, i) => Math.round(s + (end[i] - s) * ratio));
  return `rgb(${rgb.join(',')})`;
}

export function assetInventoryForLocation(locName, assetInventory) {
  const key = (locName || '').toLowerCase();
  return assetInventory.filter((r) => (r.venue || '').toLowerCase() === key);
}

// Total screens/faces straight from Asset Inventory - deliberately NOT filtered to locations with
// live sync data (unlike sourceStats/locationOfflineStats, which only count what a Broadsign/
// Grassfish sync has matched to a Location by venue name). This counts every physical screen the
// business tracks, online or offline, matched-to-a-location or not - "faces" and "screens" both
// default to 1 per row when unset, so a row always counts as at least one of each. Also breaks out
// the Broadsign+Grassfish subtotal specifically, since those are the two networked sources callers
// want combined into one number rather than reported separately.
export function inventoryFaceTotals(assetInventory) {
  let totalScreens = 0;
  let totalFaces = 0;
  let networkedScreens = 0;
  let networkedFaces = 0;
  for (const r of assetInventory) {
    const screens = r.screens || 1;
    const faces = r.faces || 1;
    totalScreens += screens;
    totalFaces += faces;
    if (r.player_type === 'Broadsign' || r.player_type === 'Grassfish') {
      networkedScreens += screens;
      networkedFaces += faces;
    }
  }
  return { totalScreens, totalFaces, networkedScreens, networkedFaces };
}

// Majid Al Futtaim mall venue names that don't carry "MAF" anywhere in their own asset_inventory
// venue text or a linked network - the "MAF" only exists on the corresponding Locations row (e.g.
// "MAF-FUJAIRAH CITY CENTER"), which asset_inventory.venue doesn't match verbatim. Confirmed
// against real data: every one of these has networkNames === [] and a venue string with no "MAF"
// substring, so network-name matching alone silently excludes all of them. Substring match (not
// exact) so "-3D"/"-FACADE"/etc suffix variants of the same mall still count.
// Spelled "CENTRE" (UK) to match the real venue text in Asset Inventory, not "CENTER" (US) - the
// keyword list here previously used US spelling and silently matched nothing, since every one of
// these malls' real venue strings use UK spelling. Also previously missing Deira/Ajman/Me'aisem
// entirely (Deira/Ajman happen to also carry a "Retail MAF" network link so they were still
// counted via the network-name path; Me'aisem had neither and was fully uncounted).
// Exported for reuse by the Traffic Sheet page, which needs the same MAF-mall venue-name match
// against the external Traffic Sheet API's venue names (a different data source than
// asset_inventory, so it can't reuse isMafRow() directly - just the keyword list).
export const MAF_MALL_VENUE_KEYWORDS = [
  'MIRDIF CITY CENTRE', 'ZAHIA CITY CENTRE', 'SHINDAGHA CITY CENTRE', 'SHINDAGAH CITY CENTRE',
  'SHARJAH CITY CENTRE', 'FUJAIRAH CITY CENTRE', 'DEIRA CITY CENTRE', 'AJMAN CITY CENTRE',
  "ME'AISEM CITY CENTRE", 'MALL OF THE EMIRATES',
];

// True if a row belongs to a Majid Al Futtaim mall, whether that's discoverable from its linked
// network name (the original convention) or only from its venue text (the gap above). The venue-
// text fallback is scoped to category === 'Malls' specifically - "Mall of the Emirates" is also a
// Metro-station venue name (category 'Metro', unrelated screens sharing the landmark's name), and
// category is the only thing that reliably tells those apart.
export function isMafRow(r) {
  if ((r.networkNames || []).some((n) => n.toUpperCase().includes('MAF'))) return true;
  if (r.category !== 'Malls') return false;
  const venue = (r.venue || '').toUpperCase();
  return MAF_MALL_VENUE_KEYWORDS.some((k) => venue.includes(k));
}

// Same "straight from Asset Inventory" approach as inventoryFaceTotals(), scoped to MAF mall rows.
export function mafInventoryTotals(assetInventory) {
  let screens = 0;
  let faces = 0;
  for (const r of assetInventory) {
    if (!isMafRow(r)) continue;
    screens += r.screens || 1;
    faces += r.faces || 1;
  }
  return { screens, faces };
}

export function locationScreenCount(loc, allLocations, assetInventory) {
  let count = 0;
  for (const l of effectiveLocations(loc, allLocations)) {
    const byVenue = assetInventoryForLocation(l.name, assetInventory);
    const byManualLink = assetInventory.filter((r) => (l.manual_asset_inventory_ids || []).includes(r.id));
    const ids = new Set([...byVenue.map((r) => r.id), ...byManualLink.map((r) => r.id)]);
    count += ids.size;
  }
  return count;
}

// Same venue-match + manual-link + chain/combined-member resolution as locationScreenCount(),
// but returns the actual rows instead of just a count - for anywhere that needs to let someone
// pick a specific screen at a location (e.g. the ticket modal). Asset Inventory venue text often
// doesn't match a Location's name exactly (naming drift between the two), which is exactly what
// manual_asset_inventory_ids exists to bridge - a caller that only checks venue text (as the
// ticket modal used to) silently shows zero screens for every location that relies on a manual
// link, even when that link is already correctly set up (confirmed live: "ABU DHABI Coop" has 21
// manually-linked screens that never appeared in the ticket screen dropdown).
export function assetInventoryForLocationFull(loc, allLocations, assetInventory) {
  const seen = new Set();
  const rows = [];
  for (const l of effectiveLocations(loc, allLocations)) {
    const byVenue = assetInventoryForLocation(l.name, assetInventory);
    const byManualLink = assetInventory.filter((r) => (l.manual_asset_inventory_ids || []).includes(r.id));
    for (const r of [...byVenue, ...byManualLink]) {
      if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
    }
  }
  return rows;
}

// Asset Inventory is the source of truth for a screen's identity - its own Name, not the venue
// text (which is really just the Location match key, not the screen's name). Sequence is Name,
// then Format (Width x Height), then Location - falling back to venue when Location is blank so
// there's still some "where" context. Shared by the Ticket, SIM Card, and Hardware Asset deploy
// modals, all of which let someone pick a specific screen at a selected Location.
export function screenLabel(s) {
  const dims = s.width && s.height ? `${s.width}x${s.height}` : '';
  const format = [s.format, dims ? `(${dims})` : ''].filter(Boolean).join(' ');
  const where = s.location || s.venue || '';
  return [s.name, format, where].filter(Boolean).join(' - ');
}

const EMIRATES_KEYWORDS = {
  'Abu Dhabi': ['abu dhabi', 'auh', 'yas island', 'saadiyat', 'khalifa city', 'mussafah', 'musaffah', 'corniche'],
  Dubai: ['dubai', 'dxb', 'deira', 'jumeirah', 'marina', 'jbr', 'downtown', 'business bay'],
  Sharjah: ['sharjah', 'shj'],
  Ajman: ['ajman'],
  Fujairah: ['fujairah'],
  'Ras Al Khaimah': ['ras al khaimah', 'rak'],
  'Umm Al Quwain': ['umm al quwain', 'uaq'],
};
export const EMIRATES_ORDER = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Fujairah', 'Ras Al Khaimah', 'Umm Al Quwain', 'Unspecified'];

export function guessEmirate(loc) {
  if (loc.emirate) return loc.emirate;
  const text = `${loc.name} ${loc.address || ''}`.toLowerCase();
  for (const [emirate, keywords] of Object.entries(EMIRATES_KEYWORDS)) {
    if (keywords.some((k) => text.includes(k))) return emirate;
  }
  return 'Unspecified';
}

// Sorts by app_settings.venueTileOrder (array of ids); anything not in that
// array keeps its relative order and sorts after the explicitly-ordered items.
export function sortByTileOrder(list, order) {
  const orderIndex = new Map((order || []).map((id, i) => [id, i]));
  return [...list].sort((a, b) => {
    const ai = orderIndex.has(a.id) ? orderIndex.get(a.id) : Infinity;
    const bi = orderIndex.has(b.id) ? orderIndex.get(b.id) : Infinity;
    return ai - bi;
  });
}
