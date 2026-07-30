import { supabase } from '../supabaseClient.js';
import { openModal, closeModal, toast, invalidate, setState } from '../state.js';
import { registerModal } from '../modals.js';
import { parseSpreadsheetFile, mapImportRow } from '../lib/csv.js';
import { saveAsset } from '../data/assets.js';
import { saveLocation } from '../data/locations.js';
import { saveCampaign } from '../data/campaigns.js';
import { savePermit } from '../data/permits.js';
import { saveSimCard, listSimCards } from '../data/simCards.js';
import { saveAssetInventory, listAssetInventory } from '../data/assetsInventory.js';
import { invalidateAssetInventoryCaches } from './assetsInventory.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';

// Mirrors the original app's TEMPLATE_HEADERS/FIELD_ALIASES - column order/casing doesn't
// matter, mapImportRow() matches on normalized header text.
//
// Two import styles here:
//  - insert-only (assets/locations/campaigns/permits): every row becomes a new record, same as
//    the original app's bulk import.
//  - match-and-update (simCards/assetsInventory): `matchKey` finds an existing row by a natural
//    id, and `updateFields` returns ONLY the columns present in the sheet (so a bulk update never
//    blanks out existing good data with an empty sheet cell) - unmatched rows still insert as new.
const IMPORT_CONFIGS = {
  assets: {
    label: 'Hardware Assets',
    aliases: {
      name: ['Name'], category: ['Category'], unitPrice: ['Unit Price', 'Price'],
      stockAvailable: ['Stock Available', 'Stock Warehouse'], stockOnSite: ['Stock On Site', 'Stock Site'],
      serialNumber: ['Serial Number', 'Serial'], warrantyExpiry: ['Warranty Expiry'],
      dateOfRent: ['Date of Rent'], maintenanceLocation: ['Maintenance Location'],
      maintenanceContractor: ['Maintenance Contractor'], status: ['Status'], notes: ['Notes'],
    },
    required: 'name',
    transform: (m) => ({ ...m, status: m.status || 'Active' }),
    save: saveAsset,
    dataKey: 'assets',
  },
  locations: {
    label: 'Locations',
    aliases: { name: ['Name'], type: ['Type'], address: ['Address'], notes: ['Notes'] },
    required: 'name',
    transform: (m) => ({ ...m, type: m.type === 'Installed' ? 'Installed' : 'Planned' }),
    save: saveLocation,
    dataKey: 'locationsPage',
  },
  campaigns: {
    label: 'Digital Campaigns',
    aliases: {
      name: ['Name'], client: ['Client'], locations: ['Locations'],
      startDate: ['Start Date'], endDate: ['End Date'], budget: ['Budget'], notes: ['Notes'],
    },
    required: 'name',
    transform: (m) => ({ ...m, status: 'Scheduled' }),
    save: saveCampaign,
    dataKey: 'campaigns',
  },
  permits: {
    label: 'Permits',
    aliases: {
      title: ['Title'], type: ['Type'], location: ['Location'], issuedBy: ['Issued By'],
      issueDate: ['Issue Date'], expiryDate: ['Expiry Date'], notes: ['Notes'],
    },
    required: 'title',
    transform: (m) => m,
    save: savePermit,
    dataKey: 'permits',
  },
  simCards: {
    label: 'SIM Cards',
    aliases: {
      simNumber: ['SIM Number', 'Sim Number', 'Number'], iccid: ['ICCID'], carrier: ['Carrier'],
      dataPlan: ['Data Plan', 'Plan'], billingCost: ['Billing Cost', 'Cost'], status: ['Status'], notes: ['Notes'],
    },
    required: 'simNumber',
    transform: (m) => m,
    table: 'sim_cards',
    list: listSimCards,
    matchKey: (mapped, existing) => existing.find((e) => e.sim_number === mapped.simNumber),
    updateFields: (m) => {
      const out = {};
      if (m.iccid) out.iccid = m.iccid;
      if (m.carrier) out.carrier = m.carrier;
      if (m.dataPlan) out.data_plan = m.dataPlan;
      if (m.billingCost) out.billing_cost = Number(m.billingCost);
      if (m.status) out.status = m.status;
      if (m.notes) out.notes = m.notes;
      return out;
    },
    save: saveSimCard,
    dataKey: 'simCardsPage',
  },
  assetsInventory: {
    label: 'Asset Inventory',
    aliases: {
      sourceAssetId: ['Asset ID', 'Source Asset ID'], name: ['Name'], venue: ['Venue'], location: ['Location'],
      category: ['Category'], format: ['Format'], playerBoxId: ['Player Box ID'], playerType: ['Player Type'],
      anydeskId: ['AnyDesk ID'], teamviewerId: ['TeamViewer ID'], sensorId: ['Sensor ID'],
      lat: ['Latitude'], lng: ['Longitude'], multiplier: ['Multiplier'], networks: ['Networks'],
    },
    required: 'name',
    transform: (m) => ({ ...m, sourceAssetId: m.sourceAssetId ? Number(m.sourceAssetId) : undefined }),
    table: 'asset_inventory',
    list: listAssetInventory,
    matchKey: (mapped, existing) => (mapped.sourceAssetId && existing.find((e) => e.source_asset_id === mapped.sourceAssetId))
      || existing.find((e) => e.name === mapped.name && e.venue === mapped.venue),
    updateFields: (m) => {
      const out = {};
      if (m.venue) out.venue = m.venue;
      if (m.location) out.location = m.location;
      if (m.category) out.category = m.category;
      if (m.format) out.format = m.format;
      if (m.playerBoxId) out.player_box_id = m.playerBoxId;
      if (m.playerType) out.player_type = m.playerType;
      if (m.anydeskId) out.anydesk_id = m.anydeskId;
      if (m.teamviewerId) out.teamviewer_id = m.teamviewerId;
      if (m.sensorId) out.sensor_id = m.sensorId;
      if (m.lat) out.lat = m.lat;
      if (m.lng) out.lng = m.lng;
      if (m.multiplier) out.multiplier = m.multiplier;
      return out;
    },
    save: saveAssetInventory,
    dataKey: 'assetsInventoryPage',
  },
};

export function openBulkImport(entity) {
  openModal('bulkImport', { entity });
}

export async function runBulkImport(event, entity) {
  event.preventDefault();
  const config = IMPORT_CONFIGS[entity];
  const file = document.getElementById('bulk-file').files[0];
  if (!file || !config) return;
  try {
    const rows = await parseSpreadsheetFile(file);
    const existing = config.list ? await config.list() : [];
    let inserted = 0;
    let updated = 0;
    for (const raw of rows) {
      const mapped = config.transform(mapImportRow(raw, config.aliases));
      if (!mapped[config.required]) continue;
      const match = config.matchKey ? config.matchKey(mapped, existing) : null;
      if (match) {
        const fields = config.updateFields ? config.updateFields(mapped) : {};
        if (Object.keys(fields).length) {
          const { error } = await supabase.from(config.table).update(fields).eq('id', match.id);
          if (error) throw error;
        }
        updated++;
      } else {
        await config.save(mapped);
        inserted++;
      }
    }
    await logAudit(`Bulk import ${config.label}`, `${inserted} new, ${updated} updated`);
    // Asset Inventory is the baseline every other workspace matches screens against, each with
    // its own independent cache - busting just this one key would leave the rest stale.
    if (entity === 'assetsInventory') invalidateAssetInventoryCaches();
    else invalidate(config.dataKey || entity);
    closeModal();
    toast(`Imported: ${inserted} new, ${updated} updated`);
  } catch (e) {
    toast(e.message || 'Import failed', 'error');
  }
}

registerModal('bulkImport', (data) => {
  const config = IMPORT_CONFIGS[data.entity];
  const matchNote = config.matchKey
    ? `<p class="small muted">Rows matching an existing record (by ${data.entity === 'simCards' ? 'SIM number' : 'Asset ID or name+venue'}) update only the fields present in the sheet - blank cells never overwrite existing data. Unmatched rows are added as new.</p>`
    : '';
  return `
    <h3>Bulk Import - ${esc(config.label)}</h3>
    <p class="small muted">Upload a CSV or Excel file. Column headers are matched flexibly regardless of order or casing.</p>
    ${matchNote}
    <form onsubmit="App.runBulkImport(event, '${data.entity}')">
      <div class="field"><label>File</label><input id="bulk-file" type="file" accept=".csv,.xlsx,.xls" required></div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Import</button>
      </div>
    </form>
  `;
});
