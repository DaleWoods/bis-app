import pptxgen from 'pptxgenjs';

/**
 * pptxgenjs merges a class and a namespace of the same name, so under NodeNext
 * TypeScript resolves the default import to the namespace and refuses `new`.
 * The runtime default export is the constructor, so we describe the slice of
 * the API this module uses.
 */
interface PptxSlide {
  background: { color: string };
  addText(text: unknown, options: Record<string, unknown>): unknown;
  addShape(shape: string, options: Record<string, unknown>): unknown;
  addImage(options: Record<string, unknown>): unknown;
  addTable(rows: unknown[], options: Record<string, unknown>): unknown;
}

interface PptxPresentation {
  layout: string;
  author: string;
  company: string;
  title: string;
  addSlide(): PptxSlide;
  write(props: { outputType: 'nodebuffer' }): Promise<unknown>;
}

const PptxGenJS = pptxgen as unknown as new () => PptxPresentation;
import { CategoryDef, PackConfig } from '../domain/types.js';
import { formatUkDate } from '../util/time.js';
import { Round } from '../services/roundService.js';
import { Ticket } from '../services/ticketService.js';

/**
 * §7 committee distribution pack.
 *
 * The in-app ticket card is the primary scoring surface; this generates the
 * matching PowerPoint for circulation and archiving. Both are driven from the
 * same ticket data, so they cannot drift.
 *
 * Layout per slide: header (JIRA ID – Title + type chip), executive summary,
 * four labelled panels (Current / Impacts / Future / Benefits), metadata strip.
 * Plus a title slide and a closing thank-you slide, as today.
 */

const PANELS: Array<{ key: keyof Ticket; label: string; blurb: string }> = [
  { key: 'panelCurrent', label: 'Current', blurb: 'The present situation / problem' },
  { key: 'panelImpacts', label: 'Impacts', blurb: 'What the problem causes' },
  { key: 'panelFuture', label: 'Future', blurb: 'The target / desired state' },
  { key: 'panelBenefits', label: 'Benefits', blurb: 'What resolving it delivers' },
];

function trim(value: string | null | undefined, max = 700): string {
  const text = (value ?? '').trim();
  if (!text) return '—';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface PackInput {
  round: Round;
  tickets: Ticket[];
  categories: CategoryDef[];
  config: PackConfig;
}

export async function buildPptx(input: PackInput): Promise<Buffer> {
  const { round, tickets, categories, config } = input;
  const accent = config.accentColour.replace('#', '');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = config.organisation;
  pptx.company = config.organisation;
  pptx.title = `${config.deckTitle} – ${round.weekLabel}`;

  // --- Title slide -------------------------------------------------------
  const title = pptx.addSlide();
  title.background = { color: accent };
  title.addText(config.deckTitle, { x: 0.6, y: 1.7, w: 8.8, h: 0.9, fontSize: 40, bold: true, color: 'FFFFFF' });
  title.addText(round.weekLabel, { x: 0.6, y: 2.6, w: 8.8, h: 0.6, fontSize: 24, color: 'FFFFFF' });
  title.addText(
    [
      { text: `${tickets.length} ticket${tickets.length === 1 ? '' : 's'} for scoring`, options: { breakLine: true } },
      { text: `Cut-off: ${formatUkDate(round.cutOffAt)}`, options: { breakLine: true } },
      { text: `Stream: ${round.stream}`, options: {} },
    ],
    { x: 0.6, y: 3.4, w: 8.8, h: 1.2, fontSize: 14, color: 'E6EEF5' },
  );

  // --- How to score ------------------------------------------------------
  const guide = pptx.addSlide();
  guide.addText('How to score', { x: 0.5, y: 0.4, w: 9, h: 0.5, fontSize: 26, bold: true, color: accent });
  guide.addText(
    'Score each ticket 0–10 in every category. 0 = Not Impacted, 10 = Highly Impacted. Answer the relevance question first — if you are unsure, choose "Unsure" rather than guessing.',
    { x: 0.5, y: 0.95, w: 9, h: 0.6, fontSize: 12, color: '444444' },
  );
  guide.addTable(
    [
      [
        { text: 'Category', options: { bold: true, color: 'FFFFFF', fill: { color: accent } } },
        { text: 'What it means', options: { bold: true, color: 'FFFFFF', fill: { color: accent } } },
      ],
      ...categories
        .filter((c) => c.active)
        .map((category) => [
          { text: category.name, options: { bold: true } },
          { text: category.description || '' },
        ]),
    ],
    { x: 0.5, y: 1.6, w: 9, colW: [2.6, 6.4], fontSize: 11, border: { pt: 0.5, color: 'D9D9D9' }, valign: 'middle' },
  );

  // --- One slide per ticket ---------------------------------------------
  for (const ticket of tickets) {
    const slide = pptx.addSlide();

    slide.addShape('rect', { x: 0, y: 0, w: 10, h: 0.85, fill: { color: accent } });
    slide.addText(`${ticket.jiraId} – ${ticket.title}`, {
      x: 0.35,
      y: 0.12,
      w: 7.6,
      h: 0.6,
      fontSize: 20,
      bold: true,
      color: 'FFFFFF',
      valign: 'middle',
    });
    if (ticket.type) {
      slide.addShape('roundRect', { x: 8.1, y: 0.22, w: 1.55, h: 0.42, fill: { color: 'FFFFFF' }, line: { color: 'FFFFFF' } });
      slide.addText(ticket.type, { x: 8.1, y: 0.22, w: 1.55, h: 0.42, fontSize: 11, bold: true, color: accent, align: 'center', valign: 'middle' });
    }

    const hasImage = Boolean(ticket.screenshotUrl);
    slide.addText('Executive summary', { x: 0.35, y: 1.0, w: 4, h: 0.28, fontSize: 12, bold: true, color: accent });
    slide.addText(trim(ticket.execSummary, 520), {
      x: 0.35,
      y: 1.3,
      w: hasImage ? 6.4 : 9.3,
      h: 0.95,
      fontSize: 12,
      color: '333333',
      valign: 'top',
    });
    if (hasImage) {
      try {
        slide.addImage({ path: ticket.screenshotUrl, x: 6.95, y: 1.05, w: 2.7, h: 1.5, sizing: { type: 'contain', w: 2.7, h: 1.5 } });
      } catch {
        // A missing or unreachable screenshot must never fail pack generation.
      }
    }

    const panelWidth = 2.28;
    PANELS.forEach((panel, index) => {
      const x = 0.35 + index * (panelWidth + 0.09);
      slide.addShape('rect', { x, y: 2.4, w: panelWidth, h: 0.34, fill: { color: accent } });
      slide.addText(panel.label, { x, y: 2.4, w: panelWidth, h: 0.34, fontSize: 12, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle' });
      slide.addShape('rect', { x, y: 2.74, w: panelWidth, h: 1.85, fill: { color: 'F4F7FA' }, line: { color: 'DCE4EC' } });
      slide.addText(trim(ticket[panel.key] as string, 420), {
        x: x + 0.08,
        y: 2.8,
        w: panelWidth - 0.16,
        h: 1.73,
        fontSize: 10,
        color: '333333',
        valign: 'top',
      });
    });

    const metadata = [
      ['Created', formatUkDate(ticket.createdDate)],
      ['Type', ticket.type],
      ['Stakeholder', ticket.stakeholder],
      ['Affects', ticket.affects],
      ['Impacts', ticket.impacts],
      ['Workaround', ticket.workaround],
    ];
    slide.addShape('rect', { x: 0.35, y: 4.72, w: 9.3, h: 0.55, fill: { color: 'EFF3F7' } });
    slide.addText(
      metadata.map(([label, value], index) => ({
        text: `${label}: ${value || '—'}${index < metadata.length - 1 ? '   ·   ' : ''}`,
        options: { bold: false },
      })),
      { x: 0.45, y: 4.72, w: 9.1, h: 0.55, fontSize: 9.5, color: '445566', valign: 'middle' },
    );
  }

  // --- Closing slide -----------------------------------------------------
  const closing = pptx.addSlide();
  closing.background = { color: accent };
  closing.addText('Thank you', { x: 0.6, y: 1.9, w: 8.8, h: 0.9, fontSize: 40, bold: true, color: 'FFFFFF' });
  closing.addText(config.closingMessage, { x: 0.6, y: 2.8, w: 8.8, h: 0.8, fontSize: 16, color: 'E6EEF5' });
  closing.addText(`Cut-off: ${formatUkDate(round.cutOffAt)}`, { x: 0.6, y: 3.5, w: 8.8, h: 0.5, fontSize: 14, color: 'E6EEF5' });

  const data = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return data;
}
