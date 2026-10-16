import type { Db } from '../db/index.js';
import type { LeagueConfig } from '../domain/types.js';
import type { Member } from './memberService.js';
import { memberStreak } from './submissionService.js';

/**
 * The committee league table.
 *
 * The problem it exists for is participation, not scoring: a handful of people
 * score every round and the rest drift, and an average of four scores is a much
 * shakier number than an average of ten. So points are for *taking part* -
 * answering tickets, finishing the round, finishing it early - and never for
 * what anybody scored. Nothing here reads a mark, and nothing here could reward
 * scoring high, low or "with the room".
 *
 * Built only from FINALISED rounds. While a round is open, who has and hasn't
 * answered stays hidden from the committee (§9); by the time a round reaches
 * this table it is over, and everyone can see it anyway on the Feedback page.
 */

export type LeagueBadge = 'ever-present' | 'early-bird' | 'on-fire' | 'comeback' | 'climber';

export interface LeagueRow {
  memberId: string;
  memberName: string;
  team: string;
  rank: number;
  /** Where they stood before the latest round counted; null if they were not on the table. */
  previousRank: number | null;
  /** Places gained (positive) or lost (negative) since the latest round; null when there is nothing to compare. */
  movement: number | null;
  points: number;
  ticketsAnswered: number;
  roundsCompleted: number;
  /** Rounds in the season that ran after they joined - the fair denominator. */
  roundsEligible: number;
  completionRate: number | null;
  /** Times among the first `earlyFinisherPlaces` to finish a round. */
  earlyFinishes: number;
  /** Times the very first to finish a round. */
  firstPlaces: number;
  /** Finalised rounds in a row finished, the same number the Score page shows. */
  streak: number;
  badges: LeagueBadge[];
}

export interface LeagueCoverage {
  committeeSize: number;
  /** Average number of real answers each ticket got this season. */
  avgResponsesPerTicket: number | null;
  /** The typical spread of scores on a ticket - what the margins below are worked from. */
  typicalStdDev: number | null;
  /** Roughly how far a ticket's average could be from the committee's "true" view at today's turnout. */
  marginNow: number | null;
  /** The same, if the whole committee scored every ticket. */
  marginIfEveryone: number | null;
}

export interface LeagueSummary {
  enabled: boolean;
  roundsInSeason: number;
  latestRound: { weekLabel: string; firstFinisher: string | null } | null;
  rules: Pick<LeagueConfig, 'seasonRounds' | 'pointsPerTicket' | 'fullRoundBonus' | 'earlyFinisherBonus' | 'earlyFinisherPlaces'>;
  rows: LeagueRow[];
  coverage: LeagueCoverage;
}

interface SeasonRound {
  id: string;
  weekLabel: string;
  cutOffAt: string;
  ticketCount: number;
}

/** Per member, per round: how many tickets answered and when the last one went in. */
type Answers = Map<string, Map<string, { submitted: number; lastAt: string }>>;

interface MemberStanding {
  member: Member;
  points: number;
  ticketsAnswered: number;
  roundsCompleted: number;
  roundsEligible: number;
  earlyFinishes: number;
  firstPlaces: number;
  completedRoundIds: Set<string>;
  eligibleRoundIds: Set<string>;
}

/**
 * The standings over one window of rounds. Pure, so the "where were they a
 * round ago" comparison is the same calculation over a window shifted by one,
 * not a second implementation that could disagree with the first.
 */
function standingsFor(
  rounds: SeasonRound[],
  scorers: Member[],
  answers: Answers,
  startedAt: Map<string, string>,
  rules: LeagueConfig,
): MemberStanding[] {
  const standings = new Map<string, MemberStanding>(
    scorers.map((member) => [
      member.id,
      {
        member,
        points: 0,
        ticketsAnswered: 0,
        roundsCompleted: 0,
        roundsEligible: 0,
        earlyFinishes: 0,
        firstPlaces: 0,
        completedRoundIds: new Set(),
        eligibleRoundIds: new Set(),
      },
    ]),
  );

  for (const round of rounds) {
    const finishers: Array<{ memberId: string; lastAt: string }> = [];
    for (const member of scorers) {
      const s = standings.get(member.id)!;
      const record = answers.get(member.id)?.get(round.id);
      const start = startedAt.get(member.id);
      // A round that closed before somebody joined is not one they missed.
      const eligible = Boolean(record) || !start || round.cutOffAt >= start;
      if (!eligible) continue;
      s.roundsEligible += 1;
      s.eligibleRoundIds.add(round.id);
      if (!record) continue;
      const answered = Math.min(record.submitted, round.ticketCount);
      s.ticketsAnswered += answered;
      s.points += answered * rules.pointsPerTicket;
      if (answered >= round.ticketCount) {
        s.roundsCompleted += 1;
        s.completedRoundIds.add(round.id);
        s.points += rules.fullRoundBonus;
        finishers.push({ memberId: member.id, lastAt: record.lastAt });
      }
    }
    finishers.sort((a, b) => a.lastAt.localeCompare(b.lastAt));
    finishers.slice(0, Math.max(rules.earlyFinisherPlaces, 0)).forEach((f, i) => {
      const s = standings.get(f.memberId)!;
      s.earlyFinishes += 1;
      s.points += rules.earlyFinisherBonus;
      if (i === 0) s.firstPlaces += 1;
    });
  }

  return [...standings.values()];
}

function completion(s: MemberStanding): number | null {
  return s.roundsEligible ? s.roundsCompleted / s.roundsEligible : null;
}

/** Points first; on a tie, the better finishing rate, then alphabetical so the order is stable. */
function rank(standings: MemberStanding[]): Map<string, number> {
  const sorted = [...standings].sort(
    (a, b) =>
      b.points - a.points ||
      (completion(b) ?? -1) - (completion(a) ?? -1) ||
      a.member.name.localeCompare(b.member.name),
  );
  const ranks = new Map<string, number>();
  sorted.forEach((s, i) => {
    const prev = sorted[i - 1];
    // Joint places for an exact tie on points and rate - nobody is "behind" on alphabet.
    const tied = prev && prev.points === s.points && completion(prev) === completion(s);
    ranks.set(s.member.id, tied ? ranks.get(prev.member.id)! : i + 1);
  });
  return ranks;
}

async function loadRounds(db: Db, limit: number): Promise<SeasonRound[]> {
  const rows = await db.all<{ id: string; week_label: string; cut_off_at: string; ticket_count: number }>(
    `SELECT r.id, r.week_label, r.cut_off_at,
            (SELECT COUNT(*) FROM round_tickets rt WHERE rt.round_id = r.id AND rt.held = 0) AS ticket_count
     FROM rounds r WHERE r.status = 'FINALISED' ORDER BY r.cut_off_at DESC LIMIT ?`,
    [limit],
  );
  // A round with nothing in it says nothing about who turned up.
  return rows
    .map((r) => ({ id: r.id, weekLabel: r.week_label, cutOffAt: r.cut_off_at, ticketCount: Number(r.ticket_count) }))
    .filter((r) => r.ticketCount > 0);
}

async function loadAnswers(db: Db, roundIds: string[]): Promise<Answers> {
  const answers: Answers = new Map();
  if (!roundIds.length) return answers;
  const placeholders = roundIds.map(() => '?').join(',');
  const rows = await db.all<{ member_id: string; round_id: string; submitted: number; last_at: string }>(
    `SELECT s.member_id, s.round_id, COUNT(*) AS submitted, MAX(s.updated_at) AS last_at
     FROM submissions s
     JOIN round_tickets rt ON rt.round_id = s.round_id AND rt.ticket_id = s.ticket_id AND rt.held = 0
     WHERE s.round_id IN (${placeholders}) AND s.archived = 0
     GROUP BY s.member_id, s.round_id`,
    roundIds,
  );
  for (const row of rows) {
    if (!answers.has(row.member_id)) answers.set(row.member_id, new Map());
    answers.get(row.member_id)!.set(row.round_id, { submitted: Number(row.submitted), lastAt: String(row.last_at) });
  }
  return answers;
}

/**
 * When each member's season starts: the earlier of joining and the first
 * round they ever answered in. Join date alone is wrong for anyone imported
 * after they had already been scoring; first answer alone would let somebody
 * who has never scored look like they have missed nothing.
 */
async function loadStarts(db: Db, scorers: Member[]): Promise<Map<string, string>> {
  const starts = new Map<string, string>();
  if (!scorers.length) return starts;
  const placeholders = scorers.map(() => '?').join(',');
  const joined = await db.all<{ id: string; created_at: string }>(
    `SELECT id, created_at FROM members WHERE id IN (${placeholders})`,
    scorers.map((m) => m.id),
  );
  const firstAnswer = await db.all<{ member_id: string; first_cut_off: string }>(
    `SELECT s.member_id, MIN(r.cut_off_at) AS first_cut_off
     FROM submissions s JOIN rounds r ON r.id = s.round_id
     WHERE s.member_id IN (${placeholders}) AND s.archived = 0
     GROUP BY s.member_id`,
    scorers.map((m) => m.id),
  );
  const first = new Map(firstAnswer.map((r) => [r.member_id, String(r.first_cut_off)]));
  for (const row of joined) {
    const f = first.get(row.id);
    starts.set(row.id, f && f < row.created_at ? f : row.created_at);
  }
  return starts;
}

async function loadCoverage(db: Db, roundIds: string[], committeeSize: number): Promise<LeagueCoverage> {
  const empty: LeagueCoverage = {
    committeeSize,
    avgResponsesPerTicket: null,
    typicalStdDev: null,
    marginNow: null,
    marginIfEveryone: null,
  };
  if (!roundIds.length) return empty;
  const placeholders = roundIds.map(() => '?').join(',');
  const row = await db.get<{ responses: number | null; spread: number | null }>(
    `SELECT AVG(CASE WHEN responses_count > 0 THEN responses_count END) AS responses,
            AVG(CASE WHEN responses_count > 1 THEN std_dev END) AS spread
     FROM ticket_results WHERE round_id IN (${placeholders})`,
    roundIds,
  );
  const responses = row?.responses == null ? null : Number(row.responses);
  const spread = row?.spread == null ? null : Number(row.spread);
  // ±1.96 standard errors: roughly where the committee's "true" view of a
  // ticket sits, given how far apart individual scores typically land. It is
  // a rough guide for the page, not a statistic anything is decided on.
  const margin = (n: number | null) => (spread !== null && n && n > 0 ? round1((1.96 * spread) / Math.sqrt(n)) : null);
  return {
    committeeSize,
    avgResponsesPerTicket: responses === null ? null : round1(responses),
    typicalStdDev: spread === null ? null : round1(spread),
    marginNow: margin(responses),
    marginIfEveryone: margin(committeeSize),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function buildLeague(db: Db, scorers: Member[], rules: LeagueConfig): Promise<LeagueSummary> {
  const ruleView = {
    seasonRounds: rules.seasonRounds,
    pointsPerTicket: rules.pointsPerTicket,
    fullRoundBonus: rules.fullRoundBonus,
    earlyFinisherBonus: rules.earlyFinisherBonus,
    earlyFinisherPlaces: rules.earlyFinisherPlaces,
  };
  if (!rules.enabled) {
    return {
      enabled: false,
      roundsInSeason: 0,
      latestRound: null,
      rules: ruleView,
      rows: [],
      coverage: await loadCoverage(db, [], scorers.length),
    };
  }

  const season = Math.max(1, Math.floor(rules.seasonRounds));
  // One extra round, so "where were you before the latest one" is the same
  // size window shifted back by one rather than a shorter one.
  const loaded = await loadRounds(db, season + 1);
  const current = loaded.slice(0, season);
  const previous = loaded.length > 1 ? loaded.slice(1, season + 1) : [];
  const answers = await loadAnswers(db, loaded.map((r) => r.id));
  const starts = await loadStarts(db, scorers);

  const now = standingsFor(current, scorers, answers, starts, rules);
  const ranks = rank(now);
  const prevStandings = previous.length ? standingsFor(previous, scorers, answers, starts, rules) : [];
  // Somebody with no points a round ago was not really "on" the table yet.
  const prevRanks = prevStandings.length ? rank(prevStandings.filter((s) => s.points > 0)) : new Map<string, number>();

  const latest = current[0];
  const beforeLatest = current[1];

  const rows: LeagueRow[] = [];
  for (const s of now) {
    const previousRank = prevRanks.get(s.member.id) ?? null;
    const currentRank = ranks.get(s.member.id)!;
    rows.push({
      memberId: s.member.id,
      memberName: s.member.name,
      team: s.member.team,
      rank: currentRank,
      previousRank,
      movement: previousRank === null ? null : previousRank - currentRank,
      points: s.points,
      ticketsAnswered: s.ticketsAnswered,
      roundsCompleted: s.roundsCompleted,
      roundsEligible: s.roundsEligible,
      completionRate: completion(s),
      earlyFinishes: s.earlyFinishes,
      firstPlaces: s.firstPlaces,
      streak: await memberStreak(db, s.member.id),
      badges: [],
    });
  }

  // Badges are earned against the season, so they come and go with it.
  const biggestClimb = Math.max(0, ...rows.map((r) => r.movement ?? 0));
  for (const row of rows) {
    const s = now.find((n) => n.member.id === row.memberId)!;
    if (s.roundsEligible >= 2 && s.roundsCompleted === s.roundsEligible) row.badges.push('ever-present');
    if (s.firstPlaces > 0) row.badges.push('early-bird');
    if (row.streak >= 3) row.badges.push('on-fire');
    if (
      latest &&
      beforeLatest &&
      s.completedRoundIds.has(latest.id) &&
      s.eligibleRoundIds.has(beforeLatest.id) &&
      !s.completedRoundIds.has(beforeLatest.id)
    ) {
      row.badges.push('comeback');
    }
    if (biggestClimb >= 2 && row.movement === biggestClimb) row.badges.push('climber');
  }
  rows.sort((a, b) => a.rank - b.rank || a.memberName.localeCompare(b.memberName));

  const lastAt = (s: MemberStanding) => answers.get(s.member.id)!.get(latest!.id)!.lastAt;
  const firstFinisher = latest
    ? now.filter((s) => s.completedRoundIds.has(latest.id)).sort((a, b) => lastAt(a).localeCompare(lastAt(b)))[0]?.member
        .name ?? null
    : null;

  return {
    enabled: true,
    roundsInSeason: current.length,
    latestRound: latest ? { weekLabel: latest.weekLabel, firstFinisher } : null,
    rules: ruleView,
    rows,
    coverage: await loadCoverage(db, current.map((r) => r.id), scorers.length),
  };
}
