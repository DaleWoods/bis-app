import { Db } from '../db/index.js';
import { mean } from '../domain/scoring.js';
import { listMembers } from './memberService.js';
import { listRounds, type Round } from './roundService.js';
import { roundResults, type TicketResult } from './resultService.js';

/**
 * Cross-round trends, read entirely from what `ticket_results` already
 * freezes at finalisation (§14) - nothing here is stored separately, and
 * nothing here can drift from what the Feedback page and JIRA write-back
 * already show for the same round.
 */

export interface RoundTrendPoint {
  roundId: string;
  weekLabel: string;
  finalisedAt: string;
  ticketCount: number;
  avgBusinessScore: number | null;
  sentForEstimation: number;
  toClose: number;
  discussionRequired: number;
  scorers: number;
  avgResponsesPerTicket: number | null;
}

export interface CategoryDriver {
  categoryId: string;
  name: string;
  /** Mean of each scored ticket's own average for this category - not weighted by responses, since each ticket's average is already one. */
  avgScore: number | null;
  ticketsScored: number;
  /** How often this category had the highest average among a ticket's categories - ties all count. */
  timesHighest: number;
  /** Same, for the lowest. */
  timesLowest: number;
}

export interface AnalyticsSummary {
  rounds: RoundTrendPoint[];
  categoryDrivers: CategoryDriver[];
}

async function scorerCount(db: Db, roundId: string): Promise<number> {
  const row = await db.get<{ n: number }>(
    'SELECT COUNT(DISTINCT member_id) AS n FROM submissions WHERE round_id = ? AND archived = 0',
    [roundId],
  );
  return Number(row?.n ?? 0);
}

function roundTrend(round: Round, results: TicketResult[], scorers: number): RoundTrendPoint {
  const businessScores = results.map((r) => r.aggregate.businessScore).filter((n): n is number => n !== null);
  const responseCounts = results.map((r) => r.aggregate.responsesCount);
  return {
    roundId: round.id,
    weekLabel: round.weekLabel,
    finalisedAt: round.finalisedAt ?? '',
    ticketCount: results.length,
    avgBusinessScore: mean(businessScores),
    sentForEstimation: results.filter((r) => r.aggregate.sendForEstimation).length,
    toClose: results.filter((r) => r.aggregate.toClose).length,
    discussionRequired: results.filter((r) => r.aggregate.discussionRequired).length,
    scorers,
    avgResponsesPerTicket: results.length ? mean(responseCounts) : null,
  };
}

/**
 * For every ticket that actually got scored, which of its categories came out
 * on top and which came out at the bottom - a ticket nobody scored has every
 * category sitting at zero, which is not a real answer about any of them, so
 * it is left out here entirely rather than counted as a three-way tie.
 */
function accumulateCategoryDrivers(results: TicketResult[], byId: Map<string, CategoryDriver & { total: number }>): void {
  for (const { aggregate } of results) {
    if (aggregate.responsesCount === 0 || !aggregate.categoryAverages.length) continue;
    const values = aggregate.categoryAverages.map((c) => c.average);
    const highest = Math.max(...values);
    const lowest = Math.min(...values);
    for (const category of aggregate.categoryAverages) {
      const existing = byId.get(category.categoryId) ?? {
        categoryId: category.categoryId,
        name: category.name,
        avgScore: null,
        ticketsScored: 0,
        timesHighest: 0,
        timesLowest: 0,
        total: 0,
      };
      existing.name = category.name; // the most recent name wins, in case it was reworded since
      existing.ticketsScored += 1;
      existing.total += category.average;
      if (category.average === highest) existing.timesHighest += 1;
      if (category.average === lowest) existing.timesLowest += 1;
      byId.set(category.categoryId, existing);
    }
  }
}

interface FinalisedRound {
  round: Round;
  results: TicketResult[];
  scorers: number;
}

/** The last `limit` finalised rounds, oldest first, with their frozen results already read. */
async function finalisedRoundsWithResults(db: Db, limit: number): Promise<FinalisedRound[]> {
  const finalised = (await listRounds(db))
    .filter((r) => r.status === 'FINALISED' && r.finalisedAt)
    .sort((a, b) => (a.finalisedAt ?? '').localeCompare(b.finalisedAt ?? ''))
    .slice(-limit);

  const out: FinalisedRound[] = [];
  for (const round of finalised) {
    const [results, scorers] = await Promise.all([roundResults(db, round), scorerCount(db, round.id)]);
    out.push({ round, results, scorers });
  }
  return out;
}

/**
 * The last `limit` finalised rounds, oldest first (a trend reads left to
 * right as time moving forward), plus which categories most often drove a
 * ticket's score up or down across all of them.
 */
export async function buildAnalytics(db: Db, limit = 26): Promise<AnalyticsSummary> {
  const finalised = await finalisedRoundsWithResults(db, limit);

  const rounds: RoundTrendPoint[] = [];
  const driverTotals = new Map<string, CategoryDriver & { total: number }>();

  for (const { round, results, scorers } of finalised) {
    rounds.push(roundTrend(round, results, scorers));
    accumulateCategoryDrivers(results, driverTotals);
  }

  const categoryDrivers = [...driverTotals.values()]
    .map(({ total, ...driver }) => ({ ...driver, avgScore: driver.ticketsScored ? total / driver.ticketsScored : null }))
    .sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0));

  return { rounds, categoryDrivers };
}

const CONTEXT_ROUND_LIMIT = 26;
/** Keeps the prompt bounded on a long history - the most recent tickets are what a question is almost always about. */
const CONTEXT_TICKET_LIMIT = 600;

/**
 * Every finalised ticket, flattened into one line each, for the "ask the
 * data" assistant to read as its whole world - nothing it can say goes
 * beyond what a coordinator could work out themselves from the Trends page
 * and the Feedback view, just faster.
 */
export async function buildAnalyticsContext(db: Db): Promise<string> {
  const finalised = await finalisedRoundsWithResults(db, CONTEXT_ROUND_LIMIT);
  const members = await listMembers(db, true);
  const teamByEmail = new Map(members.map((m) => [m.email.toLowerCase(), m.team]));

  const rows: string[] = [];
  for (const { round, results } of finalised) {
    for (const { ticket, aggregate } of results) {
      const team = ticket.originalRequestor ? teamByEmail.get(ticket.originalRequestor.toLowerCase()) : undefined;
      const categories = aggregate.categoryAverages.map((c) => `${c.name}=${c.average.toFixed(1)}`).join(', ');
      rows.push(
        [
          `round="${round.weekLabel}"`,
          `finalised=${round.finalisedAt?.slice(0, 10) ?? ''}`,
          `ticket=${ticket.jiraId}`,
          `title="${ticket.title}"`,
          `requestorTeam=${team ?? 'unknown'}`,
          `businessScore=${aggregate.businessScore ?? 'n/a'}`,
          `priorityBand=${aggregate.priorityBand ?? 'n/a'}`,
          `responses=${aggregate.responsesCount}`,
          `sentForEstimation=${aggregate.sendForEstimation}`,
          `toClose=${aggregate.toClose}`,
          `discussionRequired=${aggregate.discussionRequired}`,
          `categories={${categories}}`,
        ].join(' '),
      );
    }
  }

  // Most recent first, then capped - a long history trimmed from the back
  // loses the oldest rounds rather than the ones a question is likely about.
  const capped = rows.slice(-CONTEXT_TICKET_LIMIT);
  return capped.length
    ? capped.join('\n')
    : 'No finalised rounds yet - there is nothing to answer questions about.';
}
