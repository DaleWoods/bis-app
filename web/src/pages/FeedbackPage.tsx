import { useEffect, useState } from 'react';
import { api, formatDateTime, type FeedbackTicket, type Round } from '../api';

/**
 * §9 post-round feedback view - visible to the whole committee once a round is
 * finalised. Shows how each ticket scored (per-category averages, total, spread,
 * discussion flag) with no individual attribution.
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

  return (
    <>
      <h1>How the committee scored – {round.weekLabel}</h1>
      <p className="lede">
        Finalised {formatDateTime(round.finalisedAt)}. Scores are shown as committee averages and spread. Individual
        scores are never attributed to a named member.
      </p>

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
