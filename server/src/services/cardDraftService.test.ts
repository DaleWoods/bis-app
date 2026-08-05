import { beforeEach, describe, expect, it, vi } from 'vitest';

const draftCardWithAi = vi.fn();

vi.mock('../integrations/anthropic.js', () => ({ draftCardWithAi }));
vi.mock('../config/env.js', () => ({
  env: {
    ai: {
      apiKey: 'test-key',
      enabled: true,
      get configured() {
        return Boolean(this.apiKey) && this.enabled;
      },
    },
  },
}));

const { env } = await import('../config/env.js');
const { draftCardFor, draftCardsFor } = await import('./cardDraftService.js');

const ticket = {
  jiraId: 'ECOM-1',
  title: 'Gift wrap fails in SAP',
  type: 'Bug',
  description: 'Current:\nOrders with gift wrap post a line SAP rejects.',
};

const aiDraft = {
  execSummary: 'Gift wrap orders stall on their way to SAP.',
  panelCurrent: 'SAP rejects the gift wrap line',
  panelImpacts: 'Despatch is delayed',
  panelFuture: 'The line posts and clears',
  panelBenefits: 'No manual correction',
};

describe('draftCardFor', () => {
  beforeEach(() => {
    draftCardWithAi.mockReset();
    env.ai.apiKey = 'test-key';
    env.ai.enabled = true;
  });

  it('uses the model when a key is configured', async () => {
    draftCardWithAi.mockResolvedValue(aiDraft);
    const outcome = await draftCardFor(ticket);
    expect(outcome.drafter).toBe('ai');
    expect(outcome.draft.execSummary).toContain('stall on their way to SAP');
  });

  it('uses the heading parser when no key is configured, without calling out', async () => {
    env.ai.apiKey = '';
    const outcome = await draftCardFor(ticket);
    expect(outcome.drafter).toBe('text');
    expect(outcome.draft.panelCurrent).toContain('SAP rejects');
    expect(draftCardWithAi).not.toHaveBeenCalled();
  });

  it('falls back to the heading parser when the model call fails', async () => {
    draftCardWithAi.mockRejectedValue(new Error('401 authentication_error'));
    const outcome = await draftCardFor(ticket);
    expect(outcome.drafter).toBe('text');
    expect(outcome.aiError).toContain('401');
    expect(outcome.draft.panelCurrent).toContain('SAP rejects');
  });

  it('falls back when the model finds nothing but the description has headings', async () => {
    draftCardWithAi.mockResolvedValue({
      execSummary: '',
      panelCurrent: '',
      panelImpacts: '',
      panelFuture: '',
      panelBenefits: '',
    });
    const outcome = await draftCardFor(ticket);
    expect(outcome.drafter).toBe('text');
    expect(outcome.draft.panelCurrent).toContain('SAP rejects');
  });
});

describe('draftCardsFor', () => {
  beforeEach(() => {
    draftCardWithAi.mockReset();
    env.ai.apiKey = 'test-key';
    env.ai.enabled = true;
  });

  it('keeps drafts lined up with their tickets despite running in parallel', async () => {
    const sources = Array.from({ length: 9 }, (_, i) => ({ ...ticket, jiraId: `ECOM-${i}`, title: `Ticket ${i}` }));
    // Reversed delays: without index tracking the results would come back in
    // completion order rather than ticket order.
    draftCardWithAi.mockImplementation(async (source: { jiraId: string }) => {
      const index = Number(source.jiraId.split('-')[1]);
      await new Promise((resolve) => setTimeout(resolve, (9 - index) * 2));
      return { ...aiDraft, execSummary: `summary for ${source.jiraId}` };
    });

    const outcomes = await draftCardsFor(sources, 4);
    expect(outcomes).toHaveLength(9);
    outcomes.forEach((outcome, index) => {
      expect(outcome.draft.execSummary).toBe(`summary for ECOM-${index}`);
    });
  });

  it('lets one ticket fail without taking the import down', async () => {
    draftCardWithAi.mockImplementation(async (source: { jiraId: string }) => {
      if (source.jiraId === 'ECOM-1') throw new Error('rate limited');
      return aiDraft;
    });

    const outcomes = await draftCardsFor([ticket, { ...ticket, jiraId: 'ECOM-2' }]);
    expect(outcomes[0].drafter).toBe('text');
    expect(outcomes[1].drafter).toBe('ai');
  });
});
