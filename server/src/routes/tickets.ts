import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireCoordinator } from '../auth/middleware.js';
import { STREAMS } from '../domain/types.js';
import { audit } from '../services/auditService.js';
import { importQueue, refreshTicketFromJira } from '../services/jiraService.js';
import { addTicketToRound, getRound } from '../services/roundService.js';
import { deleteTicket, getTicket, listTickets, upsertTicket } from '../services/ticketService.js';
import { getAppConfig } from '../services/configService.js';
import { parseCsvObjects } from '../util/csv.js';
import { actorOf, asyncHandler } from './helpers.js';

const router = Router();

router.get(
  '/tickets',
  requireCoordinator,
  asyncHandler(async (_req, res) => {
    const db = await getDb();
    res.json({ tickets: await listTickets(db) });
  }),
);

const ticketSchema = z.object({
  jiraId: z.string().min(1),
  title: z.string().min(1),
  type: z.string().optional(),
  jiraStatus: z.string().optional(),
  createdDate: z.string().nullable().optional(),
  stakeholder: z.string().optional(),
  affects: z.string().optional(),
  impacts: z.string().optional(),
  workaround: z.string().optional(),
  siteAffected: z.string().optional(),
  originalTestingEnvironment: z.string().optional(),
  rawDescription: z.string().optional(),
  execSummary: z.string().optional(),
  panelCurrent: z.string().optional(),
  panelImpacts: z.string().optional(),
  panelFuture: z.string().optional(),
  panelBenefits: z.string().optional(),
  screenshotUrl: z.string().optional(),
  originalRequestor: z.string().optional(),
  stream: z.enum(STREAMS).optional(),
  backendPokerScore: z.number().nullable().optional(),
  frontendPokerScore: z.number().nullable().optional(),
  manualEffort: z.number().nullable().optional(),
  roundId: z.string().optional(),
});

/** Manual create/edit - also the coordinator's ticket-card authoring surface (§7). */
router.post(
  '/tickets',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const { roundId, ...input } = ticketSchema.parse(req.body ?? {});
    const db = await getDb();
    const ticket = await upsertTicket(db, input);
    if (roundId) await addTicketToRound(db, roundId, ticket.id);
    await audit(db, actorOf(req), 'ticket.save', 'ticket', ticket.id, { jiraId: ticket.jiraId, roundId: roundId ?? null });
    res.json({ ticket });
  }),
);

router.delete(
  '/tickets/:id',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    await deleteTicket(db, req.params.id);
    await audit(db, actorOf(req), 'ticket.delete', 'ticket', req.params.id, {});
    res.json({ ok: true });
  }),
);

/** Pull the latest RA poker effort / status for one ticket (§10.4). */
router.post(
  '/tickets/:id/refresh',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const ticket = await getTicket(db, req.params.id);
    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }
    const config = await getAppConfig(db);
    const refreshed = await refreshTicketFromJira(db, ticket, config);
    await audit(db, actorOf(req), 'ticket.refresh', 'ticket', ticket.id, { jiraId: ticket.jiraId });
    res.json({ ticket: refreshed });
  }),
);

/** CSV fallback for adding tickets when JIRA is not wired up yet (§16). */
router.post(
  '/tickets/import/csv',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const { csv, roundId } = z.object({ csv: z.string().min(1), roundId: z.string().optional() }).parse(req.body ?? {});
    const db = await getDb();
    const rows = parseCsvObjects(csv);

    const imported = [];
    const skipped: string[] = [];
    for (const row of rows) {
      const jiraId = row.jira_id || row.jira || row.key || row.id;
      const title = row.title || row.summary;
      if (!jiraId || !title) {
        skipped.push(JSON.stringify(row).slice(0, 120));
        continue;
      }
      const ticket = await upsertTicket(db, {
        jiraId,
        title,
        type: row.type || row.issue_type || '',
        jiraStatus: row.status || row.jira_status || '',
        createdDate: row.created || row.created_date || null,
        stakeholder: row.stakeholder || row.reporter || '',
        affects: row.affects || '',
        impacts: row.impacts || '',
        workaround: row.workaround || '',
        siteAffected: row.site_affected || '',
        originalTestingEnvironment: row.original_testing_environment || '',
        execSummary: row.executive_summary || row.exec_summary || '',
        panelCurrent: row.current || row.panel_current || '',
        panelImpacts: row.panel_impacts || '',
        panelFuture: row.future || row.panel_future || '',
        panelBenefits: row.benefits || row.panel_benefits || '',
        originalRequestor: (row.original_requestor || row.requestor_email || '').toLowerCase(),
        stream: (row.stream || 'ECOM').toUpperCase() === 'IDM' ? 'IDM' : 'ECOM',
        backendPokerScore: row.backend_poker_score ? Number(row.backend_poker_score) : null,
        frontendPokerScore: row.frontend_poker_score ? Number(row.frontend_poker_score) : null,
        manualEffort: row.effort || row.ra_effort ? Number(row.effort || row.ra_effort) : null,
      });
      if (roundId) await addTicketToRound(db, roundId, ticket.id);
      imported.push(ticket);
    }

    await audit(db, actorOf(req), 'ticket.import.csv', 'round', roundId ?? '', {
      imported: imported.length,
      skipped: skipped.length,
    });
    res.json({ imported, skipped });
  }),
);

/** Read the Business Scoring queue straight from JIRA (§12.1). */
router.post(
  '/tickets/import/jira',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const { jql, roundId, maxResults } = z
      .object({ jql: z.string().optional(), roundId: z.string().optional(), maxResults: z.number().int().optional() })
      .parse(req.body ?? {});
    const db = await getDb();
    if (roundId && !(await getRound(db, roundId))) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }
    const result = await importQueue(db, actorOf(req), { jql, roundId, maxResults });
    res.json(result);
  }),
);

export default router;
