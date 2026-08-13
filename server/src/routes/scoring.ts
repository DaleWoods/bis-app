import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth } from '../auth/middleware.js';
import { RELEVANCE_VALUES, canScore, isCoordinator } from '../domain/types.js';
import { audit } from '../services/auditService.js';
import { getScoringConfig, listCategories } from '../services/configService.js';
import { getActiveRound, getRound, isScoringOpen, listRoundTickets, listRounds } from '../services/roundService.js';
import { listMemberSubmissions, saveSubmission } from '../services/submissionService.js';
import { getTicket } from '../services/ticketService.js';
import { actorOf, asyncHandler } from './helpers.js';

const router = Router();

/**
 * The committee member's scoring surface: the open round, its ticket cards, and
 * *only their own* submissions (§9).
 */
router.get(
  '/my/round',
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const round = await getActiveRound(db);
    if (!round) {
      /*
        Nothing to score is not the same as nothing to see.

        A committee member signing in the day after a round was finalised was
        told "there is no open scoring round" and left there, with no way to
        reach the anonymised feedback for the round they had just scored - that
        link lives on the rounds dashboard, which is not where the app sends
        them. So the last finalised round comes back with the empty answer, and
        the scoring page offers it.
      */
      const lastFinalised = (await listRounds(db))
        .filter((r) => r.status === 'FINALISED')
        .sort((a, b) => (b.finalisedAt ?? b.cutOffAt).localeCompare(a.finalisedAt ?? a.cutOffAt))[0];
      res.json({
        round: null,
        lastFinalised: lastFinalised ?? null,
        tickets: [],
        submissions: [],
        categories: await listCategories(db),
        canScore: canScore(req.member!.role),
      });
      return;
    }
    res.json({
      round,
      canScore: canScore(req.member!.role),
      scoringOpen: isScoringOpen(round),
      tickets: await listRoundTickets(db, round.id),
      submissions: await listMemberSubmissions(db, round.id, req.member!.id),
      categories: await listCategories(db),
    });
  }),
);

router.get(
  '/rounds/:id/my-submissions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    if (round.status === 'DRAFT' && !isCoordinator(req.member!.role)) {
      res.status(403).json({ error: 'This round has not been distributed yet' });
      return;
    }
    res.json({
      round,
      canScore: canScore(req.member!.role),
      scoringOpen: isScoringOpen(round),
      tickets: await listRoundTickets(db, round.id),
      submissions: await listMemberSubmissions(db, round.id, req.member!.id),
      categories: await listCategories(db),
    });
  }),
);

const submissionSchema = z.object({
  relevance: z.enum(RELEVANCE_VALUES),
  scores: z.record(z.string(), z.number()).optional(),
  closureReason: z.string().optional(),
  closureInfo: z.string().optional(),
  moreInfo: z.string().optional(),
});

/**
 * Submit or edit this member's score for one ticket. A member can only ever
 * write their own submission - the member id comes from the session, never the
 * request body.
 */
router.put(
  '/rounds/:roundId/tickets/:ticketId/submission',
  requireAuth,
  asyncHandler(async (req, res) => {
    const payload = submissionSchema.parse(req.body ?? {});
    const db = await getDb();

    const round = await getRound(db, req.params.roundId);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    const ticket = await getTicket(db, req.params.ticketId);
    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    const config = await getScoringConfig(db);
    const submission = await saveSubmission(db, { round, ticket, member: req.member!, payload, config });

    await audit(db, actorOf(req), 'submission.save', 'submission', submission.id, {
      roundId: round.id,
      jiraId: ticket.jiraId,
      relevance: submission.relevance,
      scores: submission.scores,
    });
    res.json({ submission });
  }),
);

export default router;
