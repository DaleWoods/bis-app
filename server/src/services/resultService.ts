import { Db } from '../db/index.js';
import { TicketAggregate, aggregateTicket, resolveEffort } from '../domain/scoring.js';
import { CategoryDef, PRIORITY_BAND_LABELS, ScoringConfig } from '../domain/types.js';
import { nowIso } from '../util/time.js';
import { listCategories, getScoringConfig } from './configService.js';
import { Round, listRoundTickets } from './roundService.js';
import { listRoundSubmissions, toScoringInput } from './submissionService.js';
import { Ticket } from './ticketService.js';

export interface TicketResult {
  ticket: Ticket;
  aggregate: TicketAggregate;
}

/** Compute every ticket in a round from live submissions (§10). */
export async function computeRoundResults(
  db: Db,
  round: Round,
  options: { config?: ScoringConfig; categories?: CategoryDef[] } = {},
): Promise<TicketResult[]> {
  const config = options.config ?? (await getScoringConfig(db));
  const categories = options.categories ?? (await listCategories(db, true));
  const tickets = await listRoundTickets(db, round.id);
  const submissions = await listRoundSubmissions(db, round.id);

  const byTicket = new Map<string, ReturnType<typeof toScoringInput>[]>();
  for (const submission of submissions) {
    const bucket = byTicket.get(submission.ticketId) ?? [];
    bucket.push(toScoringInput(submission));
    byTicket.set(submission.ticketId, bucket);
  }

  return tickets.map((ticket) => ({
    ticket,
    aggregate: aggregateTicket(
      {
        submissions: byTicket.get(ticket.id) ?? [],
        categories,
        effort: resolveEffort(ticket, config),
      },
      config,
    ),
  }));
}

/**
 * Freeze the round's results (§14 retention). The snapshot is what JIRA
 * write-back and the committee feedback view read, so a finalised round can
 * never drift after the fact.
 */
export async function snapshotRoundResults(db: Db, round: Round): Promise<TicketResult[]> {
  const results = await computeRoundResults(db, round);
  const computedAt = nowIso();
  await db.tx(async (tx) => {
    await tx.run('DELETE FROM ticket_results WHERE round_id = ?', [round.id]);
    for (const { ticket, aggregate } of results) {
      await tx.run(
        `INSERT INTO ticket_results (
          round_id, ticket_id, responses_count, business_score, std_dev, discussion_required, to_close,
          effort, priority_ratio, priority_band, status_label, send_for_estimation, category_averages,
          aggregate_json, computed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          round.id,
          ticket.id,
          aggregate.responsesCount,
          aggregate.businessScore,
          aggregate.stdDev,
          aggregate.discussionRequired ? 1 : 0,
          aggregate.toClose ? 1 : 0,
          aggregate.effort,
          aggregate.priorityRatio,
          aggregate.priorityBand,
          aggregate.statusLabel,
          aggregate.sendForEstimation ? 1 : 0,
          JSON.stringify({
            categories: aggregate.categoryAverages,
            totalsDistribution: aggregate.totalsDistribution,
            excludedCounts: aggregate.excludedCounts,
            businessScoreRaw: aggregate.businessScoreRaw,
          }),
          // The columns above are what makes a snapshot readable in SQL; this
          // is what makes it replayable. Reconstructing an aggregate from the
          // columns alone is not possible - they carry no submissionsCount and
          // no minSubmissionsMet.
          JSON.stringify(aggregate),
          computedAt,
        ],
      );
    }
  });
  return results;
}

/**
 * The frozen results, or null if this round has none.
 *
 * Null covers two cases that behave identically: a round that was never
 * finalised, and one finalised before the snapshot was stored whole (rows
 * written before migration 004). Both fall back to live computation.
 */
export async function readSnapshot(db: Db, round: Round): Promise<TicketResult[] | null> {
  const rows = await db.all<{ ticket_id: string; aggregate_json: string }>(
    'SELECT ticket_id, aggregate_json FROM ticket_results WHERE round_id = ?',
    [round.id],
  );
  if (!rows.length) return null;

  const frozen = new Map<string, TicketAggregate>();
  for (const row of rows) {
    if (!row.aggregate_json) continue;
    try {
      frozen.set(row.ticket_id, JSON.parse(row.aggregate_json) as TicketAggregate);
    } catch {
      // A snapshot we cannot read is not a snapshot.
    }
  }
  if (!frozen.size) return null;

  // Joined to the tickets as they are now: what is frozen is the scoring, not
  // the card content. A ticket added to the round after it was finalised has no
  // frozen aggregate and is left out rather than shown with invented numbers.
  const tickets = await listRoundTickets(db, round.id);
  return tickets.flatMap((ticket) => {
    const aggregate = frozen.get(ticket.id);
    return aggregate ? [{ ticket, aggregate }] : [];
  });
}

/**
 * The results to show and act on: frozen once the round is finalised, live
 * before that.
 *
 * Every consumer goes through here. Recomputing a finalised round is what let
 * its numbers drift after the fact - excluding a submission or moving a
 * threshold would quietly rewrite a result that had already gone to JIRA.
 */
export async function roundResults(
  db: Db,
  round: Round,
  options: { config?: ScoringConfig; categories?: CategoryDef[] } = {},
): Promise<TicketResult[]> {
  if (round.status === 'FINALISED') {
    const snapshot = await readSnapshot(db, round);
    if (snapshot) return snapshot;
  }
  return computeRoundResults(db, round, options);
}

/**
 * The anonymised post-round view (§9): how each ticket scored overall, with no
 * individual attribution. Notes/queries are surfaced without their author.
 */
export interface FeedbackTicket {
  jiraId: string;
  title: string;
  type: string;
  responsesCount: number;
  businessScore: number | null;
  stdDev: number | null;
  discussionRequired: boolean;
  statusLabel: string;
  priorityRatio: number | null;
  priorityBandLabel: string;
  effort: number | null;
  categoryAverages: Array<{ categoryId: string; name: string; average: number; min: number; max: number }>;
  totalsDistribution: number[];
  excludedCounts: Record<string, number>;
  notes: string[];
}

export async function buildFeedbackView(db: Db, round: Round): Promise<FeedbackTicket[]> {
  const results = await roundResults(db, round);
  const submissions = await listRoundSubmissions(db, round.id);

  const notesByTicket = new Map<string, string[]>();
  for (const submission of submissions) {
    const text = [submission.moreInfo, submission.closureInfo].filter((s) => s && s.trim()).join(' — ');
    if (!text) continue;
    const bucket = notesByTicket.get(submission.ticketId) ?? [];
    bucket.push(text.trim());
    notesByTicket.set(submission.ticketId, bucket);
  }

  return results.map(({ ticket, aggregate }) => ({
    jiraId: ticket.jiraId,
    title: ticket.title,
    type: ticket.type,
    responsesCount: aggregate.responsesCount,
    businessScore: aggregate.businessScore,
    stdDev: aggregate.stdDev,
    discussionRequired: aggregate.discussionRequired,
    statusLabel: aggregate.statusLabel,
    priorityRatio: aggregate.priorityRatio,
    priorityBandLabel: aggregate.priorityBand ? PRIORITY_BAND_LABELS[aggregate.priorityBand] : '',
    effort: aggregate.effort,
    categoryAverages: aggregate.categoryAverages,
    totalsDistribution: aggregate.totalsDistribution,
    excludedCounts: aggregate.excludedCounts,
    notes: notesByTicket.get(ticket.id) ?? [],
  }));
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** §17: results export to CSV, independent of JIRA write-back. */
export async function resultsToCsv(db: Db, round: Round): Promise<string> {
  const categories = await listCategories(db);
  const results = await roundResults(db, round);

  const header = [
    'Round',
    'Cut-off',
    'JIRA ID',
    'Title',
    'Type',
    'Stream',
    'Responses',
    ...categories.map((c) => `${c.name} (avg)`),
    'Business Score',
    'Std Dev',
    'Discussion Required',
    'Effort',
    'Priority Ratio',
    'Priority Band',
    'Status',
    'Send for Est',
    'To Close?',
    'Unsure votes',
    'Not relevant today votes',
  ];

  const lines = [header.map(csvCell).join(',')];
  for (const { ticket, aggregate } of results) {
    const averages = categories.map((category) => {
      const found = aggregate.categoryAverages.find((c) => c.categoryId === category.id);
      return found && aggregate.responsesCount > 0 ? found.average.toFixed(2) : '';
    });
    lines.push(
      [
        round.weekLabel,
        round.cutOffAt,
        ticket.jiraId,
        ticket.title,
        ticket.type,
        ticket.stream,
        aggregate.responsesCount,
        ...averages,
        aggregate.businessScore ?? '',
        aggregate.stdDev === null ? '' : aggregate.stdDev.toFixed(2),
        aggregate.discussionRequired ? 'Yes' : 'No',
        aggregate.effort ?? '',
        aggregate.priorityRatio === null ? '' : aggregate.priorityRatio.toFixed(2),
        aggregate.priorityBand ? PRIORITY_BAND_LABELS[aggregate.priorityBand] : '',
        aggregate.statusLabel,
        aggregate.sendForEstimation ? 'Send for Est' : '',
        aggregate.toClose ? 'Yes' : 'No',
        aggregate.excludedCounts.UNSURE,
        aggregate.excludedCounts.NO_NOT_RELEVANT_TODAY,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  return lines.join('\n');
}
