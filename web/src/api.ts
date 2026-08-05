export type Role = 'ADMIN' | 'COORDINATOR' | 'COMMITTEE' | 'VIEWER';
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
  execSummary: string;
  panelCurrent: string;
  panelImpacts: string;
  panelFuture: string;
  panelBenefits: string;
  screenshotUrl: string;
  originalRequestor: string;
  stream: 'ECOM' | 'IDM';
  backendPokerScore: number | null;
  frontendPokerScore: number | null;
  manualEffort: number | null;
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
  ticketCount: number;
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
  scores: Record<string, number>;
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
  cadence: {
    distributionDayOfWeek: number;
    distributionHour: number;
    cutOffDayOfWeek: number;
    cutOffHour: number;
    reminderHoursBeforeCutOff: number[];
    escalationHoursBeforeCutOff: number | null;
    timezone: string;
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
  pack: { organisation: string; deckTitle: string; closingMessage: string; accentColour: string };
}

export interface FeedbackTicket {
  jiraId: string;
  title: string;
  type: string;
  responsesCount: number;
  businessScore: number | null;
  stdDev: number | null;
  discussionRequired: boolean;
  statusLabel: string;
  priorityRatio: number | null;
  priorityBandLabel: string;
  effort: number | null;
  categoryAverages: Array<{ categoryId: string; name: string; average: number; min: number; max: number }>;
  totalsDistribution: number[];
  excludedCounts: Record<string, number>;
  notes: string[];
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
  myRound: () =>
    request<{
      round: Round | null;
      scoringOpen?: boolean;
      tickets: Ticket[];
      submissions: Submission[];
      categories: Category[];
    }>('/api/my/round'),
  myRoundSubmissions: (roundId: string) =>
    request<{ round: Round; scoringOpen: boolean; tickets: Ticket[]; submissions: Submission[]; categories: Category[] }>(
      `/api/rounds/${roundId}/my-submissions`,
    ),
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
  createRound: (input: { weekLabel: string; cutOffAt: string; stream?: string; notes?: string }) =>
    request<{ round: Round }>('/api/rounds', { method: 'POST', body: JSON.stringify(input) }),
  updateRound: (id: string, input: Partial<{ weekLabel: string; cutOffAt: string; notes: string }>) =>
    request<{ round: Round }>(`/api/rounds/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  setRoundStatus: (id: string, status: 'OPEN' | 'CLOSED' | 'FINALISED') =>
    request<{ round: Round }>(`/api/rounds/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  finaliseRound: (id: string) =>
    request<{ round: Round; results: TicketResult[] }>(`/api/rounds/${id}/finalise`, { method: 'POST', body: '{}' }),
  distribute: (id: string, attachPack: boolean) =>
    request<{ round: Round; results: Array<{ email: string; status: string; error?: string }> }>(
      `/api/rounds/${id}/distribute`,
      { method: 'POST', body: JSON.stringify({ attachPack }) },
    ),
  remind: (id: string, escalation: boolean, memberIds?: string[]) =>
    request<{ results: Array<{ email: string; status: string; error?: string }> }>(`/api/rounds/${id}/remind`, {
      method: 'POST',
      body: JSON.stringify({ escalation, memberIds }),
    }),
  writeBack: (id: string, force = false) =>
    request<{ entries: Array<{ jiraId: string; businessScore: number | null; status: string; reason?: string }> }>(
      `/api/rounds/${id}/writeback`,
      { method: 'POST', body: JSON.stringify({ force }) },
    ),
  emails: (id: string) =>
    request<{ emails: Array<{ id: string; kind: string; toAddress: string; subject: string; status: string; error: string; sentAt: string }> }>(
      `/api/rounds/${id}/emails`,
    ),
  feedback: (id: string) => request<{ round: Round; tickets: FeedbackTicket[] }>(`/api/rounds/${id}/feedback`),

  tickets: () => request<{ tickets: Ticket[] }>('/api/tickets'),
  saveTicket: (input: Partial<Ticket> & { jiraId: string; title: string; roundId?: string }) =>
    request<{ ticket: Ticket }>('/api/tickets', { method: 'POST', body: JSON.stringify(input) }),
  addTicketToRound: (roundId: string, ticketId: string) =>
    request<{ tickets: Ticket[] }>(`/api/rounds/${roundId}/tickets`, {
      method: 'POST',
      body: JSON.stringify({ ticketId }),
    }),
  removeTicketFromRound: (roundId: string, ticketId: string) =>
    request<{ tickets: Ticket[] }>(`/api/rounds/${roundId}/tickets/${ticketId}`, { method: 'DELETE' }),
  importCsv: (csv: string, roundId?: string) =>
    request<{ imported: Ticket[]; skipped: string[] }>('/api/tickets/import/csv', {
      method: 'POST',
      body: JSON.stringify({ csv, roundId }),
    }),
  importJira: (jql: string | undefined, roundId?: string) =>
    request<{ imported: Ticket[]; addedToRound: number }>('/api/tickets/import/jira', {
      method: 'POST',
      body: JSON.stringify({ jql, roundId }),
    }),

  config: () =>
    request<{
      config: AppConfig;
      categories: Category[];
      integrations: { jiraConfigured: boolean; graphConfigured: boolean; graphSendEnabled: boolean; authMode: string };
    }>('/api/config'),
  saveConfig: (section: keyof AppConfig, value: unknown) =>
    request<{ config: AppConfig }>(`/api/config/${section}`, { method: 'PUT', body: JSON.stringify(value) }),
  saveCategory: (input: Partial<Category> & { position: number; name: string }) =>
    request<{ category: Category }>('/api/categories', { method: 'POST', body: JSON.stringify(input) }),
  suggestJiraFields: () => request<{ suggestions: Record<string, string> }>('/api/jira/fields/suggest'),

  members: () => request<{ members: Member[] }>('/api/members'),
  saveMember: (input: { id?: string; name: string; email: string; team?: string; role?: Role; active?: boolean }) =>
    request<{ member: Member }>('/api/members', { method: 'POST', body: JSON.stringify(input) }),

  audit: (limit = 200) =>
    request<{ entries: Array<{ id: string; at: string; actorEmail: string; action: string; entityType: string; entityId: string; detail: unknown }> }>(
      `/api/audit?limit=${limit}`,
    ),
};

export function isCoordinator(role: Role | undefined): boolean {
  return role === 'ADMIN' || role === 'COORDINATOR';
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
