import { describe, expect, it } from 'vitest';
import { DUPLICATE_TITLE_THRESHOLD, titleSimilarity } from './similarity.js';

describe('titleSimilarity', () => {
  it('scores identical titles at 1', () => {
    expect(titleSimilarity('Remove unused metadata from remove-from-cart event', 'Remove unused metadata from remove-from-cart event')).toBe(1);
  });

  it('scores a reworded but clearly-the-same title above the duplicate threshold', () => {
    const a = 'Insights - Remove unnecessary metadata fields from remove-from-cart event';
    const b = 'Remove unnecessary metadata fields from the remove-from-cart event payload';
    expect(titleSimilarity(a, b)).toBeGreaterThanOrEqual(DUPLICATE_TITLE_THRESHOLD);
  });

  it('scores two unrelated titles low', () => {
    const a = 'Registration allows invalid First Name and Last Name values';
    const b = 'Homepage banner carousel never advances past the first slide';
    expect(titleSimilarity(a, b)).toBeLessThan(DUPLICATE_TITLE_THRESHOLD);
  });

  it('is 0 when either title has nothing left after stripping stopwords', () => {
    expect(titleSimilarity('', 'Something with real words in it')).toBe(0);
    expect(titleSimilarity('the a of', 'Something with real words in it')).toBe(0);
  });

  it('ignores case and punctuation', () => {
    expect(titleSimilarity('Fix: the checkout button!', 'fix the checkout button')).toBe(1);
  });
});
