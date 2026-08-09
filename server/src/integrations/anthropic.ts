import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../config/env.js';
import { CARD_LIMITS, CARD_KINDS, type CardDraft, type CardKind, kindFromIssueType } from '../domain/card.js';
import { type DraftSource, clip, tidy } from '../domain/cardDraft.js';

/**
 * AI drafting of a scoring card (§7).
 *
 * The deterministic drafter in domain/cardDraft.ts reads headings. That works
 * when a ticket is written in sections and produces nothing useful when it is
 * not - and most tickets are not. This reads everything the ticket has:
 * description, comments, priority, labels, components, linked issues and the
 * names of the images attached to it.
 *
 * Comments matter more than they look. A description says "carousel does not
 * rotate"; the comment three weeks later says "trading have had to pull the
 * second and third promotions from the homepage since March". The second one is
 * what a committee scores on.
 *
 * Optional by design. With no API key the app falls back to the deterministic
 * drafter, so nothing here is on the critical path.
 */

const DraftResponse = z.object({
  kind: z.enum(['PROBLEM', 'IMPROVEMENT', 'FEATURE']),
  headline: z.string(),
  current: z.array(z.string()),
  impacts: z.array(z.string()),
  future: z.array(z.string()),
  benefit: z.string(),
  impactFacts: z.array(z.string()),
  screenshotCaption: z.string(),
  screenshotFilename: z.string(),
});

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: CARD_KINDS,
      description:
        'PROBLEM = something is broken or wrong today. IMPROVEMENT = it works but it is slow, clumsy or manual. FEATURE = we cannot do this at all yet.',
    },
    headline: {
      type: 'string',
      description:
        'One or two plain sentences naming the thing and why a commercial reader should care. No jargon, no ticket numbers, no system names a buyer would not know.',
    },
    current: {
      type: 'array',
      items: { type: 'string' },
      description: 'PROBLEM: what goes wrong. IMPROVEMENT: how it works today. FEATURE: what we cannot do today.',
    },
    impacts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Who it hurts and how. Named teams, customers, order volumes - the business consequence, not the technical cause.',
    },
    future: {
      type: 'array',
      items: { type: 'string' },
      description: 'What the world looks like once this is done. Concrete and observable, not "it will be fixed".',
    },
    benefit: {
      type: 'string',
      description: 'One line completing "If we do this, …". The single strongest reason to prioritise it.',
    },
    impactFacts: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Up to four short quantified facts drawn from the ticket, shown as chips. Shape them "label: value", e.g. "Affects: all mobile customers", "Frequency: every homepage visit", "Manual effort: ~20 orders a morning", "Open since: March". Only facts the ticket supports.',
    },
    screenshotCaption: {
      type: 'string',
      description:
        'What the reader is looking at in the image and where to look, e.g. "The banner never advances past the first promotion". Empty string if the ticket has no images.',
    },
    screenshotFilename: {
      type: 'string',
      description:
        'Exact filename of the attached image that best explains this to someone who has never seen the system. Empty string if there are none or none help.',
    },
  },
  required: ['kind', 'headline', 'current', 'impacts', 'future', 'benefit', 'impactFacts', 'screenshotCaption', 'screenshotFilename'],
  additionalProperties: false,
} as const;

const SYSTEM = [
  'You turn software tickets into one-slide summaries for a business committee that scores them for priority.',
  'The committee is commercial, not technical: buyers, merchandisers, operations, finance, customer service.',
  'Most have never seen the system and will not ask a follow-up question - the slide is all they get.',
  '',
  'Work like an analyst, not a summariser. Read the description, every comment, the labels, the priority, the',
  'linked issues and the image filenames, and work out what this ticket actually is and what it costs the',
  'business. The title is frequently thin or written in internal shorthand; the real story is usually further',
  'down, and often in a comment rather than the description. Do not paraphrase the title back.',
  '',
  'Translate as you go. "Carousel component has no rotation delay" means the homepage banner never advances,',
  'so only the first promotion is ever seen. Say the second thing. Expand or drop internal names, component',
  'names and acronyms unless a buyer would know them.',
  '',
  'Draw the business consequence the ticket implies even where nobody has written it down. A checkout defect',
  'means lost orders. A manual workaround means somebody spends their morning on it. A promotion that never',
  'shows means the campaign was paid for and not seen. Say so.',
  '',
  'Length - the standing complaint is that these slides are too wordy, so:',
  `- Headline at most ${CARD_LIMITS.execSummary} characters. One or two sentences.`,
  `- Each section at most ${CARD_LIMITS.bulletsPerPanel} bullets of at most ${CARD_LIMITS.bullet} characters. Fewer is better.`,
  '- Bullets are fragments, not sentences. No trailing full stops, no sub-bullets.',
  `- The benefit line is one sentence, at most ${CARD_LIMITS.benefit} characters.`,
  '',
  'Never invent a figure, name, date, customer or system that is not in the ticket. Where the ticket gives',
  'numbers, use them, in the impact facts especially. Where it does not, describe the effect without',
  'quantifying it, and leave that chip out. An empty list beats filler: filler reads as content and survives',
  'into the deck, whereas a gap prompts the coordinator to fill it in.',
].join('\n');

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ai.apiKey, timeout: env.ai.timeoutMs, maxRetries: 2 });
  }
  return client;
}

/** Drops the memoised client. A test seam: the key comes from the
 *  environment, so a running instance never changes it. */
export function resetAiClient(): void {
  client = null;
}

/** Long fields are truncated rather than dropped - the opening is the useful part. */
function cap(text: string, max: number): string {
  const value = (text ?? '').trim();
  return value.length > max ? `${value.slice(0, max)}\n[…truncated]` : value;
}

export function ticketPrompt(source: DraftSource): string {
  const facts: Array<[string, string | undefined | null]> = [
    ['Ticket', source.jiraId],
    ['Issue type', source.type],
    ['Title', source.title],
    ['Priority', source.priority],
    ['Raised by', source.stakeholder],
    ['Raised on', source.createdDate],
    ['Labels', source.labels],
    ['Components', source.components],
    ['Site affected', source.siteAffected],
    ['Environment', source.environment],
    ['Who or what it affects', source.affects],
    ['Impact noted on the ticket', source.impacts],
    ['Workaround in place', source.workaround],
    ['Linked issues', source.linkedIssues],
  ];

  const lines = facts.filter(([, value]) => value && String(value).trim()).map(([label, value]) => `${label}: ${String(value).trim()}`);

  const images = (source.imageFilenames ?? []).filter(Boolean);
  lines.push('', 'Images attached to this ticket:', images.length ? images.map((f) => `- ${f}`).join('\n') : '(none)');

  // The description and comments go in raw - formatting, headings and all. The
  // model reads them better than a regex does, and cleaning them first only
  // throws away signal.
  lines.push('', '--- Description ---', cap(source.description ?? '', 12000) || '(the ticket has no description)');

  const comments = cap(source.comments ?? '', 12000);
  lines.push('', '--- Comments, oldest first ---', comments || '(no comments)');

  return lines.join('\n');
}

/** Bullets in, one clipped block out, matching the deterministic drafter's shape. */
function panel(bullets: string[]): string {
  const cleaned = bullets
    .map(fragment)
    .filter(Boolean)
    .slice(0, CARD_LIMITS.bulletsPerPanel)
    .map((b) => clip(b, CARD_LIMITS.bullet));

  return clip(cleaned.join('\n'), CARD_LIMITS.panel);
}

function oneLine(value: string): string {
  return tidy(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bullets are fragments, so a trailing stop is noise. Sentences keep theirs. */
function fragment(value: string): string {
  return oneLine(value).replace(/[.;]+$/, '');
}

/**
 * The model is asked for a filename, so hold it to one that exists. A
 * hallucinated name would silently blank the card's image.
 */
function resolvePick(filename: string, available: string[] | undefined): string | undefined {
  const wanted = (filename ?? '').trim().toLowerCase();
  if (!wanted) return undefined;
  return (available ?? []).find((name) => name.toLowerCase() === wanted);
}

/**
 * Draft a card with the model. Throws on any failure - callers fall back to the
 * deterministic drafter rather than surfacing an error to the coordinator.
 */
export async function draftCardWithAi(source: DraftSource): Promise<CardDraft> {
  const response = await getClient().messages.create({
    model: env.ai.model,
    max_tokens: 8000,
    system: SYSTEM,
    // Reading a long ticket and judging what matters commercially is a
    // reasoning task, not a formatting one, so this is worth medium effort.
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
    messages: [{ role: 'user', content: ticketPrompt(source) }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (!text.trim()) throw new Error('The model returned no card content');

  const parsed = DraftResponse.parse(JSON.parse(text));

  return {
    kind: (parsed.kind as CardKind) ?? kindFromIssueType(source.type),
    execSummary: clip(oneLine(parsed.headline), CARD_LIMITS.execSummary),
    panelCurrent: panel(parsed.current),
    panelImpacts: panel(parsed.impacts),
    panelFuture: panel(parsed.future),
    panelBenefits: clip(oneLine(parsed.benefit), CARD_LIMITS.benefit),
    impactFacts: parsed.impactFacts
      .map(fragment)
      .filter(Boolean)
      .slice(0, CARD_LIMITS.impactFacts)
      .map((fact) => clip(fact, CARD_LIMITS.impactFact))
      .join('\n'),
    screenshotCaption: clip(oneLine(parsed.screenshotCaption), CARD_LIMITS.screenshotCaption),
    screenshotPick: resolvePick(parsed.screenshotFilename, source.imageFilenames),
  };
}
