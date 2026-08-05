/**
 * The card's shape and vocabulary, mirroring server/src/domain/card.ts.
 *
 * A problem, an improvement and something we cannot do yet read differently to
 * a committee, so the sections are labelled by the kind of ticket rather than
 * being fixed at Current / Impacts / Future / Benefits. The in-app card, the
 * PowerPoint slide and the PDF all use these words.
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
  benefit: 170,
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
