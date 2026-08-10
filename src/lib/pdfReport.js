// Branded per-campaign PDF, modeled on Hypermedia's own reference "Campaign Report" deck (a
// landscape slide-style PDF: dark cover, one black photo-gallery page per screen/site, a light
// "Performance Report" summary page with the Playouts/Impressions breakdown table, a dark closing
// page). 960x540pt (16:9) to match that reference's own page size.
//
// Photos are optional per site - if the caller didn't attach any for a site, that site's gallery
// page draws a dashed placeholder box instead ("space to attach" a photo later, e.g. by hand in
// another PDF tool, or by re-running this export once photos exist).
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const PAGE_W = 960;
const PAGE_H = 540;
const MARGIN = 48;

const BLACK = rgb(0, 0, 0);
const DARK = rgb(0.043, 0.098, 0.11);
const WHITE = rgb(1, 1, 1);
const ORANGE = rgb(0.969, 0.580, 0.114);
const TEAL = rgb(0.078, 0.722, 0.769);
const LIGHT_BG = rgb(0.976, 0.976, 0.98);
const TEXT_DARK = rgb(0.12, 0.12, 0.12);
const BORDER = rgb(0.8, 0.8, 0.82);
const TABLE_HEAD_FILL = rgb(0.90, 0.95, 0.96);

async function loadLogoBytes() {
  const res = await fetch(`${import.meta.env.BASE_URL}logo.png`);
  return new Uint8Array(await res.arrayBuffer());
}

function fitContain(imgW, imgH, boxW, boxH) {
  const scale = Math.min(boxW / imgW, boxH / imgH);
  return { w: imgW * scale, h: imgH * scale };
}

// pdf-lib only decodes PNG/JPEG directly - anything else a browser file picker might hand us
// (webp, gif, heic-that-happens-to-decode, etc.) gets re-encoded to PNG via a throwaway <img>/
// <canvas> round-trip first.
async function embedPhoto(pdfDoc, file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.type === 'image/png') return pdfDoc.embedPng(bytes);
  if (file.type === 'image/jpeg' || file.type === 'image/jpg') return pdfDoc.embedJpg(bytes);

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Could not decode image'));
    el.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  const pngDataUrl = canvas.toDataURL('image/png');
  const pngBytes = Uint8Array.from(atob(pngDataUrl.split(',')[1]), (c) => c.charCodeAt(0));
  return pdfDoc.embedPng(pngBytes);
}

function drawPlaceholder(page, x, y, w, h, font) {
  page.drawRectangle({ x, y, width: w, height: h, borderColor: rgb(0.4, 0.4, 0.4), borderWidth: 1, borderDashArray: [6, 4] });
  const label = 'Attach photo here';
  const size = 11;
  const textW = font.widthOfTextAtSize(label, size);
  page.drawText(label, { x: x + (w - textW) / 2, y: y + h / 2 - 4, size, font, color: rgb(0.5, 0.5, 0.5) });
}

// A simple line-art eye (outline ellipse + filled pupil) - StandardFonts have no emoji glyphs, so
// the reference template's eye icon next to "Impression" is hand-drawn instead of typed.
function drawEyeIcon(page, x, y, w) {
  const h = w * 0.55;
  page.drawEllipse({ x: x + w / 2, y: y + h / 2, xScale: w / 2, yScale: h / 2, borderColor: TEXT_DARK, borderWidth: 2 });
  page.drawCircle({ x: x + w / 2, y: y + h / 2, size: h * 0.3, color: TEXT_DARK });
}

// Fallback branding if the caller doesn't pass a template (or a field in it is blank) - matches
// Settings > Integrations > Campaign Report Template's own defaults (settings.js
// REPORT_TEMPLATE_DEFAULTS) so an unconfigured template still looks right out of the box.
const DEFAULT_TEMPLATE = {
  companyName: 'Hypermedia',
  tagline: 'Creators of Impact',
  contactLine: 'Toll-Free +971 4 800 4600  |  info@hypermedia.ae  |  www.hypermedia.ae',
  addressLine1: 'Dubai HQ: Galadari Bldg, 2nd Floor, Dubai Internet City, P.O. Box 502021, Dubai, UAE',
  addressLine2: 'Abu Dhabi: Yas Mall, Cloudspaces, Level 1, Near Apple Store',
};

// campaignName/locationLabel/startDate/endDate: header/meta text, same fields as the Excel export.
// totalImpressions/totalPlayouts: campaign-wide totals for the summary page.
// screenRows: [{ site, placement, playouts, impressions }] - one row per screen, already
// aggregated by the caller (reporting.js's aggregateByScreen, shared with the Excel export).
// sitePhotos: [{ site, files: File[] }] - one entry per distinct site; files may be empty.
// template: { companyName, tagline, contactLine, addressLine1, addressLine2 } - admin-editable via
// Settings > Integrations > Campaign Report Template; falls back to DEFAULT_TEMPLATE per-field.
export async function exportCampaignPdfReport(filename, {
  campaignName, locationLabel, startDate, endDate,
  totalImpressions, totalPlayouts, screenRows, sitePhotos, template,
}) {
  const t = { ...DEFAULT_TEMPLATE, ...template };
  const pdfDoc = await PDFDocument.create();
  const logoImg = await pdfDoc.embedPng(await loadLogoBytes());
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // ---- Cover ----
  {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: DARK });
    page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: TEAL });
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 6, color: ORANGE });

    const logoDim = fitContain(logoImg.width, logoImg.height, 56, 56);
    page.drawImage(logoImg, { x: MARGIN, y: PAGE_H - MARGIN - logoDim.h, width: logoDim.w, height: logoDim.h });
    page.drawText(t.companyName.toUpperCase(), { x: MARGIN + logoDim.w + 14, y: PAGE_H - MARGIN - logoDim.h / 2 - 4, size: 18, font: bold, color: WHITE });
    if (t.tagline) page.drawText(t.tagline, { x: MARGIN + logoDim.w + 14, y: PAGE_H - MARGIN - logoDim.h / 2 - 22, size: 11, font: italic, color: TEAL });

    page.drawText('CAMPAIGN REPORT', { x: MARGIN, y: PAGE_H / 2 + 40, size: 16, font: bold, color: TEAL });
    page.drawText(campaignName.toUpperCase(), { x: MARGIN, y: PAGE_H / 2, size: 42, font: bold, color: WHITE });
    page.drawText(`${startDate}  -  ${endDate}`, { x: MARGIN, y: PAGE_H / 2 - 36, size: 14, font: regular, color: rgb(0.85, 0.85, 0.85) });
  }

  // ---- One photo-gallery page per site ----
  const cols = 3;
  const rowsPerPage = 2;
  const maxSlots = cols * rowsPerPage;
  for (const { site, files } of sitePhotos) {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: BLACK });
    page.drawCircle({ x: MARGIN + 6, y: PAGE_H - MARGIN - 2, size: 6, color: ORANGE });
    page.drawText(site.toUpperCase(), { x: MARGIN + 24, y: PAGE_H - MARGIN - 8, size: 20, font: bold, color: WHITE });

    const wmDim = fitContain(logoImg.width, logoImg.height, 26, 26);
    page.drawImage(logoImg, { x: PAGE_W - MARGIN - wmDim.w, y: MARGIN - 14, width: wmDim.w, height: wmDim.h });

    const gridTop = PAGE_H - MARGIN - 50;
    const gridBottom = MARGIN;
    const gap = 16;
    const cellW = (PAGE_W - MARGIN * 2 - gap * (cols - 1)) / cols;
    const cellH = (gridTop - gridBottom - gap * (rowsPerPage - 1)) / rowsPerPage;
    const slotCount = Math.min(Math.max(files.length, 1), maxSlots);

    for (let i = 0; i < slotCount; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = MARGIN + col * (cellW + gap);
      const y = gridTop - (row + 1) * cellH - row * gap;
      const file = files[i];
      if (file) {
        try {
          const img = await embedPhoto(pdfDoc, file);
          const dim = fitContain(img.width, img.height, cellW, cellH);
          page.drawImage(img, { x: x + (cellW - dim.w) / 2, y: y + (cellH - dim.h) / 2, width: dim.w, height: dim.h });
        } catch (_) {
          drawPlaceholder(page, x, y, cellW, cellH, regular);
        }
      } else {
        drawPlaceholder(page, x, y, cellW, cellH, regular);
      }
    }
  }

  // ---- Performance Report summary ----
  {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: LIGHT_BG });
    page.drawText('Performance Report', { x: MARGIN, y: PAGE_H - MARGIN - 10, size: 24, font: bold, color: TEXT_DARK });

    let ty = PAGE_H - MARGIN - 46;
    const metaLine = (label, value) => {
      page.drawText(`${label}: `, { x: MARGIN, y: ty, size: 11, font: bold, color: TEXT_DARK });
      const labelW = bold.widthOfTextAtSize(`${label}: `, 11);
      page.drawText(String(value || ''), { x: MARGIN + labelW, y: ty, size: 11, font: regular, color: TEXT_DARK, maxWidth: 260 });
      ty -= 16;
    };
    metaLine('Campaign Name', campaignName);
    metaLine('Location', locationLabel);
    metaLine('Start Date', startDate);
    metaLine('End Date', endDate);

    ty -= 26;
    drawEyeIcon(page, MARGIN, ty - 14, 26);
    page.drawText('Impression', { x: MARGIN + 36, y: ty, size: 13, font: bold, color: TEXT_DARK });
    page.drawText((totalImpressions ?? 0).toLocaleString(), { x: MARGIN + 36, y: ty - 20, size: 20, font: bold, color: TEXT_DARK });

    ty -= 70;
    page.drawText('Playouts', { x: MARGIN, y: ty, size: 13, font: bold, color: TEXT_DARK });
    page.drawText((totalPlayouts ?? 0).toLocaleString(), { x: MARGIN, y: ty - 20, size: 20, font: bold, color: TEXT_DARK });

    // Screen breakdown table
    const tableX = PAGE_W / 2 - 10;
    const tableW = PAGE_W - MARGIN - tableX;
    const tableCols = [
      { label: 'Site', w: 0.38, key: 'site' },
      { label: 'Placement', w: 0.28, key: 'placement' },
      { label: 'Playouts', w: 0.17, key: 'playouts' },
      { label: 'Impressions', w: 0.17, key: 'impressions' },
    ];
    const rowH = 20;
    let cy = PAGE_H - MARGIN - 46;
    let cx = tableX;
    tableCols.forEach((c) => {
      const w = tableW * c.w;
      page.drawRectangle({ x: cx, y: cy - rowH, width: w, height: rowH, color: TABLE_HEAD_FILL, borderColor: BORDER, borderWidth: 0.5 });
      page.drawText(c.label, { x: cx + 6, y: cy - rowH + 6, size: 9, font: bold, color: TEXT_DARK });
      cx += w;
    });
    cy -= rowH;
    screenRows.slice(0, 12).forEach((row) => {
      cx = tableX;
      tableCols.forEach((c) => {
        const w = tableW * c.w;
        const raw = row[c.key];
        const text = typeof raw === 'number' ? raw.toLocaleString() : String(raw ?? '');
        page.drawRectangle({ x: cx, y: cy - rowH, width: w, height: rowH, borderColor: BORDER, borderWidth: 0.5 });
        page.drawText(text, { x: cx + 6, y: cy - rowH + 6, size: 9, font: regular, color: TEXT_DARK, maxWidth: w - 10 });
        cx += w;
      });
      cy -= rowH;
    });

    const wmDim = fitContain(logoImg.width, logoImg.height, 28, 28);
    page.drawImage(logoImg, { x: PAGE_W - MARGIN - wmDim.w, y: MARGIN - 10, width: wmDim.w, height: wmDim.h });
  }

  // ---- Closing ----
  {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: BLACK });
    const logoDim = fitContain(logoImg.width, logoImg.height, 40, 40);
    const midY = PAGE_H / 2 + 40;
    page.drawImage(logoImg, { x: MARGIN, y: midY - logoDim.h / 2, width: logoDim.w, height: logoDim.h });
    page.drawText(t.companyName.toUpperCase(), { x: MARGIN + logoDim.w + 10, y: midY - 6, size: 15, font: bold, color: WHITE });
    page.drawText('THANK YOU', { x: MARGIN + 220, y: midY - 12, size: 32, font: bold, color: WHITE });

    page.drawText('BOOK YOUR MOMENT!', { x: MARGIN, y: 130, size: 20, font: bold, color: TEAL });
    if (t.contactLine) page.drawText(t.contactLine, { x: MARGIN, y: 98, size: 11, font: regular, color: rgb(0.8, 0.8, 0.8) });
    if (t.addressLine1) page.drawText(t.addressLine1, { x: MARGIN, y: 78, size: 9, font: regular, color: rgb(0.6, 0.6, 0.6) });
    if (t.addressLine2) page.drawText(t.addressLine2, { x: MARGIN, y: 64, size: 9, font: regular, color: rgb(0.6, 0.6, 0.6) });
  }

  const bytes = await pdfDoc.save();
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
