import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requireCoordinator, requireRole } from '../auth/middleware.js';
import { audit } from '../services/auditService.js';
import { deactivateCategory, getAppConfig, listCategories, restoreDefaultCategories, saveCategory, saveConfigSection } from '../services/configService.js';
import { RELEVANCE_LABELS, RELEVANCE_VALUES } from '../domain/types.js';
import { listTransitions, suggestFieldIds } from '../integrations/jira.js';
import { providerLabel, sendMail } from '../integrations/mail.js';
import { shell } from '../services/emailService.js';
import { verifyConnection } from '../integrations/smtp.js';
import { deleteRound, resetOperationalData } from '../services/adminService.js';
import { getRound } from '../services/roundService.js';
import { actorOf, asyncHandler } from './helpers.js';
import { env } from '../config/env.js';

const router = Router();

/** Everything the scoring UI needs to render itself: categories and the §8 answers. */
router.get(
  '/scoring-model',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const db = await getDb();
    const config = await getAppConfig(db);
    res.json({
      categories: await listCategories(db),
      relevanceOptions: RELEVANCE_VALUES.map((value) => ({ value, label: RELEVANCE_LABELS[value] })),
      closureReasons: config.scoring.closureReasons,
      thresholds: {
        minSubmissions: config.scoring.minSubmissions,
        stdDevDiscussionThreshold: config.scoring.stdDevDiscussionThreshold,
        priorityHigh: config.scoring.priorityHigh,
        priorityMedium: config.scoring.priorityMedium,
      },
    });
  }),
);

router.get(
  '/config',
  requireCoordinator,
  asyncHandler(async (_req, res) => {
    const db = await getDb();
    res.json({
      config: await getAppConfig(db),
      categories: await listCategories(db, true),
      integrations: {
        jiraConfigured: env.jira.configured,
        graphConfigured: env.graph.configured,
        emailProvider: env.email.provider,
        emailProviderLabel: providerLabel(),
        emailFrom: env.email.from || env.smtp.user,
        smtpHost: env.smtp.host,
        emailReplyTo: env.email.replyTo,
        // Kept under the original name so existing screens keep working.
        graphSendEnabled: env.email.canSend,
        authMode: env.auth.mode,
        aiDrafting: env.ai.configured,
        aiModel: env.ai.configured ? env.ai.model : '',
      },
    });
  }),
);

/**
 * Send a test email to the signed-in coordinator, so email can be proved
 * working without opening a round and mailing the whole committee.
 */
router.post(
  '/email/test',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const to = String(req.body?.to ?? req.member?.email ?? '').trim();
    if (!to) {
      res.status(400).json({ error: 'No address to send to' });
      return;
    }

    if (env.email.provider === 'none') {
      res.status(400).json({
        error: 'No email provider configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS and EMAIL_FROM.',
      });
      return;
    }

    // Check the connection and credentials before sending. A refused login and
    // a refused recipient both surface as "send failed" otherwise, and they
    // need completely different fixes.
    if (env.email.provider === 'smtp') {
      const check = await verifyConnection();
      if (!check.ok) {
        res.status(502).json({ error: check.error, provider: providerLabel() });
        return;
      }
    }

    const outcome = await sendMail({
      to: [to],
      subject: 'Business Impact Scoring — test email',
      html: shell(`<p>This is a test from the Business Impact Scoring app.</p>
<p>If you can read this, distribution and reminder email will reach the committee.</p>
<p style="color:#6b645d;font-size:12px">Sent via ${providerLabel()}.</p>`),
    });

    const db = await getDb();
    await audit(db, actorOf(req), 'email.test', 'member', req.member?.id ?? '', { to, status: outcome.status });

    if (outcome.status === 'FAILED') {
      res.status(502).json({ error: `Send failed: ${outcome.error}`, provider: providerLabel() });
      return;
    }
    res.json({ status: outcome.status, provider: providerLabel(), to, error: outcome.error });
  }),
);

const scoringSchema = z.object({
  minSubmissions: z.number().int().min(1).optional(),
  stdDevDiscussionThreshold: z.number().min(0).optional(),
  priorityHigh: z.number().min(0).optional(),
  priorityMedium: z.number().min(0).optional(),
  applyCategoryWeights: z.boolean().optional(),
  closureReasons: z.array(z.string().min(1)).optional(),
  effort: z
    .object({
      mode: z.enum(['BACKEND_PLUS_FRONTEND', 'BACKEND_ONLY', 'FRONTEND_ONLY', 'MANUAL']).optional(),
      backendFieldId: z.string().optional(),
      frontendFieldId: z.string().optional(),
    })
    .optional(),
});

const cadenceMinute = z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(45)]);

const cadenceSchema = z.object({
  distributionDayOfWeek: z.number().int().min(0).max(6).optional(),
  distributionHour: z.number().int().min(0).max(23).optional(),
  distributionMinute: cadenceMinute.optional(),
  cutOffDayOfWeek: z.number().int().min(0).max(6).optional(),
  cutOffHour: z.number().int().min(0).max(23).optional(),
  cutOffMinute: cadenceMinute.optional(),
  reminderMinutesBeforeCutOff: z.array(z.number().min(0)).optional(),
  escalationMinutesBeforeCutOff: z.number().min(0).nullable().optional(),
  timezone: z.string().optional(),
  nextRoundOverride: z
    .object({ opensAt: z.string(), cutOffAt: z.string() })
    .refine((v) => new Date(v.cutOffAt).getTime() > new Date(v.opensAt).getTime(), {
      message: 'Cut-off must be after the opening time',
    })
    .nullable()
    .optional(),
});

const jiraSchema = z.object({
  queueJql: z.string().optional(),
  businessScoreFieldId: z.string().optional(),
  siteAffectedFieldId: z.string().optional(),
  originalTestingEnvironmentFieldId: z.string().optional(),
  ticketPhaseFieldId: z.string().optional(),
  transitionOnFinalise: z.boolean().optional(),
  transitionName: z.string().optional(),
});

const automationSchema = z.object({
  enabled: z.boolean().optional(),
  createRounds: z.boolean().optional(),
  importFromJira: z.boolean().optional(),
  rollOverUnscored: z.boolean().optional(),
  distribute: z.boolean().optional(),
  remind: z.boolean().optional(),
  close: z.boolean().optional(),
  finalise: z.boolean().optional(),
  // Capped rather than unbounded: a delay longer than the weekly cycle would
  // leave rounds stacking up unfinalised with no sign of why.
  finaliseDelayHours: z.number().min(0).max(72).optional(),
  writeBack: z.boolean().optional(),
});

const sectionSchemas = {
  scoring: scoringSchema,
  cadence: cadenceSchema,
  automation: automationSchema,
  jira: jiraSchema,
} as const;

router.put(
  '/config/:section',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const section = req.params.section as keyof typeof sectionSchemas;
    const schema = sectionSchemas[section];
    if (!schema) {
      res.status(404).json({ error: `Unknown config section "${req.params.section}"` });
      return;
    }
    const value = schema.parse(req.body ?? {});
    const db = await getDb();
    const config = await saveConfigSection(db, section, value as never, req.member?.email ?? '');
    await audit(db, actorOf(req), 'config.update', 'config', section, value);
    res.json({ config });
  }),
);

const categorySchema = z.object({
  id: z.string().optional(),
  position: z.number().int().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  zeroLabel: z.string().optional(),
  maxLabel: z.string().optional(),
  weight: z.number().min(0).optional(),
  scaleMin: z.number().int().min(0).optional(),
  scaleMax: z.number().int().min(1).optional(),
  active: z.boolean().optional(),
});

router.post(
  '/categories',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const input = categorySchema.parse(req.body ?? {});
    const db = await getDb();
    const category = await saveCategory(db, input);
    await audit(db, actorOf(req), input.id ? 'category.update' : 'category.create', 'category', category.id, input);
    res.json({ category });
  }),
);

/** Recovery: put the seven default categories back and reactivate them (§6). */
router.post(
  '/categories/restore-defaults',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const categories = await restoreDefaultCategories(db);
    await audit(db, actorOf(req), 'category.restore-defaults', 'category', '', {
      active: categories.filter((c) => c.active).length,
    });
    res.json({ categories });
  }),
);

router.delete(
  '/categories/:id',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    await deactivateCategory(db, req.params.id);
    await audit(db, actorOf(req), 'category.deactivate', 'category', req.params.id, {});
    res.json({ ok: true });
  }),
);

/** §12.1 build action: resolve the real customfield ids from the live site. */
router.get(
  '/jira/fields/suggest',
  requireCoordinator,
  asyncHandler(async (_req, res) => {
    res.json({ suggestions: await suggestFieldIds() });
  }),
);

/**
 * What the workflow will actually accept, read off a real ticket.
 *
 * The transition name has to match JIRA exactly, and nobody can be expected to
 * know whether their workflow calls it "Send to RA" or "[RA] Rdy Estimation",
 * or where the brackets go. Guessing it wrong is silent: the score writes, the
 * move fails, and the ticket sits where it was. So the list comes from JIRA.
 *
 * Transitions depend on the status the ticket is in now, so this asks for one
 * that is in the state the write-back would find it in - by default the first
 * ticket the app knows about.
 */
router.get(
  '/jira/transitions',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const asked = String(req.query.jiraId ?? '').trim();
    const db = await getDb();

    const jiraId =
      asked ||
      (await db.get<{ jira_id: string }>('SELECT jira_id FROM tickets ORDER BY created_at DESC LIMIT 1'))?.jira_id ||
      '';
    if (!jiraId) {
      res.status(400).json({ error: 'No ticket to read the workflow from. Import one first, or give a ticket key.' });
      return;
    }

    res.json({ jiraId, transitions: await listTransitions(jiraId) });
  }),
);

/**
 * Start afresh: delete every round, ticket and score, keeping the committee,
 * the categories and all configuration. Admin only, and the exact phrase has
 * to be typed - there is no undo.
 */
router.post(
  '/admin/reset-data',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const { confirm } = z.object({ confirm: z.string() }).parse(req.body ?? {});
    if (confirm !== 'DELETE ALL ROUNDS') {
      res.status(400).json({ error: 'Type DELETE ALL ROUNDS to confirm' });
      return;
    }
    const db = await getDb();
    const counts = await resetOperationalData(db);
    await audit(db, actorOf(req), 'admin.reset-data', 'system', '', counts);
    res.json({ counts });
  }),
);

/**
 * Delete one round rather than all of them - a test round, or one created
 * twice. Admin only, and that is the whole gate: whoever runs the process
 * knows which round they picked, and the audit log records what went.
 *
 * The tickets survive; only the round and what was recorded against it go.
 */
router.post(
  '/admin/rounds/:id/delete',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const db = await getDb();

    const round = await getRound(db, req.params.id);
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }

    const deleted = await deleteRound(db, round.id);
    await audit(db, actorOf(req), 'admin.round.delete', 'round', round.id, deleted ?? {});
    res.json({ deleted });
  }),
);

export default router;
