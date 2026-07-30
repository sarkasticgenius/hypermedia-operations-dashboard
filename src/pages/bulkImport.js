import { supabase } from '../supabaseClient.js';
import { STATE, openModal, closeModal, toast, invalidate } from '../state.js';
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

// Entities where an uploaded row can land on an *existing* record (matchKey configs) get a
// staged review: the file is parsed and matched entirely in memory - nothing touches the real
// tables - then the admin sees exactly what would change and approves or cancels it. This is the
// safety net for hand-run imports against live inventory data until the generic Asset Inventory
// API Sync (Settings > Integrations) is fully configured and pulling automatically; insert-only
// entities (every row is unambiguously new) skip straight to import since there's no existing
// data a bad row could clobber.
export async function runBulkImportPreview(event, entity) {
  event.preventDefault();
  const config = IMPORT_CONFIGS[entity];
  const file = document.getElementById('bulk-file').files[0];
  if (!file || !config) return;
  try {
    const rows = await parseSpreadsheetFile(file);
    if (!rows.length) { toast('That file has no data rows.', 'error'); return; }
    const existing = await config.list();
    const inserts = [];
    const updates = [];
    let skipped = 0;
    for (const raw of rows) {
      const mapped = config.transform(mapImportRow(raw, config.aliases));
      if (!mapped[config.required]) { skipped++; continue; }
      const match = config.matchKey(mapped, existing);
      if (match) {
        const fields = config.updateFields(mapped);
        const changes = Object.entries(fields)
          .filter(([k, v]) => String(match[k] ?? '') !== String(v ?? ''))
          .map(([k, v]) => [k, match[k], v]);
        if (changes.length) updates.push({ matchId: match.id, label: match.name || match.sim_number || mapped.name || '', changes });
      } else {
        inserts.push({ mapped, label: mapped.name || '' });
      }
    }
    if (!inserts.length && !updates.length) {
      toast(skipped ? `No changes found - ${skipped} row(s) skipped (missing required field).` : 'No changes found - every row already matches what\'s on file.');
      return;
    }
    openModal('bulkImport', { entity, inserts, updates, skipped });
  } catch (e) {
    toast(e.message || 'Import failed', 'error');
  }
}

export async function approveBulkImport(entity) {
  const config = IMPORT_CONFIGS[entity];
  const data = STATE.modal?.data;
  if (!config || !data) return;
  const checkedInserts = [...document.querySelectorAll('[data-import-insert]:checked')].map((el) => Number(el.dataset.importInsert));
  const checkedUpdates = [...document.querySelectorAll('[data-import-update]:checked')].map((el) => Number(el.dataset.importUpdate));
  try {
    let inserted = 0;
    let updated = 0;
    for (const i of checkedInserts) {
      await config.save(data.inserts[i].mapped);
      inserted++;
    }
    for (const i of checkedUpdates) {
      const u = data.updates[i];
      const fields = Object.fromEntries(u.changes.map(([k, , newVal]) => [k, newVal]));
      const { error } = await supabase.from(config.table).update(fields).eq('id', u.matchId);
      if (error) throw error;
      updated++;
    }
    if (!inserted && !updated) { toast('Nothing selected to import.', 'error'); return; }
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

// Insert-only entities (assets/locations/campaigns/permits) - every valid row is unambiguously
// new, so this still parses the whole file up front but applies it in one step rather than
// staging a review nothing would actually be reviewing.
export async function runBulkImport(event, entity) {
  event.preventDefault();
  const config = IMPORT_CONFIGS[entity];
  const file = document.getElementById('bulk-file').files[0];
  if (!file || !config) return;
  try {
    const rows = await parseSpreadsheetFile(file);
    let inserted = 0;
    for (const raw of rows) {
      const mapped = config.transform(mapImportRow(raw, config.aliases));
      if (!mapped[config.required]) continue;
      await config.save(mapped);
      inserted++;
    }
    await logAudit(`Bulk import ${config.label}`, `${inserted} new`);
    invalidate(config.dataKey || entity);
    closeModal();
    toast(`Imported: ${inserted} new`);
  } catch (e) {
    toast(e.message || 'Import failed', 'error');
  }
}

function fieldDiffHtml(changes) {
  return changes.map(([k, oldVal, newVal]) => `<div><b>${esc(k)}:</b> ${oldVal ? `<span class="muted">${esc(oldVal)}</span> &rarr; ` : ''}<span style="color:#c0392b;">${esc(newVal)}</span></div>`).join('');
}

registerModal('bulkImport', (data) => {
  const config = IMPORT_CONFIGS[data.entity];
  const isStaged = !!config.matchKey;

  if (isStaged && data.inserts) {
    const { inserts, updates, skipped } = data;
    const insertRows = inserts.map((r, i) => `
      <tr><td><input type="checkbox" data-import-insert="${i}" checked></td><td>${esc(r.label)}</td></tr>
    `).join('') || `<tr><td colspan="2"><div class="empty">None</div></td></tr>`;
    const updateRows = updates.map((r, i) => `
      <tr><td><input type="checkbox" data-import-update="${i}" checked></td><td>${esc(r.label)}</td><td class="small">${fieldDiffHtml(r.changes)}</td></tr>
    `).join('') || `<tr><td colspan="3"><div class="empty">None</div></td></tr>`;
    return `
      <h3>Bulk Import - ${esc(config.label)}: Review Changes</h3>
      <p class="small muted">Parsed and matched in memory only - nothing has been saved yet. Uncheck any row you don't want, then approve.${skipped ? ` ${skipped} row(s) skipped (missing required field).` : ''}</p>
      ${inserts.length ? `
        <h4 style="margin:14px 0 6px;">${inserts.length} New Row(s)</h4>
        <table><thead><tr><th style="width:28px;"></th><th>Name</th></tr></thead><tbody>${insertRows}</tbody></table>
      ` : ''}
      ${updates.length ? `
        <h4 style="margin:14px 0 6px;">${updates.length} Existing Row(s) With Changes</h4>
        <table><thead><tr><th style="width:28px;"></th><th>Match</th><th>Changed Fields (new value)</th></tr></thead><tbody>${updateRows}</tbody></table>
      ` : ''}
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="button" class="btn btn-orange" onclick="App.approveBulkImport('${data.entity}')">Approve &amp; Import</button>
      </div>
    `;
  }

  const matchNote = isStaged
    ? `<p class="small muted">Rows matching an existing record (by ${data.entity === 'simCards' ? 'SIM number' : 'Asset ID or name+venue'}) are compared field by field - you'll see exactly what would change before anything is saved. Unmatched rows show as new.</p>`
    : '';
  return `
    <h3>Bulk Import - ${esc(config.label)}</h3>
    <p class="small muted">Upload a CSV or Excel file. Column headers are matched flexibly regardless of order or casing.</p>
    ${matchNote}
    <form onsubmit="App.${isStaged ? 'runBulkImportPreview' : 'runBulkImport'}(event, '${data.entity}')">
      <div class="field"><label>File</label><input id="bulk-file" type="file" accept=".csv,.xlsx,.xls" required></div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">${isStaged ? 'Preview Changes' : 'Import'}</button>
      </div>
    </form>
  `;
});
