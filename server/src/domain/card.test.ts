import { describe, expect, it } from 'vitest';
import { CARD_KINDS, cardLines, draftIsEmpty, kindFromIssueType, labelsFor } from './card.js';
import { sectionHeights } from '../pack/pptx.js';

describe('labelsFor', () => {
  it('asks a different question of each kind of ticket', () => {
    expect(labelsFor('PROBLEM').current.label).toBe("What's going wrong");
    expect(labelsFor('IMPROVEMENT').current.label).toBe('How it works today');
    expect(labelsFor('FEATURE').current.label).toBe("What we can't do today");
  });

  it('leads the benefit line with a phrase that fits the kind', () => {
    expect(labelsFor('PROBLEM').benefits).toBe('If we fix it');
    expect(labelsFor('FEATURE').benefits).toBe('If we build it');
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

describe('sectionHeights', () => {
  const sections = (...values: string[]) => values.map((value) => ({ value }));

  it('gives a section with more bullets more room', () => {
    const [one, three] = sectionHeights(sections('a', 'a\nb\nc'), 5.65, 10);
    expect(three).toBeGreaterThan(one);
  });

  it('never overruns the space available, however much content there is', () => {
    const long = 'x'.repeat(100);
    const heights = sectionHeights(sections(`${long}\n${long}\n${long}`, `${long}\n${long}`, long), 5.65, 2.74);
    const total = heights.reduce((sum, h) => sum + h, 0);
    expect(total).toBeLessThanOrEqual(2.74 + 0.0001);
  });

  it('leaves the spare space at the bottom rather than padding the sections out', () => {
    const heights = sectionHeights(sections('a', 'b', 'c'), 5.65, 2.74);
    expect(heights.reduce((sum, h) => sum + h, 0)).toBeLessThan(2.74);
  });

  it('still reserves a row for an empty section, so its label is not orphaned', () => {
    const [height] = sectionHeights(sections(''), 5.65, 10);
    expect(height).toBeGreaterThan(0.4);
  });
});
