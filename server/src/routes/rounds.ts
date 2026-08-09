import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requireCoordinator } from '../auth/middleware.js';
import { STREAMS, isCoordinator } from '../domain/types.js';
import { audit } from '../services/auditService.js';
import { getAppConfig, listCategories } from '../services/configService.js';
import { listEmailLog, sendDistribution, sendReminders } from '../services/emailService.js';
import { listActiveScorers, getMember } from '../services/memberService.js';
import { buildFeedbackView, computeRoundResults, resultsToCsv, snapshotRoundResults } from '../services/resultService.js';
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
  updateRound,
} from '../services/roundService.js';
import { listRoundSubmissions, roundProgress, setSubmissionArchived } from '../services/submissionService.js';
import { listWriteBacks, writeBackRound } from '../services/jiraService.js';
import { describeNext, listAutomationLog, runDueAutomation } from '../services/automationService.js';
import { fetchAttachment } from '../integrations/jira.js';
import { buildPptx } from '../pack/pptx.js';
import { buildPdf } from '../pack/pdf.js';
import { actorOf, asyncHandler } from './helpers.js';

const router = Router();

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
      payload.results = await computeRoundResults(db, round);
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
      next: describeNext(round, config.automation),
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
    res.json({ round, results: await computeRoundResults(db, round) });
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
    res.json({ round, tickets: await buildFeedbackView(db, round) });
  }),
);

async function packInput(roundId: string) {
  const db = await getDb();
  const round = await getRound(db, roundId);
  if (!round) return null;
  const [tickets, categories, config] = await Promise.all([
    listRoundTickets(db, round.id),
    listCategories(db),
    getAppConfig(db),
  ]);

  // Embed JIRA screenshots as data URIs. One unreachable image must never stop
  // the pack being generated, so each failure is skipped.
  //
  // Fetched a few at a time rather than one after another: a thirty-ticket
  // round was thirty sequential round-trips to JIRA, which is long enough for
  // the browser to give up on the download.
  const screenshots: Record<string, string> = {};
  const withImages = tickets.filter((ticket) => ticket.screenshotAttachmentId);
  let next = 0;
  const fetchWorker = async (): Promise<void> => {
    while (next < withImages.length) {
      const ticket = withImages[next++];
      try {
        const { buffer, contentType } = await fetchAttachment(ticket.screenshotAttachmentId);
        screenshots[ticket.id] = `data:${contentType};base64,${buffer.toString('base64')}`;
      } catch {
        // no screenshot for this ticket
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, withImages.length) }, fetchWorker));

  return { db, round, tickets, categories, config: config.pack, screenshots };
}

router.get(
  '/rounds/:id/pack.pptx',
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = await packInput(req.params.id);
    if (!input) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    const buffer = await buildPptx(input);
    await audit(await getDb(), actorOf(req), 'round.pack.pptx', 'round', input.round.id, {});
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('content-disposition', `attachment; filename="bis-${slug(input.round.weekLabel)}-pack.pptx"`);
    res.send(buffer);
  }),
);

router.get(
  '/rounds/:id/pack.pdf',
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = await packInput(req.params.id);
    if (!input) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    const buffer = await buildPdf(input);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `attachment; filename="bis-${slug(input.round.weekLabel)}-pack.pdf"`);
    res.send(buffer);
  }),
);

/** Open the round and email the committee (§12.2). */
router.post(
  '/rounds/:id/distribute',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const { attachPack, open } = z
      .object({ attachPack: z.boolean().optional(), open: z.boolean().optional() })
      .parse(req.body ?? {});
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

    let attachment;
    if (attachPack) {
      const input = await packInput(round.id);
      if (input) {
        const buffer = await buildPptx(input);
        attachment = {
          name: `bis-${slug(round.weekLabel)}-pack.pptx`,
          contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          contentBytes: buffer.toString('base64'),
        };
      }
    }

    const recipients = await listActiveScorers(db);
    const results = await sendDistribution(db, round, tickets, recipients, attachment);
    await markDistributed(db, round.id);
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
    const progress = await roundProgress(db, round.id, scorers, tickets.length);

    const targets = [] as Array<{ member: (typeof scorers)[number]; outstanding: number }>;
    for (const row of progress) {
      if (memberIds && !memberIds.includes(row.memberId)) continue;
      if (row.outstanding <= 0) continue;
      const member = scorers.find((m) => m.id === row.memberId) ?? (await getMember(db, row.memberId));
      if (member) targets.push({ member, outstanding: row.outstanding });
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
