import { describe, expect, it } from 'vitest';
import { CARD_KINDS } from '../domain/card.js';
import { ticketSchema } from './tickets.js';

/**
 * The save schema against the fields the editor actually sends.
 *
 * zod strips keys it does not know about, so a card field added to the editor
 * and not to the schema is discarded on save with no error anywhere — which is
 * exactly what happened to cardKind, impactFacts and screenshotCaption. This
 * test fails the moment the two drift again.
 */

// The real schema, imported rather than copied - a copy would drift in exactly
// the way this test exists to prevent.
const AUTHORED_FIELDS = [
  'cardKind',
  'execSummary',
  'panelCurrent',
  'panelImpacts',
  'panelFuture',
  'panelBenefits',
  'impactFacts',
  'screenshotCaption',
  'screenshotUrl',
  'screenshotAttachmentId',
  'stakeholder',
  'affects',
  'impacts',
  'workaround',
  'originalRequestor',
] as const;

describe('the ticket save schema', () => {
  it('keeps every field a coordinator can author on the card', () => {
    const sent: Record<string, string> = { jiraId: 'ECOM-1', title: 'T' };
    for (const field of AUTHORED_FIELDS) sent[field] = field === 'cardKind' ? 'FEATURE' : `value for ${field}`;

    const parsed = ticketSchema.parse(sent) as Record<string, unknown>;
    for (const field of AUTHORED_FIELDS) {
      expect(parsed[field], `${field} was dropped by the save schema`).toBe(sent[field]);
    }
  });

  it('accepts every card kind, and the empty string a new ticket starts with', () => {
    for (const kind of [...CARD_KINDS, '']) {
      expect(ticketSchema.parse({ jiraId: 'E-1', title: 'T', cardKind: kind }).cardKind).toBe(kind);
    }
  });

  it('rejects a card kind that is not one of the three', () => {
    expect(() => ticketSchema.parse({ jiraId: 'E-1', title: 'T', cardKind: 'URGENT' })).toThrow();
  });
});
