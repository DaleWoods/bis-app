import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireCoordinator } from '../auth/middleware.js';
import { listAudit } from '../services/auditService.js';
import { asyncHandler } from './helpers.js';

const router = Router();

/** Full audit detail is retained server-side for the coordinator/admin (§9, §14). */
router.get(
  '/audit',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const entries = await listAudit(db, {
      entityType: typeof req.query.entityType === 'string' ? req.query.entityType : undefined,
      entityId: typeof req.query.entityId === 'string' ? req.query.entityId : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ entries });
  }),
);

export default router;
