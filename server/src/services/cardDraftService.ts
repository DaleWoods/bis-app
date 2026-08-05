import { env } from '../config/env.js';
import { type CardDraft, type DraftSource, draftCard, draftIsEmpty } from '../domain/cardDraft.js';
import { draftCardWithAi } from '../integrations/anthropic.js';

/**
 * One way in for card drafting, so callers do not care which drafter ran.
 *
 * AI first when a key is configured, the heading parser otherwise. The parser
 * is also the safety net: an API outage, a bad key or a model response that
 * will not parse degrades a card to "drafted from headings", never to an error
 * a coordinator has to understand mid-import.
 */

export type Drafter = 'ai' | 'text';

export interface DraftOutcome {
  draft: CardDraft;
  drafter: Drafter;
  /** Set when AI was configured but did not work, so Settings can say why. */
  aiError?: string;
}

export async function draftCardFor(source: DraftSource): Promise<DraftOutcome> {
  const fallback = (aiError?: string): DraftOutcome => ({ draft: draftCard(source), drafter: 'text', aiError });

  if (!env.ai.configured) return fallback();

  try {
    const draft = await draftCardWithAi(source);
    // A model that found nothing is not better than a parser that found
    // nothing, and the parser sometimes picks up sections the model dismissed.
    if (draftIsEmpty(draft) && !draft.execSummary) return fallback();
    return { draft, drafter: 'ai' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[bis] AI drafting failed for ${source.jiraId}, using the heading parser instead: ${message}`);
    return fallback(message);
  }
}

/**
 * Draft several tickets during an import. Bounded concurrency: a round is
 * typically five to thirty tickets, and firing them all at once is the quickest
 * way to hit a rate limit.
 */
export async function draftCardsFor(sources: DraftSource[], concurrency = 4): Promise<DraftOutcome[]> {
  const outcomes: DraftOutcome[] = new Array(sources.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < sources.length) {
      const index = next++;
      outcomes[index] = await draftCardFor(sources[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
  return outcomes;
}
