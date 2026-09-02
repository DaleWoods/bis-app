import { Db } from '../db/index.js';
import { audit } from './auditService.js';
import { listMembers } from './memberService.js';
import { sendMail, type MailAttachment } from '../integrations/mail.js';
import { nowIso } from '../util/time.js';

/**
 * An independent copy of the whole database, decoupled from Render's own
 * backups and from anyone remembering to click a button.
 *
 * This app is the single system of record for the scoring process (§3) - if
 * the database is ever lost, so is every round it replaced a spreadsheet
 * for. See docs/plans/PLAN-1-data-durability.md for the full reasoning.
 */

/**
 * Every table in the schema, in an order that is safe to re-insert in (a
 * table only appears after anything it has a foreign key to). Update this
 * list in the same commit as any migration that adds or renames a table -
 * a table missing from here is a table silently left out of every future
 * backup, which defeats the entire point and would not be noticed until
 * someone needed the missing data.
 */
const TABLES = [
  'app_config',
  'categories',
  'members',
  'tickets',
  'rounds',
  'round_tickets',
  'submissions',
  'submission_scores',
  'ticket_results',
  'ticket_discussions',
  'email_log',
  'jira_writebacks',
  'round_automation_log',
  'audit_log',
] as const;

export interface BackupExport {
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

/** Read every row of every table into one plain object. Read-only - never mutates anything. */
export async function buildBackupExport(db: Db): Promise<BackupExport> {
  const tables: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    tables[table] = await db.all(`SELECT * FROM ${table}`);
  }
  return { exportedAt: nowIso(), tables };
}

function toAttachment(data: BackupExport): MailAttachment {
  const json = JSON.stringify(data);
  return {
    name: `bis-backup-${data.exportedAt.slice(0, 10)}.json`,
    contentType: 'application/json',
    contentBytes: Buffer.from(json, 'utf8').toString('base64'),
  };
}

/**
 * Build the export and email it to every active admin. This is the
 * independent second copy of the data - it does not depend on Render's own
 * backups, the database driver, or anyone remembering to click a button.
 *
 * Failure here must never throw into the scheduler tick or the request
 * handler that triggered it; a failed backup attempt is worth logging, not
 * worth taking the app down over.
 */
export async function runBackupAndEmail(
  db: Db,
  actor: { id?: string | null; email?: string | null },
): Promise<{ ok: boolean; recipients: number; error?: string }> {
  try {
    const data = await buildBackupExport(db);
    const admins = (await listMembers(db, false)).filter((m) => m.role === 'ADMIN');
    if (!admins.length) {
      await audit(db, actor, 'backup.export', 'system', '', { recipients: 0, reason: 'no active admins' });
      return { ok: false, recipients: 0, error: 'No active admin to send the backup to' };
    }
    const attachment = toAttachment(data);
    const tableCounts = Object.fromEntries(TABLES.map((t) => [t, data.tables[t].length]));
    const outcome = await sendMail({
      to: admins.map((a) => a.email),
      subject: `BIS database backup — ${data.exportedAt.slice(0, 10)}`,
      html: `<p>Attached: a full export of the Business Impact Scoring database, taken ${data.exportedAt}.</p>
<p>Row counts: ${Object.entries(tableCounts)
        .map(([t, n]) => `${t}: ${n}`)
        .join(', ')}.</p>
<p>Keep this somewhere outside Render - a shared drive, an email folder that is itself backed up. This is the independent copy, not a substitute for Render's own database backups.</p>`,
      attachments: [attachment],
    });
    await audit(db, actor, 'backup.export', 'system', '', {
      recipients: admins.length,
      status: outcome.status,
      error: outcome.error,
      tableCounts,
    });
    return { ok: outcome.status === 'SENT', recipients: admins.length, error: outcome.error };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit(db, actor, 'backup.export.failed', 'system', '', { error: message });
    return { ok: false, recipients: 0, error: message };
  }
}

const AUTOMATION_ACTOR = { id: null, email: 'automation@bis' };

/**
 * True once in every rolling 24h window. Reads the most recent successful
 * `backup.export` audit entry rather than keeping its own clock, so a
 * restart never causes two backups in one day and a long outage never
 * causes zero - the very next tick after the gap sends one.
 */
export async function backupDueToday(db: Db): Promise<boolean> {
  const last = await db.get<{ at: string }>(
    `SELECT at FROM audit_log WHERE action = 'backup.export' ORDER BY at DESC LIMIT 1`,
  );
  if (!last) return true;
  const hoursSince = (Date.now() - new Date(last.at).getTime()) / 3_600_000;
  return hoursSince >= 24;
}

export async function runDailyBackupIfDue(db: Db): Promise<void> {
  if (!(await backupDueToday(db))) return;
  await runBackupAndEmail(db, AUTOMATION_ACTOR);
}
