import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireCoordinator } from '../auth/middleware.js';
import { env } from '../config/env.js';
import { HttpishError } from '../services/roundService.js';
import { buildAnalytics, buildAnalyticsContext } from '../services/analyticsService.js';
import { answerAnalyticsQuestion } from '../integrations/anthropic.js';
import { audit } from '../services/auditService.js';
import { asyncHandler, actorOf } from './helpers.js';

const router = Router();

/** Cross-round trends: business score, category drivers, and participation, coordinator-only (§Phase 3). */
router.get(
  '/analytics',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await buildAnalytics(db, limit && Number.isFinite(limit) ? limit : undefined));
  }),
);

const askSchema = z.object({ question: z.string().trim().min(1).max(500) });

/**
 * "Ask the data": a coordinator's own natural-language question, answered
 * from the same frozen history the Trends charts are drawn from.
 * Coordinator-only - same gate as the rest of the Trends page, enforced
 * again here rather than trusted from the route above.
 */
router.post(
  '/analytics/ask',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    if (!env.ai.configured) {
      throw new HttpishError(503, 'AI is not configured for this instance, so there is nothing to ask yet.');
    }
    const { question } = askSchema.parse(req.body ?? {});
    const db = await getDb();
    const context = await buildAnalyticsContext(db);
    const answer = await answerAnalyticsQuestion(question, context);
    await audit(db, actorOf(req), 'analytics.ask', 'system', '', { question });
    res.json({ answer });
  }),
);

export default router;
