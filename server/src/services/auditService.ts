import { Db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/time.js';

export interface AuditActor {
  id?: string | null;
  email?: string | null;
}

export interface AuditEntry {
  id: string;
  at: string;
  actorId: string | null;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string;
  detail: unknown;
}

/**
 * §14 auditability: every submission, edit, calculation and JIRA write-back is
 * recorded with who and when. Append-only - nothing in the app updates or
 * deletes rows in audit_log.
 */
export async function audit(
  db: Db,
  actor: AuditActor,
  action: string,
  entityType: string,
  entityId: string,
  detail: unknown = {},
): Promise<void> {
  await db.run(
    `INSERT INTO audit_log (id, at, actor_id, actor_email, action, entity_type, entity_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), nowIso(), actor.id ?? null, actor.email ?? '', action, entityType, entityId, JSON.stringify(detail ?? {})],
  );
}

export async function listAudit(
  db: Db,
  filters: { entityType?: string; entityId?: string; actorId?: string; limit?: number } = {},
): Promise<AuditEntry[]> {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filters.entityType) {
    where.push('entity_type = ?');
    params.push(filters.entityType);
  }
  if (filters.entityId) {
    where.push('entity_id = ?');
    params.push(filters.entityId);
  }
  if (filters.actorId) {
    where.push('actor_id = ?');
    params.push(filters.actorId);
  }
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
  const rows = await db.all<{
    id: string;
    at: string;
    actor_id: string | null;
    actor_email: string;
    action: string;
    entity_type: string;
    entity_id: string;
    detail: string;
  }>(
    `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ${limit}`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    detail: parse(row.detail),
  }));
}

function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
