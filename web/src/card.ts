/**
 * The card's shape and vocabulary, mirroring server/src/domain/card.ts.
 *
 * The four sections answer the four things a committee member has to know
 * before they can score anything: what is this, what is it costing us, what
 * would we do about it, and what changes once it is live. A fault, a clumsy
 * journey and a capability we do not have yet answer those differently, so the
 * labels follow the kind of ticket - the questions never change. The in-app
 * card, the PowerPoint slide and the PDF all use these words.
 */

export type CardKind = 'PROBLEM' | 'IMPROVEMENT' | 'FEATURE';

export interface SectionLabels {
  kind: string;
  current: { label: string; hint: string };
  impacts: { label: string; hint: string };
  future: { label: string; hint: string };
  benefits: string;
}

const LABELS: Record<CardKind, SectionLabels> = {
  PROBLEM: {
    kind: 'Problem',
    current: { label: "What's happening", hint: 'in plain English' },
    impacts: { label: "What it's costing us", hint: 'right now, every day' },
    future: { label: "What we'd do about it", hint: 'and how it would look' },
    benefits: 'Once it’s live',
  },
  IMPROVEMENT: {
    kind: 'Improvement',
    current: { label: 'How it works today', hint: 'the journey people actually take' },
    impacts: { label: 'What that costs us', hint: 'time, errors, frustration' },
    future: { label: "What we'd change", hint: 'and how it would look' },
    benefits: 'Once it’s live',
  },
  FEATURE: {
    kind: 'New capability',
    current: { label: "What we can't do today", hint: 'the gap' },
    impacts: { label: "What that's costing us", hint: 'why it keeps coming up' },
    future: { label: "What we'd build", hint: 'and how it would look' },
    benefits: 'Once it’s live',
  },
};

export const CARD_KINDS: CardKind[] = ['PROBLEM', 'IMPROVEMENT', 'FEATURE'];

/** Plain-English descriptions for the coordinator's kind picker. */
export const KIND_HINTS: Record<CardKind, string> = {
  PROBLEM: 'Something is broken or wrong today',
  IMPROVEMENT: 'It works, but it is slow, clumsy or manual',
  FEATURE: 'We cannot do this at all yet',
};

export function labelsFor(kind: string | null | undefined): SectionLabels {
  return LABELS[(kind ?? '') as CardKind] ?? LABELS.PROBLEM;
}

/** Kept in step with CARD_LIMITS on the server. */
export const CARD_LIMITS = {
  execSummary: 240,
  panel: 300,
  benefit: 200,
  impactFact: 62,
  screenshotCaption: 150,
} as const;

export function cardLines(value: string | null | undefined, max = 3): string[] {
  return (value ?? '')
    .split('\n')
    .map((line) => line.replace(/^[-*•\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, max);
}

/**
 * What is wrong with a card, in the words a coordinator would use. Mirrors
 * cardWarnings() in server/src/domain/card.ts - the server checks it when a
 * card is drafted, this shows it on the round page.
 *
 * The point is unattended running: a drafter that quietly writes a weak card is
 * worse than one that fails, because the weak card goes to the committee and
 * gets scored anyway.
 */
const JARGON =
  /\b(api|endpoint|null|nullable|cache|cron|regex|css|dom|sql|json|payload|middleware|refactor|deploy(?:ment)?|backend|front[- ]?end|repo(?:sitory)?|schema|env(?:ironment)? var\w*|stack ?trace|race condition|component|400|404|500|timeout)\b/i;

export interface CardCheckInput {
  title: string;
  execSummary: string;
  panelCurrent: string;
  panelImpacts: string;
  panelFuture: string;
  panelBenefits: string;
  impactFacts: string;
  screenshotCaption: string;
  screenshotAttachmentId?: string;
  screenshotUrl?: string;
  hasUnusedImage?: boolean;
}

export function cardWarnings(card: CardCheckInput): string[] {
  const warnings: string[] = [];
  const summary = (card.execSummary ?? '').trim();

  if (!summary) warnings.push('no headline');
  else if (normalise(summary) === normalise(card.title)) warnings.push('the headline just repeats the ticket title');

  const sections: Array<[string, string]> = [
    ['what it is', card.panelCurrent],
    ['what it costs', card.panelImpacts],
    ['what we would do', card.panelFuture],
    ["what changes once it's live", card.panelBenefits],
  ];
  const missing = sections.filter(([, value]) => !cardLines(value, 4).length).map(([label]) => label);
  if (missing.length) warnings.push(`nothing under ${missing.join(', ')}`);

  if (!cardLines(card.impactFacts, 4).length) warnings.push('no figures');

  const jargon = [summary, card.panelCurrent, card.panelImpacts, card.panelFuture, card.panelBenefits]
    .join(' ')
    .match(JARGON);
  if (jargon) warnings.push(`reads technical (\u201c${jargon[0]}\u201d)`);

  const hasShot = Boolean(card.screenshotAttachmentId || card.screenshotUrl);
  if (hasShot && !(card.screenshotCaption ?? '').trim()) warnings.push('the picture has no caption');
  if (!hasShot && card.hasUnusedImage) warnings.push('the ticket has a picture the card is not using');

  return warnings;
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
