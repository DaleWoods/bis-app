/** Roles (§4). RBAC is enforced server-side on every route. */
export const ROLES = ['ADMIN', 'COORDINATOR', 'COMMITTEE', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

export function isCoordinator(role: Role): boolean {
  return role === 'ADMIN' || role === 'COORDINATOR';
}

export const ROUND_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'FINALISED'] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

export const STREAMS = ['ECOM', 'IDM'] as const;
export type Stream = (typeof STREAMS)[number];

/**
 * §8 relevance answers - the scoring form's first question.
 * Only YES submissions feed the score (§10.1).
 */
export const RELEVANCE_VALUES = ['YES', 'UNSURE', 'NO_CLOSE', 'NO_NOT_RELEVANT_TODAY'] as const;
export type Relevance = (typeof RELEVANCE_VALUES)[number];

export const RELEVANCE_LABELS: Record<Relevance, string> = {
  YES: 'Yes – It aligns with Business Strategy',
  UNSURE: "Unsure – I will skip scoring as I don't understand the request",
  NO_CLOSE: 'No – This ticket can be closed',
  NO_NOT_RELEVANT_TODAY: "No – This ticket isn't relevant today",
};

/** Answers that require a reason for closure / parking (§8). */
export const RELEVANCE_REQUIRING_REASON: Relevance[] = ['NO_CLOSE', 'NO_NOT_RELEVANT_TODAY'];

/** Only the original requestor may say "isn't relevant today" (§8). */
export const RELEVANCE_REQUESTOR_ONLY: Relevance[] = ['NO_NOT_RELEVANT_TODAY'];

export type PriorityBand = 'HIGH' | 'MEDIUM' | 'LOW';

export const PRIORITY_BAND_LABELS: Record<PriorityBand, string> = {
  HIGH: 'High priority',
  MEDIUM: 'Medium priority',
  LOW: 'Low priority',
};

/** Status labels reproduce the spreadsheet's progress gate verbatim (§10.3). */
export const STATUS_LABELS = {
  NONE: '',
  AWAITING_RESPONSES: 'Awaiting WOSG Responses',
  TO_CLOSE: 'To Close?',
  AWAITING_EFFORT: 'Awaiting RA effort',
  PENDING_DISCUSSION: 'Pending discussion',
  HIGH: PRIORITY_BAND_LABELS.HIGH,
  MEDIUM: PRIORITY_BAND_LABELS.MEDIUM,
  LOW: PRIORITY_BAND_LABELS.LOW,
} as const;

export type StatusLabel = (typeof STATUS_LABELS)[keyof typeof STATUS_LABELS];

export interface CategoryDef {
  id: string;
  position: number;
  name: string;
  description: string;
  zeroLabel: string;
  maxLabel: string;
  weight: number;
  scaleMin: number;
  scaleMax: number;
  active: boolean;
}

/**
 * How `effort` is derived from JIRA (§10.4 - residual question 1).
 * Configurable so it can be pointed at the right field(s) without a rewrite.
 */
export type EffortMode = 'BACKEND_PLUS_FRONTEND' | 'BACKEND_ONLY' | 'FRONTEND_ONLY' | 'MANUAL';

export interface EffortConfig {
  mode: EffortMode;
  /** JIRA custom field ids resolved via GET /rest/api/3/field (§12.1). */
  backendFieldId: string;
  frontendFieldId: string;
}

/** Everything the §10 maths needs. Persisted in app_config, editable in-app (§14). */
export interface ScoringConfig {
  minSubmissions: number;             // MIN_SUBMISSIONS = 5
  stdDevDiscussionThreshold: number;  // STD_DEV_DISCUSSION_THRESHOLD = 16
  priorityHigh: number;               // PRIORITY_HIGH = 6
  priorityMedium: number;             // PRIORITY_MEDIUM = 1.8
  /** Straight sum today (§13.3); weights are supported when wanted. */
  applyCategoryWeights: boolean;
  effort: EffortConfig;
  closureReasons: string[];
}

export interface CadenceConfig {
  /** 0=Sunday .. 6=Saturday. Not hard-coded weekdays (§11). */
  distributionDayOfWeek: number;
  distributionHour: number;
  cutOffDayOfWeek: number;
  cutOffHour: number;
  /** Hours before cut-off at which reminders fire, e.g. [48, 24, 4]. */
  reminderHoursBeforeCutOff: number[];
  escalationHoursBeforeCutOff: number | null;
  timezone: string;
}

export interface JiraConfig {
  /** JQL that defines the Business Scoring queue (§12.1). */
  queueJql: string;
  businessScoreFieldId: string;
  siteAffectedFieldId: string;
  originalTestingEnvironmentFieldId: string;
  ticketPhaseFieldId: string;
  /** Foundation default: write the score only (§13.2). */
  transitionOnFinalise: boolean;
  transitionName: string;
}

export interface PackConfig {
  organisation: string;
  deckTitle: string;
  closingMessage: string;
  accentColour: string;
}

export interface AppConfig {
  scoring: ScoringConfig;
  cadence: CadenceConfig;
  jira: JiraConfig;
  pack: PackConfig;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  minSubmissions: 5,
  stdDevDiscussionThreshold: 16,
  priorityHigh: 6,
  priorityMedium: 1.8,
  applyCategoryWeights: false,
  effort: {
    // §10.4 residual question - defaulted to the combined poker total and
    // switchable in Settings without a code change.
    mode: 'BACKEND_PLUS_FRONTEND',
    backendFieldId: '',
    frontendFieldId: '',
  },
  closureReasons: ['Postponed', 'Fixed via other means', 'No Longer Required'],
};

export const DEFAULT_CADENCE_CONFIG: CadenceConfig = {
  distributionDayOfWeek: 4, // Thursday send, per the weekly rhythm in §11
  distributionHour: 9,
  cutOffDayOfWeek: 2, // Tuesday cut-off (COP Tue)
  cutOffHour: 17,
  reminderHoursBeforeCutOff: [48, 24, 4],
  escalationHoursBeforeCutOff: 2,
  timezone: 'Europe/London',
};

export const DEFAULT_JIRA_CONFIG: JiraConfig = {
  queueJql: 'status = "WOSG: Business Scoring" ORDER BY created ASC',
  businessScoreFieldId: '',
  siteAffectedFieldId: '',
  originalTestingEnvironmentFieldId: '',
  ticketPhaseFieldId: '',
  transitionOnFinalise: false,
  transitionName: 'RA: Ready for Estimation',
};

export const DEFAULT_PACK_CONFIG: PackConfig = {
  organisation: 'WOSG',
  deckTitle: 'Business Impact Scoring',
  closingMessage: 'Thank you – please submit your scores before the cut-off.',
  accentColour: '1F4E79',
};

export const DEFAULT_APP_CONFIG: AppConfig = {
  scoring: DEFAULT_SCORING_CONFIG,
  cadence: DEFAULT_CADENCE_CONFIG,
  jira: DEFAULT_JIRA_CONFIG,
  pack: DEFAULT_PACK_CONFIG,
};

/** The seven categories of §6. Seeded as data, editable thereafter. */
export const SEED_CATEGORIES: Array<Omit<CategoryDef, 'id'> & { id: string }> = [
  {
    id: 'commercial-impact',
    position: 1,
    name: 'Commercial Impact',
    description: 'Revenue generation or cost savings',
    zeroLabel: 'N/A',
    maxLabel: 'Highly Impacted',
    weight: 1,
    scaleMin: 0,
    scaleMax: 10,
    active: true,
  },
  {
    id: 'operational-impact',
    position: 2,
    name: 'Operational Impact',
    description:
      'Reduces manual effort, speeds up workflows, automates repetitive tasks for system users / support colleagues',
    zeroLabel: 'Not Impacted',
    maxLabel: 'Highly Impacted',
    weight: 1,
    scaleMin: 0,
    scaleMax: 10,
    active: true,
  },
  {
    id: 'support-strain',
    position: 3,
    name: 'Support Strain',
    description: 'Reduces customer service or internal support demand',
    zeroLabel: 'Not Impacted',
    maxLabel: 'Highly Impacted',
    weight: 1,
    scaleMin: 0,
    scaleMax: 10,
    active: true,
  },
  {
    id: 'client-user-impact',
    position: 4,
    name: 'Client / User Impact',
    description: 'Improves UX/UI or end-user satisfaction, including accessibility initiatives',
    zeroLabel: 'Not Impacted',
    maxLabel: 'Highly Impacted',
    weight: 1,
    scaleMin: 0,
    scaleMax: 10,
    active: true,
  },
  {
    id: 'strategic-alignment',
    position: 5,
    name: 'Strategic Alignment',
    description: 'Aligns with Objectives & Key Results, board priorities, or long-term business goals',
    zeroLabel: 'Not Impacted',
    maxLabel: 'Highly Impacted',
    weight: 1,
    scaleMin: 0,
    scaleMax: 10,
    active: true,
  },
  {
    id: 'data-reporting-value',
    position: 6,
    name: 'Data & Reporting Value',
    description: 'Enhances analytics, attribution, or operational insights',
    zeroLabel: 'Not Impacted',
    maxLabel: 'Highly Impacted',
    weight: 1,
    scaleMin: 0,
    scaleMax: 10,
    active: true,
  },
  {
    id: 'reputational-brand-risk',
    position: 7,
    name: 'Reputational / Brand Risk',
    description: 'Prevents reputational harm or enhances brand trust',
    zeroLabel: 'Not Impacted',
    maxLabel: 'Highly Impacted',
    weight: 1,
    scaleMin: 0,
    scaleMax: 10,
    active: true,
  },
];
