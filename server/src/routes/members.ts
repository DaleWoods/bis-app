import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requireCoordinator } from '../auth/middleware.js';
import { ROLES } from '../domain/types.js';
import { audit } from '../services/auditService.js';
import { listMembers, saveMember } from '../services/memberService.js';
import { actorOf, asyncHandler } from './helpers.js';

const router = Router();

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ member: req.member });
  }),
);

router.get(
  '/members',
  requireCoordinator,
  asyncHandler(async (_req, res) => {
    const db = await getDb();
    res.json({ members: await listMembers(db) });
  }),
);

const memberSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  email: z.string().email(),
  team: z.string().optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
});

router.post(
  '/members',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const input = memberSchema.parse(req.body ?? {});
    const db = await getDb();
    const member = await saveMember(db, input);
    await audit(db, actorOf(req), input.id ? 'member.update' : 'member.create', 'member', member.id, input);
    res.json({ member });
  }),
);

export default router;
