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
 * not - and most tickets are not. This reads the ticket the way an analyst
 * would: description, every comment, priority, labels, components, linked
 * issues, and the names of the images attached to it.
 *
 * The job is not summarising. A committee member scoring thirty of these has
 * four questions and no way to ask a fifth, so the drafter has to work out the
 * answers - which often means saying something the ticket never says outright.
 * "Carousel component has no rotation delay" has to come out as "only the first
 * promotion on the homepage is ever seen". The second sentence is what gets
 * scored; the first is what the ticket happens to say.
 *
 * Two passes, because one was not good enough. The analyst writes the card;
 * a second call reads it back as the committee member would, cold, with no
 * access to anything but the card and the ticket, and fixes what does not
 * survive that reading. It is a different job rather than a "check your work"
 * instruction, and it catches the two failures that matter: a sentence only
 * somebody who had read the ticket could understand, and a claim the ticket
 * does not support.
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

const ReviewResponse = DraftResponse.extend({
  /** What the reviewer changed, in its own words. Logged, never shown on the card. */
  fixed: z.array(z.string()),
});

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: CARD_KINDS,
      description:
        'PROBLEM = something is broken or wrong today. IMPROVEMENT = it works, but it is slow, clumsy or manual. FEATURE = we cannot do this at all yet.',
    },
    headline: {
      type: 'string',
      description:
        'The whole ticket in one or two plain sentences: what this is and why a commercial reader should care. This is the sentence somebody remembers when they vote. Never a rewording of the ticket title.',
    },
    current: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Question 1 - what is this, in plain English? PROBLEM: what actually happens, described so somebody who has never seen the screen can picture it. IMPROVEMENT: how the job gets done today, step by step. FEATURE: what we cannot do at all.',
    },
    impacts: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Question 2 - what is it costing us right now? Money, orders, hours, customers, risk, reputation. Name the team or the customer it lands on. This is the section that decides the score, so it is the one worth getting right.',
    },
    future: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Question 3 - what would we actually do about it, and what would it look like afterwards? Describe the change in terms of what the reader would see or do differently, not the implementation.',
    },
    benefit: {
      type: 'string',
      description:
        'Question 4 - what changes once it is live? One sentence, the single clearest gain, in the same units as question 2 where you can. Completes "Once it is live, …" without repeating those words.',
    },
    impactFacts: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Up to four short quantified facts, shown as chips beside the picture. Shape them "Label: value" - "Affects: all mobile customers", "Frequency: every homepage visit", "Manual effort: ~20 orders a morning", "Open since: March". Only facts the ticket supports. An empty list is a perfectly good answer.',
    },
    screenshotCaption: {
      type: 'string',
      description:
        'What the reader is looking at and where to look, e.g. "The banner never advances past the first promotion". Empty string if the ticket has no images.',
    },
    screenshotFilename: {
      type: 'string',
      description:
        'Exact filename of the attached image that best explains this to somebody who has never seen the system. Prefer one that shows the problem happening over a settings screen or a log. Empty string if there are none or none help.',
    },
  },
  required: ['kind', 'headline', 'current', 'impacts', 'future', 'benefit', 'impactFacts', 'screenshotCaption', 'screenshotFilename'],
  additionalProperties: false,
} as const;

const REVIEW_SCHEMA = {
  ...DRAFT_SCHEMA,
  properties: {
    ...DRAFT_SCHEMA.properties,
    fixed: {
      type: 'array',
      items: { type: 'string' },
      description:
        'One short line per thing you changed and why, e.g. "headline was the ticket title reworded". Empty if the card was already right - say nothing rather than inventing a change.',
    },
  },
  required: [...DRAFT_SCHEMA.required, 'fixed'],
} as const;

/** The reader both passes are writing for. Stated once, used by both. */
const AUDIENCE = [
  'The readers are a business committee who score tickets for priority: buyers, merchandisers, operations,',
  'finance, customer service. Most have never seen the system, none will read the ticket, and none can ask a',
  'follow-up question. They read about thirty of these in a sitting, so a card that takes effort to understand',
  'does not get understood - it gets a middling score and moves on.',
].join('\n');

const SYSTEM = [
  'You write the one-slide card a business committee scores a software ticket from.',
  '',
  AUDIENCE,
  '',
  'HOW TO READ THE TICKET',
  'Read all of it before writing anything: description, every comment in order, labels, priority, components,',
  'linked issues, image filenames. Then work out, for yourself, what this ticket actually is. Do not go looking',
  'for headings to lift - most tickets do not have them, and the ones that do are usually stale. The real story',
  'is often in a comment weeks after the description: the description says the banner does not rotate, the',
  'comment in March says trading have pulled two promotions off the homepage because of it. The comment is the',
  'card.',
  '',
  'THE FOUR QUESTIONS',
  'A committee member has four questions and nothing else. Answer them in this order and answer all four:',
  '  1. What is this? In plain English, so somebody who has never seen the screen can picture it.',
  '  2. What is it costing us right now? Money, orders, hours, customers, risk. Who it lands on.',
  '  3. What would we do about it, and what would it look like afterwards?',
  '  4. What changes once it is live? One line.',
  'If the ticket does not answer one of them, say the most that the ticket does support - never pad, never guess.',
  '',
  'WRITE IT FOR SOMEBODY WHO HAS NEVER SEEN THE SYSTEM',
  'Translate everything. A component name, a table name, a status code, an internal acronym, a screen name only',
  'the team uses, a data-engineering word like "payload" or "metadata" - all of it goes, replaced by what the',
  'reader would actually see or do. "The carousel component has no rotation delay" becomes "the homepage banner',
  'never moves past the first promotion". "Orders fail with a null customer id" becomes "some orders will not go',
  'through at checkout". "The event payload includes unused metadata fields" becomes "we are sending extra data',
  'nobody uses every time somebody removes an item from their basket".',
  'Keep names the reader genuinely knows: the brand, the site, the department, the customer-facing product.',
  '',
  'DRAW THE CONSEQUENCE THE TICKET IMPLIES',
  'Tickets are written by people who already know why it matters, so they leave the why out. A checkout defect',
  'means lost orders. A manual workaround means somebody spends their morning on it. A promotion that never shows',
  'means the campaign was paid for and not seen. Say the second thing. This is judgement, not invention: it has',
  'to follow from what the ticket says, and if it does not follow, leave it out.',
  '',
  'A TICKET THAT DOWNPLAYS ITS OWN IMPACT IS NOT THE SAME AS ONE WITH NO IMPACT',
  'Some tickets open question 2 with their own answer already in it - "this does not affect X" - and stop there.',
  'That line is not the impact, it is the ticket ruling out the impact people might otherwise assume. Read past',
  'it for what the ticket still says: data that nobody uses, a report that becomes harder to trust, a process',
  'that stays inconsistent. If that is genuinely all there is, write that - a thin, honest answer beats copying',
  'the ticket\'s own disclaimer as if it were the answer to "what is this costing us".',
  '',
  'LENGTH - the standing complaint is that these are too wordy, and a wall of text gets skimmed:',
  `- Headline at most ${CARD_LIMITS.execSummary} characters. One or two sentences.`,
  `- Each section at most ${CARD_LIMITS.bulletsPerPanel} bullets. Aim for ${CARD_LIMITS.bulletTarget} characters ` +
    `or fewer - that is the length of a good bullet. ${CARD_LIMITS.bullet} is the hard ceiling: anything longer ` +
    'gets cut off mid-word with "…" appended, which reads worse than a shorter bullet ever would. If a bullet ' +
    'is running long, cut the least important clause rather than let it be truncated - a bullet you shortened on ' +
    'purpose always beats one the system shortened for you.',
  '- Two good bullets beat three padded ones.',
  '- Bullets are fragments, not sentences. No trailing full stops, no sub-bullets, no bullet that restates another.',
  `- The closing line is one sentence, at most ${CARD_LIMITS.benefit} characters.`,
  '',
  'NEVER',
  '- Reword the ticket title and call it a headline.',
  '- Use a ticket number, a component name, a class or table name, an HTTP status, or an acronym a buyer would not know.',
  '- Invent a figure, a name, a date, a customer or a system that is not in the ticket.',
  '- Write filler to fill a section. An empty list beats filler: filler reads as content and survives into the deck,',
  '  whereas a gap tells the coordinator to go and find the answer.',
  '',
  'WORKED EXAMPLE - the translation, not a template. Do not copy its shape, subject or phrasing.',
  'Ticket: "ECOM-1213 Aurora banner carousel component, no rotation delay". Description names the component and the',
  'missing config value. A comment from marketing three weeks later says the second and third slots have been sold',
  'to two brands for the spring campaign and neither has been seen.',
  '  Weak headline: "The Aurora banner carousel component has no rotation delay set."',
  '  Good headline: "The homepage banner never moves past the first promotion, so two campaigns we have already',
  '  been paid for are not being seen."',
  '  Weak bullet under question 2: "rotation delay not configured"',
  '  Good bullet under question 2: "two spring campaigns paid for and never shown"',
  '',
  'SECOND WORKED EXAMPLE - a ticket that plays down its own impact.',
  'Ticket: a tracking event sends three fields nobody reads any more. The description says "this does not affect',
  'tracking functionality" and lists the fields as unused, the event structures as inconsistent with other event',
  'types, and the change as making the tracking implementation easier to maintain.',
  '  Weak headline: "The event payload includes unused metadata fields."',
  '  Good headline: "Every time someone removes something from their basket we record data nobody uses, and it',
  '  makes this event harder to compare with the others feeding the same reports."',
  '  Weak bullet under question 2: "does not affect tracking functionality" (this is the ticket ruling out a',
  '  concern, not answering the question - see it and keep reading).',
  '  Good bullet under question 2: "this event does not match the shape of the others, so reports built across',
  '  them are harder to trust"',
  '  This ticket has no lost orders or angry customers in it, and a good card does not invent any. It is a small,',
  '  honest card about data quality, not a padded one.',
].join('\n');

const REVIEW_SYSTEM = [
  'You are the committee member. A card has been written for you about a software ticket you have never seen,',
  'and you have to score it. You get the ticket as well, which the real committee does not - use it only to',
  'check the card, never to excuse it.',
  '',
  AUDIENCE,
  '',
  'Read the card cold and fix it. Return the corrected card - the whole card, not just the parts you changed.',
  'If it is already right, return it unchanged and say so by returning an empty list of fixes. Do not manufacture',
  'a change to look thorough, and do not rewrite good phrasing into your own.',
  '',
  'What to fix, in the order it matters:',
  '1. Anything you cannot understand without having read the ticket. A component or system name, an acronym, a',
  '   data-engineering word like "payload" or "metadata", a screen only the team would recognise, a sentence that',
  '   assumes you know how the thing works. Rewrite it as what a reader would see or do.',
  '2. Anything the ticket does not support. A figure, date, team, customer or consequence that is not there, or',
  '   is stated more confidently than the ticket warrants. Cut it or soften it to what the ticket actually says.',
  '   The opposite fault counts too: a cost bullet that just repeats the ticket\'s own "this does not affect X" and',
  '   stops, when the ticket goes on to describe a real if modest cost - read past the disclaimer and use it.',
  '3. A question that is not answered. The four are: what is this, what is it costing us, what would we do, what',
  '   changes once it is live. If the ticket answers it and the card does not, answer it. If the ticket does not,',
  '   leave it empty.',
  '4. A headline that is the ticket title reworded, or that says what is broken without saying why anyone cares.',
  '5. Padding. A bullet that restates another, a caveat nobody needs, a sentence that could lose half its words.',
  '6. Over-length. Headline, bullets and the closing line all have limits, and the card is clipped if they are',
  '   exceeded - so a sentence over the limit loses its ending rather than being shortened well.',
  '',
  'Do not add sections, do not add facts, and do not make the card longer than you found it.',
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

/** The drafted card, laid out the way the reviewer will read it on screen. */
function cardPrompt(parsed: z.infer<typeof DraftResponse>): string {
  return [
    `Kind: ${parsed.kind}`,
    `Headline: ${parsed.headline}`,
    '',
    '1. What is this?',
    ...parsed.current.map((b) => `- ${b}`),
    '',
    '2. What is it costing us?',
    ...parsed.impacts.map((b) => `- ${b}`),
    '',
    '3. What would we do about it?',
    ...parsed.future.map((b) => `- ${b}`),
    '',
    `4. Once it is live: ${parsed.benefit}`,
    '',
    `Figures shown beside the picture: ${parsed.impactFacts.join(' | ') || '(none)'}`,
    `Picture caption: ${parsed.screenshotCaption || '(no picture)'}`,
    `Picture chosen: ${parsed.screenshotFilename || '(none)'}`,
  ].join('\n');
}

/**
 * One structured call. Streamed because a long ticket plus thinking can run
 * past the SDK's non-streaming timeout, and a timeout here silently demotes
 * the card to the heading parser.
 */
async function ask<T extends z.ZodTypeAny>(
  system: string,
  user: string,
  schema: Record<string, unknown>,
  shape: T,
  effort: 'low' | 'medium' | 'high',
): Promise<z.infer<T>> {
  const stream = getClient().messages.stream({
    model: env.ai.model,
    max_tokens: 24000,
    system,
    // Reading a long ticket and working out what it costs the business is a
    // reasoning task, not a formatting one.
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }],
  });

  const response = await stream.finalMessage();
  if (response.stop_reason === 'refusal') throw new Error('The model declined to draft this card');

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (!text.trim()) throw new Error('The model returned no card content');
  return shape.parse(JSON.parse(text));
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

function toDraft(parsed: z.infer<typeof DraftResponse>, source: DraftSource): CardDraft {
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

/**
 * Draft a card with the model. Throws on any failure - callers fall back to the
 * deterministic drafter rather than surfacing an error to the coordinator.
 */
export async function draftCardWithAi(source: DraftSource): Promise<CardDraft> {
  const ticket = ticketPrompt(source);
  const drafted = await ask(SYSTEM, ticket, DRAFT_SCHEMA, DraftResponse, 'high');

  if (!env.ai.reviewEnabled) return toDraft(drafted, source);

  // A failed review is not a failed card. The draft is already usable, and
  // losing it to a second network call would be a worse outcome than shipping
  // it unreviewed.
  try {
    const reviewed = await ask(
      REVIEW_SYSTEM,
      [`--- The card ---`, cardPrompt(drafted), '', '--- The ticket it came from ---', ticket].join('\n'),
      REVIEW_SCHEMA,
      ReviewResponse,
      'medium',
    );
    if (reviewed.fixed.length) {
      console.log(`[bis] card review for ${source.jiraId}: ${reviewed.fixed.join('; ')}`);
    }
    return toDraft(reviewed, source);
  } catch (err) {
    console.warn(
      `[bis] card review failed for ${source.jiraId}, keeping the first draft: ${err instanceof Error ? err.message : String(err)}`,
    );
    return toDraft(drafted, source);
  }
}
