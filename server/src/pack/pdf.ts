import PDFDocument from 'pdfkit';
import { PackInput } from './pptx.js';
import { formatUkDate } from '../util/time.js';
import { Ticket } from '../services/ticketService.js';

/**
 * PDF twin of the PowerPoint pack (§7) - same ticket data, same layout language,
 * for people who would rather read/circulate a PDF.
 */

const PANELS: Array<{ key: keyof Ticket; label: string }> = [
  { key: 'panelCurrent', label: 'Current' },
  { key: 'panelImpacts', label: 'Impacts' },
  { key: 'panelFuture', label: 'Future' },
  { key: 'panelBenefits', label: 'Benefits' },
];

function text(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed || '—';
}

export async function buildPdf(input: PackInput): Promise<Buffer> {
  const { round, tickets, config } = input;
  const accent = `#${config.accentColour.replace('#', '')}`;

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const width = doc.page.width - 72;

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

    doc.rect(0, 0, doc.page.width, 54).fill(accent);
    doc.fillColor('#FFFFFF').fontSize(16).text(`${ticket.jiraId} – ${ticket.title}`, 36, 18, { width: width - 120, ellipsis: true });
    if (ticket.type) {
      doc.fontSize(10).text(ticket.type, doc.page.width - 156, 21, { width: 120, align: 'right' });
    }

    doc.fillColor(accent).fontSize(11).text('Executive summary', 36, 72);
    doc.fillColor('#333333').fontSize(10).text(text(ticket.execSummary), 36, 88, { width, height: 60 });

    const panelTop = 156;
    const panelWidth = (width - 3 * 8) / 4;
    const panelHeight = 200;
    PANELS.forEach((panel, index) => {
      const x = 36 + index * (panelWidth + 8);
      doc.rect(x, panelTop, panelWidth, 20).fill(accent);
      doc.fillColor('#FFFFFF').fontSize(10).text(panel.label, x, panelTop + 6, { width: panelWidth, align: 'center' });
      doc.rect(x, panelTop + 20, panelWidth, panelHeight).fillAndStroke('#F4F7FA', '#DCE4EC');
      doc
        .fillColor('#333333')
        .fontSize(9)
        .text(text(ticket[panel.key] as string), x + 6, panelTop + 28, { width: panelWidth - 12, height: panelHeight - 16 });
    });

    const stripTop = panelTop + panelHeight + 32;
    doc.rect(36, stripTop, width, 34).fill('#EFF3F7');
    const metadata = [
      `Created: ${formatUkDate(ticket.createdDate) || '—'}`,
      `Type: ${text(ticket.type)}`,
      `Stakeholder: ${text(ticket.stakeholder)}`,
      `Affects: ${text(ticket.affects)}`,
      `Impacts: ${text(ticket.impacts)}`,
      `Workaround: ${text(ticket.workaround)}`,
    ].join('   ·   ');
    doc.fillColor('#445566').fontSize(8.5).text(metadata, 44, stripTop + 11, { width: width - 16, ellipsis: true });
  }

  doc.addPage();
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(accent);
  doc.fillColor('#FFFFFF').fontSize(34).text('Thank you', 60, 200);
  doc.fontSize(13).text(config.closingMessage, 60, 250, { width: doc.page.width - 120 });
  doc.fontSize(12).text(`Cut-off: ${formatUkDate(round.cutOffAt)}`, 60, 300);

  doc.end();
  return done;
}
