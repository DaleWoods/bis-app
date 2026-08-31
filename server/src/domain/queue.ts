/**
 * Where a scored ticket currently sits in the dev queue.
 *
 * This module is pure: no database, no clock, no JIRA. It takes the hopper -
 * tickets that have been given a business score and are waiting to be built -
 * and works out each one's position.
 *
 * Nothing here is ever stored. A queue position is only true at the moment it
 * is read: it moves whenever a ticket is built, a new score lands, or somebody
 * puts an effort estimate on something. Persisting it would mean showing
 * people a position that quietly stopped being true, which is worse than not
 * showing one at all.
 */

export interface QueueCandidate {
  key: string;
  summary: string;
  status: string;
  /** The business score this process gave it, read live from JIRA. */
  businessScore: number;
  frontendEffort: number;
  backendEffort: number;
}

export interface RankedTicket extends QueueCandidate {
  /** Standard competition rank - ties share a place, and the next one skips. */
  rank: number;
}

export type QueueName = 'FRONTEND' | 'BACKEND';

export interface QueueSplit {
  frontend: RankedTicket[];
  backend: RankedTicket[];
  /**
   * Scored and in a qualifying status, but with no effort on either side, so
   * it is in no queue at all. This is its own state rather than an omission -
   * a ticket that has silently fallen out of both queues is exactly the thing
   * somebody needs to be told about.
   */
  notQueued: QueueCandidate[];
}

/**
 * Standard competition ranking ("1224"): equal scores share a place, and the
 * next distinct score skips by however many were tied.
 *
 * Two tickets on the same score really are level - the process has not
 * separated them - so inventing an order between them would be reporting a
 * precision the scoring does not have.
 */
export function rankByScore(candidates: QueueCandidate[]): RankedTicket[] {
  // Highest score first; key breaks ties only so the list is stable between
  // reads, never to claim one of a tied pair is ahead of the other.
  const sorted = [...candidates].sort(
    (a, b) => b.businessScore - a.businessScore || a.key.localeCompare(b.key),
  );
  const ranked: RankedTicket[] = [];
  sorted.forEach((candidate, index) => {
    const previous = ranked[index - 1];
    const tied = previous !== undefined && previous.businessScore === candidate.businessScore;
    ranked.push({ ...candidate, rank: tied ? previous.rank : index + 1 });
  });
  return ranked;
}

/**
 * Split the hopper into the two independent queues and rank each.
 *
 * A ticket with effort on both sides is in both queues and ranked separately
 * in each - it is genuinely waiting on two different people, and a single
 * position would have to lie about one of them.
 */
export function splitQueues(candidates: QueueCandidate[]): QueueSplit {
  return {
    frontend: rankByScore(candidates.filter((c) => c.frontendEffort > 0)),
    backend: rankByScore(candidates.filter((c) => c.backendEffort > 0)),
    notQueued: candidates.filter((c) => !(c.frontendEffort > 0) && !(c.backendEffort > 0)),
  };
}

export interface QueuePlacement {
  queue: QueueName;
  rank: number;
  /** How many are in that queue, so a rank reads as "3rd of 14". */
  outOf: number;
}

/** Every queue one ticket sits in. Empty when it is scored but has no effort. */
export function placementsFor(split: QueueSplit, key: string): QueuePlacement[] {
  const placements: QueuePlacement[] = [];
  const frontend = split.frontend.find((t) => t.key === key);
  if (frontend) placements.push({ queue: 'FRONTEND', rank: frontend.rank, outOf: split.frontend.length });
  const backend = split.backend.find((t) => t.key === key);
  if (backend) placements.push({ queue: 'BACKEND', rank: backend.rank, outOf: split.backend.length });
  return placements;
}

const ORDINAL_TEENS_START = 11;
const ORDINAL_TEENS_END = 13;

export function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= ORDINAL_TEENS_START && teens <= ORDINAL_TEENS_END) return `${n}th`;
  if (n % 10 === 1) return `${n}st`;
  if (n % 10 === 2) return `${n}nd`;
  if (n % 10 === 3) return `${n}rd`;
  return `${n}th`;
}

export const QUEUE_LABELS: Record<QueueName, string> = {
  FRONTEND: 'Frontend',
  BACKEND: 'Backend',
};

/**
 * "Currently 3rd in the Frontend queue."
 *
 * Deliberately an ordinal rather than "N tickets ahead of you", which read as
 * a countdown people then expected to tick down predictably.
 */
export function placementSentence(placement: QueuePlacement): string {
  return `Currently ${ordinal(placement.rank)} in the ${QUEUE_LABELS[placement.queue]} queue`;
}
