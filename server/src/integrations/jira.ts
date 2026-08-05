import { env } from '../config/env.js';
import { JiraConfig } from '../domain/types.js';
import { TicketInput } from '../services/ticketService.js';

/**
 * JIRA Cloud REST integration (§12.1).
 * Credentials come from a service account / API token in configuration -
 * never hard-coded, never a personal login.
 */

export class JiraNotConfiguredError extends Error {
  constructor() {
    super('JIRA is not configured. Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.');
    this.name = 'JiraNotConfiguredError';
  }
}

export class JiraApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'JiraApiError';
  }
}

function authHeader(): string {
  const token = Buffer.from(`${env.jira.email}:${env.jira.apiToken}`).toString('base64');
  return `Basic ${token}`;
}

async function jiraFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!env.jira.configured) throw new JiraNotConfiguredError();
  const res = await fetch(`${env.jira.baseUrl}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: authHeader(),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new JiraApiError(res.status, `JIRA ${init.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type?: string };
}

/**
 * §12.1 action for build: resolve the real customfield_XXXXX ids and store them
 * in config, rather than guessing them.
 */
export async function listFields(): Promise<JiraField[]> {
  return jiraFetch<JiraField[]>('/rest/api/3/field');
}

/** Best-effort field lookup by display name, used to pre-fill the config screen. */
export async function suggestFieldIds(): Promise<Record<string, string>> {
  const fields = await listFields();
  const find = (name: string) =>
    fields.find((f) => f.name.trim().toLowerCase() === name.toLowerCase())?.id ?? '';
  return {
    businessScoreFieldId: find('Business Score'),
    backendFieldId: find('Backend Poker Score'),
    frontendFieldId: find('Frontend Poker Score'),
    siteAffectedFieldId: find('Site Affected'),
    originalTestingEnvironmentFieldId: find('Original Testing Environment'),
    ticketPhaseFieldId: find('Ticket Phase'),
  };
}

interface JiraIssue {
  key: string;
  fields: Record<string, any>;
}

interface SearchResponse {
  issues?: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

/** Read the Business Scoring queue (§12.1). */
export async function searchQueue(
  jiraConfig: JiraConfig,
  effortFields: { backendFieldId: string; frontendFieldId: string },
  options: { jql?: string; maxResults?: number } = {},
): Promise<TicketInput[]> {
  const jql = options.jql?.trim() || jiraConfig.queueJql;
  const fields = [
    'summary',
    'issuetype',
    'status',
    'created',
    'reporter',
    'description',
    'environment',
    jiraConfig.siteAffectedFieldId,
    jiraConfig.originalTestingEnvironmentFieldId,
    jiraConfig.ticketPhaseFieldId,
    effortFields.backendFieldId,
    effortFields.frontendFieldId,
  ].filter(Boolean);

  const body = JSON.stringify({ jql, fields, maxResults: Math.min(options.maxResults ?? 50, 100) });

  // Jira Cloud's newer endpoint; fall back to the classic one for older sites.
  let response: SearchResponse;
  try {
    response = await jiraFetch<SearchResponse>('/rest/api/3/search/jql', { method: 'POST', body });
  } catch (err) {
    if (err instanceof JiraApiError && (err.status === 404 || err.status === 410)) {
      response = await jiraFetch<SearchResponse>('/rest/api/3/search', { method: 'POST', body });
    } else {
      throw err;
    }
  }

  return (response.issues ?? []).map((issue) => mapIssue(issue, jiraConfig, effortFields));
}

export async function getIssue(
  key: string,
  jiraConfig: JiraConfig,
  effortFields: { backendFieldId: string; frontendFieldId: string },
): Promise<TicketInput> {
  const issue = await jiraFetch<JiraIssue>(`/rest/api/3/issue/${encodeURIComponent(key)}`);
  return mapIssue(issue, jiraConfig, effortFields);
}

export function mapIssue(
  issue: JiraIssue,
  jiraConfig: JiraConfig,
  effortFields: { backendFieldId: string; frontendFieldId: string },
): TicketInput {
  const fields = issue.fields ?? {};
  const custom = (id: string) => (id ? fields[id] : undefined);
  return {
    jiraId: issue.key,
    title: fields.summary ?? issue.key,
    type: fields.issuetype?.name ?? '',
    jiraStatus: fields.status?.name ?? '',
    createdDate: fields.created ?? null,
    stakeholder: fields.reporter?.displayName ?? '',
    originalRequestor: (fields.reporter?.emailAddress ?? '').toLowerCase(),
    rawDescription: adfToText(fields.description),
    siteAffected: valueOf(custom(jiraConfig.siteAffectedFieldId)),
    originalTestingEnvironment:
      valueOf(custom(jiraConfig.originalTestingEnvironmentFieldId)) || (fields.environment ? adfToText(fields.environment) : ''),
    backendPokerScore: numberOf(custom(effortFields.backendFieldId)),
    frontendPokerScore: numberOf(custom(effortFields.frontendFieldId)),
    jiraSyncedAt: new Date().toISOString(),
  };
}

/** §12.1 write: the computed integer business score to the Business Score field. */
export async function writeBusinessScore(key: string, fieldId: string, score: number): Promise<void> {
  if (!fieldId) throw new Error('No JIRA Business Score field id configured');
  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ fields: { [fieldId]: score } }),
  });
}

/** Optional status transition on finalisation (§12.1, §13.2 - off by default). */
export async function transitionIssue(key: string, transitionName: string): Promise<string> {
  const { transitions } = await jiraFetch<{ transitions: Array<{ id: string; name: string; to?: { name?: string } }> }>(
    `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
  );
  const match = transitions.find(
    (t) =>
      t.name.toLowerCase() === transitionName.toLowerCase() ||
      (t.to?.name ?? '').toLowerCase() === transitionName.toLowerCase(),
  );
  if (!match) throw new Error(`No transition to "${transitionName}" available on ${key}`);
  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: match.id } }),
  });
  return match.name;
}

function valueOf(field: unknown): string {
  if (field === null || field === undefined) return '';
  if (typeof field === 'string' || typeof field === 'number') return String(field);
  if (Array.isArray(field)) return field.map(valueOf).filter(Boolean).join(', ');
  if (typeof field === 'object') {
    const record = field as Record<string, unknown>;
    return String(record.value ?? record.name ?? record.displayName ?? '');
  }
  return '';
}

function numberOf(field: unknown): number | null {
  if (field === null || field === undefined) return null;
  const n = Number(typeof field === 'object' ? (field as any).value : field);
  return Number.isFinite(n) ? n : null;
}

/** Flatten Atlassian Document Format into plain text for the ticket card. */
export function adfToText(node: unknown): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const doc = node as { type?: string; text?: string; content?: unknown[] };
  if (typeof doc.text === 'string') return doc.text;
  const children = Array.isArray(doc.content) ? doc.content.map(adfToText).join('') : '';
  const isBlock = ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'rule'].includes(doc.type ?? '');
  return isBlock ? `${children}\n` : children;
}
