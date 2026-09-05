import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requireCoordinator } from '../auth/middleware.js';
import { DISCUSSION_OUTCOMES, STREAMS, isCoordinator } from '../domain/types.js';
import { audit } from '../services/auditService.js';
import { getAppConfig, listCategories } from '../services/configService.js';
import { listEmailLog, sendDistribution, sendReminders } from '../services/emailService.js';
import { listActiveScorers, getMember } from '../services/memberService.js';
import { buildFeedbackView, resultsToCsv, roundResults, snapshotRoundResults } from '../services/resultService.js';
import {
  addTicketToRound,
  createRound,
  getRound,
  listRoundTickets,
  listRounds,
  markDistributed,
  removeTicketFromRound,
  reorderRoundTickets,
  setRoundStatus,
  setTicketHeld,
  updateRound,
} from '../services/roundService.js';
import {
  listRoundSubmissions,
  outstandingTicketsByMember,
  participationHistory,
  roundProgress,
  setSubmissionArchived,
} from '../services/submissionService.js';
import type { Ticket } from '../services/ticketService.js';
import { listWriteBacks, writeBackRound } from '../services/jiraService.js';
import { discussionAgenda, listDiscussions, listPendingDiscussions, recordDiscussion } from '../services/discussionService.js';
import { describeNext, listAutomationLog, listStuckAutomationSteps, runDueAutomation } from '../services/automationService.js';
import { actorOf, asyncHandler } from './helpers.js';

const router = Router();

/**
 * Completion rate over recent rounds, not just this one - so a coordinator can
 * see who has quietly drifted off without piecing it together from memory.
 */
router.get(
  '/rounds/participation',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const limit = Number(req.query.limit ?? 8) || 8;
    const scorers = await listActiveScorers(db);
    res.json({ participation: await participationHistory(db, scorers, limit) });
  }),
);

router.get(
  '/rounds',
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const rounds = await listRounds(db);
    // Committee members never see draft rounds - those are the coordinator's
    // working area until distribution.
    res.json({
      rounds: isCoordinator(req.member!.role) ? rounds : rounds.filter((r) => r.status !== 'DRAFT'),
    });
  }),
);

const roundSchema = z.object({
  weekLabel: z.string().min(1),
  cutOffAt: z.string().min(1),
  /** Start of the scoring window. Null clears it, so the round waits for a person. */
  opensAt: z.string().nullable().optional(),
  stream: z.enum(STREAMS).optional(),
  notes: z.string().optional(),
  automationPaused: z.boolean().optional(),
});

router.post(
  '/rounds',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const input = roundSchema.parse(req.body ?? {});
    const db = await getDb();
    const round = await createRound(db, { ...input, createdBy: req.member?.email });
    await audit(db, actorOf(req), 'round.create', 'round', round.id, input);
    res.json({ round });
  }),
);

router.get(
  '/rounds/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    if (!isCoordinator(req.member!.role) && round.status === 'DRAFT') {
      res.status(403).json({ error: 'This round has not been distributed yet' });
      return;
    }

    const tickets = await listRoundTickets(db, round.id);
    const payload: Record<string, unknown> = { round, tickets, categories: await listCategories(db) };

    if (isCoordinator(req.member!.role)) {
      const scorers = await listActiveScorers(db);
      payload.progress = await roundProgress(db, round.id, scorers, tickets.length);
      payload.results = await roundResults(db, round);
      payload.submissions = await listRoundSubmissions(db, round.id);
    }
    res.json(payload);
  }),
);

router.put(
  '/rounds/:id',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const input = roundSchema.partial().parse(req.body ?? {});
    const db = await getDb();
    const round = await updateRound(db, req.params.id, input);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    await audit(db, actorOf(req), 'round.update', 'round', round.id, input);
    res.json({ round });
  }),
);

router.post(
  '/rounds/:id/status',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.enum(['OPEN', 'CLOSED', 'FINALISED']) }).parse(req.body ?? {});
    const db = await getDb();
    const before = await getRound(db, req.params.id);
    const round = await setRoundStatus(db, req.params.id, status);
    if (status === 'FINALISED') await snapshotRoundResults(db, round);
    // Reopening is the one transition worth naming in the audit log on its own:
    // it unfreezes results that may already have been written to JIRA.
    const action = before?.status === 'FINALISED' ? 'round.reopen' : `round.${status.toLowerCase()}`;
    await audit(db, actorOf(req), action, 'round', round.id, { from: before?.status });
    res.json({ round });
  }),
);

/**
 * What the app has done to this round on its own, and what it will do next.
 * Automation that cannot be inspected is automation nobody trusts.
 */
router.get(
  '/rounds/:id/automation',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    const config = await getAppConfig(db);
    res.json({
      next: describeNext(round, config.automation, new Date(), config.cadence.timezone),
      paused: round.automationPaused,
      enabled: config.automation.enabled,
      log: await listAutomationLog(db, round.id),
    });
  }),
);

/**
 * Run everything that is due, now, instead of waiting for the next tick. The
 * override in the other direction: the same code path, on demand.
 */
router.post(
  '/automation/run',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const run = await runDueAutomation(db);
    await audit(db, actorOf(req), 'automation.run', 'round', '', { steps: run.steps.length });
    res.json(run);
  }),
);

router.get(
  '/automation/failures',
  requireCoordinator,
  asyncHandler(async (_req, res) => {
    const db = await getDb();
    res.json({ failures: await listStuckAutomationSteps(db) });
  }),
);

router.get(
  '/discussions/pending',
  requireCoordinator,
  asyncHandler(async (_req, res) => {
    const db = await getDb();
    res.json({ discussions: await listPendingDiscussions(db) });
  }),
);

/**
 * Finalise: close if still open, then freeze the results snapshot. After this
 * the committee can see the anonymised feedback view (§9).
 */
router.post(
  '/rounds/:id/finalise',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    let round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    if (round.status === 'OPEN') round = await setRoundStatus(db, round.id, 'CLOSED');
    round = await setRoundStatus(db, round.id, 'FINALISED');
    const results = await snapshotRoundResults(db, round);
    await audit(db, actorOf(req), 'round.finalise', 'round', round.id, {
      tickets: results.length,
      scored: results.filter((r) => r.aggregate.businessScore !== null).length,
    });
    res.json({ round, results });
  }),
);

/**
 * Re-freeze a finalised round from the submissions as they stand now.
 *
 * Finalising takes a snapshot, and everything afterwards reads it - which is
 * what stops a result drifting once it has gone to JIRA. The cost is that
 * excluding a submission on a finalised round changed nothing: the row greyed
 * out, the score and the spread stayed exactly as they were, and nothing said
 * why. This is the deliberate "yes, I meant that" - the exclusion counts, the
 * spread moves, and a ticket that has become too split to average is flagged
 * for discussion and held out of the write-back like any other.
 */
router.post(
  '/rounds/:id/recalculate',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    if (round.status !== 'FINALISED') {
      res.status(409).json({ error: 'Only a finalised round has frozen results to refresh' });
      return;
    }

    const before = await roundResults(db, round);
    const after = await snapshotRoundResults(db, round);

    // What actually moved, so the coordinator is told rather than left to spot
    // it - a newly split ticket is the whole reason to press this.
    const wasDiscussion = new Set(before.filter((r) => r.aggregate.discussionRequired).map((r) => r.ticket.id));
    const newlySplit = after
      .filter((r) => r.aggregate.discussionRequired && !wasDiscussion.has(r.ticket.id))
      .map((r) => r.ticket.jiraId);
    const changed = after.filter((r) => {
      const previous = before.find((b) => b.ticket.id === r.ticket.id);
      return previous && previous.aggregate.businessScore !== r.aggregate.businessScore;
    }).length;

    await audit(db, actorOf(req), 'round.recalculate', 'round', round.id, {
      tickets: after.length,
      scoresChanged: changed,
      newlySplit,
    });
    res.json({ round, results: after, scoresChanged: changed, newlySplit });
  }),
);

router.post(
  '/rounds/:id/tickets',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const { ticketId } = z.object({ ticketId: z.string().min(1) }).parse(req.body ?? {});
    const db = await getDb();
    await addTicketToRound(db, req.params.id, ticketId);
    await audit(db, actorOf(req), 'round.ticket.add', 'round', req.params.id, { ticketId });
    res.json({ tickets: await listRoundTickets(db, req.params.id) });
  }),
);

router.delete(
  '/rounds/:id/tickets/:ticketId',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const { submissionsRemoved } = await removeTicketFromRound(db, req.params.id, req.params.ticketId);
    await audit(db, actorOf(req), 'round.ticket.remove', 'round', req.params.id, {
      ticketId: req.params.ticketId,
      submissionsRemoved,
    });
    res.json({ tickets: await listRoundTickets(db, req.params.id), submissionsRemoved });
  }),
);

/** Let a ticket automation held back at distribution go to the committee. */
router.post(
  '/rounds/:id/tickets/:ticketId/release',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    await setTicketHeld(db, req.params.id, req.params.ticketId, false);
    await audit(db, actorOf(req), 'round.ticket.release', 'round', req.params.id, { ticketId: req.params.ticketId });
    res.json({ tickets: await listRoundTickets(db, req.params.id) });
  }),
);

router.put(
  '/rounds/:id/tickets/order',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const { ticketIds } = z.object({ ticketIds: z.array(z.string()) }).parse(req.body ?? {});
    const db = await getDb();
    await reorderRoundTickets(db, req.params.id, ticketIds);
    res.json({ tickets: await listRoundTickets(db, req.params.id) });
  }),
);

/**
 * Archive or restore one submission (coordinator only). An archived submission
 * stays in the record and the audit log, but stops counting toward the score.
 */
router.post(
  '/rounds/:id/submissions/:submissionId/archive',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const { archived } = z.object({ archived: z.boolean() }).parse(req.body ?? {});
    const db = await getDb();
    await setSubmissionArchived(db, req.params.submissionId, archived);
    await audit(db, actorOf(req), archived ? 'submission.archive' : 'submission.restore', 'submission', req.params.submissionId, {
      roundId: req.params.id,
    });
    res.json({ submissions: await listRoundSubmissions(db, req.params.id) });
  }),
);

router.get(
  '/rounds/:id/results',
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    // §9: individual results are coordinator-only; the committee gets the
    // anonymised view, and only once the round is finalised.
    if (!isCoordinator(req.member!.role)) {
      res.status(403).json({ error: 'Use the feedback view for round results' });
      return;
    }
    res.json({ round, results: await roundResults(db, round) });
  }),
);

router.get(
  '/rounds/:id/results.csv',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    const csv = await resultsToCsv(db, round);
    await audit(db, actorOf(req), 'round.export.csv', 'round', round.id, {});
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="bis-${slug(round.weekLabel)}-results.csv"`);
    res.send(csv);
  }),
);

/**
 * §10.4 discussions: the tickets the committee was split on, and what the
 * meeting about them decided. Coordinator-only - it is the coordinator who
 * calls the meeting and records the outcome. The committee sees the outcome on
 * the feedback view once the round is finalised.
 */
router.get(
  '/rounds/:id/discussions',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    res.json({ round, items: await discussionAgenda(db, round) });
  }),
);

const discussionSchema = z.object({
  meetingAt: z.string().nullable().optional(),
  outcome: z.enum(DISCUSSION_OUTCOMES).or(z.literal('')).optional(),
  agreedScore: z.number().nullable().optional(),
  note: z.string().optional(),
});

router.post(
  '/rounds/:id/discussions/:ticketId',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    const input = discussionSchema.parse(req.body ?? {});
    const result = await recordDiscussion(db, actorOf(req), round, req.params.ticketId, input);
    res.json({ ...result, items: await discussionAgenda(db, round) });
  }),
);

/** §9 feedback view - visible to the whole committee once finalised, never attributed. */
router.get(
  '/rounds/:id/feedback',
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    if (round.status !== 'FINALISED' && !isCoordinator(req.member!.role)) {
      res.status(403).json({ error: 'The feedback view opens once the round is finalised' });
      return;
    }
    res.json({
      round,
      tickets: await buildFeedbackView(db, round, await listDiscussions(db, round.id), req.member!.id),
    });
  }),
);

/** Open the round and email the committee (§12.2). */
router.post(
  '/rounds/:id/distribute',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const { open } = z.object({ open: z.boolean().optional() }).parse(req.body ?? {});
    const db = await getDb();
    let round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    const tickets = await listRoundTickets(db, round.id);
    if (!tickets.length) {
      res.status(400).json({ error: 'Add at least one ticket before distributing' });
      return;
    }
    if ((open ?? true) && round.status === 'DRAFT') round = await setRoundStatus(db, round.id, 'OPEN');

    const recipients = await listActiveScorers(db);
    const results = await sendDistribution(db, round, tickets, recipients);
    // Only stamp the round as distributed if something actually went out. With
    // email switched off every result is SUPPRESSED, and stamping it anyway put
    // a "Distributed" badge on a round nobody had been told about.
    if (results.some((r) => r.status === 'SENT')) await markDistributed(db, round.id);
    await audit(db, actorOf(req), 'round.distribute', 'round', round.id, {
      recipients: recipients.length,
      sent: results.filter((r) => r.status === 'SENT').length,
      failed: results.filter((r) => r.status === 'FAILED').length,
    });
    res.json({ round: await getRound(db, round.id), results });
  }),
);

/** Chase non-responders before the cut-off (§11). */
router.post(
  '/rounds/:id/remind',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const { escalation, memberIds } = z
      .object({ escalation: z.boolean().optional(), memberIds: z.array(z.string()).optional() })
      .parse(req.body ?? {});
    const db = await getDb();
    const round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    const tickets = await listRoundTickets(db, round.id);
    const scorers = await listActiveScorers(db);

    // Chasing somebody by id who is not (or no longer) an active scorer is
    // still allowed - Chase non-responders can target anyone on the round.
    const extra = [];
    for (const id of memberIds ?? []) {
      if (scorers.some((m) => m.id === id)) continue;
      const member = await getMember(db, id);
      if (member) extra.push(member);
    }
    const considered = [...scorers, ...extra];
    const outstandingTickets = await outstandingTicketsByMember(db, round.id, considered, tickets);

    const targets = [] as Array<{ member: (typeof considered)[number]; outstandingTickets: Ticket[] }>;
    for (const member of considered) {
      if (memberIds && !memberIds.includes(member.id)) continue;
      const forMember = outstandingTickets.get(member.id) ?? [];
      if (forMember.length) targets.push({ member, outstandingTickets: forMember });
    }

    const results = await sendReminders(db, round, targets, escalation ?? false);
    await audit(db, actorOf(req), escalation ? 'round.escalate' : 'round.remind', 'round', round.id, {
      targets: targets.length,
      sent: results.filter((r) => r.status === 'SENT').length,
    });
    res.json({ results });
  }),
);

router.get(
  '/rounds/:id/emails',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    res.json({ emails: await listEmailLog(db, req.params.id) });
  }),
);

/** §12.1 write-back, idempotent and re-triggerable (§14). */
router.post(
  '/rounds/:id/writeback',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const { force, ignoreMinSubmissions } = z
      .object({ force: z.boolean().optional(), ignoreMinSubmissions: z.boolean().optional() })
      .parse(req.body ?? {});
    const db = await getDb();
    const round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    const entries = await writeBackRound(db, actorOf(req), round, { force, ignoreMinSubmissions });
    res.json({ entries });
  }),
);

router.get(
  '/rounds/:id/writebacks',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    res.json({ writebacks: await listWriteBacks(db, req.params.id) });
  }),
);

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'round';
}

export default router;
