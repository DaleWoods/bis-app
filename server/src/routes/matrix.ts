import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireCoordinator } from '../auth/middleware.js';
import { getMatrixView } from '../services/matrixService.js';
import { asyncHandler } from './helpers.js';

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

export default router;
