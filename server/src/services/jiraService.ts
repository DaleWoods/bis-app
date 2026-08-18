import { Db } from '../db/index.js';
import { env } from '../config/env.js';
import { AppConfig } from '../domain/types.js';
import { DUPLICATE_TITLE_THRESHOLD, titleSimilarity } from '../domain/similarity.js';
import * as jira from '../integrations/jira.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/time.js';
import { AuditActor, audit } from './auditService.js';
import { getAppConfig } from './configService.js';
import { HttpishError, Round, addTicketToRound, assertRoundAcceptsTickets, getRound } from './roundService.js';
import { roundResults } from './resultService.js';
import { Ticket, activeTicketTitles, upsertTicket } from './ticketService.js';
import { draftCardsFor, draftToTicketFields } from './cardDraftService.js';
import { heldForDiscussion, listDiscussions } from './discussionService.js';

export interface PossibleDuplicate {
  jiraId: string;
  title: string;
  similarTo: Array<{ jiraId: string; title: string }>;
}

export interface ImportResult {
  imported: Ticket[];
  addedToRound: number;
  /** Echoed back so an import that matches nothing can say what it searched. */
  jql: string;
  /** How many cards the AI drafter wrote, so the UI can say which one ran. */
  aiDrafted: number;
  /** Tickets whose title closely matches one already live in another round - worth a look before scoring both. */
  possibleDuplicates: PossibleDuplicate[];
}

/** Read the Business Scoring queue and bring it into the app (§12.1). */
export async function importQueue(
  db: Db,
  actor: AuditActor,
  options: { roundId?: string; jql?: string; maxResults?: number } = {},
): Promise<ImportResult> {
  const config = await getAppConfig(db);

  // Checked before JIRA is called rather than when the first ticket is added:
  // a round that will not take tickets should say so straight away, not after
  // pulling thirty issues and drafting thirty cards.
  if (options.roundId) {
    const round = await getRound(db, options.roundId);
    if (!round) throw new HttpishError(404, 'Round not found');
    assertRoundAcceptsTickets(round);
  }

  const jql = options.jql?.trim() || config.jira.queueJql;
  const inputs = await jira.searchQueue(
    config.jira,
    { backendFieldId: config.scoring.effort.backendFieldId, frontendFieldId: config.scoring.effort.frontendFieldId },
    { jql: options.jql, maxResults: options.maxResults },
  );

  // Draft the cards from the tickets' own content so a coordinator starts from
  // something rather than a blank form (§7). Drafted up front and in parallel:
  // the AI drafter is a network call per ticket, and doing them inside the
  // insert loop would make a thirty-ticket import feel broken.
  const drafts = await draftCardsFor(
    inputs.map((input) => ({
      jiraId: input.jiraId,
      title: input.title,
      type: input.type ?? '',
      description: input.rawDescription ?? '',
      comments: input.rawComments,
      stakeholder: input.stakeholder,
      affects: input.affects,
      impacts: input.impacts,
      workaround: input.workaround,
      priority: input.priority,
      labels: input.labels,
      components: input.components,
      siteAffected: input.siteAffected,
      environment: input.originalTestingEnvironment,
      linkedIssues: input.linkedIssues,
      createdDate: input.createdDate,
      imageFilenames: (input.attachments ?? []).filter((a) => a.isImage).map((a) => a.filename),
    })),
  );

  const imported: Ticket[] = [];
  for (const [index, input] of inputs.entries()) {
    // preserveAuthored means a re-sync never overwrites what a coordinator has
    // since written.
    const fields = draftToTicketFields(drafts[index].draft, input.attachments ?? []);
    const ticket = await upsertTicket(db, { ...input, ...fields }, { preserveAuthored: true });
    imported.push(ticket);
    if (options.roundId) await addTicketToRound(db, options.roundId, ticket.id);
  }

  const aiDrafted = drafts.filter((d) => d.drafter === 'ai').length;
  const possibleDuplicates = await findPossibleDuplicates(db, imported);
  await audit(db, actor, 'jira.import', 'round', options.roundId ?? '', {
    jql: options.jql ?? config.jira.queueJql,
    count: imported.length,
    aiDrafted,
    possibleDuplicates: possibleDuplicates.length,
  });

  return { imported, addedToRound: options.roundId ? imported.length : 0, jql, aiDrafted, possibleDuplicates };
}

/**
 * Whether the same underlying issue has already been raised under a different
 * JIRA number. Checked against everything still live in a round, not just this
 * import batch, so re-raising last week's ticket under a new number is caught
 * too - not just two near-identical tickets pulled in together.
 */
async function findPossibleDuplicates(db: Db, imported: Ticket[]): Promise<PossibleDuplicate[]> {
  const active = await activeTicketTitles(db);
  const duplicates: PossibleDuplicate[] = [];
  for (const ticket of imported) {
    const similarTo = active
      .filter((other) => other.jiraId !== ticket.jiraId && titleSimilarity(ticket.title, other.title) >= DUPLICATE_TITLE_THRESHOLD)
      .map((other) => ({ jiraId: other.jiraId, title: other.title }));
    if (similarTo.length) duplicates.push({ jiraId: ticket.jiraId, title: ticket.title, similarTo });
  }
  return duplicates;
}

/** Refresh RA poker effort (and status) for tickets already in the app (§10.4). */
export async function refreshTicketFromJira(db: Db, ticket: Ticket, config: AppConfig): Promise<Ticket> {
  const input = await jira.getIssue(ticket.jiraId, config.jira, {
    backendFieldId: config.scoring.effort.backendFieldId,
    frontendFieldId: config.scoring.effort.frontendFieldId,
  });
  return upsertTicket(db, input, { preserveAuthored: true });
}

export interface WriteBackEntry {
  jiraId: string;
  businessScore: number | null;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  reason?: string;
  transitionedTo?: string;
}

/**
 * Write the computed business score back to JIRA (§12.1).
 *
 * Idempotent (§14): the round+ticket+score triple is the idempotency key, so
 * re-running after a partial failure only retries what did not land, and
 * re-running after success is a no-op.
 */
export async function writeBackRound(
  db: Db,
  actor: AuditActor,
  round: Round,
  options: { force?: boolean; ignoreMinSubmissions?: boolean } = {},
): Promise<WriteBackEntry[]> {
  const config = await getAppConfig(db);
  if (!env.jira.configured) throw new jira.JiraNotConfiguredError();
  if (!config.jira.businessScoreFieldId) {
    throw new HttpishError(
      400,
      'No JIRA Business Score field id configured. Set it in Settings (use "Resolve field ids from JIRA").',
    );
  }

  // Frozen once the round is finalised, so what goes to JIRA is the number
  // the committee actually landed on, not a recalculation of it.
  const results = await roundResults(db, round, { config: config.scoring });
  const discussions = await listDiscussions(db, round.id);
  const entries: WriteBackEntry[] = [];

  for (const { ticket, aggregate } of results) {
    const discussion = discussions.get(ticket.id) ?? null;
    // An agreed score replaces the average it was agreed instead of, and being
    // part of the key means changing it after the fact writes again rather
    // than being waved through as "already written".
    const agreed = discussion?.outcome === 'AGREED' ? discussion.agreedScore : null;

    if (aggregate.businessScore === null) {
      entries.push({
        jiraId: ticket.jiraId,
        businessScore: null,
        status: 'SKIPPED',
        reason: aggregate.submissionsCount
          ? 'Nobody answered "Yes" to the relevance question, so there is no score to write'
          : 'Nobody has scored this ticket',
      });
      continue;
    }

    const businessScore = agreed ?? aggregate.businessScore;
    const key = `${round.id}:${ticket.id}:${businessScore}`;
    // The minimum-responses gate (§10) is a rule about confidence, not about
    // JIRA, so a coordinator can knowingly write past it - for a test ticket, or
    // a round the committee will never reach a quorum on.
    if (!aggregate.minSubmissionsMet && !options.ignoreMinSubmissions) {
      entries.push({
        jiraId: ticket.jiraId,
        businessScore: aggregate.businessScore,
        status: 'SKIPPED',
        reason: `${aggregate.responsesCount} of the ${config.scoring.minSubmissions} responses needed — rolls over to the next round`,
      });
      continue;
    }
    /*
      A ticket the committee was split on is held back until the discussion has
      happened - and there is no override for it, unlike the responses gate.
      The average of two people who scored it 1 and 70 is not a number anyone
      in that meeting agreed with, and the meeting may well end in a re-score,
      so writing it to JIRA first would put a figure in front of RA that the
      committee is in the middle of retracting.
    */
    if (heldForDiscussion(aggregate.discussionRequired, discussion)) {
      entries.push({
        jiraId: ticket.jiraId,
        businessScore: aggregate.businessScore,
        status: 'SKIPPED',
        reason:
          discussion?.outcome === 'RESCORE'
            ? 'The discussion sent this back to the committee to be scored again'
            : discussion?.outcome === 'CLOSE'
              ? 'The discussion decided to close this ticket, so there is no score to write'
              : `Scores ranged ${Math.min(...aggregate.totalsDistribution)} to ${Math.max(...aggregate.totalsDistribution)} — held until the discussion is recorded on the Discussions tab`,
      });
      continue;
    }

    const existing = await db.get<{ id: string; status: string; attempts: number; transitioned_to: string }>(
      'SELECT id, status, attempts, transitioned_to FROM jira_writebacks WHERE idempotency_key = ?',
      [key],
    );

    /*
      What counts as ready is the §10.3 gate, plus the one thing the gate cannot
      know: a split the committee has since talked through and agreed a score
      for is ready, even though sendForEstimation still says it is not.
    */
    const readyForEstimation =
      (aggregate.minSubmissionsMet || Boolean(options.ignoreMinSubmissions)) &&
      !aggregate.toClose &&
      (!aggregate.discussionRequired || agreed !== null);
    const wantsTransition = config.jira.transitionOnFinalise && readyForEstimation;

    /*
      An already-written score does not mean an already-finished ticket.

      This used to skip the whole ticket the moment the score had gone across,
      which left no way to move a ticket on afterwards: switching the transition
      on, or correcting its name, changed nothing because the second run never
      got past this check. So the skip now only applies when there is genuinely
      nothing left to do - and when there is, the score is left alone and only
      the move is attempted.
    */
    const alreadyWritten = existing?.status === 'SUCCESS' && !options.force;
    const stillToMove = wantsTransition && !(existing?.transitioned_to ?? '').trim();
    if (alreadyWritten && !stillToMove) {
      entries.push({
        jiraId: ticket.jiraId,
        businessScore,
        status: 'SKIPPED',
        reason: 'Already written with this score',
        transitionedTo: existing?.transitioned_to || undefined,
      });
      continue;
    }

    const id = existing?.id ?? newId();
    const attempts = Number(existing?.attempts ?? 0) + 1;
    const now = nowIso();
    if (existing) {
      await db.run('UPDATE jira_writebacks SET status = ?, attempts = ?, updated_at = ? WHERE id = ?', [
        'PENDING',
        attempts,
        now,
        id,
      ]);
    } else {
      await db.run(
        `INSERT INTO jira_writebacks (id, round_id, ticket_id, jira_id, business_score, idempotency_key, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        [id, round.id, ticket.id, ticket.jiraId, businessScore, key, attempts, now, now],
      );
    }

    try {
      // Skipped when the score is already in JIRA and only the move is
      // outstanding - re-writing an identical value is pointless noise on the
      // ticket's history.
      if (!alreadyWritten) {
        await jira.writeBusinessScore(ticket.jiraId, config.jira.businessScoreFieldId, businessScore);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.run('UPDATE jira_writebacks SET status = ?, error = ?, updated_at = ? WHERE id = ?', [
        'FAILED',
        message,
        nowIso(),
        id,
      ]);
      await audit(db, actor, 'jira.writeback.failed', 'ticket', ticket.id, { jiraId: ticket.jiraId, error: message });
      entries.push({ jiraId: ticket.jiraId, businessScore, status: 'FAILED', reason: message });
      continue;
    }

    /*
      Moving the ticket on is a second, separate step.

      It used to share the score's try block, so a workflow that would not
      accept the transition - a missing permission, a name that no longer
      matches - reported the whole ticket as FAILED even though the score was
      sitting in JIRA. Re-running then wrote the same score again chasing an
      error that had nothing to do with it.
    */
    let transitionedTo = existing?.transitioned_to ?? '';
    let transitionError = '';
    if (wantsTransition) {
      try {
        transitionedTo = await jira.transitionIssue(ticket.jiraId, config.jira.transitionName);
      } catch (err) {
        transitionError = err instanceof Error ? err.message : String(err);
      }
    }

    await db.run('UPDATE jira_writebacks SET status = ?, error = ?, transitioned_to = ?, updated_at = ? WHERE id = ?', [
      'SUCCESS',
      transitionError,
      transitionedTo,
      nowIso(),
      id,
    ]);
    await audit(db, actor, 'jira.writeback', 'ticket', ticket.id, {
      jiraId: ticket.jiraId,
      businessScore,
      agreedAtDiscussion: agreed !== null,
      transitionedTo,
      transitionError,
    });
    entries.push({
      jiraId: ticket.jiraId,
      businessScore,
      status: 'SUCCESS',
      transitionedTo,
      reason: transitionError
        ? `${alreadyWritten ? 'Score was already in JIRA' : 'Score written'}, but the move failed: ${transitionError}`
        : !config.jira.transitionOnFinalise
          ? 'Score written. Moving the ticket on is switched off in Settings → JIRA.'
          : !readyForEstimation
            ? 'Score written. Not moved on — it has not cleared every gate yet.'
            : alreadyWritten
              ? 'Score was already in JIRA; the ticket has been moved on now.'
              : undefined,
    });
  }

  return entries;
}

export interface WriteBackRow {
  jiraId: string;
  businessScore: number | null;
  status: string;
  attempts: number;
  transitionedTo: string;
  error: string;
  updatedAt: string;
}

export async function listWriteBacks(db: Db, roundId: string): Promise<WriteBackRow[]> {
  const rows = await db.all<any>('SELECT * FROM jira_writebacks WHERE round_id = ? ORDER BY updated_at DESC', [roundId]);
  return rows.map((row) => ({
    jiraId: row.jira_id,
    businessScore: row.business_score,
    status: row.status,
    attempts: Number(row.attempts),
    transitionedTo: row.transitioned_to,
    error: row.error,
    updatedAt: row.updated_at,
  }));
}
