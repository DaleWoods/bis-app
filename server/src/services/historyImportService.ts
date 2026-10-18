import ExcelJS from 'exceljs';
import type { Db } from '../db/index.js';
import { RELEVANCE_VALUES, type Relevance } from '../domain/types.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/time.js';
import { getAppConfig, listCategories } from './configService.js';
import { nextOccurrence, timezoneOffsetMinutes } from './automationService.js';
import { listMembers, saveMember } from './memberService.js';
import { addTicketToRound, createRound, getRound, HttpishError } from './roundService.js';
import { deleteRound } from './adminService.js';
import { getTicketByJiraId, upsertTicket } from './ticketService.js';
import { snapshotRoundResults } from './resultService.js';

/**
 * Bringing the manual process's history into the app.
 *
 * The source is the Microsoft Forms export the manual process collected in
 * its scoring workbook - the "Responses" sheet, one row per person per
 * ticket. Every one of those tickets was already decided and written to JIRA
 * by hand, so what is created here is history and nothing else: rounds
 * flagged `imported`, which Trends, the league table and streaks read, and
 * which nothing that acts - automation, write-back, roll-over, discussion
 * alerts - will touch.
 *
 * Two things the spreadsheet never recorded have to be inferred:
 *
 * - **Which round a ticket was in.** The manual process had no rounds, only
 *   weeks: a ticket went out in a deck, and responses trickled in, some of
 *   them weeks later. Each ticket is put in the week of its first real
 *   response - the week it went out - with all its responses, so its average
 *   comes out the same as the spreadsheet's rather than split across weeks.
 * - **A clean ticket key.** People typed "Ecom 1520", "ecom - 1565", or just
 *   "1422". The prefix and the number are pulled out; a bare number takes the
 *   prefix it was typed with elsewhere in the file, or ECOM, and every guess is
 *   shown before anything is imported.
 */

const RELEVANCE_BY_TEXT: Array<[RegExp, Relevance]> = [
  [/^yes/i, 'YES'],
  [/^unsure/i, 'UNSURE'],
  [/can be closed/i, 'NO_CLOSE'],
  [/^no/i, 'NO_NOT_RELEVANT_TODAY'],
];

interface RawResponse {
  row: number;
  startedAt: Date | null;
  completedAt: Date;
  email: string;
  name: string;
  rawKey: string;
  relevanceText: string;
  closureReason: string;
  closureInfo: string;
  moreInfo: string;
  scores: Record<string, number>;
}

export interface ImportPreview {
  responses: { total: number; used: number; archived: number; duplicates: number; skipped: Array<{ row: number; reason: string }> };
  rounds: Array<{ label: string; stream: string; cutOffAt: string; tickets: number; responses: number }>;
  tickets: number;
  /** Keys that had to be guessed from what was typed, so they can be checked. */
  guessedKeys: Array<{ typed: string; key: string; rows: number }>;
  existingMembers: Array<{ name: string; email: string; role: string }>;
  newMembers: Array<{ name: string; email: string; lastResponse: string; suggestedActive: boolean }>;
  categoryColumns: Array<{ column: string; category: string }>;
  /** Imported rounds already in the app - committing replaces them. */
  previouslyImportedRounds: number;
  from: string;
  to: string;
}

interface Plan {
  preview: ImportPreview;
  rounds: Array<{
    label: string;
    stream: 'ECOM' | 'IDM';
    cutOffAt: Date;
    tickets: Array<{ key: string; title: string; responses: Array<RawResponse & { relevance: Relevance; archived: boolean }> }>;
  }>;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
  }
  return String(v).trim();
}

function cellDate(v: ExcelJS.CellValue): Date | null {
  if (v instanceof Date) return v;
  const text = cellText(v);
  if (!text) return null;
  const d = new Date(text.includes('T') || text.includes('Z') ? text : text.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "Ecom 1520", "ecom - 1565", "IDM-10 – Price Updates" -> prefix + number; a bare "1422" -> number only. */
export function parseTicketKey(typed: string): { prefix: string | null; number: string } | null {
  const m = typed.trim().match(/^\s*([A-Z]+)?\s*[-–]?\s*(\d+)/i);
  if (!m) return null;
  const prefix = m[1]?.toUpperCase() ?? null;
  // A prefix that is not a project ("wos-1422") is a typo: treat the number as
  // bare, so it is resolved the same way and shown as a guess.
  return { prefix: prefix && KNOWN_PREFIXES.includes(prefix) ? prefix : null, number: String(Number(m[2])) };
}

const KNOWN_PREFIXES = ['ECOM', 'WOSG', 'IDM'];

export async function readWorkbook(
  buffer: Buffer,
  categories: Array<{ id: string; name: string }>,
): Promise<{
  rows: RawResponse[];
  titles: Map<string, string>;
  categoryColumns: Array<{ column: string; category: string }>;
  skipped: Array<{ row: number; reason: string }>;
}> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new HttpishError(400, 'That file could not be read as an Excel workbook (.xlsx).');
  }

  // The Forms export: whichever sheet has a "JIRA ID" question in its header.
  const sheet =
    wb.getWorksheet('Responses') ??
    wb.worksheets.find((ws) => (ws.getRow(1).values as ExcelJS.CellValue[]).some((v) => /jira id/i.test(cellText(v))));
  if (!sheet) throw new HttpishError(400, 'No "Responses" sheet in that workbook - it needs the Forms responses tab.');

  const header = new Map<number, string>();
  sheet.getRow(1).eachCell((cell, col) => header.set(col, cellText(cell.value)));
  const find = (re: RegExp) => [...header.entries()].find(([, h]) => re.test(h))?.[0];
  const cols = {
    start: find(/^start time/i),
    done: find(/^completion time/i),
    email: find(/^email/i),
    name: find(/^name$/i),
    key: find(/jira id/i),
    relevance: find(/relevant/i),
    closureReason: find(/reason for closure/i),
    closureInfo: find(/info on closure/i),
    moreInfo: find(/^more info/i),
  };
  const missing = Object.entries({ 'Completion time': cols.done, Email: cols.email, 'JIRA ID': cols.key, 'relevant today': cols.relevance })
    .filter(([, c]) => !c)
    .map(([n]) => n);
  if (missing.length) throw new HttpishError(400, `The Responses sheet is missing: ${missing.join(', ')}.`);

  // Category columns are matched to the app's categories by name, ignoring
  // case and punctuation - "REPUTATIONAL/BRAND RISK" is "Reputational / Brand Risk".
  const categoryCols: Array<{ col: number; categoryId: string; column: string; category: string }> = [];
  for (const c of categories) {
    const col = [...header.entries()].find(([, h]) => squash(h) === squash(c.name))?.[0];
    if (col) categoryCols.push({ col, categoryId: c.id, column: header.get(col)!, category: c.name });
  }
  if (!categoryCols.length) {
    throw new HttpishError(400, "None of the sheet's columns match a category name in Settings, so there are no scores to import.");
  }

  const rows: RawResponse[] = [];
  const skipped: Array<{ row: number; reason: string }> = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const v = (c: number | undefined) => (c ? row.getCell(c).value : null);
    const email = cellText(v(cols.email)).toLowerCase();
    const rawKey = cellText(v(cols.key));
    const completedAt = cellDate(v(cols.done));
    if (!email && !rawKey) return; // a blank line, not a response
    if (!email) return void skipped.push({ row: n, reason: 'No email address' });
    if (!completedAt) return void skipped.push({ row: n, reason: 'No completion time' });
    if (!rawKey) return void skipped.push({ row: n, reason: 'No JIRA ID' });
    const scores: Record<string, number> = {};
    for (const c of categoryCols) {
      const text = cellText(v(c.col));
      if (text !== '' && Number.isFinite(Number(text))) scores[c.categoryId] = Number(text);
    }
    rows.push({
      row: n,
      startedAt: cellDate(v(cols.start)),
      completedAt,
      email,
      name: cellText(v(cols.name)) || email,
      rawKey,
      relevanceText: cellText(v(cols.relevance)),
      closureReason: cellText(v(cols.closureReason)),
      closureInfo: cellText(v(cols.closureInfo)),
      moreInfo: cellText(v(cols.moreInfo)),
      scores,
    });
  });

  // Titles, where the workbook carries the backlog export alongside.
  const titles = new Map<string, string>();
  const backlog = wb.worksheets.find((ws) => /backlog/i.test(ws.name));
  if (backlog) {
    const h = new Map<string, number>();
    backlog.getRow(1).eachCell((cell, col) => h.set(cellText(cell.value).toLowerCase(), col));
    const k = h.get('key');
    const s = h.get('summary');
    if (k && s) {
      backlog.eachRow((row, n) => {
        if (n === 1) return;
        const key = cellText(row.getCell(k).value).toUpperCase();
        const title = cellText(row.getCell(s).value);
        if (key && title) titles.set(key, title);
      });
    }
  }

  return { rows, titles, categoryColumns: categoryCols.map(({ column, category }) => ({ column, category })), skipped };
}

async function buildPlan(db: Db, buffer: Buffer): Promise<Plan> {
  const config = await getAppConfig(db);
  const categories = await listCategories(db);
  const { rows, titles, categoryColumns, skipped } = await readWorkbook(buffer, categories);

  // A bare number takes the prefix it was typed with elsewhere in the file.
  const prefixesByNumber = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = parseTicketKey(r.rawKey);
    if (k?.prefix) {
      if (!prefixesByNumber.has(k.number)) prefixesByNumber.set(k.number, new Set());
      prefixesByNumber.get(k.number)!.add(k.prefix);
    }
  }
  const guessed = new Map<string, { key: string; rows: number }>();
  type Resolved = RawResponse & { key: string; relevance: Relevance; archived: boolean };
  const resolved: Resolved[] = [];
  for (const r of rows) {
    const k = parseTicketKey(r.rawKey);
    if (!k) {
      skipped.push({ row: r.row, reason: `"${r.rawKey}" is not a ticket key` });
      continue;
    }
    let prefix = k.prefix;
    if (!prefix) {
      const seen = prefixesByNumber.get(k.number);
      prefix = seen && seen.size === 1 ? [...seen][0] : 'ECOM';
    }
    const key = `${prefix}-${k.number}`;
    // Only a missing (or mistyped) project is a guess; "Ecom 1520" is just untidy.
    if (!k.prefix) {
      const g = guessed.get(r.rawKey) ?? { key, rows: 0 };
      g.rows += 1;
      guessed.set(r.rawKey, g);
    }
    const relevance = RELEVANCE_BY_TEXT.find(([re]) => re.test(r.relevanceText))?.[1];
    if (!relevance || !RELEVANCE_VALUES.includes(relevance)) {
      skipped.push({ row: r.row, reason: `Unrecognised answer "${r.relevanceText}"` });
      continue;
    }
    if (relevance === 'YES' && !Object.keys(r.scores).length) {
      skipped.push({ row: r.row, reason: 'Answered "Yes" but has no scores' });
      continue;
    }
    // The manual sheet's own way of retiring an old score.
    const archived = /archived/i.test(r.closureInfo);
    resolved.push({ ...r, key, relevance, archived });
  }

  // One answer per person per ticket: a live one beats an archived one, and
  // otherwise the latest wins - the same "latest response" rule the sheet used.
  const byPair = new Map<string, Resolved>();
  let duplicates = 0;
  for (const r of resolved) {
    const pair = `${r.key}|${r.email}`;
    const prev = byPair.get(pair);
    if (!prev) {
      byPair.set(pair, r);
      continue;
    }
    duplicates += 1;
    const better =
      prev.archived !== r.archived ? (prev.archived ? r : prev) : r.completedAt > prev.completedAt ? r : prev;
    byPair.set(pair, better);
  }
  const kept = [...byPair.values()];

  // Each ticket in the week of its first live response.
  const byTicket = new Map<string, Resolved[]>();
  for (const r of kept) {
    if (!byTicket.has(r.key)) byTicket.set(r.key, []);
    byTicket.get(r.key)!.push(r);
  }
  const { cutOffDayOfWeek, cutOffHour, cutOffMinute, timezone } = config.cadence;
  const roundsByKey = new Map<string, Plan['rounds'][number]>();
  for (const [key, responses] of byTicket) {
    const live = responses.filter((r) => !r.archived);
    const first = (live.length ? live : responses).reduce((a, b) => (a.completedAt < b.completedAt ? a : b)).completedAt;
    const cutOffAt = nextOccurrence(
      new Date(first.getTime() - 1),
      cutOffDayOfWeek,
      cutOffHour,
      cutOffMinute,
      timezoneOffsetMinutes(timezone, first),
    );
    const stream = key.startsWith('IDM-') ? 'IDM' : 'ECOM';
    const id = `${stream}|${cutOffAt.toISOString()}`;
    if (!roundsByKey.has(id)) {
      const day = cutOffAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: timezone });
      roundsByKey.set(id, { label: `Imported${stream === 'IDM' ? ' IDM' : ''} · closed ${day}`, stream, cutOffAt, tickets: [] });
    }
    roundsByKey.get(id)!.tickets.push({ key, title: titles.get(key) ?? '', responses });
  }
  const rounds = [...roundsByKey.values()].sort((a, b) => a.cutOffAt.getTime() - b.cutOffAt.getTime());

  // People: existing members are matched by email and left exactly as they are.
  const members = await listMembers(db, true);
  const known = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  const latest = kept.reduce((d, r) => (r.completedAt > d ? r.completedAt : d), new Date(0));
  const people = new Map<string, { name: string; email: string; last: Date }>();
  for (const r of kept) {
    const p = people.get(r.email);
    if (!p || r.completedAt > p.last) people.set(r.email, { name: r.name, email: r.email, last: r.completedAt });
  }
  const eightWeeks = 8 * 7 * 86_400_000;
  const existingMembers = [...people.values()]
    .filter((p) => known.has(p.email))
    .map((p) => ({ name: known.get(p.email)!.name, email: p.email, role: known.get(p.email)!.role }));
  const newMembers = [...people.values()]
    .filter((p) => !known.has(p.email))
    .map((p) => ({
      name: p.name,
      email: p.email,
      lastResponse: p.last.toISOString(),
      // Still scoring recently: probably still on the committee.
      suggestedActive: latest.getTime() - p.last.getTime() <= eightWeeks,
    }))
    .sort((a, b) => b.lastResponse.localeCompare(a.lastResponse));

  const previous = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM rounds WHERE imported = 1');
  const all = kept.map((r) => r.completedAt.getTime());

  return {
    rounds,
    preview: {
      responses: {
        total: rows.length + skipped.filter((s) => !rows.some((r) => r.row === s.row)).length,
        used: kept.filter((r) => !r.archived).length,
        archived: kept.filter((r) => r.archived).length,
        duplicates,
        skipped: skipped.sort((a, b) => a.row - b.row),
      },
      rounds: rounds.map((r) => ({
        label: r.label,
        stream: r.stream,
        cutOffAt: r.cutOffAt.toISOString(),
        tickets: r.tickets.length,
        responses: r.tickets.reduce((n, t) => n + t.responses.length, 0),
      })),
      tickets: byTicket.size,
      guessedKeys: [...guessed.entries()].map(([typed, g]) => ({ typed, key: g.key, rows: g.rows })).sort((a, b) => b.rows - a.rows),
      existingMembers,
      newMembers,
      categoryColumns,
      previouslyImportedRounds: Number(previous?.n ?? 0),
      from: all.length ? new Date(Math.min(...all)).toISOString() : '',
      to: all.length ? new Date(Math.max(...all)).toISOString() : '',
    },
  };
}

export async function previewHistoryImport(db: Db, buffer: Buffer): Promise<ImportPreview> {
  return (await buildPlan(db, buffer)).preview;
}

export interface ImportResult {
  rounds: number;
  tickets: number;
  submissions: number;
  membersCreated: number;
  replacedRounds: number;
}

/**
 * Write the plan. Previously imported rounds are replaced, not added to, so
 * importing an updated copy of the spreadsheet later is safe. Rounds run in
 * the app itself are never touched.
 */
export async function commitHistoryImport(db: Db, buffer: Buffer, activeEmails: string[]): Promise<ImportResult> {
  const plan = await buildPlan(db, buffer);
  const active = new Set(activeEmails.map((e) => e.toLowerCase()));
  const categories = await listCategories(db);
  const categoryIds = new Set(categories.map((c) => c.id));

  return db.tx(async (tx) => {
    const previous = await tx.all<{ id: string }>('SELECT id FROM rounds WHERE imported = 1');
    for (const r of previous) await deleteRound(tx, r.id);
    const replacedRounds = previous.length;

    const members = new Map((await listMembers(tx, true)).map((m) => [m.email.toLowerCase(), m]));
    let membersCreated = 0;
    for (const p of plan.preview.newMembers) {
      const m = await saveMember(tx, { name: p.name, email: p.email, role: 'COMMITTEE', active: active.has(p.email) });
      members.set(p.email, m);
      membersCreated += 1;
    }

    let submissions = 0;
    const ticketIds = new Set<string>();
    for (const r of plan.rounds) {
      const created = await createRound(tx, { weekLabel: r.label, cutOffAt: r.cutOffAt.toISOString(), stream: r.stream, createdBy: 'import' });
      for (const t of r.tickets) {
        const ticket =
          (await getTicketByJiraId(tx, t.key)) ??
          (await upsertTicket(tx, { jiraId: t.key, title: t.title || t.key, stream: r.stream }));
        ticketIds.add(ticket.id);
        await addTicketToRound(tx, created.id, ticket.id);
        for (const resp of t.responses) {
          const member = members.get(resp.email);
          if (!member) continue;
          const id = newId();
          const completed = resp.completedAt.toISOString();
          await tx.run(
            `INSERT INTO submissions (id, round_id, ticket_id, member_id, relevance, closure_reason, closure_info, more_info, archived, submitted_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              created.id,
              ticket.id,
              member.id,
              resp.relevance,
              resp.relevance === 'NO_CLOSE' ? resp.closureReason : '',
              resp.archived ? '' : resp.closureInfo,
              resp.moreInfo,
              resp.archived ? 1 : 0,
              (resp.startedAt ?? resp.completedAt).toISOString(),
              completed,
            ],
          );
          if (resp.relevance === 'YES') {
            for (const [categoryId, score] of Object.entries(resp.scores)) {
              if (!categoryIds.has(categoryId)) continue;
              await tx.run('INSERT INTO submission_scores (submission_id, category_id, score) VALUES (?, ?, ?)', [
                id,
                categoryId,
                Math.round(score),
              ]);
            }
          }
          submissions += 1;
        }
      }
      // Straight to finalised, and fenced off: paused for automation and
      // flagged imported, so nothing that acts on a finalised round acts on this.
      const at = r.cutOffAt.toISOString();
      await tx.run(
        `UPDATE rounds SET status = 'FINALISED', imported = 1, automation_paused = 1,
           opened_at = ?, closed_at = ?, finalised_at = ?, updated_at = ? WHERE id = ?`,
        [at, at, at, nowIso(), created.id],
      );
      await snapshotRoundResults(tx, (await getRound(tx, created.id))!);
    }

    return { rounds: plan.rounds.length, tickets: ticketIds.size, submissions, membersCreated, replacedRounds };
  });
}
