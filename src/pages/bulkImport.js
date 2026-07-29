import { openModal, closeModal, toast, invalidate, setState } from '../state.js';
import { registerModal } from '../modals.js';
import { parseSpreadsheetFile, mapImportRow } from '../lib/csv.js';
import { saveAsset } from '../data/assets.js';
import { saveLocation } from '../data/locations.js';
import { saveCampaign } from '../data/campaigns.js';
import { savePermit } from '../data/permits.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';

// Mirrors the original app's TEMPLATE_HEADERS/FIELD_ALIASES - column order/casing doesn't
// matter, mapImportRow() matches on normalized header text.
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
  },
  locations: {
    label: 'Locations',
    aliases: { name: ['Name'], type: ['Type'], address: ['Address'], notes: ['Notes'] },
    required: 'name',
    transform: (m) => ({ ...m, type: m.type === 'Installed' ? 'Installed' : 'Planned' }),
    save: saveLocation,
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
    let count = 0;
    for (const raw of rows) {
      const mapped = config.transform(mapImportRow(raw, config.aliases));
      if (!mapped[config.required]) continue;
      await config.save(mapped);
      count++;
    }
    await logAudit(`Bulk import ${config.label}`, `${count} row(s)`);
    invalidate(entity === 'assets' ? 'assets' : entity);
    closeModal();
    toast(`Imported ${count} ${config.label.toLowerCase()}`);
  } catch (e) {
    toast(e.message || 'Import failed', 'error');
  }
}

registerModal('bulkImport', (data) => {
  const config = IMPORT_CONFIGS[data.entity];
  return `
    <h3>Bulk Import - ${esc(config.label)}</h3>
    <p class="small muted">Upload a CSV or Excel file. Column headers are matched flexibly regardless of order or casing.</p>
    <form onsubmit="App.runBulkImport(event, '${data.entity}')">
      <div class="field"><label>File</label><input id="bulk-file" type="file" accept=".csv,.xlsx,.xls" required></div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Import</button>
      </div>
    </form>
  `;
});
