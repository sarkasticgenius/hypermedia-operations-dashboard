// Shared aggregation math for Locations / Live Ops Overview / the Broadsign &
// Grassfish console panels. The original app recomputed chain/combined-member
// resolution independently in ~4 places; here it's centralized.

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
      offlineItems.push({ location: l.name, name: sa.name, detail: sa.notes || '' });
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

// Same "straight from Asset Inventory" approach as inventoryFaceTotals(), scoped to rows linked to
// any network whose name contains "MAF" (Majid Al Futtaim malls) - same convention the Asset
// Inventory page's "MAF Malls only" filter already uses.
export function mafInventoryTotals(assetInventory) {
  let screens = 0;
  let faces = 0;
  for (const r of assetInventory) {
    if (!(r.networkNames || []).some((n) => n.toUpperCase().includes('MAF'))) continue;
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
