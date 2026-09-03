import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requireCoordinator } from '../auth/middleware.js';
import { searchHopper } from '../integrations/jira.js';
import { getAppConfig } from '../services/configService.js';
import { getQueueView } from '../services/queueService.js';
import { asyncHandler } from './helpers.js';

const router = Router();

/**
 * Where the scored tickets currently sit in the dev queue.
 *
 * Open to anyone signed in, committee included. It carries no individual
 * scores and nothing about who answered what - it is the committee's own
 * output, read back from JIRA, and the people who did the scoring are the
 * ones with the most reason to see where it went.
 */
router.get(
  '/queue',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json(await getQueueView(await getDb()));
  }),
);

const previewSchema = z.object({ jql: z.string().min(1) });

/**
 * Read-only: shows exactly what a JQL currently matches, without saving it
 * or requiring the queue to be switched on first. Exists because the
 * hopper JQL silently dropping a ticket is invisible until this exists -
 * see PLAN-5 in docs/plans/.
 */
router.post(
  '/queue/preview',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const { jql } = previewSchema.parse(req.body ?? {});
    const config = await getAppConfig(await getDb());
    const issues = await searchHopper(jql, {
      businessScoreFieldId: config.jira.businessScoreFieldId,
      backendFieldId: config.scoring.effort.backendFieldId,
      frontendFieldId: config.scoring.effort.frontendFieldId,
    });
    res.json({ issues });
  }),
);

export default router;
