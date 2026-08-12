// Shared venue-category classifier for aiootech-platform site/venue strings - used by both the
// IoT Panel (device storeName, from iot-sync) and Reporting's Traffic Data tab (campaign site,
// from the AiOO Reporting API). Both ride on the same aiootech platform (apim-eu-1.aiootech.com /
// ads.aiootech.com), unlike the separate AdLive Center Traffic Sheet integration, so they share one
// naming convention rather than each needing their own guesswork.
//
// Confirmed against real iot-sync device data (2026-08): storeName consistently follows a
// "Category - Venue Name" prefix convention - "Metro - Business Bay", "Malls - Dragon Mart-1",
// "In-Store - Union Coop UMM SUQEIM", "Outdoor - EXPOCITY". A handful of rows have no recognized
// prefix at all (demo/test/internal entries like "Hypermedia", "Demo Kit Store", "Test (Retail
// media store)", "MODON", "Azerion GoldBach Austria") - those fall into 'Other', which doubles as
// the orphaned/stray-asset bucket on the IoT Panel.
export const SITE_CATEGORIES = ['Metro', 'Malls', 'In-Store', 'Outdoor', 'Other'];

const PREFIX_MAP = {
  METRO: 'Metro',
  MALLS: 'Malls',
  MALL: 'Malls',
  'IN-STORE': 'In-Store',
  'IN STORE': 'In-Store',
  INSTORE: 'In-Store',
  OUTDOOR: 'Outdoor',
};

// Retail chains that show up without the "Category - " prefix on some rows (e.g. bare
// "LULU AL WAHDA") - same chain-name convention as Traffic Sheet's own STORE_KEYWORDS, kept as a
// separate local list since these are two unrelated vendor platforms (aiootech vs AdLive Center).
const RETAIL_CHAIN_KEYWORDS = ['LULU', 'UNION COOP', 'ADCOOP', 'CARREFOUR'];

export function aiooSiteCategory(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return 'Other';
  const dashIdx = name.indexOf(' - ');
  if (dashIdx > 0) {
    const prefix = name.slice(0, dashIdx).trim().toUpperCase();
    if (PREFIX_MAP[prefix]) return PREFIX_MAP[prefix];
  }
  const upper = name.toUpperCase();
  if (RETAIL_CHAIN_KEYWORDS.some((k) => upper.includes(k))) return 'In-Store';
  return 'Other';
}

// Strips the "Category - " prefix for display (e.g. "Malls - Dragon Mart-1" -> "Dragon Mart-1") -
// falls back to the full raw name when there's no recognized prefix (Other bucket).
export function aiooSiteDisplayName(rawName) {
  const name = String(rawName || '').trim();
  const dashIdx = name.indexOf(' - ');
  if (dashIdx > 0) {
    const prefix = name.slice(0, dashIdx).trim().toUpperCase();
    if (PREFIX_MAP[prefix]) return name.slice(dashIdx + 3).trim() || name;
  }
  return name;
}
