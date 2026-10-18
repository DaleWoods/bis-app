import express, { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireCoordinator } from '../auth/middleware.js';
import { HttpishError } from '../services/roundService.js';
import { audit } from '../services/auditService.js';
import { commitHistoryImport, previewHistoryImport } from '../services/historyImportService.js';
import { actorOf, asyncHandler } from './helpers.js';

const router = Router();

/**
 * The workbook travels as the raw request body rather than base64 in JSON:
 * the manual scoring workbook is a few megabytes with its backlog export in
 * it, which would not fit under the app-wide JSON limit once encoded.
 */
const workbookBody = express.raw({ type: () => true, limit: '25mb' });

function bodyBuffer(body: unknown): Buffer {
  if (!Buffer.isBuffer(body) || !body.length) throw new HttpishError(400, 'Choose the scoring workbook to import.');
  return body;
}

/** Read-only: what an import of this workbook would create. Nothing is written. */
router.post(
  '/admin/import/preview',
  requireCoordinator,
  workbookBody,
  asyncHandler(async (req, res) => {
    res.json({ preview: await previewHistoryImport(await getDb(), bodyBuffer(req.body)) });
  }),
);

/**
 * Import it. `active` lists the emails of new people to add as current
 * committee members; everyone else new is added inactive, so they count in
 * the history without being emailed or expected to score.
 */
router.post(
  '/admin/import/commit',
  requireCoordinator,
  workbookBody,
  asyncHandler(async (req, res) => {
    const active = String(req.query.active ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    const db = await getDb();
    const result = await commitHistoryImport(db, bodyBuffer(req.body), active);
    await audit(db, actorOf(req), 'history.import', 'system', '', result);
    res.json({ result });
  }),
);

export default router;
