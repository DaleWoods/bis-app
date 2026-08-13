/**
 * What a scoring card is (§7), independent of who wrote it and where it is
 * rendered. The in-app card, the PowerPoint slide and the PDF page all read
 * this, so the three cannot drift.
 *
 * The four sections answer, in order, the four things a committee member has to
 * know before they can score anything:
 *
 *   1. What is this, in plain English?
 *   2. What is it costing us right now?
 *   3. What would we actually do about it, and how would that look?
 *   4. What changes once it is live?
 *
 * A fault, a clumsy journey and a capability we do not have yet answer those
 * four differently, so the labels follow the kind of ticket. The questions
 * themselves never change - which is what makes thirty cards readable in one
 * sitting.
 */

export type CardKind = 'PROBLEM' | 'IMPROVEMENT' | 'FEATURE';

export interface CardDraft {
  kind: CardKind;
  /** The headline. One or two sentences; the thing read if nothing else is. */
  execSummary: string;
  /** 1. What this is. */
  panelCurrent: string;
  /** 2. What it is costing us today. */
  panelImpacts: string;
  /** 3. What we would do about it, and what it would look like. */
  panelFuture: string;
  /** 4. What changes once it is live. One line, not bullets - the closing note. */
  panelBenefits: string;
  /** Quantified facts, one per line, shown as chips beside the screenshot. */
  impactFacts: string;
  /** What the reader is looking at in the image. */
  screenshotCaption: string;
  /** Filename of the image the drafter judged most explanatory, if any. */
  screenshotPick?: string;
}

/**
 * Deliberately tight. The complaint about the old decks was that they were too
 * wordy; the answer to "it does not tell me enough" is more structure and a
 * bigger picture, not longer paragraphs.
 */
export const CARD_LIMITS = {
  execSummary: 240,
  panel: 300,
  bulletsPerPanel: 3,
  bullet: 100,
  benefit: 200,
  impactFacts: 4,
  impactFact: 62,
  screenshotCaption: 150,
} as const;

export interface SectionLabels {
  /** Shown as the kind chip on the slide. */
  kind: string;
  current: { label: string; hint: string };
  impacts: { label: string; hint: string };
  future: { label: string; hint: string };
  benefits: string;
}

/**
 * "What's happening now" is the right prompt for a bug and the wrong one for a
 * feature that does not exist yet. One table, three readings.
 */
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

export function labelsFor(kind: string | null | undefined): SectionLabels {
  return LABELS[(kind ?? '') as CardKind] ?? LABELS.PROBLEM;
}

/** `as const` so zod can build an enum from it without restating the values. */
export const CARD_KINDS = ['PROBLEM', 'IMPROVEMENT', 'FEATURE'] as const satisfies readonly CardKind[];

/**
 * A guess from the JIRA issue type, used when nothing better is available.
 * Wrong occasionally, and a coordinator can change it in one click.
 */
export function kindFromIssueType(type: string | null | undefined): CardKind {
  const value = (type ?? '').toLowerCase();
  if (/bug|defect|fault|incident|problem/.test(value)) return 'PROBLEM';
  if (/story|epic|new feature|feature|initiative/.test(value)) return 'FEATURE';
  if (/improve|enhance|change|task|chore/.test(value)) return 'IMPROVEMENT';
  return 'PROBLEM';
}

/** Bullets on one line each, as every renderer wants them. */
export function cardLines(value: string | null | undefined, max: number = CARD_LIMITS.bulletsPerPanel): string[] {
  return (value ?? '')
    .split('\n')
    .map((line) => line.replace(/^[-*•\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, max);
}

/** True when a draft found nothing worth showing, so the UI can say so. */
export function draftIsEmpty(draft: Pick<CardDraft, 'panelCurrent' | 'panelImpacts' | 'panelFuture' | 'panelBenefits'>): boolean {
  return !draft.panelCurrent && !draft.panelImpacts && !draft.panelFuture && !draft.panelBenefits;
}

/** Everything cardWarnings() needs, which is less than a whole Ticket. */
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
  /** True when the ticket has an image nobody has put on the card. */
  hasUnusedImage?: boolean;
}

/**
 * Words that mean something inside a dev team and nothing to a buyer. Not a
 * spell-check: each one is a term that has actually turned up on a card and
 * left the reader none the wiser.
 */
const JARGON =
  /\b(api|endpoint|null|nullable|cache|cron|regex|css|dom|sql|json|payload|middleware|refactor|deploy(?:ment)?|backend|front[- ]?end|repo(?:sitory)?|schema|env(?:ironment)? var\w*|stack ?trace|race condition|component|400|404|500|timeout)\b/i;

/**
 * What is wrong with a card, in the words a coordinator would use.
 *
 * The point of this is unattended running. A drafter that quietly writes a
 * weak card is worse than one that fails, because the weak card goes out to
 * the committee and gets scored anyway. These are the things that are
 * mechanically checkable - the rest is a human reading it.
 */
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

  if (!cardLines(card.impactFacts, CARD_LIMITS.impactFacts).length) warnings.push('no figures');

  const jargon = [summary, card.panelCurrent, card.panelImpacts, card.panelFuture, card.panelBenefits]
    .join(' ')
    .match(JARGON);
  if (jargon) warnings.push(`reads technical (“${jargon[0]}”)`);

  const hasShot = Boolean(card.screenshotAttachmentId || card.screenshotUrl);
  if (hasShot && !(card.screenshotCaption ?? '').trim()) warnings.push('the picture has no caption');
  if (!hasShot && card.hasUnusedImage) warnings.push('the ticket has a picture the card is not using');

  return warnings;
}

/** Punctuation and spacing removed, so "A carousel." and "a carousel" match. */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
