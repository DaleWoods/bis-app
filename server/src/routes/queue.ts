import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth } from '../auth/middleware.js';
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

export default router;
