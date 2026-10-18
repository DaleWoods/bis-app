import type { Db } from '../db/index.js';
import { env } from '../config/env.js';
import { searchHopper } from '../integrations/jira.js';
import { getAppConfig } from './configService.js';

/**
 * The value matrix: every scored ticket waiting to be built, placed by
 * business score against effort, so the ones costing a lot for little can be questioned
 * before the effort goes in.
 *
 * Read live, never stored - the same reasoning as the queue. Both numbers
 * move after scoring (the weekly priority acceleration, a re-estimate), and a
 * plotted position that had quietly stopped being true would be worse than
 * none.
 *
 * Which box a ticket falls in is worked out by the page, not here, because
 * the splits are something a coordinator drags to see "what if" before
 * saving them.
 */

export type MatrixSource = 'jira' | 'app';

export interface MatrixPoint {
  key: string;
  summary: string;
  status: string;
  businessScore: number;
  /**
   * In poker points throughout. `testing` is the converted figure;
   * `testingHours` is what JIRA holds, kept so the page can show where the
   * number came from.
   */
  effort: { backend: number; frontend: number; testing: number; testingHours: number; manual: number | null; total: number };
}

export interface MatrixView {
  source: MatrixSource;
  /** Why the app's own scores are shown instead of JIRA's, when they are. */
  sourceNote: string;
  points: MatrixPoint[];
  /** Scored, but with no effort estimate yet - they cannot be placed, and are listed rather than hidden. */
  unestimated: Array<{ key: string; summary: string; status: string; businessScore: number }>;
  splits: { value: number; effort: number };
  /** The priority-ratio bands from Settings, drawn on the chart as guide lines. */
  priorityBands: { high: number; medium: number };
  /** For linking a ticket key to JIRA; blank when JIRA is not configured. */
  jiraBrowseUrl: string;
  testingIncluded: boolean;
  /** How many testing hours count as one poker point, worked out from Settings. */
  testingHoursPerPoint: number;
  fetchedAt: string;
}

/**
 * The app's own view when JIRA is not available: each ticket's most recent
 * finalised committee score, with the effort held on the ticket. It misses
 * anything scored before the app and the weekly acceleration, which the page
 * says plainly rather than passing it off as the JIRA picture.
 */
async function fromApp(db: Db): Promise<Pick<MatrixView, 'points' | 'unestimated'>> {
  const rows = await db.all<{
    jira_id: string;
    title: string;
    jira_status: string;
    business_score: number | null;
    backend_poker_score: number | null;
    frontend_poker_score: number | null;
    manual_effort: number | null;
  }>(
    `SELECT t.jira_id, t.title, t.jira_status, tr.business_score, t.backend_poker_score, t.frontend_poker_score, t.manual_effort
     FROM ticket_results tr
     JOIN rounds r ON r.id = tr.round_id AND r.status = 'FINALISED'
     JOIN tickets t ON t.id = tr.ticket_id
     WHERE tr.business_score IS NOT NULL
       AND r.cut_off_at = (
         SELECT MAX(r2.cut_off_at) FROM ticket_results tr2
         JOIN rounds r2 ON r2.id = tr2.round_id AND r2.status = 'FINALISED'
         WHERE tr2.ticket_id = tr.ticket_id AND tr2.business_score IS NOT NULL
       )`,
  );
  const points: MatrixPoint[] = [];
  const unestimated: MatrixView['unestimated'] = [];
  for (const row of rows) {
    const backend = Number(row.backend_poker_score ?? 0);
    const frontend = Number(row.frontend_poker_score ?? 0);
    const manual = row.manual_effort === null ? null : Number(row.manual_effort);
    // A coordinator-entered effort replaces the poker figures, as it does for priority.
    const total = manual ?? backend + frontend;
    const base = { key: row.jira_id, summary: row.title, status: row.jira_status || 'Scored', businessScore: Number(row.business_score) };
    if (!total) unestimated.push(base);
    else points.push({ ...base, effort: { backend, frontend, testing: 0, testingHours: 0, manual, total } });
  }
  return { points, unestimated };
}

export async function getMatrixView(db: Db): Promise<MatrixView> {
  const config = await getAppConfig(db);
  const fieldIds = {
    businessScoreFieldId: config.jira.businessScoreFieldId,
    backendFieldId: config.scoring.effort.backendFieldId,
    frontendFieldId: config.scoring.effort.frontendFieldId,
    testingFieldId: config.matrix.testingFieldId,
  };
  const base = {
    splits: { value: config.matrix.valueSplit, effort: config.matrix.effortSplit },
    priorityBands: { high: config.scoring.priorityHigh, medium: config.scoring.priorityMedium },
    jiraBrowseUrl: env.jira.baseUrl ? `${env.jira.baseUrl}/browse/` : '',
    testingHoursPerPoint: testingHoursPerPoint(config.matrix),
    fetchedAt: new Date().toISOString(),
  };

  const jiraReady =
    env.jira.configured && fieldIds.businessScoreFieldId && (fieldIds.backendFieldId || fieldIds.frontendFieldId);
  if (!jiraReady) {
    return {
      ...base,
      ...(await fromApp(db)),
      source: 'app',
      sourceNote: env.jira.configured
        ? 'The business score and effort fields are not set in Settings, so this shows the committee scores recorded in the app instead of JIRA.'
        : 'JIRA is not connected, so this shows the committee scores recorded in the app instead of JIRA.',
      testingIncluded: false,
    };
  }

  // The Queue tab's query, deliberately: the tickets waiting to be built are
  // the ones with estimates, and the ones where effort is about to go in -
  // which is exactly when "is it worth it?" is worth asking. One query also
  // means the two tabs can never disagree about which tickets are in play.
  const issues = await searchHopper(config.queue.hopperJql, fieldIds);
  const points: MatrixPoint[] = [];
  const unestimated: MatrixView['unestimated'] = [];
  for (const issue of issues) {
    // -1 is the "not scored yet" placeholder on this site, not a score.
    if (issue.businessScore === null || issue.businessScore < 0) continue;
    // Testing is in hours and the poker estimates in points - convert before adding.
    const testingPoints = round1(issue.testingEffort / base.testingHoursPerPoint);
    const total = round1(issue.backendEffort + issue.frontendEffort + testingPoints);
    const entry = { key: issue.key, summary: issue.summary, status: issue.status, businessScore: issue.businessScore };
    if (!total) {
      unestimated.push(entry);
      continue;
    }
    points.push({
      ...entry,
      effort: {
        backend: issue.backendEffort,
        frontend: issue.frontendEffort,
        testing: testingPoints,
        testingHours: issue.testingEffort,
        manual: null,
        total,
      },
    });
  }
  return { ...base, points, unestimated, source: 'jira', sourceNote: '', testingIncluded: Boolean(fieldIds.testingFieldId) };
}

/**
 * Hours of testing worth one poker point: a tester's day in hours, times the
 * days one point takes. With "a 13 is 7.5 days" and a 6-hour testing day,
 * a point is about 3.5 hours.
 */
export function testingHoursPerPoint(m: { testingHoursPerDay: number; referencePoints: number; referenceDays: number }): number {
  const hours = m.testingHoursPerDay > 0 ? m.testingHoursPerDay : 6;
  const points = m.referencePoints > 0 ? m.referencePoints : 13;
  const days = m.referenceDays > 0 ? m.referenceDays : 7.5;
  return (hours * days) / points;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
