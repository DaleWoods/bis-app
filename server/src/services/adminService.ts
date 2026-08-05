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
    await tx.run('DELETE FROM round_tickets', []);
    await tx.run('DELETE FROM jira_writebacks', []);
    await tx.run('DELETE FROM email_log', []);
    await tx.run('DELETE FROM rounds', []);
    await tx.run('DELETE FROM tickets', []);
  });

  return counts;
}
