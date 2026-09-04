import { describe, expect, it } from 'vitest';
import { CARD_KINDS, CARD_LIMITS, cardBlocksAutomatedDistribution, cardLines, cardWarnings, draftIsEmpty, kindFromIssueType, labelsFor } from './card.js';

describe('CARD_LIMITS', () => {
  it('gives the drafter headroom past the target before a bullet gets clipped', () => {
    // bulletTarget is what the prompt asks for; bullet is the hard cap clip()
    // actually enforces. If these ever collapse to the same number, a bullet
    // that just misses the target gets an ellipsis instead of the headroom
    // this pair exists to give it.
    expect(CARD_LIMITS.bullet).toBeGreaterThan(CARD_LIMITS.bulletTarget);
  });
});

describe('labelsFor', () => {
  it('asks a different question of each kind of ticket', () => {
    expect(labelsFor('PROBLEM').current.label).toBe("What's happening");
    expect(labelsFor('IMPROVEMENT').current.label).toBe('How it works today');
    expect(labelsFor('FEATURE').current.label).toBe("What we can't do today");
  });

  it('closes every card on what changes once it ships', () => {
    // The same four questions in the same order on every card is what makes
    // thirty of them readable in one sitting.
    for (const kind of CARD_KINDS) expect(labelsFor(kind).benefits).toBe('Once it’s live');
  });

  it('falls back to the problem wording for an unset or unknown kind', () => {
    expect(labelsFor('').kind).toBe('Problem');
    expect(labelsFor(null).kind).toBe('Problem');
    expect(labelsFor('NONSENSE').kind).toBe('Problem');
  });

  it('has labels for every kind, so no card can render unlabelled', () => {
    for (const kind of CARD_KINDS) {
      const labels = labelsFor(kind);
      expect(labels.kind).toBeTruthy();
      expect(labels.current.label).toBeTruthy();
      expect(labels.benefits).toBeTruthy();
    }
  });
});

describe('kindFromIssueType', () => {
  it('reads the common JIRA issue types', () => {
    expect(kindFromIssueType('Bug')).toBe('PROBLEM');
    expect(kindFromIssueType('Defect')).toBe('PROBLEM');
    expect(kindFromIssueType('Story')).toBe('FEATURE');
    expect(kindFromIssueType('New Feature')).toBe('FEATURE');
    expect(kindFromIssueType('Improvement')).toBe('IMPROVEMENT');
    expect(kindFromIssueType('Task')).toBe('IMPROVEMENT');
  });

  it('guesses a problem when the type says nothing useful', () => {
    expect(kindFromIssueType('')).toBe('PROBLEM');
    expect(kindFromIssueType('Widget')).toBe('PROBLEM');
  });
});

describe('cardLines', () => {
  it('strips bullet markers and blank lines', () => {
    expect(cardLines('* one\n\n- two\n• three')).toEqual(['one', 'two', 'three']);
  });

  it('caps at the number the renderer asked for', () => {
    expect(cardLines('a\nb\nc\nd\ne')).toHaveLength(3);
    expect(cardLines('a\nb\nc\nd\ne', 4)).toHaveLength(4);
  });
});

describe('draftIsEmpty', () => {
  it('is true only when every section is blank', () => {
    const blank = { panelCurrent: '', panelImpacts: '', panelFuture: '', panelBenefits: '' };
    expect(draftIsEmpty(blank)).toBe(true);
    expect(draftIsEmpty({ ...blank, panelImpacts: 'something' })).toBe(false);
  });
});

describe('cardWarnings', () => {
  const good = {
    title: 'Aurora banner carousel component - no rotation delay',
    execSummary: 'The homepage banner never moves past the first promotion, so campaigns we paid for are not seen.',
    panelCurrent: 'Banner stays on the first promotion',
    panelImpacts: 'Two spring campaigns paid for and never shown',
    panelFuture: 'Banner moves on every few seconds',
    panelBenefits: 'Every promotion we pay for is actually seen.',
    impactFacts: 'Affects: all customers\nOpen since: March',
    screenshotCaption: 'The banner stays on slide one',
    screenshotAttachmentId: 'att-1',
  };

  it('passes a card that answers all four questions in plain English', () => {
    expect(cardWarnings(good)).toEqual([]);
  });

  it('catches a headline that is just the ticket title reworded', () => {
    const warnings = cardWarnings({ ...good, execSummary: 'Aurora banner carousel component — no rotation delay!' });
    expect(warnings).toContain('the headline just repeats the ticket title');
  });

  it('names the questions the card does not answer', () => {
    const warnings = cardWarnings({ ...good, panelImpacts: '', panelBenefits: '   ' });
    expect(warnings.some((w) => w.includes('what it costs') && w.includes("what changes once it's live"))).toBe(true);
  });

  it('catches wording only a developer would understand', () => {
    // The whole point of the card is that a buyer can read it.
    expect(cardWarnings({ ...good, panelCurrent: 'The carousel API returns a null payload' })).toContainEqual(
      expect.stringContaining('reads technical'),
    );
  });

  it('catches "metadata" and "payload" left untranslated', () => {
    // Reported live: a card for ECOM-1737 read "the payload includes additional
    // metadata attributes" - exactly the wording the ticket used, never
    // translated into what a buyer would recognise.
    expect(cardWarnings({ ...good, panelCurrent: 'The payload includes additional metadata attributes' })).toContainEqual(
      expect.stringContaining('reads technical'),
    );
  });

  it('notices a picture with no caption, and a picture nobody used', () => {
    expect(cardWarnings({ ...good, screenshotCaption: '' })).toContain('the picture has no caption');
    expect(cardWarnings({ ...good, screenshotAttachmentId: '', hasUnusedImage: true })).toContain(
      'the ticket has a picture the card is not using',
    );
  });

  it('says when there are no figures to show', () => {
    expect(cardWarnings({ ...good, impactFacts: '' })).toContain('no figures');
  });
});

describe('cardBlocksAutomatedDistribution', () => {
  const good = {
    title: 'Aurora banner carousel component - no rotation delay',
    execSummary: 'The homepage banner never moves past the first promotion, so campaigns we paid for are not seen.',
    panelCurrent: 'Banner stays on the first promotion',
    panelImpacts: 'Two spring campaigns paid for and never shown',
    panelFuture: 'Banner moves on every few seconds',
    panelBenefits: 'Every promotion we pay for is actually seen.',
    impactFacts: '',
    screenshotCaption: '',
  };

  it('lets a card through that is missing only the polish cardWarnings() would flag', () => {
    // No figures and no screenshot caption - cardWarnings() would name both,
    // but neither makes a card unsafe to send unattended.
    expect(cardBlocksAutomatedDistribution(good)).toEqual([]);
  });

  it('blocks a card with nothing drafted at all', () => {
    expect(
      cardBlocksAutomatedDistribution({
        title: 'A ticket nobody has looked at',
        execSummary: '',
        panelCurrent: '',
        panelImpacts: '',
        panelFuture: '',
        panelBenefits: '',
        impactFacts: '',
        screenshotCaption: '',
      }),
    ).toContainEqual(expect.stringContaining('nothing has been drafted'));
  });

  it('does not block a card that has at least a headline and one section written', () => {
    expect(
      cardBlocksAutomatedDistribution({ ...good, panelImpacts: '', panelFuture: '', panelBenefits: '' }),
    ).toEqual([]);
  });

  it('blocks a card that still reads technical', () => {
    expect(cardBlocksAutomatedDistribution({ ...good, panelCurrent: 'The payload includes additional metadata' })).toContainEqual(
      expect.stringContaining('reads technical'),
    );
  });
});
