import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requireCoordinator } from '../auth/middleware.js';
import { audit } from '../services/auditService.js';
import { deactivateCategory, getAppConfig, listCategories, saveCategory, saveConfigSection } from '../services/configService.js';
import { RELEVANCE_LABELS, RELEVANCE_VALUES } from '../domain/types.js';
import { suggestFieldIds } from '../integrations/jira.js';
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
        graphSendEnabled: env.graph.sendEnabled,
        authMode: env.auth.mode,
      },
    });
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

const cadenceSchema = z.object({
  distributionDayOfWeek: z.number().int().min(0).max(6).optional(),
  distributionHour: z.number().int().min(0).max(23).optional(),
  cutOffDayOfWeek: z.number().int().min(0).max(6).optional(),
  cutOffHour: z.number().int().min(0).max(23).optional(),
  reminderHoursBeforeCutOff: z.array(z.number().min(0)).optional(),
  escalationHoursBeforeCutOff: z.number().min(0).nullable().optional(),
  timezone: z.string().optional(),
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

const packSchema = z.object({
  organisation: z.string().optional(),
  deckTitle: z.string().optional(),
  closingMessage: z.string().optional(),
  accentColour: z.string().optional(),
});

const sectionSchemas = { scoring: scoringSchema, cadence: cadenceSchema, jira: jiraSchema, pack: packSchema } as const;

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

export default router;
