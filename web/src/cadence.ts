/**
 * Mirrors the weekly-cadence arithmetic in server/src/services/automationService.ts,
 * so Settings can preview the next round's opening and cut-off the instant a
 * coordinator changes a field, without a round trip. If that server-side maths
 * changes, bring this in step with it - the two are deliberately kept apart
 * rather than shared, because there is no shared package between web and
 * server, and this is small and stable enough that duplicating it beats
 * plumbing one in.
 */
export interface CadenceLike {
  distributionDayOfWeek: number;
  distributionHour: number;
  distributionMinute: number;
  cutOffDayOfWeek: number;
  cutOffHour: number;
  cutOffMinute: number;
  timezone: string;
}

function nextOccurrence(from: Date, dayOfWeek: number, hour: number, minute: number, offsetMinutes: number): Date {
  const local = new Date(from.getTime() + offsetMinutes * 60_000);
  const result = new Date(local);
  result.setUTCHours(hour, minute, 0, 0);

  let delta = (dayOfWeek - result.getUTCDay() + 7) % 7;
  if (delta === 0 && result.getTime() <= local.getTime()) delta = 7;
  result.setUTCDate(result.getUTCDate() + delta);

  return new Date(result.getTime() - offsetMinutes * 60_000);
}

function timezoneOffsetMinutes(timezone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

/** The window the next round would run over, from these cadence settings. */
export function nextRoundWindow(cadence: CadenceLike, from: Date = new Date()): { opensAt: Date; cutOffAt: Date } {
  const offset = timezoneOffsetMinutes(cadence.timezone, from);
  const opensAt = nextOccurrence(
    from,
    cadence.distributionDayOfWeek,
    cadence.distributionHour,
    cadence.distributionMinute,
    offset,
  );
  const cutOffAt = nextOccurrence(opensAt, cadence.cutOffDayOfWeek, cadence.cutOffHour, cadence.cutOffMinute, offset);
  return { opensAt, cutOffAt };
}
