import { useEffect, useState } from 'react';
import { api, canScore, type LeagueBadge, type LeagueRow, type LeagueSummary, type Member } from '../api';
import { Link } from '../router';

/**
 * The committee league table. It exists to make turning up visible: the same
 * few people score every round and the rest drift, and the fewer people score
 * a ticket the less its average can be trusted. Points are for answering,
 * finishing and finishing early - never for what anybody scored - so there is
 * nothing here that rewards scoring a ticket any particular way.
 */

export const BADGES: Record<LeagueBadge, { icon: string; name: string; meaning: string }> = {
  'ever-present': { icon: '🛡️', name: 'Ever-present', meaning: 'Finished every round this season' },
  'early-bird': { icon: '🐦', name: 'Early bird', meaning: 'First to finish a round this season' },
  'on-fire': { icon: '🔥', name: 'On fire', meaning: 'Three or more rounds finished in a row' },
  comeback: { icon: '💪', name: 'Comeback', meaning: 'Finished the latest round after missing the one before' },
  climber: { icon: '🚀', name: 'Climber', meaning: 'Biggest climb up the table in the latest round' },
};

const MEDALS = ['🥇', '🥈', '🥉'];

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}


function Movement({ value }: { value: number | null }) {
  if (value === null) return <span className="league-move new">New</span>;
  if (value === 0) return <span className="league-move same" aria-label="No change">–</span>;
  return value > 0 ? (
    <span className="league-move up" aria-label={`Up ${value}`}>
      ▲ {value}
    </span>
  ) : (
    <span className="league-move down" aria-label={`Down ${-value}`}>
      ▼ {-value}
    </span>
  );
}

function Badges({ badges }: { badges: LeagueBadge[] }) {
  if (!badges.length) return null;
  return (
    <span className="league-badges">
      {badges.map((b) => (
        // role="img" with a label rather than hidden text: .visually-hidden only
        // collapses a block, and an inline label inside a table cell shows.
        <span key={b} className="league-badge" role="img" aria-label={BADGES[b].name} title={`${BADGES[b].name}: ${BADGES[b].meaning}`}>
          {BADGES[b].icon}
        </span>
      ))}
    </span>
  );
}

function Podium({ rows }: { rows: LeagueRow[] }) {
  const top = rows.filter((r) => r.points > 0).slice(0, 3);
  if (!top.length) return null;
  // Second, first, third - the shape everybody recognises.
  const order = [top[1], top[0], top[2]].filter(Boolean) as LeagueRow[];
  return (
    <div className="podium" aria-label="Top three">
      {order.map((row) => {
        const place = top.indexOf(row);
        return (
          <div key={row.memberId} className={`podium-step place-${place + 1}`}>
            <span className="podium-medal" aria-hidden="true">
              {MEDALS[place]}
            </span>
            <strong className="podium-name">{row.memberName}</strong>
            <span className="podium-team">{row.team || ' '}</span>
            <span className="podium-points">{row.points} pts</span>
            <span className="podium-block">{ordinal(row.rank)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The reader's own line, and what it would take to climb - the part that makes a table a reason to act. */
function YourPosition({ me, rows, rules }: { me: LeagueRow; rows: LeagueRow[]; rules: LeagueSummary['rules'] }) {
  const ahead = rows.filter((r) => r.points > me.points).sort((a, b) => a.points - b.points)[0];
  const fullRound = rules.fullRoundBonus;
  return (
    <div className="card league-you">
      <div className="row between" style={{ alignItems: 'center', gap: '1rem' }}>
        <div>
          <p className="league-you-label">Your position</p>
          <p className="league-you-rank">
            {ordinal(me.rank)} <span className="hint">of {rows.length}</span>
          </p>
        </div>
        <div className="league-you-stats">
          <span>
            <strong>{me.points}</strong> pts
          </span>
          <span>
            <strong>{me.roundsCompleted}</strong>/{me.roundsEligible} rounds
          </span>
          {me.streak >= 2 ? (
            <span className="streak-badge" title={`${me.streak} rounds in a row`}>
              <span aria-hidden="true">🔥</span> {me.streak}
            </span>
          ) : null}
          <Movement value={me.movement} />
        </div>
      </div>
      <p style={{ margin: '0.6rem 0 0' }}>
        {me.rank === 1 && !ahead
          ? 'Top of the table. Finish the next round to stay there.'
          : ahead
            ? `${ahead.points - me.points} points behind ${ahead.memberName}. Finishing a whole round is worth at least ${fullRound} on top of the tickets themselves.`
            : 'Score the next round to get on the board.'}{' '}
        <Link to="/">Go to scoring</Link>
      </p>
    </div>
  );
}

function WhyItMatters({ coverage }: { coverage: LeagueSummary['coverage'] }) {
  const { avgResponsesPerTicket: avg, committeeSize, marginNow, marginIfEveryone } = coverage;
  if (avg === null || !committeeSize) return null;
  const share = Math.min(1, avg / committeeSize);
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Why every score counts</h2>
      <p style={{ marginTop: 0 }}>
        This season a ticket was scored by <strong>{avg}</strong> of the <strong>{committeeSize}</strong> of us, on
        average.
      </p>
      <span className="bar league-coverage" aria-hidden="true">
        <span style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      {marginNow !== null && marginIfEveryone !== null ? (
        <p className="hint" style={{ marginBottom: 0 }}>
          With that many scores, a ticket's average can land roughly <strong>±{marginNow}</strong> points away from
          where the whole committee would put it. If everyone scored every ticket, that would shrink to about{' '}
          <strong>±{marginIfEveryone}</strong>. A steadier score is what decides whether a ticket gets built sooner or
          waits.
        </p>
      ) : null}
    </div>
  );
}

export function LeaguePage({ member }: { member: Member }) {
  const [league, setLeague] = useState<LeagueSummary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .league()
      .then(setLeague)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the league table'));
  }, []);

  if (error) return <p className="status error">{error}</p>;
  if (!league) return <p>Loading…</p>;

  if (!league.enabled) {
    return (
      <>
        <h1>League table</h1>
        <div className="notice">The league table is switched off at the moment.</div>
      </>
    );
  }

  const { rows, rules, latestRound } = league;
  const me = canScore(member.role) ? rows.find((r) => r.memberId === member.id) : undefined;
  const anyPoints = rows.some((r) => r.points > 0);

  return (
    <>
      <h1>League table</h1>
      <p className="lede">
        Who has been turning up over the last {league.roundsInSeason || rules.seasonRounds} rounds. Points are for
        taking part, never for what you scored.
      </p>

      {latestRound ? (
        <div className="league-hero">
          <span className="league-hero-label">Latest round</span>
          <strong>{latestRound.weekLabel}</strong>
          {latestRound.firstFinisher ? (
            <span>
              <span aria-hidden="true">🏁</span> First to finish: <strong>{latestRound.firstFinisher}</strong>
            </span>
          ) : null}
        </div>
      ) : null}

      {!anyPoints ? (
        <div className="notice">
          No finished rounds yet. The table fills in as soon as the first round is finalised — so whoever scores
          first this week starts at the top.
        </div>
      ) : (
        <>
          <Podium rows={rows} />
          {me ? <YourPosition me={me} rows={rows} rules={rules} /> : null}

          <div className="card table-scroll">
            <table className="league-table">
              <caption className="visually-hidden">Committee league table</caption>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    #
                  </th>
                  <th scope="col" aria-label="Movement" />
                  <th scope="col">Name</th>
                  <th scope="col">Rounds finished</th>
                  <th scope="col" className="num">
                    Tickets
                  </th>
                  <th scope="col" className="num">
                    Streak
                  </th>
                  <th scope="col" className="num">
                    Points
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.memberId} className={row.memberId === member.id ? 'league-me' : undefined}>
                    <td className="num league-rank">{row.rank <= 3 && row.points > 0 ? MEDALS[row.rank - 1] : row.rank}</td>
                    <td>
                      <Movement value={row.movement} />
                    </td>
                    <th
                      scope="row"
                      style={{ background: 'transparent', textTransform: 'none', letterSpacing: 0, fontSize: '0.95rem', color: 'inherit' }}
                    >
                      {row.memberName}
                      {row.memberId === member.id ? <span className="hint"> (you)</span> : null}{' '}
                      <Badges badges={row.badges} />
                      {row.team ? <span className="league-team">{row.team}</span> : null}
                    </th>
                    <td>
                      <span className="league-completion">
                        <span className="bar" aria-hidden="true">
                          <span style={{ width: `${Math.round((row.completionRate ?? 0) * 100)}%` }} />
                        </span>
                        <span>
                          {row.roundsCompleted}/{row.roundsEligible}
                        </span>
                      </span>
                    </td>
                    <td className="num">{row.ticketsAnswered}</td>
                    <td className="num">{row.streak >= 2 ? `🔥 ${row.streak}` : row.streak}</td>
                    <td className="num">
                      <strong>{row.points}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

        </>
      )}

      <WhyItMatters coverage={league.coverage} />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>How points work</h2>
        <ul style={{ marginTop: 0 }}>
          <li>
            <strong>{rules.pointsPerTicket}</strong> for every ticket you answer.
          </li>
          <li>
            <strong>+{rules.fullRoundBonus}</strong> for answering every ticket in a round.
          </li>
          {rules.earlyFinisherPlaces > 0 ? (
            <li>
              <strong>+{rules.earlyFinisherBonus}</strong> for being one of the first {rules.earlyFinisherPlaces} to
              finish a round.
            </li>
          ) : null}
        </ul>
        <p className="hint">
          The table covers the last {rules.seasonRounds} finished rounds, so a missed week drops off in time. Rounds
          that closed before you joined do not count against you. Nothing here looks at the scores you gave.
        </p>
        <h3>Badges</h3>
        <ul className="league-legend">
          {(Object.keys(BADGES) as LeagueBadge[]).map((b) => (
            <li key={b}>
              <span aria-hidden="true">{BADGES[b].icon}</span> <strong>{BADGES[b].name}</strong> — {BADGES[b].meaning}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
