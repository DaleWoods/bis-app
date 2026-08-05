import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CARD_LIMITS } from '../domain/cardDraft.js';

const create = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
  },
}));

const { draftCardWithAi, resetAiClient } = await import('./anthropic.js');

function respondWith(payload: unknown) {
  create.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
}

const ticket = { jiraId: 'ECOM-1', title: 'Basket total is wrong', type: 'Bug', description: 'It rounds twice.' };

describe('draftCardWithAi', () => {
  beforeEach(() => {
    create.mockReset();
    resetAiClient();
  });

  it('maps the model response onto the card fields', async () => {
    respondWith({
      execSummary: 'Baskets with a promotion charge a penny too much.',
      current: ['Promotion applied twice', 'Total is a penny out'],
      impacts: ['Customers query the price'],
      future: ['Promotion applied once'],
      benefits: ['Fewer refunds'],
    });

    const draft = await draftCardWithAi(ticket);
    expect(draft.execSummary).toBe('Baskets with a promotion charge a penny too much.');
    expect(draft.panelCurrent).toBe('Promotion applied twice\nTotal is a penny out');
    expect(draft.panelBenefits).toBe('Fewer refunds');
  });

  it('holds the model to the card limits even when it overruns them', async () => {
    respondWith({
      execSummary: 'x'.repeat(600),
      current: ['one', 'two', 'three', 'four', 'five'],
      impacts: [`${'word '.repeat(80)}`],
      future: [],
      benefits: [],
    });

    const draft = await draftCardWithAi(ticket);
    expect(draft.execSummary.length).toBeLessThanOrEqual(CARD_LIMITS.execSummary + 1);
    expect(draft.panelCurrent.split('\n')).toHaveLength(CARD_LIMITS.bulletsPerPanel);
    expect(draft.panelImpacts.length).toBeLessThanOrEqual(CARD_LIMITS.panel + 1);
    // An empty list stays empty rather than becoming a blank bullet.
    expect(draft.panelFuture).toBe('');
  });

  it('drops the trailing punctuation and stray markup that reads badly as a bullet', async () => {
    respondWith({
      execSummary: 'Summary',
      current: ['*Orders fail.*', '', '   '],
      impacts: [],
      future: [],
      benefits: [],
    });

    const draft = await draftCardWithAi(ticket);
    expect(draft.panelCurrent).toBe('Orders fail');
  });

  it('throws when the model returns nothing, so the caller can fall back', async () => {
    create.mockResolvedValue({ content: [] });
    await expect(draftCardWithAi(ticket)).rejects.toThrow(/no card content/i);
  });

  it('throws when the response is not the shape we asked for', async () => {
    respondWith({ execSummary: 'Summary' });
    await expect(draftCardWithAi(ticket)).rejects.toThrow();
  });

  it('sends the ticket fields and description to the model', async () => {
    respondWith({ execSummary: 's', current: [], impacts: [], future: [], benefits: [] });
    await draftCardWithAi({ ...ticket, stakeholder: 'Trading', workaround: 'Refund by hand' });

    const prompt = create.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('Basket total is wrong');
    expect(prompt).toContain('It rounds twice.');
    expect(prompt).toContain('Trading');
    expect(prompt).toContain('Refund by hand');
  });
});
