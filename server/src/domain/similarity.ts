/**
 * How alike two ticket titles are, for spotting a likely duplicate at import
 * (§12.1 residual: the same underlying issue raised twice under different
 * JIRA numbers wastes the committee's time twice and skews the numbers once).
 *
 * Deliberately mechanical, in the same spirit as `cardWarnings()`: word
 * overlap, not meaning. It will miss a duplicate that is worded completely
 * differently and it will occasionally flag two unrelated tickets that happen
 * to share several words - both are fine, because this only ever produces a
 * "worth a look" for a coordinator, never an automatic block.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'is', 'are',
  'not', 'with', 'at', 'by', 'from', 'this', 'that', 'it', 'as', 'be', 'we',
  'when', 'does', 'do', 'has', 'have', 'their', 'they',
]);

/** Lowercased, punctuation stripped, short and common words dropped. */
export function titleWords(title: string): Set<string> {
  return new Set(
    (title ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

/** Jaccard similarity of the two titles' word sets: 0 (nothing shared) to 1 (identical). */
export function titleSimilarity(a: string, b: string): number {
  const wordsA = titleWords(a);
  const wordsB = titleWords(b);
  if (!wordsA.size || !wordsB.size) return 0;
  let intersection = 0;
  for (const word of wordsA) if (wordsB.has(word)) intersection += 1;
  const union = wordsA.size + wordsB.size - intersection;
  return union ? intersection / union : 0;
}

/** Similar enough that a coordinator should look, not so loose it fires on any shared word. */
export const DUPLICATE_TITLE_THRESHOLD = 0.6;
