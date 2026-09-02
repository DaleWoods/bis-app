import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';

/**
 * The independent second copy of the data (docs/plans/PLAN-1-data-durability.md).
 * These tests hold the two things that matter: only admins ever receive it,
 * and a failure - anywhere - never throws into the caller.
 */

const sendMail = vi.fn();

vi.mock('../integrations/mail.js', () => ({
  sendMail,
}));

const { ensureDefaultConfig, ensureSeedCategories } = await import('./configService.js');
const { saveMember } = await import('./memberService.js');
const { listAudit } = await import('./auditService.js');
const { buildBackupExport, runBackupAndEmail, backupDueToday } = await import('./backupService.js');

let db: Db;
const ACTOR = { id: 'test', email: 'test@example.com' };

beforeEach(async () => {
  db = await createDb({ driver: 'sqlite', sqliteFile: ':memory:' });
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);
  sendMail.mockReset();
  sendMail.mockResolvedValue({ status: 'SENT' });
});

afterEach(async () => {
  await db.close();
});

describe('buildBackupExport', () => {
  it('returns every table, even when empty', async () => {
    const data = await buildBackupExport(db);
    expect(Array.isArray(data.tables.members)).toBe(true);
    expect(Array.isArray(data.tables.rounds)).toBe(true);
    expect(Array.isArray(data.tables.audit_log)).toBe(true);
    expect(Array.isArray(data.tables.ticket_discussions)).toBe(true);
    expect(Array.isArray(data.tables.round_automation_log)).toBe(true);
  });

  it('includes rows that actually exist', async () => {
    await saveMember(db, { name: 'Alice', email: 'alice@example.com', team: 'Trading', role: 'ADMIN' });
    const data = await buildBackupExport(db);
    expect(data.tables.members.length).toBe(1);
  });
});

describe('runBackupAndEmail', () => {
  it('emails every active admin and no committee member', async () => {
    await saveMember(db, { name: 'Admin One', email: 'admin1@example.com', team: 'Ops', role: 'ADMIN' });
    await saveMember(db, { name: 'Admin Two', email: 'admin2@example.com', team: 'Ops', role: 'ADMIN' });
    await saveMember(db, { name: 'Scorer', email: 'scorer@example.com', team: 'Trading', role: 'COMMITTEE' });

    const result = await runBackupAndEmail(db, ACTOR);

    expect(result.ok).toBe(true);
    expect(result.recipients).toBe(2);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [message] = sendMail.mock.calls[0];
    expect(message.to.sort()).toEqual(['admin1@example.com', 'admin2@example.com']);
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].contentType).toBe('application/json');
  });

  it('excludes an inactive admin', async () => {
    await saveMember(db, { name: 'Admin', email: 'admin@example.com', team: 'Ops', role: 'ADMIN', active: false });
    const result = await runBackupAndEmail(db, ACTOR);
    expect(result.ok).toBe(false);
    expect(result.recipients).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('does not throw, and reports failure, when there are no active admins', async () => {
    const result = await runBackupAndEmail(db, ACTOR);
    expect(result.ok).toBe(false);
    expect(result.recipients).toBe(0);
    expect(result.error).toBeTruthy();
  });

  it('does not throw when sendMail itself throws', async () => {
    await saveMember(db, { name: 'Admin', email: 'admin@example.com', team: 'Ops', role: 'ADMIN' });
    sendMail.mockRejectedValueOnce(new Error('smtp down'));

    const result = await runBackupAndEmail(db, ACTOR);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('smtp down');
  });

  it('logs a success to the audit log', async () => {
    await saveMember(db, { name: 'Admin', email: 'admin@example.com', team: 'Ops', role: 'ADMIN' });
    await runBackupAndEmail(db, ACTOR);
    const entries = await listAudit(db, { entityType: 'system' });
    expect(entries.some((e) => e.action === 'backup.export')).toBe(true);
  });

  it('logs backup.export.failed, not backup.export, when sendMail throws', async () => {
    await saveMember(db, { name: 'Admin', email: 'admin@example.com', team: 'Ops', role: 'ADMIN' });
    sendMail.mockRejectedValueOnce(new Error('smtp down'));
    await runBackupAndEmail(db, ACTOR);
    const entries = await listAudit(db, { entityType: 'system' });
    expect(entries.some((e) => e.action === 'backup.export.failed')).toBe(true);
    expect(entries.some((e) => e.action === 'backup.export')).toBe(false);
  });
});

describe('backupDueToday', () => {
  it('is true when nothing has ever been backed up', async () => {
    expect(await backupDueToday(db)).toBe(true);
  });

  it('is false immediately after a backup has been sent', async () => {
    await saveMember(db, { name: 'Admin', email: 'admin@example.com', team: 'Ops', role: 'ADMIN' });
    await runBackupAndEmail(db, ACTOR);
    expect(await backupDueToday(db)).toBe(false);
  });

  it('is true again once the last backup is more than 24 hours old', async () => {
    await saveMember(db, { name: 'Admin', email: 'admin@example.com', team: 'Ops', role: 'ADMIN' });
    await runBackupAndEmail(db, ACTOR);
    const yesterday = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await db.run(`UPDATE audit_log SET at = ? WHERE action = 'backup.export'`, [yesterday]);
    expect(await backupDueToday(db)).toBe(true);
  });
});
