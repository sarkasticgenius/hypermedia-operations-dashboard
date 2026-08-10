// Branded per-campaign PowerPoint, modeled on Hypermedia's own reference "Campaign Report" deck
// (see the PDF the user shared): dark cover, one black placeholder slide per screen/site (photos
// are added later by hand directly in PowerPoint - see file header note below), a light
// "Performance Report" summary slide with the real Playouts/Impressions totals, per-screen
// breakdown table and Direct/Programmatic split, then a closing slide. 13.33x7.5in (16:9) to match
// a standard PowerPoint widescreen slide.
//
// Photos used to be uploaded in the browser before generating the PDF version of this report, but
// that blocked the download on having files ready first and only supported PDF export (no way to
// edit afterward). Now every site just gets a labeled placeholder box - the user drops their own
// screen photos in directly with PowerPoint's own Insert > Pictures once they have the .pptx open,
// which is faster than a browser upload flow and means the report is never blocked on photos.
import pptxgen from 'pptxgenjs';

const BRAND_DARK = '0B1C1F';
const BLACK = '000000';
const WHITE = 'FFFFFF';
const ORANGE = 'F7941D';
const TEAL = '14B8C4';
const LIGHT_BG = 'F9FAFA';
const TEXT_DARK = '1F1F1F';
const TEXT_MUTED = '666666';
const BORDER = 'CCCCD1';
const TABLE_HEAD_FILL = 'E3F5F6';

const LOGO_PATH = `${import.meta.env.BASE_URL}logo.png`;

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

function addPlaceholderBox(slide, x, y, w, h) {
  slide.addShape('rect', { x, y, w, h, fill: { color: BLACK }, line: { color: '666666', width: 1, dashType: 'dash' } });
  slide.addText('Insert photo here', { x, y, w, h, align: 'center', valign: 'middle', color: '888888', fontSize: 14, italic: true });
}

// campaignName/locationLabel: header/meta text. realStartDate/realEndDate: the campaign's actual
// flight dates from GET /campaigns (may be null if that lookup failed/wasn't available - falls
// back to the loaded reporting date range in that case, same as before).
// totalImpressions/totalPlayouts: campaign-wide totals for the summary slide.
// screenRows: [{ site, placement, playouts, impressions }] - one row per screen, already
// aggregated by the caller (reporting.js's aggregateByScreen, shared with the Excel export).
// demandSplit: { direct, programmatic } ad counts, or null if the /ads lookup wasn't available.
// sites: string[] - one placeholder slide per entry.
// template: { companyName, tagline, contactLine, addressLine1, addressLine2 } - admin-editable via
// Settings > Integrations > Campaign Report Template; falls back to DEFAULT_TEMPLATE per-field.
export async function exportCampaignPptxReport(filename, {
  campaignName, locationLabel, startDate, endDate, realStartDate, realEndDate,
  totalImpressions, totalPlayouts, screenRows, demandSplit, sites, template,
}) {
  const t = { ...DEFAULT_TEMPLATE, ...template };
  const pres = new pptxgen();
  pres.defineLayout({ name: 'HM_WIDE', width: 13.33, height: 7.5 });
  pres.layout = 'HM_WIDE';

  const durationLabel = realStartDate && realEndDate ? `${realStartDate} - ${realEndDate}`
    : startDate === endDate ? startDate : `${startDate} to ${endDate}`;

  // ---- Cover ----
  {
    const slide = pres.addSlide();
    slide.background = { color: BRAND_DARK };
    slide.addShape('rect', { x: 0, y: 0, w: 13.33, h: 0.08, fill: { color: TEAL } });
    slide.addShape('rect', { x: 0, y: 7.42, w: 13.33, h: 0.08, fill: { color: ORANGE } });

    slide.addImage({ path: LOGO_PATH, x: 0.6, y: 0.5, w: 0.7, h: 0.7 });
    slide.addText(t.companyName.toUpperCase(), { x: 1.45, y: 0.5, w: 4, h: 0.35, fontSize: 18, bold: true, color: WHITE });
    if (t.tagline) slide.addText(t.tagline, { x: 1.45, y: 0.85, w: 4, h: 0.3, fontSize: 11, italic: true, color: TEAL });

    slide.addText('CAMPAIGN REPORT', { x: 0.6, y: 3.1, w: 10, h: 0.4, fontSize: 16, bold: true, color: TEAL });
    slide.addText(campaignName.toUpperCase(), { x: 0.6, y: 3.5, w: 12, h: 1, fontSize: 40, bold: true, color: WHITE });
    slide.addText(durationLabel, { x: 0.6, y: 4.5, w: 10, h: 0.4, fontSize: 14, color: 'D9D9D9' });
  }

  // ---- One placeholder slide per site ----
  sites.forEach((site) => {
    const slide = pres.addSlide();
    slide.background = { color: BLACK };
    slide.addShape('ellipse', { x: 0.6, y: 0.55, w: 0.14, h: 0.14, fill: { color: ORANGE } });
    slide.addText(site.toUpperCase(), { x: 0.9, y: 0.35, w: 11, h: 0.5, fontSize: 22, bold: true, color: WHITE });
    slide.addImage({ path: LOGO_PATH, x: 12.5, y: 6.9, w: 0.4, h: 0.4 });

    addPlaceholderBox(slide, 0.6, 1.3, 5.9, 5.5);
    addPlaceholderBox(slide, 6.8, 1.3, 5.9, 5.5);
  });

  // ---- Performance Report summary ----
  {
    const slide = pres.addSlide();
    slide.background = { color: LIGHT_BG };
    slide.addText('Performance Report', { x: 0.6, y: 0.4, w: 8, h: 0.6, fontSize: 26, bold: true, color: TEXT_DARK });

    const metaLines = [
      `Campaign Name: ${campaignName}`,
      `Location: ${locationLabel}`,
      `Duration: ${durationLabel}`,
    ];
    slide.addText(metaLines.join('\n'), { x: 0.6, y: 1.1, w: 5.6, h: 1, fontSize: 11, color: TEXT_DARK, lineSpacingMultiple: 1.3 });

    slide.addText('Impressions', { x: 0.6, y: 2.3, w: 3, h: 0.3, fontSize: 12, bold: true, color: TEXT_DARK });
    slide.addText((totalImpressions ?? 0).toLocaleString(), { x: 0.6, y: 2.6, w: 3, h: 0.5, fontSize: 22, bold: true, color: TEXT_DARK });
    slide.addText('Playouts', { x: 0.6, y: 3.3, w: 3, h: 0.3, fontSize: 12, bold: true, color: TEXT_DARK });
    slide.addText((totalPlayouts ?? 0).toLocaleString(), { x: 0.6, y: 3.6, w: 3, h: 0.5, fontSize: 22, bold: true, color: TEXT_DARK });

    if (demandSplit) {
      slide.addText('Delivery Type', { x: 0.6, y: 4.4, w: 3, h: 0.3, fontSize: 12, bold: true, color: TEXT_DARK });
      slide.addText(`Direct: ${demandSplit.direct}   Programmatic: ${demandSplit.programmatic}`, { x: 0.6, y: 4.7, w: 5.5, h: 0.4, fontSize: 12, color: TEXT_MUTED });
    }

    const tableHeader = ['Site', 'Placement', 'Playouts', 'Impressions'].map((h) => ({
      text: h, options: { bold: true, fill: { color: TABLE_HEAD_FILL }, color: TEXT_DARK, fontSize: 9 },
    }));
    const tableBody = screenRows.slice(0, 14).map((r) => [
      { text: r.site || '', options: { fontSize: 9 } },
      { text: r.placement || '', options: { fontSize: 9 } },
      { text: (r.playouts ?? 0).toLocaleString(), options: { fontSize: 9, align: 'right' } },
      { text: (r.impressions ?? 0).toLocaleString(), options: { fontSize: 9, align: 'right' } },
    ]);
    slide.addTable([tableHeader, ...tableBody], {
      x: 6.6, y: 1.1, w: 6.1, h: 5.6,
      border: { type: 'solid', color: BORDER, pt: 0.5 },
      autoPage: false,
      colW: [2.2, 1.9, 1.0, 1.0],
    });

    slide.addImage({ path: LOGO_PATH, x: 12.5, y: 6.9, w: 0.4, h: 0.4 });
  }

  // ---- Closing ----
  {
    const slide = pres.addSlide();
    slide.background = { color: BLACK };
    slide.addImage({ path: LOGO_PATH, x: 0.6, y: 3.2, w: 0.6, h: 0.6 });
    slide.addText(t.companyName.toUpperCase(), { x: 1.35, y: 3.25, w: 3, h: 0.4, fontSize: 15, bold: true, color: WHITE });
    slide.addText('THANK YOU', { x: 4.3, y: 3.15, w: 6, h: 0.6, fontSize: 32, bold: true, color: WHITE });

    slide.addText('BOOK YOUR MOMENT!', { x: 0.6, y: 5.2, w: 8, h: 0.5, fontSize: 20, bold: true, color: TEAL });
    if (t.contactLine) slide.addText(t.contactLine, { x: 0.6, y: 5.75, w: 11, h: 0.35, fontSize: 11, color: 'CCCCCC' });
    if (t.addressLine1) slide.addText(t.addressLine1, { x: 0.6, y: 6.1, w: 11, h: 0.3, fontSize: 9, color: '999999' });
    if (t.addressLine2) slide.addText(t.addressLine2, { x: 0.6, y: 6.4, w: 11, h: 0.3, fontSize: 9, color: '999999' });
  }

  await pres.writeFile({ fileName: filename });
}
