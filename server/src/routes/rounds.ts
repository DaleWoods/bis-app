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
import { listRoundSubmissions, roundProgress } from '../services/submissionService.js';
import { listWriteBacks, writeBackRound } from '../services/jiraService.js';
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
  stream: z.enum(STREAMS).optional(),
  notes: z.string().optional(),
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
    const round = await setRoundStatus(db, req.params.id, status);
    if (status === 'FINALISED') await snapshotRoundResults(db, round);
    await audit(db, actorOf(req), `round.${status.toLowerCase()}`, 'round', round.id, {});
    res.json({ round });
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
    await removeTicketFromRound(db, req.params.id, req.params.ticketId);
    await audit(db, actorOf(req), 'round.ticket.remove', 'round', req.params.id, { ticketId: req.params.ticketId });
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
  return { db, round, tickets, categories, config: config.pack };
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
    const { force } = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    const db = await getDb();
    const round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    const entries = await writeBackRound(db, actorOf(req), round, { force });
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
