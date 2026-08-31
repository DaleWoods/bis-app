import { describe, expect, it } from 'vitest';
import { ordinal, placementSentence, placementsFor, rankByScore, splitQueues, type QueueCandidate } from './queue.js';

function candidate(key: string, businessScore: number, frontendEffort = 0, backendEffort = 0): QueueCandidate {
  return { key, summary: `${key} summary`, status: 'Rdy FE Dev', businessScore, frontendEffort, backendEffort };
}

describe('rankByScore', () => {
  it('ranks highest business score first', () => {
    const ranked = rankByScore([candidate('A', 20), candidate('B', 50), candidate('C', 35)]);
    expect(ranked.map((t) => [t.key, t.rank])).toEqual([
      ['B', 1],
      ['C', 2],
      ['A', 3],
    ]);
  });

  it('shares a rank between ties and skips the places they used up', () => {
    // Two on 40 are both second; the next distinct score is fourth, not third.
    const ranked = rankByScore([candidate('A', 50), candidate('B', 40), candidate('C', 40), candidate('D', 10)]);
    expect(ranked.map((t) => [t.key, t.rank])).toEqual([
      ['A', 1],
      ['B', 2],
      ['C', 2],
      ['D', 4],
    ]);
  });

  it('puts three-way ties on the same place and resumes after them', () => {
    const ranked = rankByScore([candidate('A', 30), candidate('B', 30), candidate('C', 30), candidate('D', 20)]);
    expect(ranked.map((t) => t.rank)).toEqual([1, 1, 1, 4]);
  });

  it('orders tied tickets by key so the list does not shuffle between reads', () => {
    const one = rankByScore([candidate('ECOM-9', 30), candidate('ECOM-2', 30)]);
    const two = rankByScore([candidate('ECOM-2', 30), candidate('ECOM-9', 30)]);
    expect(one.map((t) => t.key)).toEqual(two.map((t) => t.key));
  });

  it('has nothing to rank when the hopper is empty', () => {
    expect(rankByScore([])).toEqual([]);
  });
});

describe('splitQueues', () => {
  it('routes a ticket by which side has effort on it', () => {
    const split = splitQueues([
      candidate('FE', 50, 3, 0),
      candidate('BE', 40, 0, 5),
      candidate('BOTH', 30, 2, 2),
      candidate('NEITHER', 20, 0, 0),
    ]);
    expect(split.frontend.map((t) => t.key)).toEqual(['FE', 'BOTH']);
    expect(split.backend.map((t) => t.key)).toEqual(['BE', 'BOTH']);
    expect(split.notQueued.map((t) => t.key)).toEqual(['NEITHER']);
  });

  it('ranks each queue independently, so one ticket can sit differently in each', () => {
    const split = splitQueues([
      candidate('TOP-FE', 90, 3, 0),
      candidate('BOTH', 50, 2, 2),
      candidate('LOW-BE', 10, 0, 4),
    ]);
    // Second on the frontend behind a higher-scoring frontend-only ticket,
    // but first on the backend where nothing outscores it.
    expect(placementsFor(split, 'BOTH')).toEqual([
      { queue: 'FRONTEND', rank: 2, outOf: 2 },
      { queue: 'BACKEND', rank: 1, outOf: 2 },
    ]);
  });

  it('treats a negative or missing effort as no effort', () => {
    const split = splitQueues([candidate('A', 10, -1, 0), candidate('B', 10, 0, 0)]);
    expect(split.frontend).toEqual([]);
    expect(split.notQueued.map((t) => t.key)).toEqual(['A', 'B']);
  });

  it('gives no placement for a ticket nobody has estimated', () => {
    const split = splitQueues([candidate('A', 10, 0, 0)]);
    expect(placementsFor(split, 'A')).toEqual([]);
  });
});

describe('ordinal', () => {
  it('reads correctly, including the teens that break the pattern', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '101st',
      '111th',
    ]);
  });
});

describe('placementSentence', () => {
  it('says the place, not how many are ahead', () => {
    expect(placementSentence({ queue: 'FRONTEND', rank: 3, outOf: 14 })).toBe(
      'Currently 3rd in the Frontend queue',
    );
  });
});
