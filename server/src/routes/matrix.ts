import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireCoordinator } from '../auth/middleware.js';
import { closeFromMatrix, getMatrixView, recordReview } from '../services/matrixService.js';
import { audit } from '../services/auditService.js';
import { actorOf, asyncHandler } from './helpers.js';

const router = Router();

/**
 * The value matrix. Coordinator-only: it is where tickets get singled out as
 * not worth their effort, which is a conversation to have with the person who
 * raised the ticket, not something to put in front of the whole committee
 * first.
 */
router.get(
  '/matrix',
  requireCoordinator,
  asyncHandler(async (_req, res) => {
    res.json(await getMatrixView(await getDb()));
  }),
);

const ticketKey = z.string().trim().regex(/^[A-Z][A-Z0-9_]*-\d+$/, 'Not a JIRA key');

const reviewSchema = z.object({
  key: ticketKey,
  // CLOSED is not accepted here - it only ever comes from actually closing the ticket.
  outcome: z.enum(['REQUESTED', 'KEPT', 'RESCORE']),
  note: z.string().max(2000).default(''),
  businessScore: z.number().nullable().default(null),
  effort: z.number().nullable().default(null),
});

/** Log what was decided about a ticket, so it is not questioned again next week. */
router.post(
  '/matrix/reviews',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const input = reviewSchema.parse(req.body ?? {});
    const db = await getDb();
    await recordReview(db, { ...input, actorEmail: req.member?.email ?? '' });
    await audit(db, actorOf(req), `matrix.review.${input.outcome.toLowerCase()}`, 'ticket', input.key, {
      note: input.note,
      businessScore: input.businessScore,
      effort: input.effort,
    });
    res.json({ ok: true });
  }),
);

const closeSchema = z.object({
  key: ticketKey,
  reason: z.string().trim().min(1, 'Say why it is being closed').max(2000),
  businessScore: z.number().nullable().default(null),
  effort: z.number().nullable().default(null),
});

/** Close one ticket in JIRA, on a coordinator's explicit say-so. */
router.post(
  '/matrix/close',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const input = closeSchema.parse(req.body ?? {});
    const db = await getDb();
    const result = await closeFromMatrix(db, { ...input, actorEmail: req.member?.email ?? '' });
    await audit(db, actorOf(req), 'matrix.close', 'ticket', input.key, { reason: input.reason, ...result });
    res.json(result);
  }),
);

export default router;
