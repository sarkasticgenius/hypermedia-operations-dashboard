// One-off script that pulled the real-data arrays (ASSET_INVENTORY_ROWS, SIM_IMPORT_ROWS,
// BROADSIGN_LOCATIONS, and the real dashboardSections links) out of the original
// hypermedia-operations.html and wrote them to scripts/seed-data/*.json, which is what
// scripts/seed.mjs actually reads. Kept here for provenance/reproducibility - you shouldn't need
// to run this again unless the legacy HTML file changes and you want to re-pull from it. Point
// SOURCE_HTML_PATH at wherever that file lives on your machine (it is not part of this repo).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_HTML_PATH = process.env.SOURCE_HTML_PATH
  || path.join(__dirname, '..', '..', 'hypermedia-operations.html');
const OUT_DIR = path.join(__dirname, 'seed-data');

const source = fs.readFileSync(SOURCE_HTML_PATH, 'utf-8');

function extractArrayLiteral(src, varName) {
  const startMarker = `const ${varName} = [`;
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`${varName} not found in ${SOURCE_HTML_PATH}`);
  let i = startIdx + startMarker.length - 1; // index of '['
  let depth = 0;
  let inString = false, stringChar = null, escaped = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = true; stringChar = ch; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  const literalText = src.slice(startIdx + startMarker.length - 1, i);
  // Safe here because the input is your own local trusted file, not user-supplied data.
  // eslint-disable-next-line no-new-func
  return new Function('uid', `return ${literalText};`)((p) => p + '_seed_' + Math.random().toString(36).slice(2, 9));
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const assetInventoryRows = extractArrayLiteral(source, 'ASSET_INVENTORY_ROWS');
fs.writeFileSync(path.join(OUT_DIR, 'asset-inventory-rows.json'), JSON.stringify(assetInventoryRows));
console.log('asset_inventory rows:', assetInventoryRows.length);

const simImportRows = extractArrayLiteral(source, 'SIM_IMPORT_ROWS');
fs.writeFileSync(path.join(OUT_DIR, 'sim-import-rows.json'), JSON.stringify(simImportRows));
console.log('sim_cards rows:', simImportRows.length);

const broadsignLocations = extractArrayLiteral(source, 'BROADSIGN_LOCATIONS');
fs.writeFileSync(path.join(OUT_DIR, 'broadsign-locations.json'), JSON.stringify(broadsignLocations));
console.log('broadsign locations rows:', broadsignLocations.length);

const dashboardSections = extractArrayLiteral(source, 'dashboardSections');
fs.writeFileSync(path.join(OUT_DIR, 'dashboard-sections.json'), JSON.stringify(dashboardSections));
console.log('dashboard sections:', dashboardSections.length);

console.log('Done. Wrote JSON to', OUT_DIR);
