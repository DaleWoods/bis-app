import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../config/env.js';
import { CARD_LIMITS, type CardDraft, type DraftSource, clip, tidy } from '../domain/cardDraft.js';

/**
 * AI drafting of a scoring card (§7).
 *
 * The deterministic drafter in domain/cardDraft.ts reads headings. That works
 * when a ticket is written in sections and produces nothing useful when it is
 * not - and most tickets are not. This reads the whole ticket instead and
 * writes the card the way a business analyst would: what is happening, what it
 * costs the business, what good looks like, what we get.
 *
 * Optional by design. With no API key the app falls back to the deterministic
 * drafter, so nothing here is on the critical path.
 */

/** Bullets rather than prose, so the model cannot hand back a paragraph. */
const DraftResponse = z.object({
  execSummary: z.string(),
  current: z.array(z.string()),
  impacts: z.array(z.string()),
  future: z.array(z.string()),
  benefits: z.array(z.string()),
});

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    execSummary: {
      type: 'string',
      description: 'One or two plain sentences a non-technical reader understands. No jargon, no ticket numbers.',
    },
    current: { type: 'array', items: { type: 'string' }, description: 'What is happening today, and why it is a problem.' },
    impacts: { type: 'array', items: { type: 'string' }, description: 'What it costs the business: people, money, time, risk, customers.' },
    future: { type: 'array', items: { type: 'string' }, description: 'What good looks like once this is done.' },
    benefits: { type: 'array', items: { type: 'string' }, description: 'What the business gains. Not a restatement of the fix.' },
  },
  required: ['execSummary', 'current', 'impacts', 'future', 'benefits'],
  additionalProperties: false,
} as const;

const SYSTEM = [
  'You write one-slide summaries of software tickets for a business committee that scores them for priority.',
  'The committee is commercial, not technical: buyers, operations, finance, customer service. Most have never seen the system.',
  '',
  'The complaint about the current slides is that they are too wordy, too descriptive and overpowering. So:',
  `- The summary is at most ${CARD_LIMITS.execSummary} characters. Two short sentences is the target, one is fine.`,
  `- Each panel is at most ${CARD_LIMITS.bulletsPerPanel} bullets of at most ${CARD_LIMITS.bullet} characters. Fewer is better.`,
  '- Bullets are fragments, not sentences. No trailing full stops. No sub-bullets.',
  '- Plain English. Expand or drop internal names, system names and acronyms unless a buyer would know them.',
  '',
  'Read the whole ticket and work out what it actually means for the business. The title is often thin and the',
  'description is often written by an engineer for an engineer - your job is to translate, and to draw the obvious',
  'business consequence the ticket implies even where nobody has written it down. A checkout defect means lost orders;',
  'a manual workaround means someone spends their morning on it.',
  '',
  'Anchor everything in the ticket. Never invent a specific figure, name, date, customer or system that is not there.',
  'Where the ticket gives numbers, use them. Where it does not, describe the effect without quantifying it.',
  'If a panel genuinely has nothing to say, return an empty list rather than filler - an empty panel prompts the',
  'coordinator to fill it in, whereas filler reads as content and gets left in.',
].join('\n');

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ai.apiKey, timeout: env.ai.timeoutMs, maxRetries: 2 });
  }
  return client;
}

/** Reset after a config change so a new key takes effect without a restart. */
export function resetAiClient(): void {
  client = null;
}

function ticketPrompt(source: DraftSource): string {
  const facts: Array<[string, string | undefined]> = [
    ['Ticket', source.jiraId],
    ['Type', source.type],
    ['Title', source.title],
    ['Raised by', source.stakeholder],
    ['Who or what it affects', source.affects],
    ['Impact noted on the ticket', source.impacts],
    ['Workaround in place', source.workaround],
  ];

  const lines = facts.filter(([, value]) => value && value.trim()).map(([label, value]) => `${label}: ${value!.trim()}`);

  // The description goes in raw - formatting, headings and all. The model reads
  // it better than a regex does, and stripping it first only loses signal.
  const description = (source.description ?? '').trim();
  lines.push('', 'Description:', description || '(the ticket has no description - work from the title and the fields above)');

  return lines.join('\n');
}

/** Bullets in, one clipped panel string out, matching the deterministic drafter's shape. */
function panel(bullets: string[]): string {
  const cleaned = bullets
    .map((b) => tidy(b).replace(/\s+/g, ' ').replace(/[.;]+$/, '').trim())
    .filter(Boolean)
    .slice(0, CARD_LIMITS.bulletsPerPanel)
    .map((b) => clip(b, CARD_LIMITS.bullet));

  return clip(cleaned.join('\n'), CARD_LIMITS.panel);
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
    // A short, well-specified writing task. Low effort keeps a 30-ticket import
    // quick and cheap without costing anything in quality here.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
    messages: [{ role: 'user', content: ticketPrompt(source) }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (!text.trim()) throw new Error('The model returned no card content');

  const parsed = DraftResponse.parse(JSON.parse(text));

  return {
    execSummary: clip(tidy(parsed.execSummary).replace(/\s+/g, ' '), CARD_LIMITS.execSummary),
    panelCurrent: panel(parsed.current),
    panelImpacts: panel(parsed.impacts),
    panelFuture: panel(parsed.future),
    panelBenefits: panel(parsed.benefits),
  };
}
