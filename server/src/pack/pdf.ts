import PDFDocument from 'pdfkit';
import { PackInput } from './pptx.js';
import { cardLines, labelsFor } from '../domain/card.js';
import { formatUkDate } from '../util/time.js';
import { Ticket } from '../services/ticketService.js';

/**
 * PDF twin of the PowerPoint pack (§7) - same ticket data, same layout, for
 * people who would rather read or circulate a PDF. A4 landscape is close enough
 * to 16:9 that the two read as the same document.
 */

const ACCENT_TINT = '#F5F8FB';
const LINE = '#DCE4EC';
const INK = '#1F2933';
const MUTED = '#5A6B7B';

function text(value: string | null | undefined, max = 600): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function chipParts(fact: string): { label: string; value: string } {
  const index = fact.indexOf(':');
  if (index <= 0) return { label: '', value: fact };
  return { label: fact.slice(0, index).trim(), value: fact.slice(index + 1).trim() };
}

export async function buildPdf(input: PackInput): Promise<Buffer> {
  const { round, tickets, config } = input;
  const screenshots = input.screenshots ?? {};
  const accent = `#${config.accentColour.replace('#', '')}`;

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const M = 36;
  const width = doc.page.width - M * 2;

  // Title page
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(accent);
  doc.fillColor('#FFFFFF').fontSize(34).text(config.deckTitle, 60, 180);
  doc.fontSize(20).text(round.weekLabel, 60, 230);
  doc
    .fontSize(12)
    .text(`${tickets.length} ticket${tickets.length === 1 ? '' : 's'} for scoring`, 60, 275)
    .text(`Cut-off: ${formatUkDate(round.cutOffAt)}`, 60, 293)
    .text(`Stream: ${round.stream}`, 60, 311);

  for (const ticket of tickets) {
    doc.addPage();
    ticketPage(doc, ticket, accent, screenshots[ticket.id] ?? '', M, width);
  }

  doc.addPage();
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(accent);
  doc.fillColor('#FFFFFF').fontSize(34).text('Thank you', 60, 200);
  doc.fontSize(13).text(config.closingMessage, 60, 250, { width: doc.page.width - 120 });
  doc.fontSize(12).text(`Cut-off: ${formatUkDate(round.cutOffAt)}`, 60, 300);

  doc.end();
  return done;
}

function ticketPage(
  doc: PDFKit.PDFDocument,
  ticket: Ticket,
  accent: string,
  screenshot: string,
  M: number,
  width: number,
): void {
  const labels = labelsFor(ticket.cardKind);
  const facts = cardLines(ticket.impactFacts, 4);
  const hasImage = Boolean(screenshot);
  const hasAside = hasImage || facts.length > 0;

  const narrativeW = hasAside ? width * 0.6 : width;
  const asideX = M + width * 0.63;
  const asideW = width - width * 0.63;

  // --- Header ------------------------------------------------------------
  doc.rect(0, 0, doc.page.width, 52).fill(accent);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(10).text(ticket.jiraId, M, 20);

  const chip = labels.kind.toUpperCase();
  const chipW = 100;
  doc.roundedRect(doc.page.width - M - chipW, 14, chipW, 22, 11).fill('#FFFFFF');
  doc.fillColor(accent).fontSize(8).text(chip, doc.page.width - M - chipW, 21, { width: chipW, align: 'center' });

  /*
    --- Headline ----------------------------------------------------------

    The drafted headline is the heading; the JIRA title sits above it, small and
    grey. The title is written for the team that raised the ticket - "Aurora
    banner carousel component, no rotation delay" - and setting it large undid
    the translation the rest of the page had just done. It stays because
    somebody will want to look the ticket up.
  */
  let y = 64;
  const headline = text(ticket.execSummary, 260);
  if (headline) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(text(ticket.title, 150), M, y, {
      width: narrativeW,
      ellipsis: true,
      lineBreak: false,
    });
    y += 12;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12.5).text(headline, M, y, { width: narrativeW, lineGap: 1 });
    y = Math.max(y + 34, doc.y + 10);
  } else {
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12.5).text(text(ticket.title, 160), M, y, { width: narrativeW });
    y = Math.max(y + 30, doc.y + 10);
  }
  const narrativeTop = y;

  // --- Narrative ---------------------------------------------------------
  const bandTop = doc.page.height - 106;
  const sections = [
    { ...labels.current, value: ticket.panelCurrent },
    { ...labels.impacts, value: ticket.panelImpacts },
    { ...labels.future, value: ticket.panelFuture },
  ];

  // Sections flow at the height their content needs rather than being spread
  // over the page. Three short sections evenly distributed leave bands of dead
  // space between them, which reads as an unfinished slide.
  for (const section of sections) {
    const top = y;

    doc.fillColor(accent).font('Helvetica-Bold').fontSize(8).text(section.label.toUpperCase(), M + 10, top, { continued: true });
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(7).text(`   ${section.hint}`);

    const lines = cardLines(section.value);
    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
    if (lines.length) {
      doc.list(lines, M + 12, top + 14, { width: narrativeW - 14, bulletRadius: 1.5, textIndent: 8, lineGap: 1.5 });
    } else {
      doc.fillColor('#A3AEB9').font('Helvetica-Oblique').text('Not written yet', M + 12, top + 14, { width: narrativeW - 14 });
    }

    // Drawn after the text, now that its height is known. The rule sits left of
    // the text column, so painting it here cannot cover anything.
    doc.rect(M, top, 3, Math.max(14, doc.y - top - 2)).fill(accent);
    y = Math.min(doc.y + 16, bandTop - 20);
  }

  // --- Aside: picture, caption, chips ------------------------------------
  if (hasAside) {
    // The aside starts level with the narrative, not wherever the narrative
    // happened to finish.
    let asideY = narrativeTop;
    if (hasImage) {
      const maxH = facts.length ? 165 : 230;
      let imageH = maxH;
      let drawn = false;
      try {
        const bytes = Buffer.from(screenshot.slice(screenshot.indexOf(',') + 1), 'base64');
        // Size the frame to the picture instead of leaving a band of tint above
        // and below a wide screenshot. openImage is pdfkit's own API but is
        // missing from @types/pdfkit, hence the cast.
        const image = (doc as unknown as { openImage(src: Buffer): { width: number; height: number } }).openImage(bytes);
        const scaled = ((asideW - 8) * image.height) / image.width;
        imageH = Math.min(maxH, Math.round(scaled) + 8);
        doc.rect(asideX, asideY, asideW, imageH).fillAndStroke(ACCENT_TINT, LINE);
        doc.image(bytes, asideX + 4, asideY + 4, { fit: [asideW - 8, imageH - 8], align: 'center', valign: 'center' });
        drawn = true;
      } catch {
        // An unreadable image must never stop the pack being produced.
      }
      if (!drawn) imageH = 0;
      asideY += imageH + 6;

      const caption = text(ticket.screenshotCaption, 160);
      if (caption) {
        doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(7.5).text(caption, asideX, asideY, { width: asideW });
        asideY = doc.y + 8;
      }
    }

    if (facts.length) {
      doc.fillColor(accent).font('Helvetica-Bold').fontSize(7.5).text('THE NUMBERS', asideX, asideY, { width: asideW });
      asideY += 12;
      for (const fact of facts) {
        if (asideY + 22 > bandTop) break;
        const { label, value } = chipParts(fact);
        doc.roundedRect(asideX, asideY, asideW, 20, 4).fillAndStroke(ACCENT_TINT, LINE);
        doc.fillColor(accent).font('Helvetica-Bold').fontSize(7.5).text(label ? `${label}  ` : '', asideX + 6, asideY + 6, {
          width: asideW - 12,
          continued: Boolean(label),
          lineBreak: false,
        });
        doc.fillColor(INK).font('Helvetica').fontSize(8).text(value, label ? undefined : asideX + 6, label ? undefined : asideY + 6, {
          width: asideW - 12,
          lineBreak: false,
          ellipsis: true,
        });
        asideY += 24;
      }
    }
  }

  // --- "If we fix it" band ----------------------------------------------
  const benefit = text(ticket.panelBenefits, 220);
  if (benefit) {
    doc.rect(M, bandTop, width, 30).fill(ACCENT_TINT);
    doc.rect(M, bandTop, 3, 30).fill(accent);
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(8).text(labels.benefits.toUpperCase(), M + 12, bandTop + 11, { continued: true });
    doc.fillColor(INK).font('Helvetica').fontSize(9.5).text(`   ${benefit}`, { width: width - 24, ellipsis: true, lineBreak: false });
  }

  // --- Metadata ----------------------------------------------------------
  const metadata: Array<[string, string]> = [
    ['Raised by', ticket.stakeholder],
    ['Since', formatUkDate(ticket.createdDate)],
    ['Affects', ticket.affects || ticket.siteAffected],
    ['Workaround', ticket.workaround || 'None'],
    ['Priority', ticket.priority],
  ];
  const strip = metadata
    .filter(([, value]) => value && value.trim())
    .map(([label, value]) => `${label}: ${value}`)
    .join('     ·     ');
  if (strip) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(strip, M, bandTop + 42, { width, ellipsis: true, lineBreak: false });
  }
}
