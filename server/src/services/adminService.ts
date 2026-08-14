import { Db } from '../db/index.js';

export interface ResetCounts {
  rounds: number;
  tickets: number;
  submissions: number;
  scores: number;
  results: number;
  writebacks: number;
  emails: number;
}

/**
 * Clear the operational data - rounds, tickets and everything scored against
 * them - while keeping the setup: the committee, the categories, and all
 * configuration.
 *
 * The audit log is deliberately left intact. It is the append-only record of
 * what happened, and the reset itself is written to it.
 */
export async function resetOperationalData(db: Db): Promise<ResetCounts> {
  const count = async (table: string): Promise<number> => {
    const row = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
    return Number(row?.count ?? 0);
  };

  const counts: ResetCounts = {
    rounds: await count('rounds'),
    tickets: await count('tickets'),
    submissions: await count('submissions'),
    scores: await count('submission_scores'),
    results: await count('ticket_results'),
    writebacks: await count('jira_writebacks'),
    emails: await count('email_log'),
  };

  await db.tx(async (tx) => {
    // Child rows first, so the delete works whether or not the driver has
    // cascades switched on.
    await tx.run('DELETE FROM submission_scores', []);
    await tx.run('DELETE FROM submissions', []);
    await tx.run('DELETE FROM ticket_results', []);
    await tx.run('DELETE FROM ticket_discussions', []);
    await tx.run('DELETE FROM round_tickets', []);
    await tx.run('DELETE FROM round_automation_log', []);
    await tx.run('DELETE FROM jira_writebacks', []);
    await tx.run('DELETE FROM email_log', []);
    await tx.run('DELETE FROM rounds', []);
    await tx.run('DELETE FROM tickets', []);
  });

  return counts;
}

export interface DeletedRound {
  weekLabel: string;
  tickets: number;
  submissions: number;
  writebacks: number;
}

/**
 * Delete one round and everything recorded against it.
 *
 * The tickets themselves are kept. A ticket is not owned by a round - it comes
 * from JIRA, usually sits in more than one round over its life, and rolls over
 * when a round does not reach quorum. Deleting a round because it was a test or
 * was created twice should not take the ticket with it.
 *
 * What is written to JIRA is already outside this database, so a round whose
 * scores went across leaves those scores behind. The caller is told how many,
 * because that is the part nobody can undo from in here.
 */
export async function deleteRound(db: Db, roundId: string): Promise<DeletedRound | null> {
  const round = await db.get<{ week_label: string }>('SELECT week_label FROM rounds WHERE id = ?', [roundId]);
  if (!round) return null;

  const countIn = async (table: string): Promise<number> => {
    const row = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE round_id = ?`, [roundId]);
    return Number(row?.count ?? 0);
  };

  const deleted: DeletedRound = {
    weekLabel: round.week_label,
    tickets: await countIn('round_tickets'),
    submissions: await countIn('submissions'),
    writebacks: Number(
      (
        await db.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM jira_writebacks WHERE round_id = ? AND status = 'SUCCESS'",
          [roundId],
        )
      )?.count ?? 0,
    ),
  };

  await db.tx(async (tx) => {
    // Child rows first, so this works whether or not the driver has cascades on.
    await tx.run(
      'DELETE FROM submission_scores WHERE submission_id IN (SELECT id FROM submissions WHERE round_id = ?)',
      [roundId],
    );
    await tx.run('DELETE FROM submissions WHERE round_id = ?', [roundId]);
    await tx.run('DELETE FROM ticket_results WHERE round_id = ?', [roundId]);
    await tx.run('DELETE FROM ticket_discussions WHERE round_id = ?', [roundId]);
    await tx.run('DELETE FROM round_tickets WHERE round_id = ?', [roundId]);
    await tx.run('DELETE FROM round_automation_log WHERE round_id = ?', [roundId]);
    await tx.run('DELETE FROM jira_writebacks WHERE round_id = ?', [roundId]);
    await tx.run('DELETE FROM email_log WHERE round_id = ?', [roundId]);
    await tx.run('DELETE FROM rounds WHERE id = ?', [roundId]);
  });

  return deleted;
}
