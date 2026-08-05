import { Db } from '../db/index.js';
import { Stream } from '../domain/types.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/time.js';

export interface Ticket {
  id: string;
  jiraId: string;
  title: string;
  type: string;
  jiraStatus: string;
  createdDate: string | null;
  stakeholder: string;
  affects: string;
  impacts: string;
  workaround: string;
  siteAffected: string;
  originalTestingEnvironment: string;
  rawDescription: string;
  execSummary: string;
  panelCurrent: string;
  panelImpacts: string;
  panelFuture: string;
  panelBenefits: string;
  screenshotUrl: string;
  originalRequestor: string;
  stream: Stream;
  backendPokerScore: number | null;
  frontendPokerScore: number | null;
  manualEffort: number | null;
  jiraSyncedAt: string | null;
}

interface TicketRow {
  id: string;
  jira_id: string;
  title: string;
  type: string;
  jira_status: string;
  created_date: string | null;
  stakeholder: string;
  affects: string;
  impacts: string;
  workaround: string;
  site_affected: string;
  original_testing_environment: string;
  raw_description: string;
  exec_summary: string;
  panel_current: string;
  panel_impacts: string;
  panel_future: string;
  panel_benefits: string;
  screenshot_url: string;
  original_requestor: string;
  stream: string;
  backend_poker_score: number | null;
  frontend_poker_score: number | null;
  manual_effort: number | null;
  jira_synced_at: string | null;
}

export function mapTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    jiraId: row.jira_id,
    title: row.title,
    type: row.type,
    jiraStatus: row.jira_status,
    createdDate: row.created_date,
    stakeholder: row.stakeholder,
    affects: row.affects,
    impacts: row.impacts,
    workaround: row.workaround,
    siteAffected: row.site_affected,
    originalTestingEnvironment: row.original_testing_environment,
    rawDescription: row.raw_description,
    execSummary: row.exec_summary,
    panelCurrent: row.panel_current,
    panelImpacts: row.panel_impacts,
    panelFuture: row.panel_future,
    panelBenefits: row.panel_benefits,
    screenshotUrl: row.screenshot_url,
    originalRequestor: row.original_requestor,
    stream: (row.stream as Stream) ?? 'ECOM',
    backendPokerScore: numeric(row.backend_poker_score),
    frontendPokerScore: numeric(row.frontend_poker_score),
    manualEffort: numeric(row.manual_effort),
    jiraSyncedAt: row.jira_synced_at,
  };
}

function numeric(value: number | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export type TicketInput = Partial<Omit<Ticket, 'id'>> & { jiraId: string; title: string };

type TicketTextField = keyof Omit<
  Ticket,
  'id' | 'jiraId' | 'createdDate' | 'backendPokerScore' | 'frontendPokerScore' | 'manualEffort' | 'jiraSyncedAt'
>;

const TEXT_FIELDS: Array<[TicketTextField, string]> = [
  ['title', 'title'],
  ['type', 'type'],
  ['jiraStatus', 'jira_status'],
  ['stakeholder', 'stakeholder'],
  ['affects', 'affects'],
  ['impacts', 'impacts'],
  ['workaround', 'workaround'],
  ['siteAffected', 'site_affected'],
  ['originalTestingEnvironment', 'original_testing_environment'],
  ['rawDescription', 'raw_description'],
  ['execSummary', 'exec_summary'],
  ['panelCurrent', 'panel_current'],
  ['panelImpacts', 'panel_impacts'],
  ['panelFuture', 'panel_future'],
  ['panelBenefits', 'panel_benefits'],
  ['screenshotUrl', 'screenshot_url'],
  ['originalRequestor', 'original_requestor'],
  ['stream', 'stream'],
];

export async function listTickets(db: Db): Promise<Ticket[]> {
  const rows = await db.all<TicketRow>('SELECT * FROM tickets ORDER BY created_at DESC');
  return rows.map(mapTicket);
}

export async function getTicket(db: Db, id: string): Promise<Ticket | undefined> {
  const row = await db.get<TicketRow>('SELECT * FROM tickets WHERE id = ?', [id]);
  return row ? mapTicket(row) : undefined;
}

export async function getTicketByJiraId(db: Db, jiraId: string): Promise<Ticket | undefined> {
  const row = await db.get<TicketRow>('SELECT * FROM tickets WHERE UPPER(jira_id) = UPPER(?)', [jiraId]);
  return row ? mapTicket(row) : undefined;
}

/**
 * Create or update by JIRA id. Used by manual entry, CSV import and the JIRA
 * sync alike, so a re-import never duplicates a ticket and never silently
 * discards the coordinator's authored card content.
 */
export async function upsertTicket(db: Db, input: TicketInput, options: { preserveAuthored?: boolean } = {}): Promise<Ticket> {
  const now = nowIso();
  const existing = await getTicketByJiraId(db, input.jiraId);

  if (!existing) {
    const id = newId();
    await db.run(
      `INSERT INTO tickets (
        id, jira_id, title, type, jira_status, created_date, stakeholder, affects, impacts, workaround,
        site_affected, original_testing_environment, raw_description, exec_summary, panel_current, panel_impacts,
        panel_future, panel_benefits, screenshot_url, original_requestor, stream, backend_poker_score,
        frontend_poker_score, manual_effort, jira_synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.jiraId.toUpperCase(),
        input.title,
        input.type ?? '',
        input.jiraStatus ?? '',
        input.createdDate ?? null,
        input.stakeholder ?? '',
        input.affects ?? '',
        input.impacts ?? '',
        input.workaround ?? '',
        input.siteAffected ?? '',
        input.originalTestingEnvironment ?? '',
        input.rawDescription ?? '',
        input.execSummary ?? '',
        input.panelCurrent ?? '',
        input.panelImpacts ?? '',
        input.panelFuture ?? '',
        input.panelBenefits ?? '',
        input.screenshotUrl ?? '',
        input.originalRequestor ?? '',
        input.stream ?? 'ECOM',
        input.backendPokerScore ?? null,
        input.frontendPokerScore ?? null,
        input.manualEffort ?? null,
        input.jiraSyncedAt ?? null,
        now,
        now,
      ],
    );
    return (await getTicket(db, id)) as Ticket;
  }

  // Coordinator-authored pack content (§7) is never overwritten by a JIRA re-sync.
  const authored = new Set(['execSummary', 'panelCurrent', 'panelImpacts', 'panelFuture', 'panelBenefits', 'screenshotUrl']);
  const sets: string[] = [];
  const params: Array<string | number | null> = [];

  for (const [key, column] of TEXT_FIELDS) {
    const value = input[key];
    if (value === undefined) continue;
    if (options.preserveAuthored && authored.has(key as string) && (existing[key] as string)) continue;
    sets.push(`${column} = ?`);
    params.push(String(value));
  }
  for (const [key, column] of [
    ['createdDate', 'created_date'],
    ['jiraSyncedAt', 'jira_synced_at'],
  ] as const) {
    if (input[key] === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(input[key] as string | null);
  }
  for (const [key, column] of [
    ['backendPokerScore', 'backend_poker_score'],
    ['frontendPokerScore', 'frontend_poker_score'],
    ['manualEffort', 'manual_effort'],
  ] as const) {
    if (input[key] === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(input[key] as number | null);
  }

  if (sets.length) {
    sets.push('updated_at = ?');
    params.push(now, existing.id);
    await db.run(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  return (await getTicket(db, existing.id)) as Ticket;
}

export async function deleteTicket(db: Db, id: string): Promise<void> {
  await db.run('DELETE FROM tickets WHERE id = ?', [id]);
}
