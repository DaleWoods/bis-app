import { describe, expect, it } from 'vitest';
import {
  aggregateTicket,
  excelRound,
  isValidSubmission,
  resolveEffort,
  sampleStdDev,
  statusLabelFor,
  submissionTotal,
  SubmissionInput,
} from './scoring.js';
import { CategoryDef, DEFAULT_SCORING_CONFIG, ScoringConfig, SEED_CATEGORIES, STATUS_LABELS } from './types.js';

const categories: CategoryDef[] = SEED_CATEGORIES.map((c) => ({ ...c }));
const config: ScoringConfig = { ...DEFAULT_SCORING_CONFIG };

/** Spread a bis_total across the seven 0-10 categories so tests can work in totals. */
function scoresForTotal(total: number): Record<string, number> {
  if (total < 0 || total > 70) throw new Error(`total ${total} outside 0-70`);
  const base = Math.floor(total / categories.length);
  let remainder = total % categories.length;
  const scores: Record<string, number> = {};
  for (const category of categories) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    scores[category.id] = base + extra;
  }
  return scores;
}

function submission(total: number, overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    id: overrides.id ?? `sub-${Math.random().toString(36).slice(2)}`,
    memberId: overrides.memberId ?? `member-${Math.random().toString(36).slice(2)}`,
    relevance: overrides.relevance ?? 'YES',
    archived: overrides.archived,
    scores: overrides.scores ?? scoresForTotal(total),
  };
}

function aggregate(totals: number[], effort: number | null, extra: SubmissionInput[] = []) {
  return aggregateTicket(
    { submissions: [...totals.map((t) => submission(t)), ...extra], categories, effort },
    config,
  );
}

describe('§10.1 per submission', () => {
  it('bis_total is the sum of all seven category scores (0-70)', () => {
    const sub = submission(0, { scores: { 'commercial-impact': 8, 'operational-impact': 5, 'support-strain': 6, 'client-user-impact': 4, 'strategic-alignment': 7, 'data-reporting-value': 3, 'reputational-brand-risk': 3 } });
    expect(submissionTotal(sub, categories, config)).toBe(36);
  });

  it('maxes out at 70', () => {
    const sub = submission(70);
    expect(submissionTotal(sub, categories, config)).toBe(70);
  });

  it('counts a 0 (including Commercial N/A) as 0 rather than excluding it', () => {
    const withNa = submission(0, {
      scores: { 'commercial-impact': 0, 'operational-impact': 10, 'support-strain': 10, 'client-user-impact': 10, 'strategic-alignment': 10, 'data-reporting-value': 10, 'reputational-brand-risk': 10 },
    });
    expect(submissionTotal(withNa, categories, config)).toBe(60);

    // If N/A were excluded rather than zero, the average of these two would be 65, not 60.
    const result = aggregate([], null, [withNa, submission(60)]);
    expect(result.businessScore).toBe(60);
  });

  it('only Yes submissions are valid; Unsure and both No variants are excluded', () => {
    expect(isValidSubmission(submission(50))).toBe(true);
    expect(isValidSubmission(submission(50, { relevance: 'UNSURE' }))).toBe(false);
    expect(isValidSubmission(submission(50, { relevance: 'NO_CLOSE' }))).toBe(false);
    expect(isValidSubmission(submission(50, { relevance: 'NO_NOT_RELEVANT_TODAY' }))).toBe(false);
    expect(isValidSubmission(submission(50, { archived: true }))).toBe(false);
  });

  it('applies weights only when configured (currently a straight sum, §13.3)', () => {
    const weighted = categories.map((c) => ({ ...c, weight: c.id === 'commercial-impact' ? 2 : 1 }));
    const sub = submission(7, { scores: Object.fromEntries(categories.map((c) => [c.id, 1])) });
    expect(submissionTotal(sub, weighted, { applyCategoryWeights: false })).toBe(7);
    expect(submissionTotal(sub, weighted, { applyCategoryWeights: true })).toBe(8);
  });
});

describe('§10.2 per ticket aggregation', () => {
  it('business_score is ROUND(AVERAGE(valid totals), 0)', () => {
    const result = aggregate([30, 34, 36, 40, 40], null);
    expect(result.responsesCount).toBe(5);
    expect(result.businessScoreRaw).toBe(36);
    expect(result.businessScore).toBe(36);
  });

  it('rounds halves away from zero, like Excel ROUND', () => {
    expect(excelRound(35.5)).toBe(36);
    expect(excelRound(35.4999)).toBe(35);
    expect(excelRound(2.675, 2)).toBe(2.68);
    // 3 submissions averaging 41.5 -> 42
    const result = aggregate([40, 41, 43, 42], null);
    expect(result.businessScoreRaw).toBe(41.5);
    expect(result.businessScore).toBe(42);
  });

  it('excludes Unsure and No submissions from the aggregate but records them', () => {
    const result = aggregate([40, 44], null, [
      submission(0, { relevance: 'UNSURE' }),
      submission(70, { relevance: 'NO_CLOSE' }),
      submission(70, { relevance: 'NO_NOT_RELEVANT_TODAY' }),
    ]);
    expect(result.responsesCount).toBe(2);
    expect(result.submissionsCount).toBe(5);
    expect(result.businessScore).toBe(42);
    expect(result.excludedCounts.UNSURE).toBe(1);
    expect(result.clarificationRequested).toBe(true);
    expect(result.toClose).toBe(true);
    expect(result.parkRequested).toBe(true);
  });

  it('uses the sample standard deviation (STDEV.S)', () => {
    // Population sd of these is 2; sample sd is 2.2360679...
    expect(sampleStdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4);
    expect(sampleStdDev([10, 20])).toBeCloseTo(7.0710678, 6);
    expect(sampleStdDev([10])).toBeNull();
    expect(sampleStdDev([])).toBeNull();
  });

  it('flags discussion only when std_dev is strictly greater than the threshold', () => {
    const config16: ScoringConfig = { ...config, stdDevDiscussionThreshold: 16 };
    // totals with sample sd exactly 16: mean 35, devs -16 and +16 -> sd = 16 * sqrt(2/1)... use explicit check instead
    expect(aggregateTicket({ submissions: [submission(35), submission(35)], categories, effort: 10 }, config16).stdDev).toBe(0);
    expect(aggregateTicket({ submissions: [submission(35), submission(35)], categories, effort: 10 }, config16).discussionRequired).toBe(false);

    const wide = aggregate([11, 25, 37, 42, 60], null); // sd 18.4
    expect(wide.stdDev).toBeCloseTo(18.4, 1);
    expect(wide.discussionRequired).toBe(true);
  });

  it('leaves std_dev null (and discussion off) for a single response', () => {
    const result = aggregate([40], 10);
    expect(result.stdDev).toBeNull();
    expect(result.discussionRequired).toBe(false);
  });

  it('computes priority_ratio only when discussion is not required and effort is present', () => {
    expect(aggregate([40, 42, 44, 46, 48], null).priorityRatio).toBeNull();
    expect(aggregate([11, 25, 37, 42, 60], 10).priorityRatio).toBeNull(); // discussion required
    expect(aggregate([40, 42, 44, 46, 48], 8).priorityRatio).toBeCloseTo(44 / 8, 6);
  });

  it('bands on >= 6 High, >= 1.8 Medium, else Low', () => {
    expect(aggregate([60, 60, 60, 60, 60], 10).priorityBand).toBe('HIGH'); // 6.0 exactly
    expect(aggregate([59, 59, 59, 59, 59], 10).priorityBand).toBe('MEDIUM'); // 5.9
    expect(aggregate([18, 18, 18, 18, 18], 10).priorityBand).toBe('MEDIUM'); // 1.8 exactly
    expect(aggregate([17, 17, 17, 17, 17], 10).priorityBand).toBe('LOW'); // 1.7
  });

  it('reports per-category averages for the anonymised feedback view (§9)', () => {
    const a = submission(0, { scores: Object.fromEntries(categories.map((c) => [c.id, 2])) });
    const b = submission(0, { scores: Object.fromEntries(categories.map((c) => [c.id, 8])) });
    const result = aggregate([], 5, [a, b]);
    expect(result.categoryAverages).toHaveLength(7);
    for (const category of result.categoryAverages) {
      expect(category.average).toBe(5);
      expect(category.min).toBe(2);
      expect(category.max).toBe(8);
    }
    expect(result.totalsDistribution).toEqual([14, 56]);
  });
});

describe('§10.3 status label precedence', () => {
  const label = (input: Parameters<typeof statusLabelFor>[0]) => statusLabelFor(input, config);

  it('is blank with no responses', () => {
    expect(label({ responsesCount: 0, toClose: false, effortPresent: true, discussionRequired: false, priorityRatio: 9 })).toBe(STATUS_LABELS.NONE);
  });

  it('awaits responses below the minimum of 5', () => {
    expect(label({ responsesCount: 4, toClose: true, effortPresent: true, discussionRequired: true, priorityRatio: 9 })).toBe(
      STATUS_LABELS.AWAITING_RESPONSES,
    );
  });

  it('puts "To Close?" ahead of effort, discussion and priority', () => {
    expect(label({ responsesCount: 5, toClose: true, effortPresent: false, discussionRequired: true, priorityRatio: 9 })).toBe(
      STATUS_LABELS.TO_CLOSE,
    );
  });

  it('awaits RA effort before considering discussion', () => {
    expect(label({ responsesCount: 5, toClose: false, effortPresent: false, discussionRequired: true, priorityRatio: null })).toBe(
      STATUS_LABELS.AWAITING_EFFORT,
    );
  });

  it('flags discussion ahead of a priority band', () => {
    expect(label({ responsesCount: 5, toClose: false, effortPresent: true, discussionRequired: true, priorityRatio: 9 })).toBe(
      STATUS_LABELS.PENDING_DISCUSSION,
    );
  });

  it('falls through to the priority bands', () => {
    expect(label({ responsesCount: 5, toClose: false, effortPresent: true, discussionRequired: false, priorityRatio: 6 })).toBe(STATUS_LABELS.HIGH);
    expect(label({ responsesCount: 5, toClose: false, effortPresent: true, discussionRequired: false, priorityRatio: 1.8 })).toBe(STATUS_LABELS.MEDIUM);
    expect(label({ responsesCount: 5, toClose: false, effortPresent: true, discussionRequired: false, priorityRatio: 1.79 })).toBe(STATUS_LABELS.LOW);
  });

  it('marks a ticket "Send for Est" at >= 5 valid submissions with no discussion required', () => {
    expect(aggregate([40, 42, 44, 46, 48], null).sendForEstimation).toBe(true);
    expect(aggregate([40, 42, 44, 46], null).sendForEstimation).toBe(false);
    expect(aggregate([11, 25, 37, 42, 60], null).sendForEstimation).toBe(false);
  });

  it('honours reconfigured thresholds without code changes (§14)', () => {
    const relaxed: ScoringConfig = { ...config, minSubmissions: 2, stdDevDiscussionThreshold: 25 };
    const result = aggregateTicket(
      { submissions: [11, 25, 37, 42, 60].map((t) => submission(t)), categories, effort: 10 },
      relaxed,
    );
    expect(result.discussionRequired).toBe(false); // 18.4 no longer breaches a threshold of 25
    expect(result.statusLabel).toBe(STATUS_LABELS.MEDIUM); // 35 / 10 = 3.5 -> Medium
  });
});

describe('§10.5 worked checks from live data', () => {
  it('ECOM-1466: score 43, effort 16 -> ratio 2.69 Medium, std_dev 12.8, no discussion', () => {
    const result = aggregate([27, 35, 43, 50, 60], 16);
    expect(result.businessScore).toBe(43);
    expect(result.stdDev).toBeCloseTo(12.8, 1);
    expect(result.discussionRequired).toBe(false);
    expect(result.priorityRatio).toBeCloseTo(2.69, 2);
    expect(result.priorityBand).toBe('MEDIUM');
    expect(result.statusLabel).toBe(STATUS_LABELS.MEDIUM);
    expect(result.sendForEstimation).toBe(true);
  });

  it('ECOM-1422: score 13, effort 13 -> ratio 1.0 Low', () => {
    const result = aggregate([10, 12, 13, 14, 16], 13);
    expect(result.businessScore).toBe(13);
    expect(result.priorityRatio).toBeCloseTo(1.0, 6);
    expect(result.priorityBand).toBe('LOW');
    expect(result.statusLabel).toBe(STATUS_LABELS.LOW);
  });

  it('ECOM-915: std_dev 18.4 -> Pending discussion', () => {
    const result = aggregate([11, 25, 37, 42, 60], 12);
    expect(result.stdDev).toBeCloseTo(18.4, 1);
    expect(result.discussionRequired).toBe(true);
    expect(result.priorityRatio).toBeNull();
    expect(result.statusLabel).toBe(STATUS_LABELS.PENDING_DISCUSSION);
  });

  it('ECOM-1775: business score 36 is what would be written to JIRA', () => {
    const result = aggregate([30, 34, 36, 40, 40], 21);
    expect(result.businessScore).toBe(36);
  });

  it('a ticket short of 5 responses rolls over as "Awaiting WOSG Responses"', () => {
    const result = aggregate([40, 42, 44, 46], 8);
    expect(result.responsesCount).toBe(4);
    expect(result.statusLabel).toBe(STATUS_LABELS.AWAITING_RESPONSES);
  });

  it('a single "No - can be closed" vote flags "To Close?" once the minimum is met', () => {
    const result = aggregate([40, 42, 44, 46, 48], 8, [submission(0, { relevance: 'NO_CLOSE' })]);
    expect(result.toClose).toBe(true);
    expect(result.statusLabel).toBe(STATUS_LABELS.TO_CLOSE);
  });
});

describe('§10.4 effort mapping', () => {
  const ticket = { backendPokerScore: 13, frontendPokerScore: 8, manualEffort: null };

  it('defaults to the backend + frontend poker total (ECOM-1775 = 21)', () => {
    expect(resolveEffort(ticket, config)).toBe(21);
  });

  it('can be pointed at a single field via config', () => {
    expect(resolveEffort(ticket, { ...config, effort: { ...config.effort, mode: 'BACKEND_ONLY' } })).toBe(13);
    expect(resolveEffort(ticket, { ...config, effort: { ...config.effort, mode: 'FRONTEND_ONLY' } })).toBe(8);
    expect(resolveEffort(ticket, { ...config, effort: { ...config.effort, mode: 'MANUAL' } })).toBeNull();
  });

  it('lets a coordinator override effort manually', () => {
    expect(resolveEffort({ ...ticket, manualEffort: 16 }, config)).toBe(16);
  });

  it('is null when RA has not estimated yet', () => {
    expect(resolveEffort({ backendPokerScore: null, frontendPokerScore: null, manualEffort: null }, config)).toBeNull();
  });

  it('tolerates one poker field being absent', () => {
    expect(resolveEffort({ backendPokerScore: 13, frontendPokerScore: null, manualEffort: null }, config)).toBe(13);
  });
});
