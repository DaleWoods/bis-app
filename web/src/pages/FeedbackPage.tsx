import { useEffect, useState } from 'react';
import { api, formatDateTime, type FeedbackTicket, type QueueView, type Round } from '../api';
import { Link } from '../router';
import { ordinal } from './QueuePage';

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
  /** Live queue positions, if the queue is switched on. Never fatal. */
  const [queue, setQueue] = useState<QueueView | null>(null);

  useEffect(() => {
    api
      .feedback(roundId)
      .then((data) => {
        setRound(data.round);
        setTickets(data.tickets);
      })
      .catch((err) => setError(err.message));
    // The queue is read live from JIRA and is a nice-to-have here: if it is
    // off or unreachable, the round's own results still stand on their own.
    api
      .queue()
      .then(setQueue)
      .catch(() => setQueue(null));
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
  /*
    The two things worth reading on this page were both buried: which tickets
    the room actually disagreed about, and which one you personally were
    furthest from everyone else on. Both were recoverable from the table by
    anyone willing to scan seven columns, which is nobody. A round nobody reads
    the result of is a round people stop scoring, so they lead now.
  */
  const split = tickets.filter((t) => t.discussionRequired);
  const furthest = scoredByYou.reduce<(typeof scoredByYou)[number] | null>(
    (worst, t) =>
      !worst || Math.abs(t.yourTotal! - t.businessScore!) > Math.abs(worst.yourTotal! - worst.businessScore!) ? t : worst,
    null,
  );
  const furthestGap = furthest ? furthest.yourTotal! - furthest.businessScore! : 0;
  /*
    A ticket under the minimum is not decided - it rolls over and waits another
    week. So a ticket that landed on exactly the minimum got there on its last
    answer, and everyone who gave one is a reason it was decided at all.
    "Nothing would have gone differently if I had skipped it" is the belief
    that keeps people from scoring, and for these tickets it is untrue.
  */
  const carried = tickets.filter(
    (t) => t.yourTotal !== null && t.minSubmissions !== undefined && t.responsesCount === t.minSubmissions,
  );

  /*
    Where this round's tickets have landed in the dev queue.

    Ranked against the whole hopper, not just this round - a position within
    the round would be a different number that looks like the same one, and
    "3rd" has to mean third in the queue rather than third of the four we
    happened to score this week.
  */
  const roundKeys = new Set(tickets.map((t) => t.jiraId));
  const placements = queue?.available
    ? [
        ...queue.split.frontend.filter((t) => roundKeys.has(t.key)).map((t) => ({ ...t, queue: 'Frontend' as const })),
        ...queue.split.backend.filter((t) => roundKeys.has(t.key)).map((t) => ({ ...t, queue: 'Backend' as const })),
      ].sort((a, b) => a.key.localeCompare(b.key) || a.queue.localeCompare(b.queue))
    : [];

  return (
    <>
      <h1>How the committee scored – {round.weekLabel}</h1>
      <p className="lede">
        Finalised {formatDateTime(round.finalisedAt)}. Scores are shown as committee averages and spread. Nobody else's
        score is attributed to them — the only individual scores here are your own.
      </p>

      <h2>The round at a glance</h2>

      {carried.length ? (
        <div className="notice carried" role="status">
          <strong>
            {carried.length === 1
              ? 'One ticket was decided because you answered.'
              : `${carried.length} tickets were decided because you answered.`}
          </strong>{' '}
          {carried.map((t) => t.jiraId).join(', ')} reached the minimum number of responses exactly — one fewer and{' '}
          {carried.length === 1 ? 'it' : 'they'} would have rolled over to another week undecided.
        </div>
      ) : null}

      {placements.length ? (
        <section className="card" aria-labelledby="round-queue">
          <div className="row between">
            <h2 id="round-queue" style={{ margin: 0 }}>
              Where this round's tickets are now
            </h2>
            <Link to="/queue">See the whole queue</Link>
          </div>
          <p className="hint">
            Read from JIRA just now, and ranked against everything waiting — not just this round.
          </p>
          <ul className="placements">
            {placements.map((placement) => (
              <li key={`${placement.key}-${placement.queue}`}>
                <span className="jira-id">{placement.key}</span>{' '}
                <strong>
                  Currently {ordinal(placement.rank)} in the {placement.queue} queue
                </strong>{' '}
                <span className="hint">
                  of {placement.queue === 'Frontend' ? queue!.split.frontend.length : queue!.split.backend.length}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="takeaways">
        <div className="takeaway">
          <h3>What split the room</h3>
          {split.length ? (
            <>
              <p>
                {split.length === 1 ? 'One ticket' : `${split.length} tickets`} had scores too far apart to average, so{' '}
                {split.length === 1 ? 'it went' : 'they went'} to a discussion rather than straight to a number.
              </p>
              <ul>
                {split.map((ticket) => (
                  <li key={ticket.jiraId}>
                    <strong>{ticket.jiraId}</strong> — spread {ticket.stdDev === null ? '—' : ticket.stdDev.toFixed(1)}
                    {ticket.discussionOutcome ? `, settled as ${ticket.discussionOutcome.toLowerCase()}` : ', still to be talked through'}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>
              Nobody was far apart on anything this round — every ticket was close enough to average straight to a
              score.
            </p>
          )}
        </div>

        <div className="takeaway">
          <h3>Your furthest call</h3>
          {furthest && Math.abs(furthestGap) > 0 ? (
            <p>
              <strong>{furthest.jiraId}</strong> — you had it at {furthest.yourTotal}, the committee at{' '}
              {furthest.businessScore}. You were <strong>{Math.abs(furthestGap)} points {furthestGap > 0 ? 'above' : 'below'}</strong>{' '}
              them. That is not a mistake to correct; it is the disagreement the spread exists to find.
            </p>
          ) : scoredByYou.length ? (
            <p>You landed on the committee's number on every ticket you scored this round.</p>
          ) : (
            <p>You didn't score anything in this round, so there is nothing of yours to compare.</p>
          )}
        </div>
      </div>

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
