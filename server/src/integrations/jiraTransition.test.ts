import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The reported bug: the transition was configured as "RA: Ready for Estimation"
 * and the live workflow calls the status "[RA] Rdy Estimation". Nothing
 * matched, so every ticket kept its score and stayed where it was.
 */
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('../config/env.js', () => ({
  env: {
    jira: { configured: true, baseUrl: 'https://example.atlassian.net', email: 'a@b.c', apiToken: 'x' },
  },
}));

const { transitionIssue, listTransitions } = await import('./jira.js');

const TRANSITIONS = [
  { id: '11', name: 'Send to RA', to: { name: '[RA] Rdy Estimation' } },
  { id: '21', name: 'Close', to: { name: 'Done' } },
];

function respondWithTransitions() {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
    init?.method === 'POST'
      ? { ok: true, status: 204, text: async () => '' }
      : { ok: true, status: 200, text: async () => JSON.stringify({ transitions: TRANSITIONS }) },
  );
}

beforeEach(respondWithTransitions);

describe('transitionIssue', () => {
  it('matches the status the transition leads to', async () => {
    expect(await transitionIssue('ECOM-1', '[RA] Rdy Estimation')).toBe('[RA] Rdy Estimation');
  });

  it("matches the transition's own name", async () => {
    expect(await transitionIssue('ECOM-1', 'Send to RA')).toBe('[RA] Rdy Estimation');
  });

  it('forgives the punctuation nobody can be expected to reproduce', async () => {
    expect(await transitionIssue('ECOM-1', 'RA Rdy Estimation')).toBe('[RA] Rdy Estimation');
    expect(await transitionIssue('ECOM-1', '  [ra]  rdy estimation ')).toBe('[RA] Rdy Estimation');
  });

  it('will not guess at an abbreviation it was not given', async () => {
    // Moving a ticket into a status nobody asked for is worse than refusing.
    await expect(transitionIssue('ECOM-1', 'RA: Ready for Estimation')).rejects.toThrow(/no transition called/i);
  });

  it('says what the workflow does offer, so the name can be corrected', async () => {
    await expect(transitionIssue('ECOM-1', 'Nonsense')).rejects.toThrow(/"Send to RA" → \[RA\] Rdy Estimation/);
  });

  it('lists the choices for the settings picker', async () => {
    expect(await listTransitions('ECOM-1')).toEqual([
      { name: 'Send to RA', toStatus: '[RA] Rdy Estimation' },
      { name: 'Close', toStatus: 'Done' },
    ]);
  });
});
