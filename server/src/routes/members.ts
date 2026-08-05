import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requireCoordinator } from '../auth/middleware.js';
import { ROLES, isCoordinator } from '../domain/types.js';
import { audit } from '../services/auditService.js';
import { countMemberSubmissions, deleteMember, getMember, listMembers, saveMember } from '../services/memberService.js';
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

/** Delete a member. Requires force once the coordinator has seen the count. */
router.delete(
  '/members/:id',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const member = await getMember(db, req.params.id);
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    // Removing the last way in would lock everyone out of administration.
    if (isCoordinator(member.role)) {
      const admins = (await listMembers(db)).filter((m) => m.active && isCoordinator(m.role));
      if (admins.length <= 1) {
        res.status(409).json({ error: 'That is the only active coordinator — promote someone else first' });
        return;
      }
    }
    if (member.id === req.member?.id) {
      res.status(409).json({ error: 'You cannot delete your own account' });
      return;
    }

    const force = String(req.query.force ?? '') === 'true';
    const { submissionsRemoved } = await deleteMember(db, member.id, { force });
    await audit(db, actorOf(req), 'member.delete', 'member', member.id, {
      email: member.email,
      submissionsRemoved,
    });
    res.json({ ok: true, submissionsRemoved });
  }),
);

/** How many scores a member carries, so the UI can warn before deleting. */
router.get(
  '/members/:id/submission-count',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    res.json({ count: await countMemberSubmissions(db, req.params.id) });
  }),
);

export default router;
