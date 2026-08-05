import { supabase } from '../supabaseClient.js';
import { STATE, openModal, closeModal, toast, invalidate } from '../state.js';
import { registerModal } from '../modals.js';
import { parseSpreadsheetFile, mapImportRow, parseImportDate } from '../lib/csv.js';
import { saveAsset } from '../data/assets.js';
import { saveLocation } from '../data/locations.js';
import { saveCampaign } from '../data/campaigns.js';
import { savePermit } from '../data/permits.js';
import { saveMetroPic, listMetroPics } from '../data/metroPics.js';
import { saveSimCard, listSimCards } from '../data/simCards.js';
import { saveAssetInventory, listAssetInventory } from '../data/assetsInventory.js';
import { ensureNetwork } from '../data/networks.js';
import { invalidateAssetInventoryCaches } from './assetsInventory.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';

// Networks is a many-to-many relation (asset_inventory_networks), not a plain column, so it can't
// go through the generic updateFields()/supabase.update() path the other fields use - split on
// comma/semicolon/pipe, dedupe case-insensitively (keeping first-seen casing), same separators an
// admin would naturally use in a spreadsheet cell.
function parseNetworkNames(text) {
  const seen = new Map();
  String(text || '').split(/[,;|]/).forEach((part) => {
    const trimmed = part.trim();
    if (trimmed && !seen.has(trimmed.toLowerCase())) seen.set(trimmed.toLowerCase(), trimmed);
  });
  return [...seen.values()];
}

function sameNameSet(a, b) {
  const norm = (arr) => [...arr].map((s) => s.toLowerCase()).sort().join('|');
  return norm(a) === norm(b);
}

// ensureNetwork matches an existing network case-insensitively or creates a new one - same
// resolution the "Add Network" button on the Asset Inventory edit form uses.
async function resolveNetworkIds(names) {
  const ids = [];
  for (const name of names) {
    const net = await ensureNetwork(name);
    if (net) ids.push(net.id);
  }
  return ids;
}

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
    transform: (m) => ({ ...m, status: m.status || 'Spare' }),
    dateFields: ['warrantyExpiry', 'dateOfRent'],
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
    dateFields: ['startDate', 'endDate'],
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
    dateFields: ['issueDate', 'expiryDate'],
    save: savePermit,
    dataKey: 'permits',
  },
  metroPic: {
    label: 'Metro PIC',
    aliases: {
      station: ['Company Name', 'Station', 'Station Name'], picName: ['PIC Name', 'Name'],
      designation: ['Designation'], phone: ['Phone'], email: ['Email'],
      validityStart: ['Validity Start'], validityEnd: ['Validity End'],
      eidNumber: ['EID Number', 'Emirates ID Number'], notes: ['Notes'],
    },
    required: 'station',
    transform: (m) => m,
    dateFields: ['validityStart', 'validityEnd'],
    table: 'metro_pics',
    list: listMetroPics,
    // Same company (Company Name) or same person (Emirates ID) re-appearing in a re-uploaded
    // sheet is a renewal, not a new record - match on either and overwrite validity/status.
    matchKey: (mapped, existing) => {
      const eid = (mapped.eidNumber || '').trim().toLowerCase();
      const station = (mapped.station || '').trim().toLowerCase();
      return existing.find((e) => (eid && (e.eid_number || '').trim().toLowerCase() === eid))
        || existing.find((e) => (station && (e.station || '').trim().toLowerCase() === station));
    },
    // Dedup key for rows within the *same* uploaded file - a later row with the same key wins,
    // so a sheet listing the same PIC twice doesn't insert two records.
    dedupeKey: (m) => (m.eidNumber || '').trim().toLowerCase() || (m.station || '').trim().toLowerCase(),
    updateFields: (m) => {
      const out = {};
      if (m.picName) out.pic_name = m.picName;
      if (m.designation) out.designation = m.designation;
      if (m.phone) out.phone = m.phone;
      if (m.email) out.email = m.email;
      if (m.validityStart) out.validity_start = m.validityStart;
      if (m.validityEnd) out.validity_end = m.validityEnd;
      if (m.eidNumber) out.eid_number = m.eidNumber;
      if (m.notes) out.notes = m.notes;
      return out;
    },
    save: saveMetroPic,
    dataKey: 'metroPics',
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
    // Every aliased field gets applied - a bulk update must never silently skip a column just
    // because it wasn't hand-picked here (name and sourceAssetId were previously missing, so a
    // sheet correcting either was silently ignored on an update). Networks is handled separately
    // below (networksField) since it isn't a plain column.
    updateFields: (m) => {
      const out = {};
      if (m.sourceAssetId) out.source_asset_id = m.sourceAssetId;
      if (m.name) out.name = m.name;
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
    networksField: 'networks',
    save: saveAssetInventory,
    dataKey: 'assetsInventoryPage',
  },
};

export function openBulkImport(entity) {
  openModal('bulkImport', { entity });
}

// Normalizes every field listed in config.dateFields to ISO before it ever reaches Supabase -
// see parseImportDate() in lib/csv.js for why this is needed. Unparseable values are dropped
// (field left blank) rather than sent through, since garbage would 500 the whole row.
function normalizeImportDates(mapped, dateFields) {
  if (dateFields) {
    for (const f of dateFields) {
      if (mapped[f] !== undefined) {
        const iso = parseImportDate(mapped[f]);
        if (iso) mapped[f] = iso; else delete mapped[f];
      }
    }
  }
  return mapped;
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
    const insertByDedupeKey = new Map();
    const updateByMatchId = new Map();
    let skipped = 0;
    let duplicates = 0;
    for (const raw of rows) {
      const mapped = normalizeImportDates(config.transform(mapImportRow(raw, config.aliases)), config.dateFields);
      if (!mapped[config.required]) { skipped++; continue; }
      const match = config.matchKey(mapped, existing);
      const label = mapped.name || mapped.station || mapped.picName || mapped.simNumber || '';
      if (match) {
        const fields = config.updateFields(mapped);
        const changes = Object.entries(fields)
          .filter(([k, v]) => String(match[k] ?? '') !== String(v ?? ''))
          .map(([k, v]) => [k, match[k], v]);
        // Networks isn't a plain column (asset_inventory_networks is many-to-many), so it's diffed
        // separately and applied later via resolveNetworkIds() rather than the generic column
        // update - but it still shows up in `changes` for the review screen like everything else.
        let networkNamesTarget = null;
        if (config.networksField && mapped[config.networksField] !== undefined) {
          const targetNames = parseNetworkNames(mapped[config.networksField]);
          const existingNames = match.networkNames || [];
          if (!sameNameSet(targetNames, existingNames)) {
            changes.push(['networks', existingNames.join(', '), targetNames.join(', ')]);
            networkNamesTarget = targetNames;
          }
        }
        if (updateByMatchId.has(match.id)) {
          // Later row in the same file wins over an earlier one matching the same existing record.
          duplicates++;
          const existingUpdate = updateByMatchId.get(match.id);
          for (const [k, oldVal, v] of changes) {
            const i = existingUpdate.changes.findIndex(([ck]) => ck === k);
            if (i >= 0) existingUpdate.changes[i] = [k, oldVal, v]; else existingUpdate.changes.push([k, oldVal, v]);
          }
          if (networkNamesTarget) existingUpdate.networkNamesTarget = networkNamesTarget;
        } else if (changes.length) {
          const entry = {
            matchId: match.id, label: match.name || match.station || match.pic_name || match.sim_number || label, changes, networkNamesTarget,
          };
          updateByMatchId.set(match.id, entry);
          updates.push(entry);
        }
      } else if (config.dedupeKey && config.dedupeKey(mapped)) {
        const key = config.dedupeKey(mapped);
        if (insertByDedupeKey.has(key)) {
          duplicates++;
          insertByDedupeKey.get(key).mapped = mapped;
          insertByDedupeKey.get(key).label = label;
        } else {
          const entry = { mapped, label };
          insertByDedupeKey.set(key, entry);
          inserts.push(entry);
        }
      } else {
        const entry = { mapped, label };
        if (config.networksField && mapped[config.networksField] !== undefined) {
          entry.networkNamesTarget = parseNetworkNames(mapped[config.networksField]);
        }
        inserts.push(entry);
      }
    }
    if (!inserts.length && !updates.length) {
      toast(skipped ? `No changes found - ${skipped} row(s) skipped (missing required field).` : 'No changes found - every row already matches what\'s on file.');
      return;
    }
    openModal('bulkImport', { entity, inserts, updates, skipped, duplicates });
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
      const entry = data.inserts[i];
      if (entry.networkNamesTarget) {
        const networkIds = await resolveNetworkIds(entry.networkNamesTarget);
        await saveAssetInventory(entry.mapped, networkIds);
      } else {
        await config.save(entry.mapped);
      }
      inserted++;
    }
    for (const i of checkedUpdates) {
      const u = data.updates[i];
      // Networks isn't a plain column - strip it from the generic update and apply it via the
      // asset_inventory_networks join table separately below.
      const plainChanges = u.changes.filter(([k]) => k !== 'networks');
      if (plainChanges.length) {
        const fields = Object.fromEntries(plainChanges.map(([k, , newVal]) => [k, newVal]));
        const { error } = await supabase.from(config.table).update(fields).eq('id', u.matchId);
        if (error) throw error;
      }
      if (u.networkNamesTarget) {
        const networkIds = await resolveNetworkIds(u.networkNamesTarget);
        await supabase.from('asset_inventory_networks').delete().eq('asset_inventory_id', u.matchId);
        if (networkIds.length) {
          await supabase.from('asset_inventory_networks').insert(networkIds.map((id) => ({ asset_inventory_id: u.matchId, network_id: id })));
        }
      }
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
      const mapped = normalizeImportDates(config.transform(mapImportRow(raw, config.aliases)), config.dateFields);
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

// Ticks/unticks every checkbox in one section (inserts or updates) at once - the header checkbox
// in each table. Direct DOM, no re-render, so it doesn't disturb anything else on the modal.
export function toggleImportSection(kind, checked) {
  document.querySelectorAll(`[data-import-${kind}]`).forEach((el) => { el.checked = checked; });
}

// One click to select (or clear) every proposed change across both sections at once - the bulk
// approval control, on top of the per-row checkboxes for fine-grained review.
export function toggleImportAll(checked) {
  toggleImportSection('insert', checked);
  toggleImportSection('update', checked);
}

registerModal('bulkImport', (data) => {
  const config = IMPORT_CONFIGS[data.entity];
  const isStaged = !!config.matchKey;

  if (isStaged && data.inserts) {
    const { inserts, updates, skipped, duplicates } = data;
    const total = inserts.length + updates.length;
    const insertRows = inserts.map((r, i) => `
      <tr><td><input type="checkbox" data-import-insert="${i}" checked></td><td>${esc(r.label)}</td></tr>
    `).join('') || `<tr><td colspan="2"><div class="empty">None</div></td></tr>`;
    const updateRows = updates.map((r, i) => `
      <tr><td><input type="checkbox" data-import-update="${i}" checked></td><td>${esc(r.label)}</td><td class="small">${fieldDiffHtml(r.changes)}</td></tr>
    `).join('') || `<tr><td colspan="3"><div class="empty">None</div></td></tr>`;
    return `
      <h3>Bulk Import - ${esc(config.label)}: Review Changes</h3>
      <p class="small muted">Parsed and matched in memory only - nothing has been saved yet. Uncheck any row you don't want, then approve.${skipped ? ` ${skipped} row(s) skipped (missing required field).` : ''}${duplicates ? ` ${duplicates} duplicate row(s) within the file were merged.` : ''}</p>
      <div class="banner" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <span>${total} change${total === 1 ? '' : 's'} proposed</span>
        <span style="display:flex;gap:8px;">
          <button type="button" class="btn-sm" onclick="App.toggleImportAll(true)">Select All</button>
          <button type="button" class="btn-sm" onclick="App.toggleImportAll(false)">Deselect All</button>
        </span>
      </div>
      ${inserts.length ? `
        <h4 style="margin:14px 0 6px;">${inserts.length} New Row(s)</h4>
        <table><thead><tr><th style="width:28px;"><input type="checkbox" checked onchange="App.toggleImportSection('insert', this.checked)"></th><th>Name</th></tr></thead><tbody>${insertRows}</tbody></table>
      ` : ''}
      ${updates.length ? `
        <h4 style="margin:14px 0 6px;">${updates.length} Existing Row(s) With Changes</h4>
        <table><thead><tr><th style="width:28px;"><input type="checkbox" checked onchange="App.toggleImportSection('update', this.checked)"></th><th>Match</th><th>Changed Fields (new value)</th></tr></thead><tbody>${updateRows}</tbody></table>
      ` : ''}
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="button" class="btn btn-orange" onclick="App.approveBulkImport('${data.entity}')">Approve &amp; Import Selected</button>
      </div>
    `;
  }

  const MATCH_BY = { simCards: 'SIM number', metroPic: 'Company Name or Emirates ID Number', assetsInventory: 'Asset ID or name+venue' };
  const matchNote = isStaged
    ? `<p class="small muted">Rows matching an existing record (by ${MATCH_BY[data.entity] || 'a natural key'}) are compared field by field - you'll see exactly what would change before anything is saved. Duplicate rows within the same file are merged. Unmatched rows show as new.</p>`
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
