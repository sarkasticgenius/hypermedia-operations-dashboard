// Traffic Sheet - a live campaign schedule report proxied from the AdLive Center Traffic Sheet
// API (see supabase/functions/traffic-sheet-proxy). Nothing here is synced into a table: the
// current month is auto-loaded on first view, and Start/End Date (the primary controls - the API
// itself only takes month granularity, derived from whichever month(s) the picked dates touch)
// + "Apply Date Filter" re-fetches a specific range on demand - held in STATE only for the
// current session. "Today's Campaigns" is a dedicated cross-category tab (ignores venueType/
// network entirely) for what's live right now regardless of which venue group it's in.
//
// NOTE on per-venue day data: the API's `days` array is per-CAMPAIGN, not per-venue (confirmed
// against a real campaign spanning all 3 Gems venues - one flat `days` array covering all of
// them combined, no venue-level breakdown anywhere in the response). So when a campaign spans
// multiple venues and the Location filter narrows to just one of them, the day-by-day spot grid
// still shows that campaign's combined total, not a number specific to the selected venue - the
// data to split it out doesn't exist in this endpoint's response. Screens/campaign counts in the
// Summary table ARE per-venue (from each venue's own `screens` field) and unaffected by this.
//
// Sub-tab filters were built against a real August 2026 pull (206 campaigns) rather than guesses
// - the venue objects ({ venue, venueType, network, screens }) come from a completely different
// platform than our own Supabase asset_inventory/networks tables, and its real data turned up
// several naming quirks worth recording:
//   - venueType casing is inconsistent ("Malls" and "MALLS" both appear for the same category) -
//     always compare uppercased.
//   - Mall venue names use US spelling "CENTER" (e.g. "SHARJAH CITY CENTER"), not the UK "CENTRE"
//     our own Asset Inventory uses - normalizeVenueText() below rewrites CENTER->CENTRE before any
//     keyword match so the same MAF_MALL_VENUE_KEYWORDS list (UK spelling) still matches. This was
//     the actual cause of "MAF malls not pulling all details" - none of the 7 real MAF City
//     Centre/MOE venues carry "MAF" in their network (all under "Retail NW (A) FMCG"), so the
//     venue-name keyword match is the ONLY path that can catch them; it just needed the spelling
//     fix. Malls (non-MAF) and MAF Malls are mutually exclusive: Malls excludes anything the MAF
//     keyword list catches.
//   - "SHZ Bridges" was matching on network text containing "Sharjah"/"SHZ", which wrongly pulled
//     in "ENOC Sharjah" (a real Convenience Stores venue in this data, nothing to do with
//     bridges). The real August pull has NO venue/network containing the literal word "bridge" at
//     all - what actually IS the Dubai Metro pedestrian-bridge inventory shows up under
//     venueType "METRO OUTDOOR" (venue names like "BUSINESS BAY", "FINANCIAL CENTER", "WORLD
//     TRADE CENTER", "ALKHAIL (AL FARDAN)" - a near-exact match to our own Locations' 'Metro
//     Bridges' chain members), so that's the real filter now, with a literal "BRIDGE" text match
//     kept as a fallback in case of future overpass-style naming.
//   - Gems' 3 Palm venues are spelled "PALM-DUBAI ZUMUROD" (hyphen, no space before DUBAI) in real
//     data, not "PALM DUBAI ZUMUROD" - normalizeVenueText() also collapses hyphens/underscores to
//     spaces so the keyword list doesn't need a hyphen-exact variant.
//   - "ENOC Hatta" is a distinct venue (network "ENOC DUBAI") that should roll up into "ENOC
//     Dubai" in the summary/location list per the customer - handled by mergeVenueName() rather
//     than a matching rule, since Hatta still needs to match the ENOC tab, just displayed/grouped
//     under the merged name afterward.
//   - Stores (labeled "In-Stores") is LULU/Union Coop/ADCOOP/Carrefour only - ENOC deliberately
//     has its own tab, not part of In-Stores.
import { STATE, setState, loadData, invalidate, toast, openModal, closeModal } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { getAllSettings, getSetting, saveSetting } from '../data/settings.js';
import { MAF_MALL_VENUE_KEYWORDS, normalizeVenueText, canonicalChainBrandName } from '../data/locationStats.js';
import { supabase } from '../supabaseClient.js';
import { isAdmin } from '../auth.js';
import { esc, jsAttr, todayISO } from '../lib/format.js';
import { renderTabs } from '../lib/tabs.js';
import { exportTrafficSheetExcel, exportOverallTrafficSheetExcel } from '../lib/excelExport.js';
import { brandLogoTag } from '../lib/brandLogo.js';
import { logAudit } from '../lib/audit.js';
import { edgeFunctionErrorMessage } from '../lib/edgeFunctionError.js';

// "Today's Campaigns" and "FOC / Marketing" are both cross-category views - venueMatchesTab
// matches every venue for either, so neither is scoped to a single venueType/network the way the
// other tabs are; FOC / Marketing is further narrowed to matching campaign names on top of that
// (see the tab === 'focMarketing' filter in renderTrafficSheet/downloadTrafficSheetExcel). Placed
// last so it sits at the right-hand end of the tab row, beside ENOC.
export const TAB_DEFS = [
  { key: 'today', label: "Today's Campaigns" },
  { key: 'shzBridges', label: 'SHZ Bridges' },
  { key: 'metro', label: 'Dubai Metro' },
  { key: 'malls', label: 'Malls' },
  { key: 'mafMalls', label: 'MAF Malls' },
  { key: 'stores', label: 'In-Stores' },
  { key: 'royals', label: 'Royals' },
  { key: 'gems', label: 'Gems' },
  { key: 'enoc', label: 'ENOC' },
  { key: 'outdoor', label: 'Outdoor' },
  { key: 'focMarketing', label: 'FOC / Marketing' },
];

// The subset of TAB_DEFS that are real venue categories - excludes the two cross-category views
// ('today' matches everything by definition, 'focMarketing' is a campaign-name filter, not a
// venue one). Used by the Campaign Calendar page to build a matching per-category breakdown
// without duplicating this list.
export const VENUE_CATEGORY_KEYS = TAB_DEFS.map((t) => t.key).filter((k) => k !== 'today' && k !== 'focMarketing');

const STORE_KEYWORDS = ['LULU', 'UNION COOP', 'ADCOOP', 'CARREFOUR'];
const GEMS_VENUE_KEYWORDS = ['PALM DUBAI ZUMUROD', 'PALM DUBAI RUBY', 'PALM DUBAI FAIROUZ'];
// Also used inside the Today's Active Campaigns list on every OTHER tab, to visually group
// FOC/marketing bookings apart from paid ones without hiding them from the normal view there.
// Matched with word boundaries (see FOC_MARKETING_PATTERN below), not a plain substring check -
// "NR" in particular would false-positive on plenty of unrelated campaign names as a substring
// (e.g. anything with "...NR..." embedded in a longer word) if it weren't boundary-anchored.
const FOC_MARKETING_KEYWORDS = ['FOC', 'MARKETING', 'MKTG', 'NAMING RIGHTS', 'NAMING RIGHT', 'NR', 'FILLER'];
const FOC_MARKETING_PATTERN = new RegExp(`\\b(?:${FOC_MARKETING_KEYWORDS.join('|')})\\b`);

// Whole advertisers whose campaigns are booked as FOC/Marketing by business arrangement regardless
// of how any individual campaign happens to be named - covers every AutoPro campaign
// automatically, present and future, without needing anything added by hand each time one
// launches. Matched as a prefix on the campaign name itself, not the keyword list above, since
// "AutoPro" isn't a word that MEANS FOC/Marketing the way "FOC" or "MKTG" do - it's a business
// rule about one specific advertiser, not a naming convention.
const FOC_MARKETING_OVERRIDE_NAME_PREFIXES = ['AUTOPRO'];

// Admin-managed one-off overrides (Settings > Integrations > Traffic Sheet FOC/Marketing
// Overrides) for campaigns with no FOC/MKTG/etc. wording in the name at all, so the keyword match
// below has nothing to go on - confirmed live: REEM MALL LOGO CAMPAIGN NEW and Max N - BTS
// Campaign_July are both genuinely FOC bookings named like any other paid one. This data is a live
// vendor proxy pull (see fetchTrafficSheetCampaigns) never stored locally, so the vendor's own
// contract ID is the only stable key available to hang a manual decision on - same shape/pattern
// as venueAliasMap() above (a small admin-editable map, self-healing via loadData() rather than a
// hardcoded list that needs a code change and redeploy for every new one-off case).
function focMarketingOverrideIds() {
  const raw = loadData('focMarketingOverrides', () => getSetting('focMarketingOverrides'));
  return new Set((raw || []).map((o) => o.contract));
}

// Split out from isFocMarketingCampaign so the UI can tell "genuinely FOC by name or business
// rule" apart from "FOC only because an admin manually overrode it" - see
// isFocMarketingByOverrideOnly below, which needs exactly that distinction to decide whether the
// Move to Active button makes sense to offer at all.
function isNameBasedFocMarketing(campaign) {
  const name = (campaign.campaignName || '').toUpperCase();
  if (FOC_MARKETING_OVERRIDE_NAME_PREFIXES.some((p) => name.startsWith(p))) return true;
  // Normalized before matching so "FOC_copy" and "FOC-2" - real, live campaign names, not
  // hypothetical - read as "FOC copy"/"FOC 2" instead of one unbroken word: JS's \b treats
  // underscore as a word character, so "FOC_copy" has no boundary between C and _ and silently
  // never matched at all. Confirmed live: Blackhawk Tire Enoc FOC_copy and Blue Tokai Burjuman
  // Mall FOC_2 were both showing as paid campaigns despite visibly containing "FOC" in the name.
  return FOC_MARKETING_PATTERN.test(name.replace(/[_-]+/g, ' '));
}

export function isFocMarketingCampaign(campaign) {
  if (campaign.contract && focMarketingOverrideIds().has(campaign.contract)) return true;
  return isNameBasedFocMarketing(campaign);
}

// True only for a campaign that is FOC/Marketing SOLELY because of a manual override - not one
// that also (or instead) matches by name/business-rule. Removing the override from the latter
// wouldn't change its classification at all, so the Move to Active button only makes sense to
// offer here; a campaign like "...FOC_copy" or any AutoPro booking has nothing to revert.
export function isFocMarketingByOverrideOnly(campaign) {
  return !!(campaign.contract && focMarketingOverrideIds().has(campaign.contract)) && !isNameBasedFocMarketing(campaign);
}

// Toggles one campaign's manual override on/off, keyed by the vendor's own contract ID - same
// shape as toggleIotDeviceExcluded (networkPanels.js): read-modify-write the whole list under one
// app_settings key, invalidate so every open view (Today's list, Campaign Calendar, the Excel
// export) picks up the change on its next render instead of only the row that was clicked.
export async function toggleFocMarketingOverride(contract, campaignName, add) {
  try {
    const current = (await getSetting('focMarketingOverrides')) || [];
    const withoutThis = current.filter((o) => o.contract !== contract);
    const next = add ? [...withoutThis, { contract, campaignName, addedAt: new Date().toISOString() }] : withoutThis;
    await saveSetting('focMarketingOverrides', next);
    await logAudit(add ? 'Move campaign to FOC/Marketing' : 'Move campaign back to Active', `${contract} - ${campaignName}`);
    invalidate('focMarketingOverrides');
    toast(add ? 'Moved to FOC/Marketing.' : 'Moved back to Active.');
    setState({});
  } catch (e) { toast(e.message || 'Failed to update campaign', 'error'); }
}

function defaultMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Start/End Date are the primary, user-facing controls - the API itself only takes month
// granularity, so the default range is the current month's first/last day and any date range
// the user picks gets rounded out to whichever month(s) it touches for the actual fetch (see
// fetchTrafficSheet), then narrowed back down to the exact days client-side (withinDateRange).
function monthBounds(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { start: `${monthStr}-01`, end: `${monthStr}-${String(lastDay).padStart(2, '0')}` };
}

function defaultDateRange() {
  return monthBounds(defaultMonth());
}

function toTitleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// MAF's "City Centre" malls show up with BOTH US ("City Center") and UK ("City Centre") spelling
// as fully distinct raw venue strings in real data (confirmed: AJMAN/SHARJAH/DEIRA/FUJAIRAH/
// MIRDIF/ZAHIA all have both) - this merges either spelling into one canonical, Title-Cased display
// name ("Ajman City Centre") regardless of which the raw venue used, without touching anything else
// about the string. A suffixed variant like "SHARJAH CITY CENTER-FACADE" is left as its own
// distinct display name from the base mall - almost certainly a genuinely separate physical
// surface, not a spelling accident, so it isn't folded in.
function mergeCityCentreSpelling(name) {
  const trimmed = (name || '').trim();
  if (!/\bcity\s+cent(?:er|re)\b/i.test(trimmed)) return null;
  return toTitleCase(trimmed.replace(/\bcenter\b/gi, 'centre'));
}

// Admin-managed venue-name merges (Settings > Integrations > Traffic Sheet Venue Aliases) - for
// one-off typos/spelling variants in the source data that keep splitting one real location into
// several rows, without needing a hardcoded rule added here every time one turns up. Stored as a
// plain {raw name: canonical name} map (same shape/pattern as Brandfetch's Domain Overrides),
// checked first in mergeVenueName() so an admin-defined alias always wins over the built-in rules
// below. loadData() self-heals once the setting loads - returns an empty map (no aliases applied
// yet) on the render before that, same as every other page-level loadData() call in this app.
function venueAliasMap() {
  const raw = loadData('venueAliases', () => getSetting('venueAliases'));
  const map = new Map();
  if (raw) Object.entries(raw).forEach(([from, to]) => { if (from && to) map.set(normalizeVenueText(from), to); });
  return map;
}

// Venue-name rollups applied for display/grouping (summary, location dropdown, campaign list,
// brand logo lookup key - see brandNameForVenue) only - the raw name is still what's matched
// against tab/keyword rules first, so e.g. "Royals Entry 2" still matches the Royals tab on its own
// name/network before being merged here.
//   - "ENOC Hatta" -> "ENOC Dubai"
//   - "Royals Entry 1/2/3" -> "Royals Entry", "Royals Exit 1/2/3" -> "Royals Exit"
//   - "AJMAN CITY CENTER"/"AJMAN CITY CENTRE" -> "Ajman City Centre" (see mergeCityCentreSpelling)
//   - "MALL OF THE EMIRATES"/"MALL OF EMIRATES"/"...STATION"/"...1" (the plain Metro station entry)
//     -> "Mall of the Emirates Station" - deliberately NOT the AUH/DXB/OUTDOOR/HOLOGRAM-suffixed
//     variants, which carry extra distinguishing words and are almost certainly separate physical
//     surfaces, not a naming accident (same conservative-merge reasoning as City Centre above).
// venueType (optional, pass the venue's own .venueType when calling this) scopes the Mall of the
// Emirates rule below to the actual Metro station - without it, a real shopping mall also named
// "Mall of the Emirates" (a genuine MAF mall, venueType MALLS - a totally different physical venue
// that just happens to share a name with the station serving it) got relabeled "...Station" too,
// which is wrong for a mall. Every call site has a venue object with .venueType on hand already.
// Single source of truth behind both mergeVenueName() and venueRawKeyForScreens() below.
// `identity: true` means the raw name is just noise (typo/spelling/casing) for the SAME physical
// venue - ENOC Hatta and Royals Entry/Exit are the opposite case: genuinely distinct physical
// installs (different petrol stations, different physical entry points) that get rolled into one
// DISPLAY group but should still have their own screens counted separately and summed. Every other
// rule here (admin aliases, City Centre spelling, Mall of the Emirates) is fixing name noise for
// what's really one physical venue, so those default to identity: true.
function resolveVenueName(name, venueType) {
  if (!name || !String(name).trim()) return { name: '(Unnamed Venue)', identity: true };
  const n = normalizeVenueText(name);
  const alias = venueAliasMap().get(n);
  if (alias) return { name: alias, identity: true };
  if (n === 'ENOC HATTA') return { name: 'ENOC Dubai', identity: false };
  if (/^ROYALS ENTRY \d+$/.test(n)) return { name: 'Royals Entry', identity: false };
  if (/^ROYALS EXIT \d+$/.test(n)) return { name: 'Royals Exit', identity: false };
  const vt = (venueType || '').toUpperCase();
  const isMetro = vt === 'METRO' || vt === 'METRO OUTDOOR';
  if (isMetro && /^MALL OF( THE)? EMIRATES( STATION)?( \d+)?$/.test(n)) return { name: 'Mall of the Emirates Station', identity: true };
  if (!isMetro && /^MALL OF( THE)? EMIRATES$/.test(n)) return { name: 'Mall of the Emirates', identity: true };
  const cityCentre = mergeCityCentreSpelling(name);
  if (cityCentre) return { name: cityCentre, identity: true };
  return { name, identity: true };
}

// A venue entry with no name at all (blank/null in the source data - a real gap in that venue's
// registration, not something this app generates) otherwise flows through untouched and renders as
// a blank row: blank Location cell in the Summary table, and previously a literal "Sheet" tab in
// the Overall Traffic Sheet export. Labeling it clearly here fixes both at the source instead of
// patching each display separately - it now groups/filters/exports as one distinct, clearly-
// flagged venue instead of colliding with "no venue name" everywhere it's used.
export function mergeVenueName(name, venueType) {
  return resolveVenueName(name, venueType).name;
}

// The key locationSummary() buckets a venue's screens by (see __rawVenue in filteredCampaigns()) -
// the ORIGINAL raw name for a genuine multi-location rollup (ENOC branches, Royals Entry 1/2/3),
// so each one's own screens still get summed into the group's total; the CANONICAL merged name for
// a pure name-noise merge (admin alias, spelling variant), so every variant collapses into one
// bucket and its screens are maxed instead of summed - otherwise a typo fix (or the City Centre/
// Mall of the Emirates spelling merges) looked like it doubled a venue's screen count, since the
// same physical screens were being reported under two different raw spellings and both got added.
export function venueRawKeyForScreens(name, venueType) {
  const r = resolveVenueName(name, venueType);
  return r.identity ? r.name : name;
}

// Brandfetch's name-Search API turned out to fuzzy-match a huge share of raw venue names to
// completely unrelated companies (real examples: "LULU" -> lululemon.com, "Energy" -> the US
// Department of Energy, "International City Pavillion" -> Garmin, "Stadium" -> a Swedish sports
// retailer) - venue/street/station names aren't reliable Search queries. This maps each venue to
// the name that's actually safe/correct to look up a logo for, used both when gathering candidate
// names (Settings > Brandfetch > Fetch Missing Logos) and when displaying a logo (brandLogoTag) on
// Traffic Sheet, so the cache key and the lookup key always match:
//   - Metro/Metro Bridges (venueType METRO / METRO OUTDOOR) -> the station/bridge's own name with
//     the "Metro Station - "/"Metro Bridge - " prefix stripped off. A handful of these really are
//     sponsor-branded (confirmed real examples: "Danube", "Equiti", "OnPassive", "Sharaf DG",
//     "National Paints") - but most are just Dubai area/place names ("Business Bay", "Al Jadaf",
//     "Energy", "Stadium", "Creek"), and Brandfetch's Search API turned out to confidently
//     fuzzy-match EVERY one of those to some unrelated company too, rather than admitting no match
//     (a full batch of ~25 station names came back 100% wrong: "Al Jadaf"/"Al Ghubaiba"/
//     "Al Qiyadah" all matched alfuttaim.com, "Energy" matched the US Dept of Energy, "Stadium"
//     matched a Swedish retailer). So this still returns the stripped name for EVERY station (it's
//     the display/cache-key), but isBrandedMetroStation() below gates which of those names are
//     actually safe to send to Search - see its comment.
//   - Multi-location retail chains (LULU/Union Coop/ADCOOP/ENOC/Nakheel Pavilion) -> just the
//     chain name, not each branch's full venue string ("LULU AL KHALIFA", "Nakheel Pavilion - Al
//     Furjan West") - one correct lookup covers every branch instead of each one needing its own
//     (every branch of Nakheel Pavilion previously failed Search individually - real example:
//     "Nakheel Pavilion - Al Furjan West"/"...Discovery Gardens"/"...International City" etc all
//     came back "No match found" on their own, before this was added).
//   - Royals/Gems (network ROYALS/GEMS) -> "Palm Dubai" (the same manually-supplied Palm Jumeirah
//     aerial photo as the Palm Dubai screen-network locations - see LOGO_CHAIN_NAMES in
//     data/locationStats.js). These are internal-only screen groupings on the Palm with no real
//     external company brand to search for - searching for "Royals Entry" or "PALM-DUBAI ZUMUROD"
//     would only ever return an unrelated company by coincidence of wording, which is exactly why
//     this is a fixed manual name rather than a live Search lookup: safe to propose as a
//     search-candidate name too (see gatherTrafficSheetVenueNames in settings.js), since "Palm
//     Dubai" itself is never actually searched once it's already cached.
//   - Everything else (malls, named venues) -> the venue name itself, unchanged.
// The chain-prefix collapse itself (LULU/Union Coop/ADCOOP/ENOC/Carrefour/Nakheel Pavilion/Palm
// Dubai -> their one canonical brand name) now lives in canonicalChainBrandName
// (data/locationStats.js), shared with brandNameForLocation on the Locations page - a branch venue
// used to resolve to a logo here but to bare initials there, since Locations had no equivalent
// collapse at all.
const METRO_FALLBACK_BRAND = 'Dubai Metro Rail';
const ROYALS_GEMS_BRAND = 'Palm Dubai';
function isMetroVenue(venue) {
  const venueType = (venue.venueType || '').toUpperCase();
  return venueType === 'METRO' || venueType === 'METRO OUTDOOR';
}
export function brandNameForVenue(venue) {
  const network = (venue.network || '').toUpperCase();
  if (network.includes('ROYALS') || network.includes('GEMS')) return ROYALS_GEMS_BRAND;
  const name = (venue.venue || '').trim();
  if (isMetroVenue(venue)) {
    const stripped = name.replace(/^Metro (Bridge|Station)\s*-\s*/i, '').trim();
    return stripped || METRO_FALLBACK_BRAND;
  }
  return canonicalChainBrandName(name) || name || null;
}

// Fallback brand shown (via brandLogoTag's fallbackName arg) when a Metro/Bridges station has no
// logo of its own on file - e.g. plain area names like "Business Bay" that were never going to
// resolve to a real company. Returns null for every non-Metro venue (no generic fallback exists).
export function brandFallbackForVenue(venue) {
  return isMetroVenue(venue) ? METRO_FALLBACK_BRAND : null;
}

// Confirmed real, sponsor-branded Dubai Metro stations - the ONLY Metro/Bridges names that should
// ever be auto-proposed as a Brandfetch Search candidate (see gatherTrafficSheetVenueNames in
// settings.js). Everything else just uses brandFallbackForVenue()'s shared "Dubai Metro Rail" logo
// and is never searched at all, since Search has a confirmed 100% false-positive rate on plain
// Dubai area names. A Domain Override can still resolve any other station name manually regardless
// of this list - that path never calls Search either way. Extend this list only for names actually
// confirmed to be real corporate sponsors, not guessed.
const METRO_BRAND_KEYWORDS = ['DANUBE', 'EQUITI', 'ONPASSIVE', 'SHARAF DG', 'NATIONAL PAINTS', 'ADCB'];
export function isBrandedMetroStation(venue) {
  if (!isMetroVenue(venue)) return false;
  const stripped = (venue.venue || '').replace(/^Metro (Bridge|Station)\s*-\s*/i, '');
  const normalized = normalizeVenueText(stripped);
  return METRO_BRAND_KEYWORDS.some((k) => normalized.includes(k));
}

function isMafVenue(venue) {
  const network = (venue.network || '').toUpperCase();
  if (network.includes('MAF')) return true;
  const venueType = (venue.venueType || '').toUpperCase();
  if (venueType !== 'MALLS') return false;
  const name = normalizeVenueText(venue.venue);
  return MAF_MALL_VENUE_KEYWORDS.some((k) => name.includes(k));
}

export function venueMatchesTab(venue, tabKey) {
  const venueType = (venue.venueType || '').toUpperCase();
  const network = (venue.network || '').toUpperCase();
  const name = normalizeVenueText(venue.venue);
  switch (tabKey) {
    case 'today':
    case 'focMarketing':
      return true;
    case 'malls':
      return venueType === 'MALLS' && !isMafVenue(venue);
    case 'mafMalls':
      return isMafVenue(venue);
    case 'stores':
      return STORE_KEYWORDS.some((k) => name.includes(k) || network.includes(k));
    case 'royals':
      return network.includes('ROYALS');
    case 'gems':
      return GEMS_VENUE_KEYWORDS.some((k) => name.includes(k));
    case 'enoc':
      return name.includes('ENOC') || network.includes('ENOC');
    case 'shzBridges':
      return venueType === 'METRO OUTDOOR' || name.includes('BRIDGE');
    // Regular in-station Metro screens - distinct venueType from the "METRO OUTDOOR"
    // pedestrian-bridge inventory above (confirmed against real data: both exist as separate
    // venueType values, ~103 combined regular-station venues vs 17 bridge ones in a real pull).
    case 'metro':
      return venueType === 'METRO';
    // Standalone outdoor screens that aren't SHZ Bridges (venueType "Outdoor", not "Metro
    // Outdoor" - confirmed as a real, distinct venueType in the data: Expo City, Garden Plaza,
    // Modon Hudayriyat, WTC Mall-AUH, Dubai Chamber Outdoor, Dubai Festival City's outdoor
    // surface, etc.). Previously these matched NO tab at all - only visible on Today's
    // Campaigns/FOC, never under a dedicated category. Excludes anything a more specific tab
    // already claims by name/network (ENOC, Gems, Royals, Stores, MAF) so a venue doesn't show
    // up twice; genuine bridges are normalized to "Metro Outdoor" before this ever runs (see
    // normalizeBridgeVenueTypes) so they aren't double-counted here either.
    case 'outdoor':
      return venueType === 'OUTDOOR' && !name.includes('BRIDGE') && !isMafVenue(venue)
        && !(name.includes('ENOC') || network.includes('ENOC'))
        && !GEMS_VENUE_KEYWORDS.some((k) => name.includes(k))
        && !network.includes('ROYALS')
        && !STORE_KEYWORDS.some((k) => name.includes(k) || network.includes(k));
    default:
      return false;
  }
}

function locationsForTab(data, tabKey) {
  const set = new Set();
  (data?.campaigns || []).forEach((c) => (c.venues || []).forEach((v) => {
    if (venueMatchesTab(v, tabKey)) set.add(mergeVenueName(v.venue, v.venueType));
  }));
  return [...set].sort();
}

// Distinct Network values seen among SHZ Bridges venues in the loaded month(s) - not knowable
// statically the way TAB_DEFS is, since real bridge network values turn out to be seasonal/
// per-campaign branding names (e.g. "Da Vinci", "Van Ghogh", "MONET") rather than a fixed list.
// Drives the secondary per-Network tab strip shown only on the SHZ Bridges tab.
function bridgeNetworksAvailable(data) {
  const set = new Set();
  (data?.campaigns || []).forEach((c) => (c.venues || []).forEach((v) => {
    if (venueMatchesTab(v, 'shzBridges')) set.add(v.network || '');
  }));
  return [...set].sort();
}

// Attaches __matchedVenues (the subset of a campaign's venues that belong to this tab/location,
// with rollups like ENOC Hatta -> ENOC Dubai or Royals Entry 1/2/3 -> Royals Entry already
// applied to `venue`) so the summary table and campaign list stay consistent with each other.
// __rawVenue keeps the pre-merge name too - locationSummary needs it to sum screens correctly
// across distinct physical venues that got merged into one display row, instead of maxing them
// down to just one.
function filteredCampaigns(data, tabKey, location) {
  const campaigns = data?.campaigns || [];
  return campaigns
    .map((c) => {
      const venues = (c.venues || [])
        .filter((v) => venueMatchesTab(v, tabKey))
        .map((v) => ({ ...v, __rawVenue: venueRawKeyForScreens(v.venue, v.venueType), venue: mergeVenueName(v.venue, v.venueType) }))
        .filter((v) => !location || v.venue === location);
      return venues.length ? { ...c, __matchedVenues: venues } : null;
    })
    .filter(Boolean);
}

function inDateRange(dateIso, startDate, endDate) {
  if (startDate && dateIso < startDate) return false;
  if (endDate && dateIso > endDate) return false;
  return true;
}

// Optional day-level refinement on top of the month-granularity API fetch - the API itself only
// takes startMonth/endMonth, so narrowing to a specific date window happens client-side against
// whatever month(s) are already loaded.
function withinDateRange(campaign, startDate, endDate) {
  if (!startDate && !endDate) return true;
  const days = campaign.days || [];
  if (days.length) return days.some((d) => inDateRange(d.date, startDate, endDate));
  if (campaign.startDate && campaign.endDate) {
    if (endDate && campaign.startDate > endDate) return false;
    if (startDate && campaign.endDate < startDate) return false;
    return true;
  }
  return true;
}

function isActiveOn(campaign, dateIso) {
  if (campaign.startDate && campaign.endDate) return campaign.startDate <= dateIso && campaign.endDate >= dateIso;
  return (campaign.days || []).some((d) => d.date === dateIso && d.spots > 0);
}

// The 15/6-per-screen cap is inherently a per-CALENDAR-MONTH rule - counting campaigns across a
// wide Start/End Date range (which can span many months since that range drives the day-by-day
// grid too) would flag venues as "overbooked" just for having a busy year, not a busy month. This
// checks whether a campaign touches a specific month at all, independent of whatever range is
// currently loaded for the grid.
function isActiveInMonth(campaign, monthStr) {
  const { start, end } = monthBounds(monthStr);
  if (campaign.startDate && campaign.endDate) return campaign.startDate <= end && campaign.endDate >= start;
  return (campaign.days || []).some((d) => d.date >= start && d.date <= end);
}

// Same "live" test statusBadge already uses for its green badge - a campaign's booked startDate/
// endDate is not reliable evidence it is STILL running. Confirmed live at Abu Dhabi Mall: Campaigns/
// Cap read 13/15 with only 5 rows showing as Live in the table right below it - the other 8 were
// AdLive's own status text already saying "Complete" (pulled early, cancelled, whatever the real
// reason) while their stored end date hadn't caught up and still fell inside the Capacity Month.
// isActiveInMonth only ever answers "does this booking's date range touch this month" - status is
// the only place AdLive actually says whether the slot is still occupied, so capacitySummary needs
// this as an additional filter, not a replacement for the date check.
function isLiveStatus(status) {
  const s = (status || '').toLowerCase();
  return s.includes('live') || s.includes('running');
}

function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Monthly campaign-slot capacity per physical screen: 15 by default, 6 for Royals, and no cap at
// all (null) for MAF Malls or Carrefour - per the customer, those two don't follow the standard
// rotation-limit rule. Determined by the venue's own network/type (not by whichever tab happens to
// be active), so it stays correct even on cross-category tabs like Today's Campaigns or FOC /
// Marketing where a Royals/MAF/Carrefour venue can show up alongside everything else. Reuses
// isMafVenue() as-is since a locationSummary() entry has the same venue/venueType/network shape
// isMafVenue() expects.
export function capacityPerScreen(summaryEntry) {
  const venue = (summaryEntry.venue || '').toUpperCase();
  // MAF Malls do have a cap after all (reversing the earlier no-cap rule) - 10/screen/month for an
  // outdoor location, 20 for indoor. No dedicated indoor/outdoor field exists on a venue, so this
  // goes by the "OUTDOOR" suffix convention already used in real venue names (e.g. "Dubai Festival
  // City - Outdoor", "Mall of Emirates OUTDOOR") - an inference, not a confirmed rule.
  if (isMafVenue(summaryEntry)) return venue.includes('OUTDOOR') ? 10 : 20;
  const network = (summaryEntry.network || '').toUpperCase();
  if (network.includes('CARREFOUR') || venue.includes('CARREFOUR')) return null;
  if (network.includes('ROYALS')) return 6;
  return 15;
}

// A single venue legitimately shows up under several different AdLive network values across
// different campaign bookings (e.g. "ENOC Dubai" spans "ENOC AutoPro", "ENOC DUBAI", "ENOC
// C-Store Pelmet" depending on which product line booked it - confirmed against real data, over
// half of all venues have more than one distinct network value). Picking just the first one seen
// (the previous behavior) made the Network column look arbitrary/wrong - showing every distinct
// value fixes that.
//
// Screens are tracked per __rawVenue (the pre-merge name) and summed, not maxed, across raw
// venues - maxing was correct for the same physical venue appearing in multiple campaigns (its
// screen count shouldn't multiply just because it's booked twice), but wrong for a merged group
// like "Royals Entry" (Entry 1/2/3, each its own physical location with its own screen): that
// needs 1+1+1=3, not max(1,1,1)=1. Confirmed against Asset Inventory - all 6 Royals Entry/Exit
// venues are 1 screen each there too, so Entry should total 3 and Exit should total 3.
function locationSummary(campaigns) {
  const map = new Map();
  campaigns.forEach((c) => {
    (c.__matchedVenues || []).forEach((v) => {
      if (!map.has(v.venue)) map.set(v.venue, { venue: v.venue, venueType: v.venueType, networks: new Set(), campaigns: new Set(), screensByRaw: new Map() });
      const entry = map.get(v.venue);
      if (v.network) entry.networks.add(v.network);
      entry.campaigns.add(c.contract);
      const rawKey = v.__rawVenue || v.venue;
      entry.screensByRaw.set(rawKey, Math.max(entry.screensByRaw.get(rawKey) || 0, v.screens || 0));
    });
  });
  return [...map.values()]
    .map((e) => ({
      ...e,
      screens: [...e.screensByRaw.values()].reduce((sum, n) => sum + n, 0),
      network: [...e.networks].sort().join(', ') || '-',
    }))
    .sort((a, b) => a.venue.localeCompare(b.venue));
}

function collectDates(campaigns) {
  const set = new Set();
  campaigns.forEach((c) => (c.days || []).forEach((d) => set.add(d.date)));
  return [...set].sort();
}

export function groupDatesByMonth(dates) {
  const groups = [];
  dates.forEach((d) => {
    const month = d.slice(0, 7);
    let g = groups[groups.length - 1];
    if (!g || g.month !== month) { g = { month, dates: [] }; groups.push(g); }
    g.dates.push(d);
  });
  return groups;
}

export function formatMonthLabel(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export function statusBadge(status) {
  const s = (status || '').toLowerCase();
  let cls = 'b-blue';
  if (s.includes('live') || s.includes('running')) cls = 'b-green';
  else if (s.includes('complete')) cls = 'b-gray';
  else if (s.includes('pending') || s.includes('scheduled')) cls = 'b-amber';
  else if (s.includes('paused') || s.includes('stopped')) cls = 'b-red';
  return `<span class="badge ${cls}">${esc(status || 'Unknown')}</span>`;
}

// Quick-glance counts above everything else - scoped to the current tab/location like the rest
// of the page. "Expiring" = endDate falls on that exact day (regardless of status text), not a
// generic "ending soon" window.
function renderQuickStatTiles(todayActive, todayExpiring, yesterdayActive, yesterdayExpired) {
  return `
    <div class="kpi-row" style="margin-bottom:16px;">
      <div class="kpi" style="border-left:4px solid #1f9d55;"><div class="label">Today - Active</div><div class="value">${todayActive}</div></div>
      <div class="kpi" style="border-left:4px solid #b45309;"><div class="label">Today - Expiring</div><div class="value">${todayExpiring}</div></div>
      <div class="kpi" style="border-left:4px solid #2563eb;"><div class="label">Yesterday - Active</div><div class="value">${yesterdayActive}</div></div>
      <div class="kpi" style="border-left:4px solid #6b7280;"><div class="label">Yesterday - Expired</div><div class="value">${yesterdayExpired}</div></div>
    </div>
  `;
}

// Each row's venue name is clickable - sets the Location dropdown to that exact venue, so
// clicking a location filters the whole page down to just its campaigns. "Network" is every
// distinct value AdLive Center's own API reports for that venue across its campaign bookings -
// see the file-header note and locationSummary() for why it's a list rather than one value.
// "Capacity" applies the 15-campaigns-per-screen rule (6 for Royals): a campaign booking runs on
// every screen at a venue at once, so the same count/cap comparison holds per screen regardless of
// how many screens the venue has - Capacity Status is that per-screen headroom (cap - count), the
// same units as the Campaigns/Cap column right next to it, not multiplied by screens.
// capacitySummary is a SEPARATE locationSummary() scoped to exactly one calendar month (see
// isActiveInMonth) AND to Live campaigns only (see isLiveStatus) - Screens/Network/Venue Type still
// come from the main summary (whatever the wider Start/End Date range currently shows), but the
// Campaigns/Cap/Capacity Status columns always come from capacitySummary, keyed by venue, so a wide
// date range never inflates the count the 15/6 cap is compared against, and a Complete/expired
// booking whose stored end date just hasn't caught up never holds a slot it isn't actually using.
function renderSummaryCard(campaigns, summary, totalScreens, capacitySummary, capacityMonth) {
  const capacityByVenue = new Map(capacitySummary.map((s) => [s.venue, s]));
  const monthLabel = formatMonthLabel(capacityMonth);
  const rows = summary.map((s) => {
    const capRow = capacityByVenue.get(s.venue);
    const cap = capacityPerScreen(s);
    const screens = s.screens || 0;
    const count = capRow ? capRow.campaigns.size : 0;
    let countCapText;
    let capacityHtml;
    if (cap === null) {
      countCapText = `${count}`;
      capacityHtml = '<span class="badge b-gray">No cap</span>';
    } else {
      const overbooked = Math.max(0, count - cap);
      const available = Math.max(0, cap - count);
      countCapText = `${count} / ${cap}`;
      capacityHtml = overbooked > 0
        ? `<span class="badge b-red">Overbooked +${overbooked}</span>`
        : `<span class="badge b-green">${available} available</span>`;
    }
    return `
      <tr style="cursor:pointer;" onclick="App.setTrafficSheetLocation('${jsAttr(s.venue)}')" title="Click to filter to this location">
        <!-- brandNameForVenue() returns null for Royals/Gems on purpose (no real external brand
             exists, so it must never be proposed as a Brandfetch search candidate - see
             gatherTrafficSheetVenueNames in settings.js). Falling back to the raw venue name HERE
             only asks brandLogoTag to check the already-cached table (it never searches live), so
             it's safe: worst case is the same initials badge every other uncached name gets,
             instead of literally nothing rendering for every Royals/Gems row. -->
        <td>${brandLogoTag(brandNameForVenue(s) || s.venue, 22, brandFallbackForVenue(s))} ${esc(s.venue)}</td>
        <td>${esc(s.venueType || '-')}</td>
        <td>${esc(s.network)}</td>
        <td class="tright">${screens}</td>
        <td class="tright">${countCapText}</td>
        <td class="tcenter">${capacityHtml}</td>
      </tr>
    `;
  }).join('');
  return `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-head">
        <h3>Summary</h3>
        <div class="desc">${campaigns.length} campaign(s), ${totalScreens} screen(s) across ${summary.length} location(s) for the selected range. Click a location to filter. Campaigns/Cap and Capacity Status are for ${esc(monthLabel)} only, counting Live campaigns only (Complete/expired bookings don't hold a slot even if their stored end date still falls in this month) - 15 campaigns/screen/month, 6 for Royals, 20 for MAF Malls indoor / 10 outdoor, no cap for Carrefour. Change the Capacity Month above to check a different month.</div>
      </div>
      <table><thead><tr><th>Location</th><th>Venue Type</th><th>Network</th><th class="tright">Screens</th><th class="tright">Campaigns / Cap (${esc(monthLabel)})</th><th class="tcenter">Capacity Status</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6"><div class="empty">No data.</div></td></tr>'}</tbody></table>
    </div>
  `;
}

// Builds, per Network, the full set of venue names ever seen under it across the WHOLE loaded
// dataset (every campaign, not just the current tab/filter) - the closest thing to an
// authoritative "which stations belong to this network" roster that exists, since Traffic Sheet
// has no static locations table of its own to check against. Feeds describeMatchedVenues() below.
function stationsByNetwork(data) {
  const map = new Map();
  (data?.campaigns || []).forEach((c) => (c.venues || []).forEach((v) => {
    if (!v.network) return;
    if (!map.has(v.network)) map.set(v.network, new Set());
    map.get(v.network).add(mergeVenueName(v.venue, v.venueType));
  }));
  return map;
}

// A campaign's venue list is normally every individual venue name joined together - for a
// campaign that happens to cover EVERY station under a given network (e.g. booked across the
// whole of "Retail NW (A) FMCG"), that's needlessly long and less useful than just naming the
// network. Groups this campaign's own matched venues by network; any network where its coverage is
// a superset of that network's full known roster collapses to just the network's name - everything
// else (including venues with no network at all) still lists individually, same as before.
function describeMatchedVenues(campaign, rosterByNetwork) {
  const venues = campaign.__matchedVenues || [];
  if (!venues.length) return '';
  const byNetwork = new Map();
  const noNetwork = [];
  venues.forEach((v) => {
    if (!v.network) { noNetwork.push(v.venue); return; }
    if (!byNetwork.has(v.network)) byNetwork.set(v.network, new Set());
    byNetwork.get(v.network).add(v.venue);
  });

  const parts = [];
  byNetwork.forEach((covered, network) => {
    const roster = rosterByNetwork.get(network);
    if (roster && roster.size > 0 && [...roster].every((v) => covered.has(v))) {
      parts.push(network);
    } else {
      parts.push(...covered);
    }
  });
  parts.push(...noNetwork);
  return parts.join(', ');
}

// Always-visible live snapshot of what's running today, independent of any Start/End Date
// narrowing applied to the grid below. Start/End/Status columns are nowrap - narrow columns next
// to Campaign Name's free text otherwise wrap "2026-06-22" onto two lines.
// isFocSection: whether this table is listing campaigns already classified FOC/Marketing (the FOC
// sub-table, or the dedicated FOC/Marketing tab) rather than the regular/paid list - decides which
// direction the per-row toggle button (admin only) offers, and whether it shows at all. Moving a
// campaign TO FOC/Marketing always makes sense from the regular list; moving one BACK to Active
// only makes sense when it's FOC purely because of a manual override (see
// isFocMarketingByOverrideOnly) - a campaign whose own name says FOC/MKTG, or an AutoPro booking,
// has nothing for the override to revert, so no button is offered for those rows.
function todayListTable(campaigns, emptyText, rosterByNetwork, isFocSection) {
  const admin = isAdmin();
  const rows = campaigns.map((c) => {
    let actionHtml = '';
    if (admin) {
      if (!isFocSection) {
        actionHtml = `<button class="btn-sm" title="Move this campaign to FOC/Marketing - it has no FOC/MKTG wording in its name, so this is remembered separately and only affects this dashboard's own grouping." onclick="App.toggleFocMarketingOverride('${jsAttr(c.contract || '')}', '${jsAttr(c.campaignName || '')}', true)">Move to FOC/Marketing</button>`;
      } else if (isFocMarketingByOverrideOnly(c)) {
        actionHtml = `<button class="btn-sm" onclick="App.toggleFocMarketingOverride('${jsAttr(c.contract || '')}', '${jsAttr(c.campaignName || '')}', false)">Move to Active</button>`;
      }
    }
    return `
    <tr>
      <td class="tleft">${esc(c.campaignName || '')}${c.contract ? ` <button class="btn-sm" style="padding:1px 6px;font-size:11px;" title="View this campaign's creative assets (approval status, matched venues, actual files) from AdLive" onclick="App.openCampaignCreativesModal('${jsAttr(c.contract)}', '${jsAttr(c.campaignName || '')}')">Creatives</button>` : ''}</td>
      <!-- Same Royals/Gems fallback as the venue table above - brandNameForVenue's null there is a
           deliberate "never search for this" signal, not a "never display anything" one. -->
      <td class="tleft">${(c.__matchedVenues || [])[0] ? brandLogoTag(brandNameForVenue((c.__matchedVenues || [])[0]) || (c.__matchedVenues || [])[0].venue, 18, brandFallbackForVenue((c.__matchedVenues || [])[0])) : ''} ${esc(describeMatchedVenues(c, rosterByNetwork))}</td>
      <td class="tsheet-nowrap">${statusBadge(c.status)}</td>
      <td class="tsheet-nowrap">${esc(c.startDate || '')}</td>
      <td class="tsheet-nowrap">${esc(c.endDate || '')}</td>
      ${admin ? `<td class="tsheet-nowrap">${actionHtml}</td>` : ''}
    </tr>
  `;
  }).join('');
  return `
    <table><thead><tr><th class="tleft">Campaign Name</th><th class="tleft">Venue(s)</th><th class="tsheet-nowrap">Status</th><th class="tsheet-nowrap">Start</th><th class="tsheet-nowrap">End</th>${admin ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${admin ? 6 : 5}"><div class="empty">${esc(emptyText)}</div></td></tr>`}</tbody></table>
  `;
}

// FOC/marketing bookings (name contains FOC/Marketing/MKTG) are grouped into their own labeled
// sub-table beneath the regular one, in the SAME card, on every OTHER tab - a visual split so
// they're still visible in the normal Today's Active Campaigns view there. On the dedicated
// FOC / Marketing tab itself every row is already FOC/Marketing (campaigns was pre-filtered to
// just those), so the split would be 100% redundant - skip it and show one plain table instead.
function renderTodayList(campaigns, tab, rosterByNetwork) {
  // SHZ Bridges' "network" values are seasonal/per-campaign branding names (see
  // bridgeNetworksAvailable above), not a fixed physical roster like Retail NW/DUBAI HOLDING/3D
  // NETWORK - collapsing to the network name here would show a meaningless label (e.g. "Da Vinci")
  // in place of the actual bridge/station name, so this tab always lists venues individually.
  if (tab === 'shzBridges') rosterByNetwork = new Map();
  if (tab === 'focMarketing') {
    return `
      <div class="card" style="margin-bottom:16px;">
        <div class="card-head"><h3>Today's Active Campaigns</h3><div class="desc">${campaigns.length} FOC/Marketing campaign(s) active today for this location.</div></div>
        ${todayListTable(campaigns, 'No FOC/Marketing campaigns active today.', rosterByNetwork, true)}
      </div>
    `;
  }
  const regular = campaigns.filter((c) => !isFocMarketingCampaign(c));
  const focMarketing = campaigns.filter(isFocMarketingCampaign);
  return `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-head"><h3>Today's Active Campaigns</h3><div class="desc">${campaigns.length} campaign(s) active today for this tab/location - ${regular.length} regular, ${focMarketing.length} FOC/Marketing.</div></div>
      ${todayListTable(regular, 'No regular campaigns active today.', rosterByNetwork, false)}
      ${focMarketing.length ? `
        <div class="card-head" style="margin-top:16px;"><h3 style="font-size:13px;">FOC / Marketing <span class="badge b-amber">${focMarketing.length}</span></h3></div>
        ${todayListTable(focMarketing, 'None.', rosterByNetwork, true)}
      ` : ''}
    </div>
  `;
}

// The full day-by-day spot grid, matching the customer's original campaign sheet layout. Also
// reused as-is by the Client Campaigns Monitor's Calendar view (see clientCampaignMonitor.js) -
// already does exactly "month and date wise campaigns view" for whatever campaign list it's given.
export function renderDayGrid(campaigns, startDate, endDate) {
  if (!campaigns.length) {
    return '<div class="card"><div class="empty">No campaigns found for this tab/period/location.</div></div>';
  }
  let dates = collectDates(campaigns);
  if (startDate || endDate) dates = dates.filter((d) => inDateRange(d, startDate, endDate));
  if (!dates.length) {
    return '<div class="card"><div class="empty">No day-level data in the selected date range.</div></div>';
  }
  const dateGroups = groupDatesByMonth(dates);

  const monthHeadRow = `<tr><th colspan="6"></th>${dateGroups.map((g) => `<th colspan="${g.dates.length}" class="tsheet-month-head">${esc(formatMonthLabel(g.month))}</th>`).join('')}</tr>`;
  const dayHeadRow = `<tr>
    <th class="tleft">Campaign Name</th><th>Start</th><th>End</th><th class="tcenter">Days</th><th class="tcenter">Loop Count</th><th>Status</th>
    ${dates.map((d) => `<th class="tsheet-day">${esc(d.slice(8, 10))}</th>`).join('')}
  </tr>`;

  const bodyRows = campaigns.map((c) => {
    const dayMap = {};
    (c.days || []).forEach((d) => { dayMap[d.date] = d.spots; });
    return `<tr>
      <td class="tleft">${esc(c.campaignName || '')}${c.contract ? ` <button class="btn-sm" style="padding:1px 6px;font-size:11px;" title="View this campaign's creative assets (approval status, matched venues, actual files) from AdLive" onclick="App.openCampaignCreativesModal('${jsAttr(c.contract)}', '${jsAttr(c.campaignName || '')}')">Creatives</button>` : ''}</td>
      <td>${esc(c.startDate || '')}</td>
      <td>${esc(c.endDate || '')}</td>
      <td class="tcenter">${c.campaignDays ?? ''}</td>
      <td class="tcenter">${c.loopCount ?? ''}</td>
      <td>${statusBadge(c.status)}</td>
      ${dates.map((d) => {
        const spots = dayMap[d];
        return `<td class="tsheet-cell${spots ? ' tsheet-active' : ''}">${spots ? esc(String(spots)) : ''}</td>`;
      }).join('')}
    </tr>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-head"><h3>Campaigns</h3></div>
      <div class="tsheet-wrap">
        <table class="tsheet-table">
          <thead>${monthHeadRow}${dayHeadRow}</thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

export function renderTrafficSheet() {
  const settings = loadData('settings', getAllSettings);
  if (settings === null) return loadingCard();
  if (settings?.__error) return loadingCard(settings.__error);
  const cfg = settings.trafficSheetApi || {};

  if (!cfg.enabled || !cfg.apiKey) {
    return `
      <div class="card">
        <div class="empty">
          Traffic Sheet isn't configured yet.<br>
          ${isAdmin() ? 'Add the API key under Settings &gt; Integrations &gt; Traffic Sheet API.' : 'Ask an administrator to configure the Traffic Sheet API under Settings &gt; Integrations.'}
        </div>
      </div>
    `;
  }

  const tab = STATE.trafficSheetTab || 'malls';
  const isTodayTab = tab === 'today';
  const location = STATE.trafficSheetLocation || '';
  const defaults = defaultDateRange();
  const startDate = STATE.trafficSheetStartDate || defaults.start;
  const endDate = STATE.trafficSheetEndDate || defaults.end;
  const loading = STATE.trafficSheetLoading;
  const error = STATE.trafficSheetError;
  const data = STATE.trafficSheetData;

  // Auto-load the current month exactly once on first view - guarded so re-renders don't refire.
  if (!data && !loading && !STATE.trafficSheetAutoFetchStarted) {
    STATE.trafficSheetAutoFetchStarted = true;
    queueMicrotask(autoFetchTrafficSheet);
  }

  const capacityMonth = STATE.trafficSheetCapacityMonth || defaultMonth();

  const locations = data ? locationsForTab(data, tab) : [];
  let campaigns = data ? filteredCampaigns(data, tab, location) : [];
  // FOC / Marketing matches every venue (venueMatchesTab), then narrows to just the campaigns
  // whose name actually says FOC/Marketing/MKTG - the venue-level match alone isn't enough since
  // this tab isn't a venue category.
  if (tab === 'focMarketing') campaigns = campaigns.filter(isFocMarketingCampaign);
  const focCategory = STATE.trafficSheetFocCategory || '';
  if (tab === 'focMarketing' && focCategory) {
    campaigns = campaigns.filter((c) => (c.__matchedVenues || []).some((v) => venueMatchesTab(v, focCategory)));
  }
  const bridgeNetwork = STATE.trafficSheetBridgeNetwork; // undefined = All Networks, '' = the blank-network bucket
  if (tab === 'shzBridges' && bridgeNetwork !== undefined) {
    campaigns = campaigns.filter((c) => (c.__matchedVenues || []).some((v) => (v.network || '') === bridgeNetwork));
  }
  // The Today's Campaigns tab is inherently "right now", so it ignores the chosen Start/End Date
  // and always shows exactly what's active today - every other tab (including FOC / Marketing)
  // respects the date range.
  const gridCampaigns = isTodayTab
    ? campaigns.filter((c) => isActiveOn(c, todayISO()))
    : campaigns.filter((c) => withinDateRange(c, startDate, endDate));
  const summary = locationSummary(gridCampaigns);
  const totalScreens = summary.reduce((sum, s) => sum + (s.screens || 0), 0);
  // Capacity is evaluated against `campaigns` (tab/location-filtered, but NOT narrowed to
  // Start/End Date) so it always reflects the true full Capacity Month regardless of how wide a
  // range is loaded for the grid - filtered down to just that one calendar month via
  // isActiveInMonth so a multi-month Start/End Date range can never inflate the count.
  const capacityMonthLoaded = capacityMonth >= startDate.slice(0, 7) && capacityMonth <= endDate.slice(0, 7);
  const capacitySummary = capacityMonthLoaded
    ? locationSummary(campaigns.filter((c) => isActiveInMonth(c, capacityMonth) && isLiveStatus(c.status)))
    : [];
  const today = todayISO();
  const yesterday = yesterdayISO();
  const todaysCampaigns = campaigns.filter((c) => isActiveOn(c, today));
  const todayExpiringCount = campaigns.filter((c) => c.endDate === today).length;
  const yesterdayActiveCount = campaigns.filter((c) => isActiveOn(c, yesterday)).length;
  const yesterdayExpiredCount = campaigns.filter((c) => c.endDate === yesterday).length;

  let detailHtml;
  if (!data) {
    detailHtml = `<div class="card"><div class="empty">${loading ? "Loading today's traffic sheet..." : 'Pick a date range and click "Apply Date Filter" to load the traffic sheet.'}</div></div>`;
  } else {
    detailHtml = renderQuickStatTiles(todaysCampaigns.length, todayExpiringCount, yesterdayActiveCount, yesterdayExpiredCount)
      + (capacityMonthLoaded
        ? renderSummaryCard(gridCampaigns, summary, totalScreens, capacitySummary, capacityMonth)
        : `<div class="card" style="margin-bottom:16px;"><div class="empty">Capacity Month (${esc(formatMonthLabel(capacityMonth))}) isn't within the loaded Start/End Date range - widen the date range and click "Apply Date Filter" to check capacity for that month.</div></div>`)
      + (isTodayTab ? '' : renderTodayList(todaysCampaigns, tab, stationsByNetwork(data)))
      + renderDayGrid(gridCampaigns, isTodayTab ? '' : startDate, isTodayTab ? '' : endDate);
  }

  const bridgeNetworks = tab === 'shzBridges' ? bridgeNetworksAvailable(data) : [];
  const bridgeNetworkTabs = [
    { key: '__all__', label: 'All Networks' },
    ...bridgeNetworks.map((n) => ({ key: n || '__blank__', label: n || '(No Network)' })),
  ];
  const activeBridgeNetworkKey = bridgeNetwork === undefined ? '__all__' : (bridgeNetwork === '' ? '__blank__' : bridgeNetwork);

  return `
    ${renderTabs(TAB_DEFS, tab, 'App.setTrafficSheetTab')}
    ${tab === 'shzBridges' && bridgeNetworks.length ? renderTabs(bridgeNetworkTabs, activeBridgeNetworkKey, 'App.setTrafficSheetBridgeNetwork') : ''}
    <div class="toolbar">
      <div class="toolbar-actions" style="align-items:flex-end;flex-wrap:wrap;">
        <div class="field" style="margin-bottom:0;"><label>Start Date</label><input type="date" id="tsheet-start-date" value="${esc(startDate)}"></div>
        <div class="field" style="margin-bottom:0;"><label>End Date</label><input type="date" id="tsheet-end-date" value="${esc(endDate)}"></div>
        <div class="field" style="margin-bottom:0;"><label>Capacity Month</label><input type="month" value="${esc(capacityMonth)}" onchange="App.setTrafficSheetCapacityMonth(this.value)" title="Which month the 15/6-per-screen cap is checked against - independent of Start/End Date above"></div>
        <div class="field" style="margin-bottom:0;min-width:220px;"><label>Location</label>
          <select onchange="App.setTrafficSheetLocation(this.value)">
            <option value="">All Locations</option>
            ${locations.map((l) => `<option value="${esc(l)}" ${location === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select>
        </div>
        ${tab === 'focMarketing' ? `
          <div class="field" style="margin-bottom:0;min-width:180px;"><label>Category</label>
            <select onchange="App.setTrafficSheetFocCategory(this.value)">
              <option value="">All Categories</option>
              ${VENUE_CATEGORY_KEYS.map((k) => `<option value="${k}" ${focCategory === k ? 'selected' : ''}>${esc((TAB_DEFS.find((t) => t.key === k) || {}).label || k)}</option>`).join('')}
            </select>
          </div>
        ` : ''}
        <button class="btn btn-orange" type="button" ${loading ? 'disabled' : ''} onclick="App.fetchTrafficSheet()">${loading ? 'Loading...' : 'Apply Date Filter'}</button>
        <button class="btn-outline btn-sm" type="button" ${data ? '' : 'disabled'} onclick="App.downloadTrafficSheetExcel()" title="Only this tab/location/date range">Download Filtered</button>
        <button class="btn-outline btn-sm" type="button" ${data ? '' : 'disabled'} onclick="App.downloadOverallTrafficSheetExcel()" title="One combined 'All Venues' sheet plus one sheet per venue/mall">Download Overall Traffic Sheet</button>
      </div>
    </div>
    ${error ? `<div class="login-error" style="margin-bottom:14px;">${esc(error)}</div>` : ''}
    ${detailHtml}
  `;
}

// Resets the Location filter on tab switch, since a location selected under one tab (e.g. a mall
// name) is meaningless once viewing a different tab (e.g. ENOC) - leaving it set silently
// filtered the new tab down to nothing.
export function setTrafficSheetTab(tab) {
  setState({ trafficSheetTab: tab, trafficSheetLocation: '' });
}

export function setTrafficSheetLocation(value) {
  setState({ trafficSheetLocation: value });
}

export function setTrafficSheetCapacityMonth(value) {
  setState({ trafficSheetCapacityMonth: value });
}

// FOC / Marketing matches every venue category by design (it's a campaign-name filter, not a
// venue one) - this lets it be narrowed back down to just one category (Malls, Dubai Metro,
// In-Stores, etc.) for a better view when there's a lot of FOC/Marketing activity spread across
// every category at once. Not reset on tab switch, unlike Location - there's no reason to lose it
// just from briefly looking at another tab.
export function setTrafficSheetFocCategory(value) {
  setState({ trafficSheetFocCategory: value });
}

// key is one of the tab strip's own synthetic keys ('__all__' or '__blank__' for the real, blank
// network value some bridge venues have) rather than the raw network string directly, since a tab
// strip key can't itself be an empty string - translated back to the real filter value here.
export function setTrafficSheetBridgeNetwork(key) {
  setState({ trafficSheetBridgeNetwork: key === '__all__' ? undefined : (key === '__blank__' ? '' : key) });
}

// Some campaign records tag a genuine SHZ Bridge venue's venueType as plain "Outdoor" instead of
// "Metro Outdoor" (confirmed against real data: the exact same venue name - e.g. "Jabel Ali DXB",
// "World Trade Centre AUH", "Dubai Internet City DXB", "Mall of Emirates AUH" - shows up with BOTH
// venueType values across different campaigns, while its network is always one of the bridge-only
// network names). venueMatchesTab's 'shzBridges' case only recognizes venueType === 'METRO
// OUTDOOR', so a campaign tagged the "Outdoor" way for one of these venues silently matched no tab
// at all instead. Fixed here, once, right after the raw fetch (shared by Traffic Sheet's own fetch
// below and the Client Campaigns Monitor, which also calls fetchTrafficSheetCampaigns) - uses each
// venue's NETWORK as the signal rather than a hardcoded network name list, since bridge network
// values are themselves seasonal/per-campaign branding (see bridgeNetworksAvailable above), so
// "which networks are bridge-only" has to be derived from this same pull, not hardcoded. Mutates
// the venue objects in place - safe since this is freshly-fetched data with no other holders yet.
function normalizeBridgeVenueTypes(data) {
  const campaigns = data?.campaigns || [];
  const bridgeNetworks = new Set();
  campaigns.forEach((c) => (c.venues || []).forEach((v) => {
    if ((v.venueType || '').toUpperCase() === 'METRO OUTDOOR' && v.network) bridgeNetworks.add(v.network);
  }));
  if (bridgeNetworks.size) {
    campaigns.forEach((c) => (c.venues || []).forEach((v) => {
      if ((v.venueType || '').toUpperCase() === 'OUTDOOR' && bridgeNetworks.has(v.network)) v.venueType = 'METRO OUTDOOR';
    }));
  }
  return data;
}

// Re-fetches whenever the API-backed month range needs to change (a different date range was
// picked, or the location dropdown changed doesn't need this - only the API call does).
// Raw fetch against the live API, no STATE side effects - shared by Traffic Sheet's own
// STATE-driven fetch below and by the Client Campaigns Monitor, which caches the result under its
// own loadData() key instead of trafficSheetData.
export async function fetchTrafficSheetCampaigns(startMonth, endMonth) {
  const { data, error } = await supabase.functions.invoke('traffic-sheet-proxy', { body: { startMonth, endMonth } });
  if (error) throw new Error(await edgeFunctionErrorMessage(error));
  if (data?.error) throw new Error(data.error);
  return normalizeBridgeVenueTypes(data);
}

// GET /api/campaigns/{contract}/creatives, proxied through the same edge function as the campaign
// list (see supabase/functions/traffic-sheet-proxy - branches on body.contract vs
// startMonth/endMonth/network, same API key either way). One campaign's actual creative assets:
// approval status, its own date range (can differ from the campaign's booked dates), which venues
// it's matched to, and the underlying files with dimensions/duration/CDN url - none of which the
// bulk campaign list response carries at all.
async function fetchCampaignCreatives(contract) {
  const { data, error } = await supabase.functions.invoke('traffic-sheet-proxy', { body: { contract } });
  if (error) throw new Error(await edgeFunctionErrorMessage(error));
  if (data?.error) throw new Error(data.error);
  return data;
}

// Opens immediately in a loading state rather than waiting on the fetch first - a creatives lookup
// is a live per-campaign API call (not pre-loaded like the campaign list), so there is no data to
// show until it returns; STATE.trafficSheetCreatives carries {contract, loading, data, error} and
// the registerModal('campaignCreatives') renderer below just reads whatever's currently in it,
// same pattern as testing_${key} elsewhere in this codebase for an in-flight action.
export async function openCampaignCreativesModal(contract, campaignName) {
  openModal('campaignCreatives', { contract, campaignName });
  setState({ trafficSheetCreatives: { contract, loading: true, data: null, error: null } });
  try {
    const data = await fetchCampaignCreatives(contract);
    setState({ trafficSheetCreatives: { contract, loading: false, data, error: null } });
  } catch (e) {
    setState({ trafficSheetCreatives: { contract, loading: false, data: null, error: e.message || 'Failed to load creatives' } });
  }
}

function creativeFileSizeLabel(f) {
  const dims = f.width && f.height ? `${f.width}×${f.height}` : '';
  const dur = f.durationSeconds ? `${f.durationSeconds}s` : '';
  return [dims, dur].filter(Boolean).join(', ');
}

// The API has no separate poster/thumbnail image - the file's own url IS the actual video/image.
// For video, setting .currentTime once metadata loads is the reliable cross-browser way to force a
// real decoded frame to paint without autoplaying or showing a play button (a bare <video preload=
// "metadata"> alone renders a black box in most browsers until something scrubs it) - no controls
// attribute and pointer-events:none so a click anywhere on the tile always falls through to the
// wrapping <a>'s href (open the real file) rather than the video element trying to handle it.
function creativeFileThumbnailHtml(f) {
  const isImage = f.type === 'image' || /^image\//.test(f.mimeType || '');
  const isVideo = f.type === 'video' || /^video\//.test(f.mimeType || '');
  const boxStyle = 'width:100%;height:100%;object-fit:cover;display:block;';
  if (isImage) {
    return `<img src="${esc(f.url || '')}" alt="${esc(f.fileName || '')}" loading="lazy" style="${boxStyle}">`;
  }
  if (isVideo) {
    return `<video src="${esc(f.url || '')}" preload="metadata" muted playsinline style="${boxStyle}pointer-events:none;" onloadedmetadata="this.currentTime=Math.min(0.5, this.duration||0.5)"></video>`;
  }
  return `<div style="${boxStyle}display:flex;align-items:center;justify-content:center;background:var(--row-alt);" class="small muted">${esc(f.type || 'file')}</div>`;
}

function creativeFileTileHtml(f) {
  return `
    <a href="${esc(f.url || '#')}" target="_blank" rel="noopener" title="${esc(f.fileName || f.fileId || 'file')}" style="display:block;text-decoration:none;color:inherit;border:1px solid var(--border);border-radius:6px;overflow:hidden;">
      <div style="width:100%;aspect-ratio:16/9;background:#000;overflow:hidden;">${creativeFileThumbnailHtml(f)}</div>
      <div class="small" style="padding:4px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.fileName || f.fileId || 'file')}</div>
      <div class="small muted" style="padding:0 6px 4px;">${esc(creativeFileSizeLabel(f))}</div>
    </a>
  `;
}

registerModal('campaignCreatives', (modalData) => {
  const state = STATE.trafficSheetCreatives;
  const title = esc(modalData.campaignName || 'Campaign');
  if (!state || state.contract !== modalData.contract) {
    return `<h3>${title} - Creatives</h3><div class="empty">Loading...</div><div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>`;
  }
  if (state.loading) {
    return `<h3>${title} - Creatives</h3><div class="empty">Loading creatives...</div><div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>`;
  }
  if (state.error) {
    return `<h3>${title} - Creatives</h3><div class="login-error">${esc(state.error)}</div><div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>`;
  }
  const d = state.data || {};
  const creatives = d.creatives || [];
  if (!creatives.length) {
    return `<h3>${title} - Creatives</h3><div class="empty">No creatives found for this campaign yet.</div><div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>`;
  }
  const body = creatives.map((cr) => `
    <div class="card" style="margin-bottom:10px;">
      <div class="card-head"><h3 style="font-size:14px;">${esc(cr.creativeName || cr.creativeId || 'Creative')}</h3>${statusBadge(cr.status)}</div>
      <div class="small muted">${esc(cr.startDate || '')} - ${esc(cr.endDate || '')}${cr.venues?.length ? ` · ${esc(cr.venues.join(', '))}` : ''}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-top:8px;">
        ${(cr.files || []).map(creativeFileTileHtml).join('')}
      </div>
    </div>
  `).join('');
  return `
    <h3>${title} - Creatives</h3>
    <div class="small muted" style="margin-bottom:8px;">${esc(String(d.creativeCount ?? creatives.length))} creative(s), as of ${esc(d.generatedAt || '')}</div>
    ${body}
    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

async function runTrafficSheetFetch(startDate, endDate) {
  const startMonth = startDate.slice(0, 7);
  const endMonth = endDate.slice(0, 7);
  setState({ trafficSheetStartDate: startDate, trafficSheetEndDate: endDate, trafficSheetLoading: true, trafficSheetError: null });
  try {
    const data = await fetchTrafficSheetCampaigns(startMonth, endMonth);
    setState({ trafficSheetData: data, trafficSheetLoading: false });
  } catch (e) {
    setState({ trafficSheetLoading: false, trafficSheetError: e.message || 'Failed to fetch traffic sheet' });
  }
}

// The explicit "Apply Date Filter" action - Start/End Date are the primary controls now; the
// month(s) needed for the actual API call are derived from whatever dates are picked.
export async function fetchTrafficSheet() {
  const defaults = defaultDateRange();
  const startDate = document.getElementById('tsheet-start-date').value || defaults.start;
  const endDate = document.getElementById('tsheet-end-date').value || defaults.end;
  await runTrafficSheetFetch(startDate, endDate);
}

function autoFetchTrafficSheet() {
  const { start, end } = defaultDateRange();
  return runTrafficSheetFetch(start, end);
}

// Matches the customer's own reference export format (see lib/excelExport.js): Campaign Name,
// Start, End, Campaign Days, Loop Count, Status (no Contract column - deliberately dropped), then
// a merged "Mon YYYY" header per month spanning day-number ("01".."31") sub-columns, active-day
// cells filled yellow, split into "Active Campaigns" / "FOC / Marketing" sections (same division
// Today's Active Campaigns already shows on-screen), each with its own TOTAL / "Number of
// Campaigns" row. A plain CSV can't do merged headers or real borders, so this downloads a styled
// .xlsx instead.
// Exactly what's currently on screen (tab/location/date range all applied).
export async function downloadTrafficSheetExcel() {
  const data = STATE.trafficSheetData;
  if (!data) return;

  const tab = STATE.trafficSheetTab || 'malls';
  const isTodayTab = tab === 'today';
  const location = STATE.trafficSheetLocation || '';
  const defaults = defaultDateRange();
  const startDate = STATE.trafficSheetStartDate || defaults.start;
  const endDate = STATE.trafficSheetEndDate || defaults.end;

  let filtered = filteredCampaigns(data, tab, location);
  if (tab === 'focMarketing') filtered = filtered.filter(isFocMarketingCampaign);
  const campaigns = isTodayTab
    ? filtered.filter((c) => isActiveOn(c, todayISO()))
    : filtered.filter((c) => withinDateRange(c, startDate, endDate));
  let dates = collectDates(campaigns);
  if (!isTodayTab) dates = dates.filter((d) => inDateRange(d, startDate, endDate));
  const tabLabel = (TAB_DEFS.find((t) => t.key === tab) || {}).label || tab;
  const filenameTag = `${tabLabel.replace(/\s+/g, '-')}-${startDate}-to-${endDate}`;

  const dateGroups = groupDatesByMonth(dates);
  const regularCampaigns = campaigns.filter((c) => !isFocMarketingCampaign(c));
  const focCampaigns = campaigns.filter(isFocMarketingCampaign);
  await exportTrafficSheetExcel(`traffic-sheet-${filenameTag}.xlsx`, {
    regularCampaigns, focCampaigns, dates, dateGroups, monthLabel: formatMonthLabel,
  });
}

// Modeled on the customer's own reference "Overall Traffic Sheet" export: one combined "All
// Venues" sheet (every campaign, one row per venue it runs on, with Venue/Venue Type columns) plus
// one sheet per individual venue/mall with just that venue's own campaigns - "if in overall sheet
// there are 5 malls then the main sheet shows the full summary and then split sheets by mall".
// Uses every campaign in the currently loaded month(s), ignoring tab/location/date filters
// entirely - Contract is still excluded, consistent with the Filtered download.
export async function downloadOverallTrafficSheetExcel() {
  const data = STATE.trafficSheetData;
  if (!data) return;
  const campaigns = data.campaigns || [];
  const dates = collectDates(campaigns);
  const dateGroups = groupDatesByMonth(dates);

  const allVenueRows = [];
  const byVenue = new Map();
  campaigns.forEach((c) => {
    (c.venues || []).forEach((v) => {
      const venue = mergeVenueName(v.venue, v.venueType);
      allVenueRows.push({ ...c, venue, venueType: v.venueType || '' });
      if (!byVenue.has(venue)) byVenue.set(venue, []);
      byVenue.get(venue).push(c);
    });
  });

  const allVenuesSheet = {
    name: 'All Venues',
    extraColumns: [
      { label: 'Venue', width: 24, value: (r) => r.venue || '' },
      { label: 'Venue Type', width: 16, value: (r) => r.venueType || '' },
    ],
    regularRows: allVenueRows.filter((r) => !isFocMarketingCampaign(r)),
    focRows: allVenueRows.filter(isFocMarketingCampaign),
  };
  // A venue-less row (blank venue name in the source data - happens occasionally) still counts
  // in the "All Venues" summary above via allVenueRows, but doesn't get its own sheet here - there's
  // no meaningful venue to name that sheet after, and safeSheetName()'s fallback for a blank name
  // is the literal string "Sheet", which reads as a stray/default tab rather than real data.
  const venueSheets = [...byVenue.entries()]
    .filter(([venue]) => venue)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([venue, venueCampaigns]) => ({
      name: venue,
      regularRows: venueCampaigns.filter((c) => !isFocMarketingCampaign(c)),
      focRows: venueCampaigns.filter(isFocMarketingCampaign),
    }));

  await exportOverallTrafficSheetExcel(`Overall-Traffic-Sheet-${todayISO()}.xlsx`, {
    sheets: [allVenuesSheet, ...venueSheets],
    dates, dateGroups, monthLabel: formatMonthLabel,
  });
}
