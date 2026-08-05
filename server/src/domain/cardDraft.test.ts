import { describe, expect, it } from 'vitest';
import { CARD_LIMITS, clip, draftCard, draftIsEmpty, splitSections, tidy, toBullets } from './cardDraft.js';

describe('splitSections', () => {
  it('splits on "Heading:" labels and keeps text that follows on the same line', () => {
    const sections = splitSections('Problem: totals are wrong\nOn multi-buy only.\nImpact:\nCustomers complain.');
    expect(sections.map((s) => s.heading)).toEqual(['Problem', 'Impact']);
    expect(sections[0].body.trim()).toBe('totals are wrong\nOn multi-buy only.');
    expect(sections[1].body.trim()).toBe('Customers complain.');
  });

  it('understands wiki headings and bold headings', () => {
    const sections = splitSections('h2. Current\nIt breaks.\n*Benefits*\nIt stops breaking.');
    expect(sections.map((s) => s.heading)).toEqual(['Current', 'Benefits']);
  });

  it('treats a short title-case line as a heading', () => {
    const sections = splitSections('Expected Behaviour\nThe total should round once.');
    expect(sections[0].heading).toBe('Expected Behaviour');
  });

  it('keeps unheaded prose in one section', () => {
    const sections = splitSections('just a paragraph about the problem, no headings at all.');
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('');
  });
});

describe('tidy', () => {
  it('removes JIRA image macros, code blocks, links and bullet markers', () => {
    const input = '* Item one\n!screenshot.png|thumbnail!\n{code}const x = 1;{code}\n[the docs|https://example.com/x]\nSee https://example.com';
    const output = tidy(input);
    expect(output).not.toContain('screenshot.png');
    expect(output).not.toContain('const x');
    expect(output).not.toContain('https://');
    expect(output).toContain('Item one');
    expect(output).toContain('the docs');
  });
});

describe('clip', () => {
  it('leaves short text alone', () => {
    expect(clip('short', 50)).toBe('short');
  });

  it('prefers to cut at a sentence end', () => {
    const text = 'First sentence here. Second sentence that would overflow the limit entirely.';
    expect(clip(text, 40)).toBe('First sentence here.');
  });

  it('falls back to a word boundary with an ellipsis', () => {
    expect(clip('averylongsentencewithoutany punctuation at all here', 20)).toMatch(/…$/);
    expect(clip('one two three four five six', 12).endsWith('…')).toBe(true);
  });
});

describe('toBullets', () => {
  it('splits prose into a few short bullets', () => {
    const bullets = toBullets('Orders fail. Customers ring up. Finance reconciles by hand. A fourth thing happens.');
    expect(bullets).toHaveLength(CARD_LIMITS.bulletsPerPanel);
    expect(bullets[0]).toBe('Orders fail');
  });

  it('keeps existing lines as bullets', () => {
    expect(toBullets('* one\n* two')).toEqual(['one', 'two']);
  });

  it('returns nothing for empty input', () => {
    expect(toBullets('   ')).toEqual([]);
  });
});

describe('draftCard', () => {
  const ticket = {
    jiraId: 'ECOM-2382',
    title: 'Incorrect gift wrap order entries causing SAP failures',
    type: 'Bug',
    description: [
      'Summary: Gift wrap lines are written to SAP with the wrong item code.',
      '',
      'Current:',
      'Orders containing gift wrap post a line SAP does not recognise.',
      'The order sits in error until someone corrects it by hand.',
      '',
      'Impact:',
      '* Despatch is delayed by up to a day',
      '* Operations correct around 20 orders each morning',
      '',
      'Expected:',
      'Gift wrap posts with the agreed item code and clears automatically.',
      '',
      'Benefits:',
      'No manual correction, and orders despatch on time.',
    ].join('\n'),
  };

  it('maps each labelled section to its panel', () => {
    const draft = draftCard(ticket);
    expect(draft.execSummary).toContain('wrong item code');
    expect(draft.panelCurrent).toContain('SAP does not recognise');
    expect(draft.panelImpacts).toContain('Despatch is delayed');
    expect(draft.panelFuture).toContain('agreed item code');
    expect(draft.panelBenefits).toContain('despatch on time');
  });

  it('keeps every field inside the length limits', () => {
    const draft = draftCard({
      ...ticket,
      description: `Current:\n${'word '.repeat(400)}\nImpact:\n${'word '.repeat(400)}`,
    });
    expect(draft.execSummary.length).toBeLessThanOrEqual(CARD_LIMITS.execSummary + 1);
    expect(draft.panelCurrent.length).toBeLessThanOrEqual(CARD_LIMITS.panel + 1);
    expect(draft.panelImpacts.length).toBeLessThanOrEqual(CARD_LIMITS.panel + 1);
  });

  it('breaks each panel into at most three bullets', () => {
    const draft = draftCard({
      ...ticket,
      description: 'Impact:\n* one\n* two\n* three\n* four\n* five',
    });
    expect(draft.panelImpacts.split('\n')).toHaveLength(3);
  });

  it('uses unheaded prose for the summary and the current panel only', () => {
    const draft = draftCard({
      jiraId: 'ECOM-1',
      title: 'Something is broken',
      type: 'Bug',
      description: 'The basket total is a penny out when a multi-buy promotion applies.',
    });
    expect(draft.execSummary).toContain('penny out');
    expect(draft.panelCurrent).toContain('penny out');
    expect(draft.panelFuture).toBe('');
    expect(draft.panelBenefits).toBe('');
  });

  it('falls back to the title when there is no description at all', () => {
    const draft = draftCard({ jiraId: 'ECOM-2', title: 'Add a packing note', type: 'Improvement', description: '' });
    expect(draft.execSummary).toBe('Add a packing note');
    expect(draftIsEmpty(draft)).toBe(true);
  });

  it('seeds the impacts panel from the JIRA impacts field when the description has none', () => {
    const draft = draftCard({
      jiraId: 'ECOM-3',
      title: 'Thing',
      type: 'Bug',
      description: 'Current:\nIt is broken.',
      impacts: 'Customers cannot check out',
    });
    expect(draft.panelImpacts).toContain('Customers cannot check out');
  });

  it('strips steps-to-reproduce numbering into readable bullets', () => {
    const draft = draftCard({
      jiraId: 'ECOM-4',
      title: 'Thing',
      type: 'Bug',
      description: 'Steps to reproduce:\n1. Add a watch to the basket\n2. Apply the promotion\n3. Look at the total',
    });
    expect(draft.panelCurrent).toContain('Add a watch to the basket');
    expect(draft.panelCurrent).not.toContain('1.');
  });
});
