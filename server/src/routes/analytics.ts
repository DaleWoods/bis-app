import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireCoordinator } from '../auth/middleware.js';
import { buildAnalytics } from '../services/analyticsService.js';
import { asyncHandler } from './helpers.js';

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

export default router;
