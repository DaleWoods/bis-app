import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CARD_LIMITS } from '../domain/card.js';

const create = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
  },
}));

const { draftCardWithAi, resetAiClient, ticketPrompt } = await import('./anthropic.js');

const FULL = {
  kind: 'PROBLEM',
  headline: 'The homepage banner never moves past the first promotion.',
  current: ['Carousel shows only the first slide', 'No rotation on any device'],
  impacts: ['Trading pull the other promotions'],
  future: ['Banner advances every few seconds'],
  benefit: 'Every promotion we pay for gets seen.',
  impactFacts: ['Affects: all customers', 'Open since: March'],
  screenshotCaption: 'The banner stays on slide one',
  screenshotFilename: 'homepage.png',
};

function respondWith(payload: Record<string, unknown>) {
  create.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
}

const ticket = {
  jiraId: 'ECOM-1213',
  title: 'Aurora banner carousel component - no rotation delay',
  type: 'Bug',
  description: 'Carousel does not advance.',
  imageFilenames: ['homepage.png', 'console.png'],
};

describe('draftCardWithAi', () => {
  beforeEach(() => {
    create.mockReset();
    resetAiClient();
  });

  it('maps the model response onto the card fields', async () => {
    respondWith(FULL);

    const draft = await draftCardWithAi(ticket);
    expect(draft.kind).toBe('PROBLEM');
    expect(draft.execSummary).toBe('The homepage banner never moves past the first promotion.');
    expect(draft.panelCurrent).toBe('Carousel shows only the first slide\nNo rotation on any device');
    expect(draft.panelBenefits).toBe('Every promotion we pay for gets seen.');
    expect(draft.impactFacts).toBe('Affects: all customers\nOpen since: March');
    expect(draft.screenshotCaption).toBe('The banner stays on slide one');
  });

  it('picks a screenshot only when the filename is really on the ticket', async () => {
    respondWith(FULL);
    expect((await draftCardWithAi(ticket)).screenshotPick).toBe('homepage.png');

    // A name the ticket does not have would otherwise blank the card's image.
    respondWith({ ...FULL, screenshotFilename: 'imagined-screenshot.png' });
    expect((await draftCardWithAi(ticket)).screenshotPick).toBeUndefined();

    respondWith({ ...FULL, screenshotFilename: '' });
    expect((await draftCardWithAi(ticket)).screenshotPick).toBeUndefined();
  });

  it('holds the model to the card limits even when it overruns them', async () => {
    respondWith({
      ...FULL,
      headline: 'x'.repeat(600),
      current: ['one', 'two', 'three', 'four', 'five'],
      impacts: [`${'word '.repeat(80)}`],
      future: [],
      benefit: 'y'.repeat(400),
      impactFacts: ['a: 1', 'b: 2', 'c: 3', 'd: 4', 'e: 5', 'f: 6'],
    });

    const draft = await draftCardWithAi(ticket);
    expect(draft.execSummary.length).toBeLessThanOrEqual(CARD_LIMITS.execSummary + 1);
    expect(draft.panelCurrent.split('\n')).toHaveLength(CARD_LIMITS.bulletsPerPanel);
    expect(draft.panelImpacts.length).toBeLessThanOrEqual(CARD_LIMITS.panel + 1);
    expect(draft.panelBenefits.length).toBeLessThanOrEqual(CARD_LIMITS.benefit + 1);
    expect(draft.impactFacts.split('\n')).toHaveLength(CARD_LIMITS.impactFacts);
    // An empty list stays empty rather than becoming a blank bullet.
    expect(draft.panelFuture).toBe('');
  });

  it('drops the trailing punctuation and stray markup that reads badly as a bullet', async () => {
    respondWith({ ...FULL, current: ['*Orders fail.*', '', '   '] });
    expect((await draftCardWithAi(ticket)).panelCurrent).toBe('Orders fail');
  });

  it('throws when the model returns nothing, so the caller can fall back', async () => {
    create.mockResolvedValue({ content: [] });
    await expect(draftCardWithAi(ticket)).rejects.toThrow(/no card content/i);
  });

  it('throws when the response is not the shape we asked for', async () => {
    respondWith({ headline: 'Summary' });
    await expect(draftCardWithAi(ticket)).rejects.toThrow();
  });
});

describe('ticketPrompt', () => {
  it('sends the comments, not just the description', () => {
    const prompt = ticketPrompt({
      ...ticket,
      comments: '[2026-03-02] Trading: we pulled promotions two and three, nobody ever saw them',
    });
    expect(prompt).toContain('--- Comments, oldest first ---');
    expect(prompt).toContain('nobody ever saw them');
  });

  it('sends the surrounding JIRA context a heading parser cannot use', () => {
    const prompt = ticketPrompt({
      ...ticket,
      priority: 'High',
      labels: 'homepage, trading',
      components: 'Aurora',
      linkedIssues: 'duplicates ECOM-1301 (Homepage promo rotation)',
      stakeholder: 'Ecommerce Trading',
    });
    expect(prompt).toContain('Priority: High');
    expect(prompt).toContain('Labels: homepage, trading');
    expect(prompt).toContain('Components: Aurora');
    expect(prompt).toContain('duplicates ECOM-1301');
  });

  it('lists the image filenames so the model can choose one', () => {
    expect(ticketPrompt(ticket)).toContain('- homepage.png');
    expect(ticketPrompt({ ...ticket, imageFilenames: [] })).toContain('(none)');
  });

  it('says so plainly when there is nothing to read', () => {
    const prompt = ticketPrompt({ ...ticket, description: '', imageFilenames: [] });
    expect(prompt).toContain('(the ticket has no description)');
    expect(prompt).toContain('(no comments)');
  });

  it('truncates a runaway description rather than sending it whole', () => {
    const prompt = ticketPrompt({ ...ticket, description: 'word '.repeat(6000) });
    expect(prompt).toContain('[…truncated]');
    expect(prompt.length).toBeLessThan(30000);
  });
});
