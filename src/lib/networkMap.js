// Real satellite map for the Broadsign/Grassfish console pages, using Leaflet + Esri's free World
// Imagery tiles (no API key/billing needed, unlike Google/Mapbox satellite). This is a genuine live
// map, not the artifact-sandbox situation - GitHub Pages sets no CSP, so tile requests to Esri's
// servers load normally from a real browser.
//
// Leaflet owns a real, persistent DOM subtree once created (its own event listeners, tile cache,
// pan/zoom state) that must NOT be torn down and rebuilt from an HTML string on every render() -
// exactly the case state.js's onAfterRender hook exists for (see its own comment: "currently unused
// - no registered page needs it"; this is the first). The map instance lives in a DETACHED div kept
// in this module, moved into whatever placeholder the current render happens to contain, rather
// than recreated - so pan/zoom position survives an unrelated setState() elsewhere in the app.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { onAfterRender } from '../state.js';

const SLOT_ID = 'network-map-slot';
// Centered/zoomed on the UAE - every location this map ever plots is here, per Digital Directory's
// own fleet (see [[project_wifi_lan_only_venues]]-adjacent context: this company operates in the
// UAE). Re-centers only ever happen by the viewer's own pan/zoom, never programmatically after
// first load, so their position holds across re-renders same as any real map app.
const INITIAL_CENTER = [24.6, 54.6];
const INITIAL_ZOOM = 8;

let mapInstance = null;
let mapContainer = null;
let markersLayer = null;
let pendingMarkers = [];
let hookRegistered = false;

function ensureMap() {
  if (mapInstance) return;
  mapContainer = document.createElement('div');
  mapContainer.style.width = '100%';
  mapContainer.style.height = '100%';
  mapInstance = L.map(mapContainer, { scrollWheelZoom: true }).setView(INITIAL_CENTER, INITIAL_ZOOM);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    maxZoom: 19,
  }).addTo(mapInstance);
  markersLayer = L.layerGroup().addTo(mapInstance);
}

// heatmapColor's own thresholds (src/data/locationStats.js), duplicated as plain hex rather than
// imported - that function takes a {offline,total} stats object and this needs the same 4 colors
// keyed off a single ratio, not worth reshaping one call site's stats object just to reuse it.
function markerColor(offline, total) {
  if (total === 0) return '#f4f3f0';
  if (offline === 0) return '#1f9d55';
  const ratio = offline / total;
  if (ratio <= 0.25) return '#e0a13a';
  if (ratio <= 0.5) return '#e07a2c';
  return '#c0392b';
}

function drawMarkers() {
  markersLayer.clearLayers();
  pendingMarkers.forEach((m) => {
    const color = markerColor(m.offline, m.total);
    L.circleMarker([m.lat, m.lng], {
      radius: 7 + Math.min(6, Math.round(m.offline / 2)),
      color: '#1a1206',
      weight: 1,
      fillColor: color,
      fillOpacity: 0.88,
    })
      .bindPopup(
        `<b>${escapeHtml(m.name)}</b><br>${m.offline} offline / ${m.total} total` +
        (m.onClick ? `<br><a href="#" onclick="${escapeHtml(m.onClick)};return false;">View offline assets</a>` : '')
      )
      .addTo(markersLayer);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Called by a page's render function with the CURRENT marker set every time it renders in map mode
// - cheap (just an array swap), actual re-drawing happens once in the afterRender hook below rather
// than here, since this runs during HTML-string construction, before the slot div this needs even
// exists in the DOM yet.
export function setNetworkMapMarkers(markers) {
  pendingMarkers = markers;
}

// The placeholder a page's render() output includes when it wants the map visible this render -
// literally just an empty, sized div for the hook below to find and fill. Omit this (render
// something else instead) to hide the map on a render where it shouldn't show; the Leaflet instance
// itself stays alive in memory either way, detached, ready to reattach next time it's wanted.
export function networkMapSlotHtml(heightPx) {
  return `<div id="${SLOT_ID}" style="width:100%;height:${heightPx || 480}px;border-radius:10px;overflow:hidden;"></div>`;
}

if (!hookRegistered) {
  hookRegistered = true;
  onAfterRender(() => {
    const slot = document.getElementById(SLOT_ID);
    if (!slot) return; // Not in map mode this render - leave the live instance detached and alone.
    ensureMap();
    if (mapContainer.parentElement !== slot) {
      slot.appendChild(mapContainer);
      // Leaflet sizes its tile grid from the container's dimensions AT THE MOMENT OF INIT/MOVE - a
      // freshly-appended div hasn't necessarily been laid out by the browser yet in this same tick,
      // so invalidateSize() is deferred one frame rather than called synchronously here (confirmed
      // needed: without the defer, the map rendered as a blank grey tile until the next manual pan).
      requestAnimationFrame(() => mapInstance.invalidateSize());
    }
    drawMarkers();
  });
}
