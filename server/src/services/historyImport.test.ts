import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultConfig, ensureSeedCategories, getAppConfig, listCategories } from './configService.js';
import { commitHistoryImport, parseTicketKey, previewHistoryImport } from './historyImportService.js';
import { getRound, listRounds, setRoundStatus } from './roundService.js';
import { saveMember } from './memberService.js';
import { runDueAutomation } from './automationService.js';
import { listPendingDiscussions } from './discussionService.js';
import { saveConfigSection } from './configService.js';
import { writeBackRound } from './jiraService.js';

let db: Db;

const HEADER = [
  'Id', 'Start time', 'Completion time', 'Email', 'Name', 'Enter the JIRA ID here', 'Is this Ticket relevant today?',
  'Reason for Closure', 'Info on Closure', 'COMMERCIAL IMPACT', 'OPERATIONAL IMPACT', 'SUPPORT STRAIN', 'CLIENT USER IMPACT',
  'STRATEGIC ALIGNMENT', 'DATA & REPORTING VALUE', 'REPUTATIONAL/BRAND RISK', 'More Info',
];
const YES = 'Yes - It aligns with Business Strategy';

/** A Forms-style export: [completion time, email, name, typed key, answer, marks (7), info]. */
async function workbook(rows: Array<[string, string, string, string, string, number[] | null, string?]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Responses');
  ws.addRow(HEADER);
  rows.forEach(([at, email, name, key, answer, marks, info], i) => {
    const when = new Date(at);
    ws.addRow([i + 1, when, when, email, name, key, answer, '', info ?? '', ...(marks ?? Array(7).fill(null)), '']);
  });
  const backlog = wb.addWorksheet('BAU-Backlog_ALL');
  backlog.addRow(['Key', 'Summary']);
  backlog.addRow(['ECOM-1520', 'Styling fix on the PDP']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const five = (n: number) => Array(7).fill(n);

beforeEach(async () => {
  db = await createDb({ driver: 'sqlite', sqliteFile: ':memory:' });
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);
});

afterEach(async () => {
  await db.close();
});

describe('parseTicketKey', () => {
  it('pulls the project and number out of however it was typed', () => {
    expect(parseTicketKey('Ecom 1520')).toEqual({ prefix: 'ECOM', number: '1520' });
    expect(parseTicketKey('ecom - 1565')).toEqual({ prefix: 'ECOM', number: '1565' });
    expect(parseTicketKey('IDM-10 – Price Updates')).toEqual({ prefix: 'IDM', number: '10' });
    expect(parseTicketKey('1422')).toEqual({ prefix: null, number: '1422' });
    expect(parseTicketKey('wos-1422')).toEqual({ prefix: null, number: '1422' });
    expect(parseTicketKey('n/a')).toBeNull();
  });
});

describe('history import', () => {
  const people = ['a', 'b', 'c', 'd', 'e'].map((x) => [`${x}@example.com`, x.toUpperCase()] as const);

  async function sample(): Promise<Buffer> {
    return workbook([
      // ECOM-1520 goes out the week of 6 Oct 2025; one answer arrives a week late.
      ...people.slice(0, 4).map(([e, n], i) => [`2025-10-0${2 + i}T10:00:00Z`, e, n, 'Ecom 1520', YES, five(2 + i)] as [string, string, string, string, string, number[]]),
      [`2025-10-10T10:00:00Z`, people[4][0], people[4][1], '1520', YES, five(6)],
      // A's second go at the same ticket: the later one wins.
      [`2025-10-05T12:00:00Z`, people[0][0], people[0][1], 'ECOM-1520', YES, five(9)],
      // An archived score, which is kept but never counts.
      [`2025-09-20T10:00:00Z`, people[1][0], people[1][1], 'ECOM-77', YES, five(1), 'Archived Scores'],
      [`2025-10-03T10:00:00Z`, people[2][0], people[2][1], 'ECOM-77', "Unsure - I will skip scoring as I don't understand the request", null],
      [`2025-10-03T10:00:00Z`, people[3][0], people[3][1], 'IDM-10 – Price Updates', YES, five(3)],
    ]);
  }

  it('previews without writing anything', async () => {
    const preview = await previewHistoryImport(db, await sample());
    expect(preview.tickets).toBe(3);
    // 9 rows: one is A's earlier duplicate, one is archived - 7 count.
    expect(preview.responses).toMatchObject({ used: 7, archived: 1, duplicates: 1 });
    expect(preview.guessedKeys).toEqual([{ typed: '1520', key: 'ECOM-1520', rows: 1 }]);
    expect(preview.newMembers.map((m) => m.email).sort()).toEqual(people.map(([e]) => e));
    expect(preview.rounds.map((r) => r.stream).sort()).toEqual(['ECOM', 'IDM']);
    expect(await listRounds(db)).toEqual([]);
  });

  it("imports each ticket into the week it went out, with the sheet's average", async () => {
    const result = await commitHistoryImport(db, await sample(), ['a@example.com']);
    expect(result).toMatchObject({ tickets: 3, membersCreated: 5 });

    const ticket = await db.get<{ id: string; title: string }>("SELECT id, title FROM tickets WHERE jira_id = 'ECOM-1520'");
    expect(ticket?.title).toBe('Styling fix on the PDP');
    const res = await db.get<{ responses_count: number; business_score: number; cut_off_at: string }>(
      `SELECT tr.responses_count, tr.business_score, r.cut_off_at FROM ticket_results tr JOIN rounds r ON r.id = tr.round_id WHERE tr.ticket_id = ?`,
      [ticket!.id],
    );
    // A's later 9s replace their 2s: (9 + 3 + 4 + 5 + 6) × 7 ÷ 5.
    expect(res).toMatchObject({ responses_count: 5, business_score: Math.round(((9 + 3 + 4 + 5 + 6) * 7) / 5) });
    // First answer 2 Oct 2025 -> the Tuesday 17:00 London cut-off after it.
    expect(res?.cut_off_at).toBe('2025-10-07T16:00:00.000Z');

    const active = await db.all<{ email: string; active: number }>('SELECT email, active FROM members ORDER BY email');
    expect(active.find((m) => m.email === 'a@example.com')?.active).toBe(1);
    expect(active.find((m) => m.email === 'b@example.com')?.active).toBe(0);
  });

  it('leaves existing members exactly as they are', async () => {
    await saveMember(db, { name: 'Alice Admin', email: 'A@example.com', team: 'Ops', role: 'ADMIN' });
    const result = await commitHistoryImport(db, await sample(), []);
    expect(result.membersCreated).toBe(4);
    const alice = await db.get<{ name: string; role: string }>("SELECT name, role FROM members WHERE LOWER(email) = 'a@example.com'");
    expect(alice).toEqual({ name: 'Alice Admin', role: 'ADMIN' });
  });

  it('replaces a previous import rather than doubling it, and leaves real rounds alone', async () => {
    await commitHistoryImport(db, await sample(), []);
    const first = (await listRounds(db)).length;
    const again = await commitHistoryImport(db, await sample(), []);
    expect(again.replacedRounds).toBe(first);
    expect((await listRounds(db)).length).toBe(first);
    const subs = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM submissions');
    expect(Number(subs?.n)).toBe(again.submissions);
  });

  it('is fenced off from everything that acts on a finalised round', async () => {
    // A split ticket (0s against 10s), so it would need a discussion if it were live.
    const split = await workbook(
      people.map(([e, n], i) => [`2025-10-0${2 + i}T10:00:00Z`, e, n, 'ECOM-5', YES, five(i % 2 ? 10 : 0)] as [string, string, string, string, string, number[]]),
    );
    await commitHistoryImport(db, split, people.map(([e]) => e));
    const [round] = await listRounds(db);
    expect(round).toMatchObject({ status: 'FINALISED', imported: true, automationPaused: true });

    expect(await listPendingDiscussions(db)).toEqual([]);
    await expect(setRoundStatus(db, round.id, 'CLOSED')).rejects.toThrow(/imported/);
    await expect(writeBackRound(db, { email: 't@x' }, round)).rejects.toThrow(/never written to JIRA/);

    await saveConfigSection(db, 'automation', { enabled: true, createRounds: false }, 'test');
    const run = await runDueAutomation(db);
    expect(run.steps.filter((s) => s.roundId === round.id)).toEqual([]);
    expect((await getRound(db, round.id))?.status).toBe('FINALISED');
  });

  it('refuses a workbook without a responses sheet', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary').addRow(['nothing here']);
    await expect(previewHistoryImport(db, Buffer.from(await wb.xlsx.writeBuffer()))).rejects.toThrow(/Responses/);
  });

  it('uses the category names in Settings to find the score columns', async () => {
    const preview = await previewHistoryImport(db, await sample());
    expect(preview.categoryColumns).toHaveLength((await listCategories(db)).length);
    expect((await getAppConfig(db)).scoring.minSubmissions).toBe(5);
  });
});
