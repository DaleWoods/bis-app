import { Router } from 'express';
import { z } from 'zod';
import { Db, getDb } from '../db/index.js';
import { requireAuth } from '../auth/middleware.js';
import { RELEVANCE_VALUES, canScore, isCoordinator } from '../domain/types.js';
import { audit } from '../services/auditService.js';
import { getScoringConfig, listCategories } from '../services/configService.js';
import { listActiveScorers } from '../services/memberService.js';
import { getActiveRound, getRound, isScoringOpen, listRoundTickets, listRounds } from '../services/roundService.js';
import { listMemberSubmissions, participationHistory, roundProgress, saveSubmission } from '../services/submissionService.js';
import { getTicket } from '../services/ticketService.js';
import { actorOf, asyncHandler } from './helpers.js';

/**
 * How many of the committee have finished this round so far - a count, never
 * who. Individual scores and who has and hasn't answered stay hidden from the
 * committee while a round is open (§9); a completion count is not that, and
 * seeing that other people are getting on with it is most of what keeps a
 * round from being ignored until the last day.
 */
async function participationSummary(db: Db, roundId: string, ticketCount: number): Promise<{ completed: number; total: number }> {
  const scorers = await listActiveScorers(db);
  const progress = await roundProgress(db, roundId, scorers, ticketCount);
  return { completed: progress.filter((p) => p.complete).length, total: progress.length };
}

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

    /*
      Nothing to score is not the same as nothing to see.

      A committee member signing in the day after a round was finalised was
      told "there is no open scoring round" and left there, with no way to
      reach the anonymised feedback for the round they had just scored - that
      link lives on the rounds dashboard, which is not where the app sends
      them. So the last finalised round comes back regardless of whether there
      is also a round open right now: a member who always has another round to
      score would otherwise never see this state, and never be nudged back to
      the results of the one they only just finished.
    */
    const lastFinalised =
      (await listRounds(db))
        .filter((r) => r.status === 'FINALISED')
        .sort((a, b) => (b.finalisedAt ?? b.cutOffAt).localeCompare(a.finalisedAt ?? a.cutOffAt))[0] ?? null;
    const lastFinalisedIncludesYou = lastFinalised
      ? (await listMemberSubmissions(db, lastFinalised.id, req.member!.id)).some((s) => !s.archived)
      : false;
    // Your own record over recent rounds - "you've completed 6 of the last 8"
    // is a small, positive nudge that costs nothing to compute here since it
    // shares the same recent-rounds query as the coordinator's view.
    const myParticipation = (await participationHistory(db, [req.member!], 8))[0];

    if (!round) {
      res.json({
        round: null,
        lastFinalised,
        lastFinalisedIncludesYou,
        myParticipation,
        tickets: [],
        submissions: [],
        categories: await listCategories(db),
        canScore: canScore(req.member!.role),
      });
      return;
    }
    // A held ticket is automation's own doubt about a card, not something for
    // the committee to weigh in on - it stays off this surface entirely until
    // a coordinator releases it, the same as if it were not in the round yet.
    const tickets = (await listRoundTickets(db, round.id)).filter((t) => !t.held);
    res.json({
      round,
      lastFinalised,
      lastFinalisedIncludesYou,
      myParticipation,
      canScore: canScore(req.member!.role),
      scoringOpen: isScoringOpen(round),
      tickets,
      submissions: await listMemberSubmissions(db, round.id, req.member!.id),
      categories: await listCategories(db),
      participation: await participationSummary(db, round.id, tickets.length),
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
    const tickets = (await listRoundTickets(db, round.id)).filter((t) => !t.held);
    res.json({
      round,
      canScore: canScore(req.member!.role),
      scoringOpen: isScoringOpen(round),
      tickets,
      submissions: await listMemberSubmissions(db, round.id, req.member!.id),
      categories: await listCategories(db),
      participation: await participationSummary(db, round.id, tickets.length),
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
