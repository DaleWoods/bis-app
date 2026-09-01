/**
 * Two roles: ADMIN runs the process, COMMITTEE scores. Mirrors
 * server/src/domain/types.ts; see docs/decisions.md D7.
 */
export const ROLES = ['ADMIN', 'COMMITTEE'] as const;
export type Role = (typeof ROLES)[number];
export type RoundStatus = 'DRAFT' | 'OPEN' | 'CLOSED' | 'FINALISED';
export type Relevance = 'YES' | 'UNSURE' | 'NO_CLOSE' | 'NO_NOT_RELEVANT_TODAY';

export interface Member {
  id: string;
  name: string;
  email: string;
  team: string;
  role: Role;
  active: boolean;
  lastLoginAt: string | null;
}

/** What the sign-in picker shows: no email addresses leave the server. */
export interface SignInMember {
  id: string;
  name: string;
  team: string;
  role: Role;
}

export interface Category {
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

export type { CardKind } from './card';
import type { CardKind } from './card';

export interface Ticket {
  id: string;
  jiraId: string;
  title: string;
  type: string;
  jiraStatus: string;
  createdDate: string | null;
  stakeholder: string;
  affects: string;
  impacts: string;
  workaround: string;
  siteAffected: string;
  originalTestingEnvironment: string;
  rawDescription: string;
  rawComments: string;
  priority: string;
  labels: string;
  components: string;
  linkedIssues: string;
  cardKind: CardKind | '';
  execSummary: string;
  panelCurrent: string;
  panelImpacts: string;
  panelFuture: string;
  panelBenefits: string;
  impactFacts: string;
  screenshotCaption: string;
  screenshotUrl: string;
  originalRequestor: string;
  stream: 'ECOM' | 'IDM';
  backendPokerScore: number | null;
  frontendPokerScore: number | null;
  manualEffort: number | null;
  attachments: TicketAttachment[];
  screenshotAttachmentId: string;
  /** Set when this ticket came from a round: held back from the committee at distribution. */
  held?: boolean;
  heldReason?: string;
}

export interface TicketAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  isImage: boolean;
}

export interface Round {
  id: string;
  weekLabel: string;
  cutOffAt: string;
  status: RoundStatus;
  stream: 'ECOM' | 'IDM';
  notes: string;
  distributionSentAt: string | null;
  finalisedAt: string | null;
  /** Start of the scoring window. Null = the round waits for a person. */
  opensAt: string | null;
  automationPaused: boolean;
  ticketCount: number;
}

export interface WriteBackEntry {
  jiraId: string;
  businessScore: number | null;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  /** Why it was skipped or how it failed. The useful half of the answer. */
  reason?: string;
  transitionedTo?: string;
  /** Which override, if any, actually applies to this skip. */
  overridable?: 'MIN_SUBMISSIONS' | 'ALREADY_WRITTEN';
}

export interface AutomationStatus {
  /** What the app will do to this round next, in plain English. */
  next: string;
  paused: boolean;
  enabled: boolean;
  log: Array<{ action: string; ranAt: string; outcome: string; detail: string }>;
}

export interface Submission {
  id: string;
  roundId: string;
  ticketId: string;
  memberId: string;
  memberName?: string;
  relevance: Relevance;
  closureReason: string;
  closureInfo: string;
  moreInfo: string;
  archived: boolean;
  scores: Record<string, number>;
  /** When the score was given. A score cannot be revised, so this is the score's own date. */
  submittedAt: string;
  updatedAt: string;
}

export interface Aggregate {
  responsesCount: number;
  submissionsCount: number;
  businessScore: number | null;
  businessScoreRaw: number | null;
  stdDev: number | null;
  discussionRequired: boolean;
  toClose: boolean;
  clarificationRequested: boolean;
  parkRequested: boolean;
  effort: number | null;
  priorityRatio: number | null;
  priorityBand: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  statusLabel: string;
  sendForEstimation: boolean;
  minSubmissionsMet: boolean;
  categoryAverages: Array<{ categoryId: string; name: string; average: number; min: number; max: number }>;
  totalsDistribution: number[];
  excludedCounts: Record<Relevance, number>;
}

export interface TicketResult {
  ticket: Ticket;
  aggregate: Aggregate;
}

export interface MemberProgress {
  memberId: string;
  memberName: string;
  memberEmail: string;
  team: string;
  submitted: number;
  outstanding: number;
  lastSubmittedAt: string | null;
  complete: boolean;
}

/**
 * This round's completion, plus the reader's own record within it. `completed`
 * and `total` are a count and never who; `yourPosition` and `streak` are the
 * reader's own and nobody else's.
 */
export interface Participation {
  completed: number;
  total: number;
  /** Where you came in among those who have finished; null until you have. */
  yourPosition: number | null;
  /** Finalised rounds in a row you finished, before this one. */
  streak: number;
}

/**
 * What somebody's scoring has moved, across every finalised round. The answer
 * to "does any of this actually go anywhere".
 */
export interface MemberRecord {
  roundsScored: number;
  ticketsScored: number;
  sentForEstimation: number;
}

export type QueueName = 'FRONTEND' | 'BACKEND';

export interface RankedTicket {
  key: string;
  summary: string;
  status: string;
  businessScore: number;
  frontendEffort: number;
  backendEffort: number;
  /** Standard competition rank - ties share a place and the next one skips. */
  rank: number;
}

/**
 * Where the scored tickets currently sit in the dev queue. Never stored -
 * recomputed from JIRA on every read, because a position stops being true the
 * moment anything is built or estimated.
 */
export interface QueueView {
  available: boolean;
  reason?: 'DISABLED' | 'JIRA_NOT_CONFIGURED' | 'FIELDS_NOT_SET';
  split: {
    frontend: RankedTicket[];
    backend: RankedTicket[];
    /** Scored and waiting, but with no effort on either side, so in no queue. */
    notQueued: Array<Omit<RankedTicket, 'rank'>>;
  };
  unscored: number;
  fetchedAt: string;
}

export interface ScoringModel {
  categories: Category[];
  relevanceOptions: Array<{ value: Relevance; label: string }>;
  closureReasons: string[];
  thresholds: {
    minSubmissions: number;
    stdDevDiscussionThreshold: number;
    priorityHigh: number;
    priorityMedium: number;
  };
}

export interface AppConfig {
  scoring: {
    minSubmissions: number;
    stdDevDiscussionThreshold: number;
    priorityHigh: number;
    priorityMedium: number;
    applyCategoryWeights: boolean;
    effort: { mode: string; backendFieldId: string; frontendFieldId: string };
    closureReasons: string[];
  };
  automation: {
    enabled: boolean;
    createRounds: boolean;
    importFromJira: boolean;
    rollOverUnscored: boolean;
    distribute: boolean;
    remind: boolean;
    close: boolean;
    finalise: boolean;
    finaliseDelayHours: number;
    writeBack: boolean;
  };
  cadence: {
    distributionDayOfWeek: number;
    distributionHour: number;
    distributionMinute: number;
    cutOffDayOfWeek: number;
    cutOffHour: number;
    cutOffMinute: number;
    reminderMinutesBeforeCutOff: number[];
    escalationMinutesBeforeCutOff: number | null;
    timezone: string;
    nextRoundOverride: { opensAt: string; cutOffAt: string } | null;
  };
  queue: {
    hopperJql: string;
    enabled: boolean;
  };
  jira: {
    queueJql: string;
    businessScoreFieldId: string;
    siteAffectedFieldId: string;
    originalTestingEnvironmentFieldId: string;
    ticketPhaseFieldId: string;
    transitionOnFinalise: boolean;
    transitionName: string;
  };
}

export interface FeedbackTicket {
  jiraId: string;
  title: string;
  type: string;
  responsesCount: number;
  /** The minimum in force when the round was decided; absent on older rounds. */
  minSubmissions?: number;
  businessScore: number | null;
  stdDev: number | null;
  discussionRequired: boolean;
  statusLabel: string;
  /** What actually happened to the ticket - "Sent for estimation" etc, not a priority label. */
  resultLabel: string;
  priorityRatio: number | null;
  priorityBandLabel: string;
  effort: number | null;
  categoryAverages: Array<{ categoryId: string; name: string; average: number; min: number; max: number }>;
  totalsDistribution: number[];
  excludedCounts: Record<string, number>;
  notes: string[];
  /** What the meeting about a split ticket decided. Empty when there was no meeting. */
  discussionOutcome: string;
  discussionNote: string;
  agreedScore: number | null;
  /** Your own answer. Null when you did not score it, or answered anything but Yes. */
  yourTotal: number | null;
  yourRelevance: string;
  /** Where the ticket came in the round, 1 = highest business score. */
  rank: number;
}

export const DISCUSSION_OUTCOMES = ['AGREED', 'RESCORE', 'CLOSE'] as const;
export type DiscussionOutcome = (typeof DISCUSSION_OUTCOMES)[number];

export const DISCUSSION_OUTCOME_LABELS: Record<DiscussionOutcome, string> = {
  AGREED: 'Agreed a score',
  RESCORE: 'Score it again next round',
  CLOSE: 'Close the ticket',
};

export interface Discussion {
  roundId: string;
  ticketId: string;
  meetingAt: string | null;
  outcome: DiscussionOutcome | '';
  agreedScore: number | null;
  note: string;
  openedAt: string;
  resolvedAt: string | null;
  resolvedBy: string;
}

export interface DiscussionItem {
  ticketId: string;
  jiraId: string;
  title: string;
  responsesCount: number;
  calculatedScore: number | null;
  stdDev: number | null;
  lowest: number | null;
  highest: number | null;
  totals: number[];
  notes: string[];
  discussion: Discussion | null;
  blockingWriteBack: boolean;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  authMode: () =>
    request<{ mode: 'entra' | 'email'; selfRegistration: boolean; tenantConfigured: boolean }>('/auth/mode'),
  signInMembers: () => request<{ members: SignInMember[] }>('/auth/members'),
  signIn: (payload: { memberId?: string; email?: string; name?: string }) =>
    request<{ member: Member }>('/auth/sign-in', { method: 'POST', body: JSON.stringify(payload) }),
  logout: () => request<{ ok: boolean; signOutUrl: string | null }>('/auth/logout', { method: 'POST' }),
  me: () => request<{ member: Member }>('/api/me'),

  scoringModel: () => request<ScoringModel>('/api/scoring-model'),
  queue: () => request<QueueView>('/api/queue'),
  myRound: () =>
    request<{
      round: Round | null;
      /** The round to look back at, whether or not one is currently open. */
      lastFinalised?: Round | null;
      /** Whether you scored anything (that still counts) in lastFinalised. */
      lastFinalisedIncludesYou?: boolean;
      canScore: boolean;
      scoringOpen?: boolean;
      tickets: Ticket[];
      submissions: Submission[];
      categories: Category[];
      /** How many of the committee have finished so far, and your own record. */
      participation?: Participation;
      record?: MemberRecord;
    }>('/api/my/round'),
  roundParticipation: (limit = 8) =>
    request<{
      participation: Array<{ memberId: string; memberName: string; team: string; roundsCompleted: number; roundsConsidered: number }>;
    }>(`/api/rounds/participation?limit=${limit}`),
  myRoundSubmissions: (roundId: string) =>
    request<{
      round: Round;
      canScore: boolean;
      scoringOpen: boolean;
      tickets: Ticket[];
      submissions: Submission[];
      categories: Category[];
      participation?: Participation;
    }>(`/api/rounds/${roundId}/my-submissions`),
  saveSubmission: (
    roundId: string,
    ticketId: string,
    payload: { relevance: Relevance; scores?: Record<string, number>; closureReason?: string; closureInfo?: string; moreInfo?: string },
  ) =>
    request<{ submission: Submission }>(`/api/rounds/${roundId}/tickets/${ticketId}/submission`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  rounds: () => request<{ rounds: Round[] }>('/api/rounds'),
  round: (id: string) =>
    request<{
      round: Round;
      tickets: Ticket[];
      categories: Category[];
      progress?: MemberProgress[];
      results?: TicketResult[];
      submissions?: Submission[];
    }>(`/api/rounds/${id}`),
  createRound: (input: { weekLabel: string; cutOffAt: string; opensAt?: string | null; stream?: string; notes?: string }) =>
    request<{ round: Round }>('/api/rounds', { method: 'POST', body: JSON.stringify(input) }),
  updateRound: (id: string, input: Partial<{ weekLabel: string; cutOffAt: string; opensAt: string | null; notes: string }>) =>
    request<{ round: Round }>(`/api/rounds/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  setRoundStatus: (id: string, status: 'OPEN' | 'CLOSED' | 'FINALISED') =>
    request<{ round: Round }>(`/api/rounds/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  finaliseRound: (id: string) =>
    request<{ round: Round; results: TicketResult[] }>(`/api/rounds/${id}/finalise`, { method: 'POST', body: '{}' }),
  distribute: (id: string) =>
    request<{ round: Round; results: Array<{ email: string; status: string; error?: string }> }>(
      `/api/rounds/${id}/distribute`,
      { method: 'POST', body: '{}' },
    ),
  remind: (id: string, escalation: boolean, memberIds?: string[]) =>
    request<{ results: Array<{ email: string; status: string; error?: string }> }>(`/api/rounds/${id}/remind`, {
      method: 'POST',
      body: JSON.stringify({ escalation, memberIds }),
    }),
  automationStatus: (id: string) => request<AutomationStatus>(`/api/rounds/${id}/automation`),
  runAutomation: () =>
    request<{ ranAt: string; steps: Array<{ weekLabel: string; action: string; outcome: string }>; skipped?: string }>(
      '/api/automation/run',
      { method: 'POST', body: '{}' },
    ),
  setRoundAutomation: (id: string, automationPaused: boolean) =>
    request<{ round: Round }>(`/api/rounds/${id}`, { method: 'PUT', body: JSON.stringify({ automationPaused }) }),
  writeBack: (id: string, options: { force?: boolean; ignoreMinSubmissions?: boolean } = {}) =>
    request<{ entries: WriteBackEntry[] }>(`/api/rounds/${id}/writeback`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),
  emails: (id: string) =>
    request<{ emails: Array<{ id: string; kind: string; toAddress: string; subject: string; status: string; error: string; sentAt: string }> }>(
      `/api/rounds/${id}/emails`,
    ),
  archiveSubmission: (roundId: string, submissionId: string, archived: boolean) =>
    request<{ submissions: Submission[] }>(`/api/rounds/${roundId}/submissions/${submissionId}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived }),
    }),
  feedback: (id: string) => request<{ round: Round; tickets: FeedbackTicket[] }>(`/api/rounds/${id}/feedback`),
  recalculateRound: (id: string) =>
    request<{ round: Round; results: TicketResult[]; scoresChanged: number; newlySplit: string[] }>(
      `/api/rounds/${id}/recalculate`,
      { method: 'POST', body: '{}' },
    ),
  discussions: (id: string) => request<{ round: Round; items: DiscussionItem[] }>(`/api/rounds/${id}/discussions`),
  recordDiscussion: (
    roundId: string,
    ticketId: string,
    payload: { outcome?: DiscussionOutcome | ''; agreedScore?: number | null; meetingAt?: string | null; note?: string },
  ) =>
    request<{ discussion: Discussion; rescoredInto: { id: string; weekLabel: string } | null; items: DiscussionItem[] }>(
      `/api/rounds/${roundId}/discussions/${ticketId}`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  tickets: () => request<{ tickets: Ticket[] }>('/api/tickets'),
  saveTicket: (input: Partial<Ticket> & { jiraId: string; title: string; roundId?: string }) =>
    request<{ ticket: Ticket }>('/api/tickets', { method: 'POST', body: JSON.stringify(input) }),
  redraftTicket: (id: string) =>
    request<{ ticket: Ticket; empty: boolean; drafter: 'ai' | 'text' }>(`/api/tickets/${id}/redraft`, {
      method: 'POST',
      body: '{}',
    }),
  addTicketToRound: (roundId: string, ticketId: string) =>
    request<{ tickets: Ticket[] }>(`/api/rounds/${roundId}/tickets`, {
      method: 'POST',
      body: JSON.stringify({ ticketId }),
    }),
  removeTicketFromRound: (roundId: string, ticketId: string) =>
    request<{ tickets: Ticket[]; submissionsRemoved: number }>(`/api/rounds/${roundId}/tickets/${ticketId}`, {
      method: 'DELETE',
    }),
  releaseTicket: (roundId: string, ticketId: string) =>
    request<{ tickets: Ticket[] }>(`/api/rounds/${roundId}/tickets/${ticketId}/release`, { method: 'POST', body: '{}' }),
  importCsv: (csv: string, roundId?: string) =>
    request<{ imported: Ticket[]; skipped: string[] }>('/api/tickets/import/csv', {
      method: 'POST',
      body: JSON.stringify({ csv, roundId }),
    }),
  importJira: (jql: string | undefined, roundId?: string) =>
    request<{
      imported: Ticket[];
      addedToRound: number;
      jql: string;
      aiDrafted: number;
      possibleDuplicates: Array<{ jiraId: string; title: string; similarTo: Array<{ jiraId: string; title: string }> }>;
    }>('/api/tickets/import/jira', {
      method: 'POST',
      body: JSON.stringify({ jql, roundId }),
    }),

  config: () =>
    request<{
      config: AppConfig;
      categories: Category[];
      integrations: {
        jiraConfigured: boolean;
        graphConfigured: boolean;
        emailProvider: 'smtp' | 'graph' | 'none';
        emailProviderLabel: string;
        emailFrom: string;
        emailReplyTo: string;
        smtpHost: string;
        graphSendEnabled: boolean;
        authMode: string;
        aiDrafting: boolean;
        aiModel: string;
      };
    }>('/api/config'),
  saveConfig: (section: keyof AppConfig, value: unknown) =>
    request<{ config: AppConfig }>(`/api/config/${section}`, { method: 'PUT', body: JSON.stringify(value) }),
  restoreDefaultCategories: () =>
    request<{ categories: Category[] }>('/api/categories/restore-defaults', { method: 'POST', body: '{}' }),
  saveCategory: (input: Partial<Category> & { position: number; name: string }) =>
    request<{ category: Category }>('/api/categories', { method: 'POST', body: JSON.stringify(input) }),
  suggestJiraFields: () => request<{ suggestions: Record<string, string> }>('/api/jira/fields/suggest'),
  jiraTransitions: (jiraId?: string) =>
    request<{ jiraId: string; transitions: Array<{ name: string; toStatus: string }> }>(
      `/api/jira/transitions${jiraId ? `?jiraId=${encodeURIComponent(jiraId)}` : ''}`,
    ),
  sendTestEmail: (to?: string) =>
    request<{ status: string; provider: string; to: string; error?: string }>('/api/email/test', {
      method: 'POST',
      body: JSON.stringify({ to }),
    }),

  members: () => request<{ members: Member[] }>('/api/members'),
  saveMember: (input: { id?: string; name: string; email: string; team?: string; role?: Role; active?: boolean }) =>
    request<{ member: Member }>('/api/members', { method: 'POST', body: JSON.stringify(input) }),

  deleteMember: (id: string, force = false) =>
    request<{ ok: boolean; submissionsRemoved: number }>(`/api/members/${id}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    }),
  memberSubmissionCount: (id: string) => request<{ count: number }>(`/api/members/${id}/submission-count`),

  resetData: (confirm: string) =>
    request<{ counts: Record<string, number> }>('/api/admin/reset-data', {
      method: 'POST',
      body: JSON.stringify({ confirm }),
    }),

  deleteRound: (id: string) =>
    request<{ deleted: { weekLabel: string; tickets: number; submissions: number; writebacks: number } }>(
      `/api/admin/rounds/${id}/delete`,
      { method: 'POST', body: '{}' },
    ),

  audit: (limit = 200) =>
    request<{ entries: Array<{ id: string; at: string; actorEmail: string; action: string; entityType: string; entityId: string; detail: unknown }> }>(
      `/api/audit?limit=${limit}`,
    ),
};

export function isCoordinator(role: Role | undefined): boolean {
  return role === 'ADMIN';
}

/** Only committee members score; coordinators run the round, viewers read it. */
export function canScore(role: Role | undefined): boolean {
  return role === 'COMMITTEE';
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

/** A Date as the local (not UTC) `YYYY-MM-DDTHH:mm` an `<input type="datetime-local">` expects. */
export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
