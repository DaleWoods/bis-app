/**
 * Turns a raw JIRA ticket into a first draft of the scoring card (§7).
 *
 * Pure and testable: no database, no network, no AI. It reads headings, which
 * works when a ticket is written in sections and finds very little when it is
 * not. That limit is why the AI drafter exists; this one is the fallback that
 * needs no account, no key and no approval, and it is what runs when the model
 * is unreachable.
 *
 * The other half of the job is restraint. The complaint about the current decks
 * is that they are too wordy, so every field is clipped to a length a committee
 * member will actually read, and prose is broken into at most a few short
 * bullets. The coordinator edits from there.
 */

import { CARD_LIMITS, type CardDraft, kindFromIssueType } from './card.js';

export { CARD_LIMITS } from './card.js';
export type { CardDraft } from './card.js';
export { draftIsEmpty } from './card.js';

export interface DraftSource {
  jiraId: string;
  title: string;
  type: string;
  /** Plain text flattened out of the JIRA description. */
  description: string;
  /** Flattened comments. Often where the business impact actually lives. */
  comments?: string;
  stakeholder?: string;
  affects?: string;
  impacts?: string;
  workaround?: string;
  priority?: string;
  labels?: string;
  components?: string;
  siteAffected?: string;
  environment?: string;
  linkedIssues?: string;
  createdDate?: string | null;
  /** Image filenames on the ticket, so a drafter can pick the telling one. */
  imageFilenames?: string[];
}

type PanelKey = 'current' | 'impacts' | 'future' | 'benefits';

/**
 * Headings seen in real tickets, mapped to the panel they belong in. Order
 * matters: the first pattern that matches a heading wins.
 */
const HEADING_PATTERNS: Array<{ panel: PanelKey | 'summary'; pattern: RegExp }> = [
  { panel: 'summary', pattern: /^(summary|overview|in a nutshell|tl;?dr|background)\b/i },
  { panel: 'current', pattern: /^(current|as[- ]is|problem|issue|the issue|what.?s happening|observed|actual|fault|defect|description|details?)\b/i },
  { panel: 'current', pattern: /^(steps? to reproduce|reproduction|how to reproduce)\b/i },
  { panel: 'impacts', pattern: /^(impacts?|effects?|consequences?|risks?|pain|business impact|customer impact|why it matters)\b/i },
  { panel: 'future', pattern: /^(future|to[- ]be|expected|desired|required|requirement|solution|proposed|proposal|fix|what.?s needed|acceptance criteria|definition of done)\b/i },
  { panel: 'benefits', pattern: /^(benefits?|value|outcomes?|gains?|roi|justification|why)\b/i },
];

interface Section {
  heading: string;
  body: string;
}

/** Split the description on headings. Handles "Heading:", "*Heading*", "h2. Heading" and bare lines. */
export function splitSections(description: string): Section[] {
  const lines = (description ?? '').replace(/\r\n?/g, '\n').split('\n');
  const sections: Section[] = [];
  let current: Section = { heading: '', body: '' };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = headingOf(line);
    if (heading) {
      if (current.heading || current.body.trim()) sections.push(current);
      current = { heading, body: '' };
      // "Heading: text on the same line" keeps its text.
      const inline = line.replace(/^h[1-6]\.\s*/i, '').replace(/^[*_#\s]+|[*_\s]+$/g, '');
      const afterColon = inline.slice(inline.indexOf(':') + 1).trim();
      if (inline.includes(':') && afterColon) current.body = `${afterColon}\n`;
    } else if (line) {
      current.body += `${line}\n`;
    } else {
      current.body += '\n';
    }
  }
  if (current.heading || current.body.trim()) sections.push(current);
  return sections;
}

function headingOf(line: string): string | null {
  if (!line) return null;

  // Wiki-style heading: "h2. Impact"
  const wiki = line.match(/^h[1-6]\.\s*(.+)$/i);
  if (wiki) return wiki[1].replace(/[:*_]+$/, '').trim();

  // "*Impact*" or "**Impact**" on its own line
  const emphasised = line.match(/^[*_]{1,2}([^*_]{2,60})[*_]{1,2}:?$/);
  if (emphasised) return emphasised[1].trim();

  // "Impact:" possibly followed by text
  const labelled = line.match(/^([A-Za-z][A-Za-z /&'-]{1,40}):(\s|$)/);
  if (labelled) return labelled[1].trim();

  // A short line in Title Case or ALL CAPS with no terminal punctuation
  if (line.length <= 40 && !/[.!?,;]$/.test(line) && /^[A-Z]/.test(line) && line.split(/\s+/).length <= 5) {
    return line.replace(/[:*_]+$/, '').trim();
  }
  return null;
}

/** Strip the noise that makes JIRA prose unreadable on a slide. */
export function tidy(text: string): string {
  return (text ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // markdown images
    .replace(/!\S+\.(png|jpe?g|gif|webp)(\|[^!]*)?!/gi, '') // JIRA image macros
    .replace(/\{code[^}]*\}[\s\S]*?\{code\}/gi, '')
    .replace(/\{noformat\}[\s\S]*?\{noformat\}/gi, '')
    .replace(/\[([^\]|]+)\|[^\]]+\]/g, '$1') // [text|url] -> text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/^[-*•\d.)\s]+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Cut at a sentence end where possible, otherwise a word boundary. */
export function clip(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;

  const window = clean.slice(0, max + 1);
  // A clean sentence end reads better than a mid-phrase ellipsis, as long as
  // it does not throw away most of the allowance.
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (sentenceEnd > max * 0.4) return clean.slice(0, sentenceEnd + 1).trim();

  const wordEnd = window.lastIndexOf(' ');
  return `${clean.slice(0, wordEnd > 0 ? wordEnd : max).trim()}…`;
}

/** Prose in, a few short bullets out. */
export function toBullets(text: string, maxBullets = CARD_LIMITS.bulletsPerPanel, maxLength = CARD_LIMITS.bullet): string[] {
  const cleaned = tidy(text);
  if (!cleaned) return [];

  const lines = cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // A single block of prose is split into sentences instead.
  const parts =
    lines.length > 1
      ? lines
      : cleaned
          .split(/(?<=[.!?])\s+/)
          .map((s) => s.trim())
          .filter(Boolean);

  return parts.slice(0, maxBullets).map((part) => clip(part.replace(/\.$/, ''), maxLength));
}

function firstSentences(text: string, max: number): string {
  const cleaned = tidy(text);
  if (!cleaned) return '';
  const flat = cleaned.replace(/\n+/g, ' ');
  return clip(flat, max);
}

/**
 * Build the draft. Anything that cannot be found is left blank rather than
 * padded out - an empty panel is a clear prompt to the coordinator, whereas
 * filler reads as content and gets left in.
 */
export function draftCard(source: DraftSource): CardDraft {
  const sections = splitSections(source.description ?? '');
  const buckets: Record<PanelKey | 'summary', string[]> = {
    summary: [],
    current: [],
    impacts: [],
    future: [],
    benefits: [],
  };
  const unlabelled: string[] = [];

  for (const section of sections) {
    const match = HEADING_PATTERNS.find((h) => h.pattern.test(section.heading));
    const body = section.body.trim();
    if (!body) continue;
    if (match) buckets[match.panel].push(body);
    else if (!section.heading) unlabelled.push(body);
    else unlabelled.push(`${section.heading}. ${body}`);
  }

  const leadIn = buckets.summary.join('\n') || unlabelled.join('\n') || buckets.current.join('\n');

  const panelText = (key: PanelKey, fallback = ''): string => {
    const raw = buckets[key].join('\n') || fallback;
    const bullets = toBullets(raw);
    return clip(bullets.join('\n'), CARD_LIMITS.panel);
  };

  return {
    kind: kindFromIssueType(source.type),
    execSummary: firstSentences(leadIn || source.title, CARD_LIMITS.execSummary),
    // With nothing labelled, unlabelled prose is more likely to describe the
    // problem than anything else, so it seeds "Current" only.
    panelCurrent: panelText('current', buckets.current.length ? '' : unlabelled.join('\n')),
    panelImpacts: panelText('impacts', source.impacts ?? ''),
    panelFuture: panelText('future'),
    // A single line on the slide now, not a column of bullets.
    panelBenefits: firstSentences(buckets.benefits.join('\n'), CARD_LIMITS.benefit),
    // Reading a figure out of prose is exactly the judgement a regex cannot
    // make, so this drafter leaves the impact chips and the caption to the
    // coordinator rather than guessing.
    impactFacts: '',
    screenshotCaption: '',
  };
}
