import { useEffect, useState } from 'react';
import { api, formatDateTime, type FeedbackTicket, type Round } from '../api';

/**
 * §9 post-round feedback view - visible to the whole committee once a round is
 * finalised. Shows how each ticket scored (per-category averages, total, spread,
 * discussion flag) with no individual attribution.
 *
 * Two things are attributed, and only to the person reading: their own score on
 * each ticket, and how it sat against the committee's. That is their own data,
 * and it is the only part of this page that teaches anybody anything - "I put
 * that at 60 and the room said 20" is the feedback. It appears here, after the
 * round, rather than during it: a score you can see the room's answer before
 * giving is not an independent score, and the spread that decides whether a
 * ticket needs discussing is only worth reading if every score was.
 */
export function FeedbackPage({ roundId }: { roundId: string }) {
  const [round, setRound] = useState<Round | null>(null);
  const [tickets, setTickets] = useState<FeedbackTicket[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .feedback(roundId)
      .then((data) => {
        setRound(data.round);
        setTickets(data.tickets);
      })
      .catch((err) => setError(err.message));
  }, [roundId]);

  if (error) return <p className="status error">{error}</p>;
  if (!round) return <p>Loading…</p>;

  const table = [...tickets].sort((a, b) => a.rank - b.rank);
  const scoredByYou = tickets.filter((t) => t.yourTotal !== null && t.businessScore !== null);
  const higher = scoredByYou.filter((t) => t.yourTotal! > t.businessScore!).length;
  const lower = scoredByYou.filter((t) => t.yourTotal! < t.businessScore!).length;
  /*
    Two different numbers, and saying which is which matters. The lean is the
    mean signed difference - whether you tend to sit above or below the room.
    The typical gap is the mean distance, which is bigger whenever you are
    above on some and below on others. Reporting the lean as though it were the
    gap makes a scorer who is 30 over on one and 30 under on another look
    perfectly aligned.
  */
  const lean = scoredByYou.length
    ? scoredByYou.reduce((sum, t) => sum + (t.yourTotal! - t.businessScore!), 0) / scoredByYou.length
    : 0;
  const typicalGap = scoredByYou.length
    ? scoredByYou.reduce((sum, t) => sum + Math.abs(t.yourTotal! - t.businessScore!), 0) / scoredByYou.length
    : 0;

  return (
    <>
      <h1>How the committee scored – {round.weekLabel}</h1>
      <p className="lede">
        Finalised {formatDateTime(round.finalisedAt)}. Scores are shown as committee averages and spread. Nobody else's
        score is attributed to them — the only individual scores here are your own.
      </p>

      <h2>The round at a glance</h2>
      <div className="card">
        {scoredByYou.length ? (
          <p className="lede" style={{ marginTop: 0 }}>
            You scored {scoredByYou.length} of {tickets.length} ticket{tickets.length === 1 ? '' : 's'}, higher than the
            committee on {higher} and lower on {lower}.{' '}
            {higher + lower > 0 ? (
              <>
                Your score was {typicalGap.toFixed(1)} points away from theirs on average, and overall you sat{' '}
                {Math.abs(lean) < 0.5 ? (
                  <strong>level with them</strong>
                ) : (
                  <>
                    <strong>
                      {Math.abs(lean).toFixed(1)} points {lean > 0 ? 'above' : 'below'}
                    </strong>{' '}
                    them
                  </>
                )}
                .
              </>
            ) : (
              'You matched the committee on every one.'
            )}
          </p>
        ) : (
          <p className="lede" style={{ marginTop: 0 }}>
            You didn't score any tickets in this round, so here's how the rest of the committee saw them.
          </p>
        )}
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">Every ticket in the round, highest business score first</caption>
            <thead>
              <tr>
                <th scope="col" className="num">
                  #
                </th>
                <th scope="col">Ticket</th>
                <th scope="col" className="num">
                  Committee
                </th>
                <th scope="col" className="num">
                  You
                </th>
                <th scope="col" className="num">
                  Difference
                </th>
                <th scope="col" className="num">
                  Spread
                </th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {table.map((ticket) => {
                const gap =
                  ticket.yourTotal !== null && ticket.businessScore !== null
                    ? ticket.yourTotal - ticket.businessScore
                    : null;
                return (
                  <tr key={ticket.jiraId}>
                    <td className="num">{ticket.rank}</td>
                    <th
                      scope="row"
                      style={{ background: 'transparent', textTransform: 'none', letterSpacing: 0, fontSize: '0.95rem', color: 'inherit' }}
                    >
                      {ticket.jiraId} – {ticket.title}
                    </th>
                    <td className="num">{ticket.agreedScore ?? ticket.businessScore ?? '—'}</td>
                    <td className="num">
                      {ticket.yourTotal !== null
                        ? ticket.yourTotal
                        : ticket.yourRelevance
                          ? 'n/a'
                          : '—'}
                    </td>
                    {/* Signed, because the direction is the interesting half. */}
                    <td className={`num${gap !== null && Math.abs(gap) >= 20 ? ' over' : ''}`}>
                      {gap === null ? '—' : gap > 0 ? `+${gap}` : gap}
                    </td>
                    <td className="num">{ticket.stdDev === null ? '—' : ticket.stdDev.toFixed(1)}</td>
                    <td>
                      {ticket.discussionOutcome || (ticket.discussionRequired ? 'Held for discussion' : ticket.resultLabel)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint">
          “You” is your own score out of 70 — <strong>n/a</strong> means you didn't say “Yes”, a dash means you
          didn't score it. A big gap from the committee isn't a mistake; it's what the spread is there to catch.
        </p>
      </div>

      {tickets.map((ticket) => (
        <section className="card" key={ticket.jiraId} aria-labelledby={`fb-${ticket.jiraId}`}>
          <div className="row between">
            <h2 id={`fb-${ticket.jiraId}`} style={{ margin: 0 }}>
              {ticket.jiraId} – {ticket.title}
            </h2>
            <div className="row">
              <span className="badge">{ticket.responsesCount} responses</span>
              <span className={`badge ${ticket.discussionRequired ? 'warn' : ticket.priorityBandLabel === 'High priority' ? 'high' : ''}`}>
                {ticket.statusLabel || 'No status yet'}
              </span>
            </div>
          </div>

          <div className="row" style={{ marginTop: '0.75rem', gap: '1.5rem' }}>
            {/*
              When a meeting agreed a number, that number is the business score
              - it is what goes to JIRA. Leading with the average the committee
              was split over would contradict the note directly below it.
            */}
            <p style={{ margin: 0 }}>
              <strong style={{ fontSize: '1.6rem' }}>{ticket.agreedScore ?? ticket.businessScore ?? '—'}</strong>
              <span className="hint"> / 70 business score</span>
              {ticket.agreedScore !== null ? (
                <span className="hint"> · agreed at the discussion, from an average of {ticket.businessScore}</span>
              ) : null}
            </p>
            <p style={{ margin: 0 }}>
              Spread (std dev): <strong>{ticket.stdDev === null ? '—' : ticket.stdDev.toFixed(1)}</strong>
              {ticket.discussionRequired ? <span className="badge warn"> Discussion required</span> : null}
            </p>
            {ticket.yourTotal !== null ? (
              <p style={{ margin: 0 }}>
                You scored it <strong>{ticket.yourTotal}</strong>
                {ticket.businessScore !== null ? (
                  <span className="hint">
                    {' '}
                    ({ticket.yourTotal === ticket.businessScore
                      ? 'the same as the committee'
                      : `${Math.abs(ticket.yourTotal - ticket.businessScore)} ${
                          ticket.yourTotal > ticket.businessScore ? 'higher' : 'lower'
                        } than the committee`}
                    )
                  </span>
                ) : null}
              </p>
            ) : null}
            <p style={{ margin: 0 }}>
              Effort: <strong>{ticket.effort ?? '—'}</strong> · Ratio:{' '}
              <strong>{ticket.priorityRatio === null ? '—' : ticket.priorityRatio.toFixed(2)}</strong>
            </p>
          </div>

          {/*
            §10.4: a split ticket is held back and talked through. The people
            who gave those scores are the ones who should hear what came of it,
            so the outcome of the meeting is shown here rather than staying in
            the coordinator's half of the app.
          */}
          {ticket.discussionRequired ? (
            <div className={`notice${ticket.discussionOutcome ? '' : ' warn'}`} style={{ marginTop: '0.75rem' }}>
              {ticket.discussionOutcome ? (
                <>
                  <strong>Discussed: {ticket.discussionOutcome.toLowerCase()}.</strong>
                  {ticket.agreedScore !== null ? ` The committee settled on ${ticket.agreedScore} out of 70.` : ''}
                  {ticket.discussionNote ? ` ${ticket.discussionNote}` : ''}
                </>
              ) : (
                <>
                  <strong>Held for discussion.</strong> The scores for this one were too far apart to average, so it is
                  waiting on a meeting. Nothing has been written to JIRA for it.
                </>
              )}
            </div>
          ) : null}

          <h3 style={{ marginTop: '1rem' }}>Category averages</h3>
          <div className="table-scroll">
            <table>
              <caption className="visually-hidden">Category averages for {ticket.jiraId}</caption>
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col" className="num">
                    Average
                  </th>
                  <th scope="col" className="num">
                    Lowest
                  </th>
                  <th scope="col" className="num">
                    Highest
                  </th>
                </tr>
              </thead>
              <tbody>
                {ticket.categoryAverages.map((category) => (
                  <tr key={category.categoryId}>
                    <th scope="row" style={{ background: 'transparent', textTransform: 'none', letterSpacing: 0, fontSize: '0.95rem', color: 'inherit' }}>
                      {category.name}
                    </th>
                    <td className="num">{ticket.responsesCount ? category.average.toFixed(1) : '—'}</td>
                    <td className="num">{ticket.responsesCount ? category.min : '—'}</td>
                    <td className="num">{ticket.responsesCount ? category.max : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 style={{ marginTop: '1rem' }}>Individual totals (unattributed)</h3>
          <div className="distribution">
            {ticket.totalsDistribution.length ? (
              ticket.totalsDistribution.map((total, index) => <span key={index}>{total}</span>)
            ) : (
              <span>No valid submissions</span>
            )}
          </div>

          {ticket.notes.length ? (
            <>
              <h3 style={{ marginTop: '1rem' }}>Notes and queries</h3>
              <ul>
                {ticket.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ))}
    </>
  );
}
