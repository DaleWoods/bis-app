import {
  CategoryDef,
  PRIORITY_BAND_LABELS,
  PriorityBand,
  Relevance,
  STATUS_LABELS,
  ScoringConfig,
  StatusLabel,
} from './types.js';

/**
 * §10 - DEFINITIVE scoring calculation.
 *
 * This module is pure: no database, no clock, no I/O. It is the single place
 * the spreadsheet maths lives, and it is driven entirely by `ScoringConfig`
 * (thresholds 5 / 16 / 6 / 1.8 are settings, not literals).
 */

export interface SubmissionInput {
  id: string;
  memberId: string;
  relevance: Relevance;
  /** Legacy/archived scores never count (§10.1). */
  archived?: boolean;
  /** categoryId -> 0..10. A 0 (incl. Commercial "N/A") counts as 0, it is not excluded. */
  scores: Record<string, number>;
}

export interface CategoryAggregate {
  categoryId: string;
  name: string;
  average: number;
  min: number;
  max: number;
}

export interface TicketAggregate {
  /** Valid `Yes` submissions only (§10.2). */
  responsesCount: number;
  /** Every non-archived submission, whatever the relevance answer. */
  submissionsCount: number;
  /** ROUND(AVERAGE(valid bis_totals), 0) - the integer written to JIRA. Null when there are none. */
  businessScore: number | null;
  /** Unrounded mean, for display/audit only. */
  businessScoreRaw: number | null;
  /** Sample standard deviation (STDEV.S). Null when fewer than 2 valid submissions. */
  stdDev: number | null;
  discussionRequired: boolean;
  /** Any "No - this ticket can be closed" vote (§8). */
  toClose: boolean;
  /** Any "Unsure" vote - ticket flagged for clarification (§8). */
  clarificationRequested: boolean;
  /** Any "isn't relevant today" vote - park/remove (§8). */
  parkRequested: boolean;
  effort: number | null;
  priorityRatio: number | null;
  priorityBand: PriorityBand | null;
  statusLabel: StatusLabel;
  /** ≥ MIN_SUBMISSIONS valid submissions and no discussion required (§10.3). */
  sendForEstimation: boolean;
  minSubmissionsMet: boolean;
  categoryAverages: CategoryAggregate[];
  /** Anonymised spread for the post-round feedback view (§9). */
  totalsDistribution: number[];
  excludedCounts: Record<Relevance, number>;
}

/** Excel ROUND(): half away from zero, with binary-noise correction. */
export function excelRound(value: number, digits = 0): number {
  if (!Number.isFinite(value)) return NaN;
  const factor = 10 ** digits;
  const scaled = Number((value * factor).toPrecision(12));
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded / factor;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** STDEV.S - sample standard deviation. Undefined (null) for n < 2, as in Excel. */
export function sampleStdDev(values: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const m = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

/** A submission counts only if it is a `Yes` and is not archived (§10.1). */
export function isValidSubmission(submission: SubmissionInput): boolean {
  return submission.relevance === 'YES' && !submission.archived;
}

/**
 * bis_total = SUM of all seven category scores -> 0..70.
 * Weights are applied only when `applyCategoryWeights` is on (currently unweighted, §13.3).
 */
export function submissionTotal(
  submission: SubmissionInput,
  categories: CategoryDef[],
  config: Pick<ScoringConfig, 'applyCategoryWeights'>,
): number {
  return categories
    .filter((c) => c.active)
    .reduce((total, category) => {
      const raw = submission.scores[category.id];
      const score = Number.isFinite(raw) ? Number(raw) : 0;
      return total + (config.applyCategoryWeights ? score * category.weight : score);
    }, 0);
}

export function priorityBandFor(ratio: number | null, config: ScoringConfig): PriorityBand | null {
  if (ratio === null) return null;
  if (ratio >= config.priorityHigh) return 'HIGH';
  if (ratio >= config.priorityMedium) return 'MEDIUM';
  return 'LOW';
}

export interface AggregateInput {
  submissions: SubmissionInput[];
  categories: CategoryDef[];
  /** RA poker effort; null when RA has not estimated yet. */
  effort: number | null;
}

/**
 * Aggregate one ticket for one round (§10.2 / §10.3).
 * Reproduces the spreadsheet, including the status-label precedence.
 */
export function aggregateTicket(input: AggregateInput, config: ScoringConfig): TicketAggregate {
  const activeCategories = input.categories.filter((c) => c.active).sort((a, b) => a.position - b.position);
  const live = input.submissions.filter((s) => !s.archived);
  const valid = live.filter(isValidSubmission);
  const totals = valid.map((s) => submissionTotal(s, activeCategories, config));

  const excludedCounts: Record<Relevance, number> = {
    YES: 0,
    UNSURE: 0,
    NO_CLOSE: 0,
    NO_NOT_RELEVANT_TODAY: 0,
  };
  for (const s of live) excludedCounts[s.relevance] += 1;

  const responsesCount = valid.length;
  const businessScoreRaw = mean(totals);
  const businessScore = businessScoreRaw === null ? null : excelRound(businessScoreRaw, 0);
  const stdDev = sampleStdDev(totals);
  const discussionRequired = stdDev !== null && stdDev > config.stdDevDiscussionThreshold;

  const toClose = excludedCounts.NO_CLOSE > 0;
  const clarificationRequested = excludedCounts.UNSURE > 0;
  const parkRequested = excludedCounts.NO_NOT_RELEVANT_TODAY > 0;

  const effort = input.effort !== null && Number.isFinite(input.effort) ? Number(input.effort) : null;
  const effortPresent = effort !== null && effort > 0;

  // priority_ratio: only when discussion is not required and effort is present (§10.2).
  const priorityRatio =
    !discussionRequired && effortPresent && businessScore !== null ? businessScore / (effort as number) : null;
  const priorityBand = priorityBandFor(priorityRatio, config);

  const minSubmissionsMet = responsesCount >= config.minSubmissions;

  const categoryAverages: CategoryAggregate[] = activeCategories.map((category) => {
    const values = valid.map((s) => {
      const raw = s.scores[category.id];
      return Number.isFinite(raw) ? Number(raw) : 0;
    });
    return {
      categoryId: category.id,
      name: category.name,
      average: mean(values) ?? 0,
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 0,
    };
  });

  return {
    responsesCount,
    submissionsCount: live.length,
    businessScore,
    businessScoreRaw,
    stdDev,
    discussionRequired,
    toClose,
    clarificationRequested,
    parkRequested,
    effort,
    priorityRatio,
    priorityBand,
    statusLabel: statusLabelFor(
      { responsesCount, toClose, effortPresent, discussionRequired, priorityRatio },
      config,
    ),
    sendForEstimation: minSubmissionsMet && !discussionRequired,
    minSubmissionsMet,
    categoryAverages,
    totalsDistribution: [...totals].sort((a, b) => a - b),
    excludedCounts,
  };
}

interface StatusLabelInput {
  responsesCount: number;
  toClose: boolean;
  effortPresent: boolean;
  discussionRequired: boolean;
  priorityRatio: number | null;
}

/**
 * §10.3 progress gate - precedence matters and is reproduced verbatim:
 *
 *   0 responses               -> ""
 *   < MIN_SUBMISSIONS         -> "Awaiting WOSG Responses"
 *   any "No - can be closed"  -> "To Close?"
 *   effort missing            -> "Awaiting RA effort"
 *   discussion required       -> "Pending discussion"
 *   ratio >= PRIORITY_HIGH    -> "High priority"
 *   ratio >= PRIORITY_MEDIUM  -> "Medium priority"
 *   otherwise                 -> "Low priority"
 */
export function statusLabelFor(input: StatusLabelInput, config: ScoringConfig): StatusLabel {
  if (input.responsesCount === 0) return STATUS_LABELS.NONE;
  if (input.responsesCount < config.minSubmissions) return STATUS_LABELS.AWAITING_RESPONSES;
  if (input.toClose) return STATUS_LABELS.TO_CLOSE;
  if (!input.effortPresent) return STATUS_LABELS.AWAITING_EFFORT;
  if (input.discussionRequired) return STATUS_LABELS.PENDING_DISCUSSION;
  if (input.priorityRatio === null) return STATUS_LABELS.AWAITING_EFFORT;
  if (input.priorityRatio >= config.priorityHigh) return STATUS_LABELS.HIGH;
  if (input.priorityRatio >= config.priorityMedium) return STATUS_LABELS.MEDIUM;
  return STATUS_LABELS.LOW;
}

export function priorityBandLabel(band: PriorityBand | null): string {
  return band ? PRIORITY_BAND_LABELS[band] : '';
}

/**
 * Effort from the RA poker fields (§10.4). Mapping is config so it can be
 * repointed once the Backend/Frontend question is settled.
 */
export function resolveEffort(
  ticket: { backendPokerScore: number | null; frontendPokerScore: number | null; manualEffort: number | null },
  config: ScoringConfig,
): number | null {
  const backend = numberOrNull(ticket.backendPokerScore);
  const frontend = numberOrNull(ticket.frontendPokerScore);
  const manual = numberOrNull(ticket.manualEffort);

  // A coordinator-entered effort always wins - it is the manual override.
  if (manual !== null) return manual;

  switch (config.effort.mode) {
    case 'BACKEND_ONLY':
      return backend;
    case 'FRONTEND_ONLY':
      return frontend;
    case 'MANUAL':
      return null;
    case 'BACKEND_PLUS_FRONTEND':
    default: {
      if (backend === null && frontend === null) return null;
      return (backend ?? 0) + (frontend ?? 0);
    }
  }
}

function numberOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
