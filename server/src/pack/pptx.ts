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
  addNotes(text: string): unknown;
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
import { cardLines, labelsFor } from '../domain/card.js';
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
 * The slide is laid out for someone who has never seen the system and will not
 * ask a follow-up question:
 *
 *   ┌ header ─ id · kind chip ───────────────────────────────────────┐
 *   │ HEADLINE - the plain-English sentence, set large                │
 *   │ the JIRA title, small and grey                                  │
 *   ├ narrative (3 sections, labelled by kind) ─┬ screenshot ────────┤
 *   │ • what this is                            │  [ image ]         │
 *   │ • what it costs us                        │  caption           │
 *   │ • what we would do                        │  impact chips      │
 *   ├ "Once it's live, …" ───────────────────────────────────────────┤
 *   └ metadata strip ────────────────────────────────────────────────┘
 *
 * The JIRA title is not the heading. It is written for the team that raised the
 * ticket - "Aurora banner carousel component, no rotation delay" - and setting
 * it large undoes the translation the rest of the slide just did. It stays,
 * small, because somebody will want to look the ticket up.
 *
 * The picture gets a third of the slide because a screenshot with a caption
 * explains a broken carousel faster than any three bullets can.
 */

const SLIDE_W = 10;
const MARGIN = 0.34;
const CONTENT_W = SLIDE_W - MARGIN * 2;
/** Where the slide body stops and the "if we fix it" band begins. */
const ASIDE_BOTTOM = 4.42;

const INK = '1F2933';
const MUTED = '5A6B7B';
const PANEL_BG = 'F5F8FB';
const PANEL_LINE = 'DCE4EC';

interface Geometry {
  narrativeW: number;
  asideX: number;
  asideW: number;
}

function trim(value: string | null | undefined, max = 700): string {
  const text = (value ?? '').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** An impact chip is "Label: value"; the label is set apart so it scans. */
function chipParts(fact: string): { label: string; value: string } {
  const index = fact.indexOf(':');
  if (index <= 0) return { label: '', value: fact };
  return { label: fact.slice(0, index).trim(), value: fact.slice(index + 1).trim() };
}

export interface PackInput {
  round: Round;
  tickets: Ticket[];
  categories: CategoryDef[];
  config: PackConfig;
  /** ticketId -> data URI, resolved by the caller from JIRA attachments. */
  screenshots?: Record<string, string>;
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
    ticketSlide(pptx.addSlide(), ticket, accent, input.screenshots?.[ticket.id] ?? '');
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

function ticketSlide(slide: PptxSlide, ticket: Ticket, accent: string, screenshot: string): void {
  const labels = labelsFor(ticket.cardKind);
  const facts = cardLines(ticket.impactFacts, 4);
  // packInput() has already resolved every source of image to a data URI.
  const hasImage = Boolean(screenshot);
  // The aside earns its width only when it has something in it. With neither a
  // picture nor a quantified fact, the narrative takes the whole slide rather
  // than sitting in a column beside white space.
  const hasAside = hasImage || facts.length > 0;
  const geometry: Geometry = hasAside
    ? { narrativeW: 5.65, asideX: MARGIN + 5.9, asideW: CONTENT_W - 5.9 }
    : { narrativeW: CONTENT_W, asideX: 0, asideW: 0 };

  header(slide, ticket, accent, labels.kind);
  const narrativeTop = headline(slide, ticket, geometry);

  narrative(slide, ticket, accent, geometry, narrativeTop, labels);
  if (hasAside) aside(slide, ticket, accent, geometry, narrativeTop, screenshot, facts, hasImage);

  benefitBand(slide, ticket, accent, labels.benefits);
  metadataStrip(slide, ticket);

  // Speaker notes carry the detail that would make the slide wordy. Anyone who
  // wants more than the slide gives has it a keystroke away.
  slide.addNotes(
    [
      `${ticket.jiraId} — ${ticket.title}`,
      ticket.stakeholder ? `Raised by ${ticket.stakeholder}${ticket.createdDate ? ` on ${formatUkDate(ticket.createdDate)}` : ''}` : '',
      ticket.workaround ? `Workaround: ${ticket.workaround}` : '',
      '',
      trim(ticket.rawDescription, 1800),
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
  );
}

function header(slide: PptxSlide, ticket: Ticket, accent: string, kindLabel: string): void {
  slide.addShape('rect', { x: 0, y: 0, w: SLIDE_W, h: 0.82, fill: { color: accent } });

  slide.addText(ticket.jiraId, {
    x: MARGIN,
    y: 0.08,
    w: CONTENT_W - 1.75,
    h: 0.66,
    bold: true,
    color: 'FFFFFF',
    fontSize: 13,
    valign: 'middle',
  });

  // The kind chip tells a scorer in one word whether they are looking at
  // something broken or something we cannot do yet. They score differently.
  slide.addShape('roundRect', {
    x: SLIDE_W - MARGIN - 1.65,
    y: 0.21,
    w: 1.65,
    h: 0.4,
    fill: { color: 'FFFFFF' },
    line: { color: 'FFFFFF' },
    rectRadius: 0.18,
  });
  slide.addText(kindLabel.toUpperCase(), {
    x: SLIDE_W - MARGIN - 1.65,
    y: 0.21,
    w: 1.65,
    h: 0.4,
    fontSize: 9.5,
    bold: true,
    color: accent,
    align: 'center',
    valign: 'middle',
    charSpacing: 0.6,
  });
}

/** Returns the y the rest of the slide starts at. */
function headline(slide: PptxSlide, ticket: Ticket, geometry: Geometry): number {
  const text = trim(ticket.execSummary, 260);
  if (!text) {
    // With nothing drafted the JIRA title is all there is, so it has to serve
    // as the heading rather than leaving the slide without one.
    slide.addText(trim(ticket.title, 160), {
      x: MARGIN,
      y: 0.98,
      w: geometry.narrativeW,
      h: 0.5,
      fontSize: 13.5,
      bold: true,
      color: INK,
      valign: 'top',
    });
    return 1.52;
  }

  slide.addText(trim(ticket.title, 120), {
    x: MARGIN,
    y: 0.92,
    w: geometry.narrativeW,
    h: 0.2,
    fontSize: 8,
    color: MUTED,
    valign: 'top',
  });

  slide.addText(text, {
    x: MARGIN,
    y: 1.12,
    w: geometry.narrativeW,
    h: 0.62,
    fontSize: 13.5,
    bold: true,
    color: INK,
    valign: 'top',
    lineSpacingMultiple: 1.05,
  });
  // The small title above the headline costs the body 0.14" of height; the
  // sections are laid out from whatever this returns, so they simply start
  // lower rather than overlapping it.
  return 1.82;
}

/**
 * How tall each narrative section wants to be, given its bullets.
 *
 * PowerPoint does the real text layout, so this estimates: roughly 16
 * characters per inch at 10.5pt, one line per wrap. Sections then take the room
 * they need instead of an equal third each - three short sections spread over
 * the full height leave bands of dead space that read as an unfinished slide.
 * If they collectively want more than there is, everything is scaled to fit.
 */
export function sectionHeights(
  sections: Array<{ value: string }>,
  width: number,
  available: number,
): number[] {
  const LABEL = 0.26;
  const LINE = 0.2;
  const GAP = 0.14;
  const charsPerLine = Math.max(20, Math.round(width * 16));

  const wanted = sections.map((section) => {
    const lines = cardLines(section.value);
    const rows = lines.length
      ? lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0)
      : 1;
    return LABEL + rows * LINE + GAP;
  });

  const total = wanted.reduce((sum, h) => sum + h, 0);
  if (total <= available) return wanted;
  return wanted.map((h) => (h / total) * available);
}

function narrative(
  slide: PptxSlide,
  ticket: Ticket,
  accent: string,
  geometry: Geometry,
  top: number,
  labels: ReturnType<typeof labelsFor>,
): void {
  const sections: Array<{ label: string; hint: string; value: string }> = [
    { ...labels.current, value: ticket.panelCurrent },
    { ...labels.impacts, value: ticket.panelImpacts },
    { ...labels.future, value: ticket.panelFuture },
  ];

  const available = ASIDE_BOTTOM - top;
  const heights = sectionHeights(sections, geometry.narrativeW, available);
  let cursor = top;

  sections.forEach((section, index) => {
    const y = cursor;
    const height = heights[index];
    cursor += height;

    // A coloured rule rather than a filled header bar: the eye still finds the
    // section, and the space goes to the words instead of the chrome.
    slide.addShape('rect', { x: MARGIN, y: y + 0.02, w: 0.05, h: height - 0.14, fill: { color: accent } });
    slide.addText(
      [
        { text: section.label.toUpperCase(), options: { bold: true, color: accent, fontSize: 9.5, charSpacing: 0.5 } },
        { text: `  ${section.hint}`, options: { color: MUTED, fontSize: 8.5, italic: true } },
      ],
      { x: MARGIN + 0.14, y, w: geometry.narrativeW - 0.14, h: 0.24, valign: 'middle' },
    );

    const lines = cardLines(section.value);
    slide.addText(
      lines.length
        ? lines.map((line, lineIndex) => ({
            text: line,
            options: { bullet: { characterCode: '2022' }, breakLine: lineIndex < lines.length - 1 },
          }))
        : [{ text: 'Not written yet', options: { italic: true, color: 'A3AEB9' } }],
      {
        x: MARGIN + 0.16,
        y: y + 0.24,
        w: geometry.narrativeW - 0.2,
        h: height - 0.3,
        fontSize: 10.5,
        color: INK,
        valign: 'top',
        lineSpacingMultiple: 1.02,
      },
    );
  });
}

function aside(
  slide: PptxSlide,
  ticket: Ticket,
  accent: string,
  geometry: Geometry,
  top: number,
  screenshot: string,
  facts: string[],
  hasImage: boolean,
): void {
  const { asideX: x, asideW: w } = geometry;
  const caption = trim(ticket.screenshotCaption, 160);
  let y = top;

  // Budget the column before drawing anything. A slide is fixed height, so a
  // picture sized first pushes the chips off the bottom edge - where, unlike a
  // web page, nobody ever finds them.
  const available = ASIDE_BOTTOM - top;
  const captionSpace = hasImage && caption ? 0.38 : 0;
  const chipHeight = facts.length ? 0.3 : 0;
  const chipSpace = facts.length ? 0.22 + facts.length * chipHeight : 0;
  const imageHeight = hasImage ? Math.max(0.9, Math.min(2.5, available - captionSpace - chipSpace - 0.08)) : 0;

  if (hasImage) {
    slide.addShape('rect', { x, y, w, h: imageHeight, fill: { color: PANEL_BG }, line: { color: PANEL_LINE } });
    try {
      // Always a data URI - packInput() fetches pasted URLs too, because
      // pptxgenjs fetching one itself takes the process down when the host
      // does not resolve.
      slide.addImage({
        data: screenshot,
        x: x + 0.06,
        y: y + 0.06,
        w: w - 0.12,
        h: imageHeight - 0.12,
        sizing: { type: 'contain', w: w - 0.12, h: imageHeight - 0.12 },
      });
    } catch {
      // A missing or unreachable screenshot must never fail pack generation.
    }
    y += imageHeight + 0.06;

    if (caption) {
      slide.addText(caption, { x, y, w, h: 0.34, fontSize: 8.5, italic: true, color: MUTED, valign: 'top' });
      y += 0.38;
    }
  }

  if (!facts.length) return;

  slide.addText('THE NUMBERS', { x, y, w, h: 0.2, fontSize: 8.5, bold: true, color: accent, charSpacing: 0.5 });
  y += 0.22;

  facts.forEach((fact, index) => {
    const { label, value } = chipParts(fact);
    const chipY = y + index * chipHeight;
    slide.addShape('roundRect', {
      x,
      y: chipY,
      w,
      h: chipHeight - 0.04,
      fill: { color: PANEL_BG },
      line: { color: PANEL_LINE },
      rectRadius: 0.06,
    });
    slide.addText(
      label
        ? [
            { text: `${label}  `, options: { bold: true, color: accent, fontSize: 8.5 } },
            { text: value, options: { color: INK, fontSize: 9 } },
          ]
        : [{ text: value, options: { color: INK, fontSize: 9 } }],
      { x: x + 0.09, y: chipY, w: w - 0.18, h: chipHeight - 0.04, valign: 'middle' },
    );
  });
}

function benefitBand(slide: PptxSlide, ticket: Ticket, accent: string, lead: string): void {
  const benefit = trim(ticket.panelBenefits, 220);
  if (!benefit) return;

  slide.addShape('rect', { x: MARGIN, y: 4.52, w: CONTENT_W, h: 0.46, fill: { color: PANEL_BG } });
  slide.addShape('rect', { x: MARGIN, y: 4.52, w: 0.05, h: 0.46, fill: { color: accent } });
  slide.addText(
    [
      { text: `${lead.toUpperCase()}  `, options: { bold: true, color: accent, fontSize: 9.5, charSpacing: 0.5 } },
      { text: benefit, options: { color: INK, fontSize: 11 } },
    ],
    { x: MARGIN + 0.16, y: 4.52, w: CONTENT_W - 0.24, h: 0.46, valign: 'middle' },
  );
}

function metadataStrip(slide: PptxSlide, ticket: Ticket): void {
  const metadata: Array<[string, string]> = [
    ['Raised by', ticket.stakeholder],
    ['Since', formatUkDate(ticket.createdDate)],
    ['Affects', ticket.affects || ticket.siteAffected],
    ['Workaround', ticket.workaround || 'None'],
    ['Priority', ticket.priority],
  ];

  const parts = metadata.filter(([, value]) => value && value.trim());
  if (!parts.length) return;

  slide.addText(
    parts.flatMap(([label, value], index) => [
      { text: `${label}: `, options: { bold: true, color: MUTED, fontSize: 8.5 } },
      { text: `${value}${index < parts.length - 1 ? '     ' : ''}`, options: { color: MUTED, fontSize: 8.5 } },
    ]),
    { x: MARGIN, y: 5.06, w: CONTENT_W, h: 0.3, valign: 'middle' },
  );
}
