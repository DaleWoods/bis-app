import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth } from '../auth/middleware.js';
import { getAppConfig } from '../services/configService.js';
import { listActiveScorers } from '../services/memberService.js';
import { buildLeague } from '../services/leagueService.js';
import { asyncHandler } from './helpers.js';

const router = Router();

/**
 * The league table - open to every signed-in member, because the point of it
 * is that the committee sees it. Safe to show to everyone: it is built only
 * from finalised rounds and only from who answered and when, never from what
 * anybody scored.
 */
router.get(
  '/league',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const db = await getDb();
    const config = await getAppConfig(db);
    const scorers = await listActiveScorers(db);
    res.json(await buildLeague(db, scorers, config.league));
  }),
);

export default router;
