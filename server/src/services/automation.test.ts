import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION_CONFIG, DEFAULT_CADENCE_CONFIG } from '../domain/types.js';
import { describeNext, nextOccurrence, nextRoundWindow, timezoneOffsetMinutes, weekLabelFor } from './automationService.js';
import type { Round } from './roundService.js';

const round = (overrides: Partial<Round> = {}): Round => ({
  id: 'r1',
  weekLabel: 'Week commencing 03 Aug 2026',
  cutOffAt: '2026-08-11T16:00:00.000Z',
  status: 'DRAFT',
  stream: 'ECOM',
  notes: '',
  distributionSentAt: null,
  opensAt: '2026-08-06T08:00:00.000Z',
  automationPaused: false,
  openedAt: null,
  closedAt: null,
  finalisedAt: null,
  createdBy: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  ticketCount: 3,
  ...overrides,
});

describe('nextOccurrence', () => {
  it('finds the next matching day and hour', () => {
    // Wednesday 5 Aug 2026, 10:00 UTC -> next Thursday 09:00
    const from = new Date('2026-08-05T10:00:00Z');
    expect(nextOccurrence(from, 4, 9).toISOString()).toBe('2026-08-06T09:00:00.000Z');
  });

  it('skips to next week when today is the day but the hour has passed', () => {
    const from = new Date('2026-08-06T10:00:00Z'); // Thursday, past 09:00
    expect(nextOccurrence(from, 4, 9).toISOString()).toBe('2026-08-13T09:00:00.000Z');
  });

  it('keeps today when the hour is still ahead', () => {
    const from = new Date('2026-08-06T07:00:00Z'); // Thursday, before 09:00
    expect(nextOccurrence(from, 4, 9).toISOString()).toBe('2026-08-06T09:00:00.000Z');
  });

  it('reads the hour as wall-clock time in the offset it is given', () => {
    // 09:00 in BST (UTC+1) is 08:00 UTC.
    const from = new Date('2026-08-05T10:00:00Z');
    expect(nextOccurrence(from, 4, 9, 60).toISOString()).toBe('2026-08-06T08:00:00.000Z');
  });
});

describe('timezoneOffsetMinutes', () => {
  it('follows British summer time', () => {
    expect(timezoneOffsetMinutes('Europe/London', new Date('2026-08-05T12:00:00Z'))).toBe(60);
    expect(timezoneOffsetMinutes('Europe/London', new Date('2026-01-05T12:00:00Z'))).toBe(0);
  });

  it('falls back to UTC rather than throwing on a bad timezone', () => {
    expect(timezoneOffsetMinutes('Not/AZone', new Date('2026-08-05T12:00:00Z'))).toBe(0);
  });
});

describe('nextRoundWindow', () => {
  it('opens on the distribution day and cuts off on the cut-off day after it', () => {
    const { opensAt, cutOffAt } = nextRoundWindow(DEFAULT_CADENCE_CONFIG, new Date('2026-08-05T10:00:00Z'));
    // Thursday 6 Aug 09:00 BST, cut-off the following Tuesday 17:00 BST.
    expect(opensAt.toISOString()).toBe('2026-08-06T08:00:00.000Z');
    expect(cutOffAt.toISOString()).toBe('2026-08-11T16:00:00.000Z');
    expect(cutOffAt.getTime()).toBeGreaterThan(opensAt.getTime());
  });

  it('always puts the cut-off after the opening, whatever days are configured', () => {
    // Cut-off day earlier in the week than the distribution day.
    const cadence = { ...DEFAULT_CADENCE_CONFIG, distributionDayOfWeek: 5, cutOffDayOfWeek: 1 };
    const { opensAt, cutOffAt } = nextRoundWindow(cadence, new Date('2026-08-05T10:00:00Z'));
    expect(cutOffAt.getTime()).toBeGreaterThan(opensAt.getTime());
  });
});

describe('weekLabelFor', () => {
  it('reads like a label a coordinator would type', () => {
    expect(weekLabelFor(new Date('2026-08-06T08:00:00Z'))).toBe('Week commencing 06 Aug 2026');
  });
});

describe('describeNext', () => {
  const on = { ...DEFAULT_AUTOMATION_CONFIG, enabled: true };
  const now = new Date('2026-08-05T10:00:00Z');

  it('says nothing is automated when the master switch is off', () => {
    expect(describeNext(round(), DEFAULT_AUTOMATION_CONFIG, now)).toMatch(/Automation is off/);
  });

  it('says a paused round is entirely manual', () => {
    expect(describeNext(round({ automationPaused: true }), on, now)).toMatch(/paused for this round/i);
  });

  it('names when a draft round will go out', () => {
    expect(describeNext(round(), on, now)).toMatch(/Opens and goes to the committee at/);
  });

  it('prompts for a ticket when a draft round is already due to open', () => {
    expect(describeNext(round(), on, new Date('2026-08-07T10:00:00Z'))).toMatch(/add at least one ticket/i);
  });

  it('says a draft round with no opening time will not go on its own', () => {
    expect(describeNext(round({ opensAt: null }), on, now)).toMatch(/will not distribute on its own/);
  });

  it('names the cut-off for an open round', () => {
    expect(describeNext(round({ status: 'OPEN' }), on, now)).toMatch(/closes automatically at/i);
  });

  it('says when a closed round finalises, and that JIRA follows', () => {
    const text = describeNext(round({ status: 'CLOSED' }), on, now);
    expect(text).toMatch(/Finalises at/);
    expect(text).toMatch(/scores go to JIRA/);
  });

  it('leaves JIRA out when writing back is switched off', () => {
    const text = describeNext(round({ status: 'CLOSED' }), { ...on, writeBack: false }, now);
    expect(text).not.toMatch(/JIRA/);
  });

  it('points at the manual button for each step that is switched off', () => {
    expect(describeNext(round(), { ...on, distribute: false }, now)).toMatch(/Round actions/);
    expect(describeNext(round({ status: 'CLOSED' }), { ...on, finalise: false }, now)).toMatch(/Round actions/);
  });

  it('has nothing left to say about a finalised round', () => {
    expect(describeNext(round({ status: 'FINALISED' }), on, now)).toMatch(/Nothing further is automated/);
  });
});
