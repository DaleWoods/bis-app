import { Db } from '../db/index.js';
import { env } from '../config/env.js';
import { searchHopper } from '../integrations/jira.js';
import { QueueCandidate, QueueSplit, splitQueues } from '../domain/queue.js';
import { getAppConfig } from './configService.js';

/**
 * The live dev queue, recomputed on every read.
 *
 * Nothing here is written down. A position is only true at the moment it is
 * read - it moves when a ticket is built, when a new round's scores land, or
 * when somebody adds an effort estimate - so storing one would mean showing
 * people a number that had quietly stopped being right.
 */

export type QueueUnavailableReason = 'DISABLED' | 'JIRA_NOT_CONFIGURED' | 'FIELDS_NOT_SET';

export interface QueueView {
  available: boolean;
  /** Why there is nothing to show, when there is nothing to show. */
  reason?: QueueUnavailableReason;
  split: QueueSplit;
  /** Scored tickets JIRA returned that carry no business score after all. */
  unscored: number;
  fetchedAt: string;
}

const EMPTY_SPLIT: QueueSplit = { frontend: [], backend: [], notQueued: [] };

function unavailable(reason: QueueUnavailableReason): QueueView {
  return { available: false, reason, split: EMPTY_SPLIT, unscored: 0, fetchedAt: new Date().toISOString() };
}

/**
 * Read the hopper and rank it.
 *
 * The three "not available" states are kept apart on purpose: a coordinator
 * who has not switched it on, an installation with no JIRA credentials, and a
 * configuration missing the field ids all need different things doing about
 * them, and one shared "no data" message would send them all to the wrong
 * place.
 */
export async function getQueueView(db: Db): Promise<QueueView> {
  const config = await getAppConfig(db);
  if (!config.queue.enabled) return unavailable('DISABLED');
  if (!env.jira.configured) return unavailable('JIRA_NOT_CONFIGURED');

  const fieldIds = {
    businessScoreFieldId: config.jira.businessScoreFieldId,
    backendFieldId: config.scoring.effort.backendFieldId,
    frontendFieldId: config.scoring.effort.frontendFieldId,
  };
  // Without the business score field there is no ranking to do, and without
  // the effort fields every ticket would look unqueued - a confidently wrong
  // answer rather than an obviously missing one.
  if (!fieldIds.businessScoreFieldId || (!fieldIds.backendFieldId && !fieldIds.frontendFieldId)) {
    return unavailable('FIELDS_NOT_SET');
  }

  const issues = await searchHopper(config.queue.hopperJql, fieldIds);

  // The JQL is meant to exclude these, but a site whose JQL says something
  // slightly different should not get a queue built on nulls.
  const scored: QueueCandidate[] = [];
  let unscored = 0;
  for (const issue of issues) {
    if (issue.businessScore === null) {
      unscored += 1;
      continue;
    }
    scored.push({
      key: issue.key,
      summary: issue.summary,
      status: issue.status,
      businessScore: issue.businessScore,
      frontendEffort: issue.frontendEffort,
      backendEffort: issue.backendEffort,
    });
  }

  return { available: true, split: splitQueues(scored), unscored, fetchedAt: new Date().toISOString() };
}
