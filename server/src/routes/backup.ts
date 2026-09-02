import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireCoordinator } from '../auth/middleware.js';
import { runBackupAndEmail } from '../services/backupService.js';
import { actorOf, asyncHandler } from './helpers.js';

const router = Router();

/** On-demand full-database export, emailed to every active admin (§14). */
router.post(
  '/backup/export',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const result = await runBackupAndEmail(db, actorOf(req));
    res.json(result);
  }),
);

export default router;
