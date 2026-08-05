/**
 * What a scoring card is (§7), independent of who wrote it and where it is
 * rendered. The in-app card, the PowerPoint slide and the PDF page all read
 * this, so the three cannot drift.
 *
 * The shape follows the one question a committee member has in front of them:
 * what is this, why does it matter, what would change, and what do I gain. A
 * problem, an improvement and a brand new feature answer that question
 * differently, so the section labels follow the kind of ticket rather than
 * being fixed at Current / Impacts / Future / Benefits.
 */

export type CardKind = 'PROBLEM' | 'IMPROVEMENT' | 'FEATURE';

export interface CardDraft {
  kind: CardKind;
  /** The headline. One or two sentences; the thing read if nothing else is. */
  execSummary: string;
  panelCurrent: string;
  panelImpacts: string;
  panelFuture: string;
  /** A single line, not bullets: "If we do this, …". */
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
  benefit: 170,
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
    current: { label: "What's going wrong", hint: 'the behaviour today' },
    impacts: { label: 'Who it hurts', hint: 'and how' },
    future: { label: 'What fixing it looks like', hint: 'the end state' },
    benefits: 'If we fix it',
  },
  IMPROVEMENT: {
    kind: 'Improvement',
    current: { label: 'How it works today', hint: 'the current journey' },
    impacts: { label: "What's clumsy about it", hint: 'the cost of leaving it' },
    future: { label: 'What would change', hint: 'the new journey' },
    benefits: 'If we do it',
  },
  FEATURE: {
    kind: 'New capability',
    current: { label: "What we can't do today", hint: 'the gap' },
    impacts: { label: "Why it's being asked for", hint: 'the pressure behind it' },
    future: { label: 'What it would let us do', hint: 'the new capability' },
    benefits: 'If we build it',
  },
};

export function labelsFor(kind: string | null | undefined): SectionLabels {
  return LABELS[(kind ?? '') as CardKind] ?? LABELS.PROBLEM;
}

export const CARD_KINDS: CardKind[] = ['PROBLEM', 'IMPROVEMENT', 'FEATURE'];

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
