import { useCallback, useEffect, useState } from 'react';
import {
  api,
  formatDateTime,
  type Category,
  type Member,
  type MemberProgress,
  type Round,
  type Submission,
  type Ticket,
  type TicketResult,
} from '../api';
import { Link } from '../router';
import { TicketEditor } from './TicketEditor';

/**
 * Coordinator dashboard for one round: ticket cards, submission progress,
 * live §10 results, distribution/reminders, pack, CSV and JIRA write-back.
 */
export function RoundDetailPage({ member, roundId }: { member: Member; roundId: string }) {
  const [round, setRound] = useState<Round | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [progress, setProgress] = useState<MemberProgress[]>([]);
  const [results, setResults] = useState<TicketResult[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<Ticket | 'new' | null>(null);
  const [csv, setCsv] = useState('');
  const [jql, setJql] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.round(roundId);
      setRound(data.round);
      setTickets(data.tickets);
      setCategories(data.categories);
      setProgress(data.progress ?? []);
      setResults(data.results ?? []);
      setSubmissions(data.submissions ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the round');
    }
  }, [roundId]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(label: string, action: () => Promise<string>) {
    setBusy(label);
    setMessage('');
    setError('');
    try {
      setMessage(await action());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy('');
    }
  }

  if (error && !round) return <p className="status error">{error}</p>;
  if (!round) return <p>Loading…</p>;

  const scored = results.filter((r) => r.aggregate.responsesCount > 0).length;
  const readyForEstimation = results.filter((r) => r.aggregate.sendForEstimation).length;

  return (
    <>
      <div className="row between">
        <div>
          <h1>{round.weekLabel}</h1>
          <p className="lede">
            <span className={`badge ${round.status === 'OPEN' ? 'open' : ''}`}>{round.status}</span> · Cut-off{' '}
            {formatDateTime(round.cutOffAt)} · {tickets.length} tickets · {scored} with responses · {readyForEstimation}{' '}
            ready to send for estimation
          </p>
        </div>
        <div className="row">
          <a className="button secondary" href={`/api/rounds/${round.id}/pack.pptx`}>
            Download pack (PPTX)
          </a>
          <a className="button secondary" href={`/api/rounds/${round.id}/pack.pdf`}>
            PDF
          </a>
          <a className="button secondary" href={`/api/rounds/${round.id}/results.csv`}>
            Results CSV
          </a>
        </div>
      </div>

      {message ? (
        <p className="status saved" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="status error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Round actions</h2>
        <div className="row">
          {round.status === 'DRAFT' ? (
            <button onClick={() => run('open', async () => (await api.setRoundStatus(round.id, 'OPEN'), 'Round opened.'))} disabled={Boolean(busy)}>
              Open round
            </button>
          ) : null}
          {round.status !== 'FINALISED' ? (
            <>
              <button
                className="secondary"
                disabled={Boolean(busy)}
                onClick={() =>
                  run('distribute', async () => {
                    const { results } = await api.distribute(round.id, true);
                    const sent = results.filter((r) => r.status === 'SENT').length;
                    const suppressed = results.filter((r) => r.status === 'SUPPRESSED').length;
                    return `Distribution: ${sent} sent, ${suppressed} suppressed (Graph sending disabled), ${
                      results.filter((r) => r.status === 'FAILED').length
                    } failed.`;
                  })
                }
              >
                Distribute to committee
              </button>
              <button
                className="secondary"
                disabled={Boolean(busy)}
                onClick={() =>
                  run('remind', async () => {
                    const { results } = await api.remind(round.id, false);
                    return `Reminded ${results.length} member(s) with outstanding tickets.`;
                  })
                }
              >
                Chase non-responders
              </button>
            </>
          ) : null}
          {round.status === 'OPEN' ? (
            <button className="secondary" disabled={Boolean(busy)} onClick={() => run('close', async () => (await api.setRoundStatus(round.id, 'CLOSED'), 'Round closed.'))}>
              Close scoring
            </button>
          ) : null}
          {round.status !== 'FINALISED' ? (
            <button
              disabled={Boolean(busy)}
              onClick={() => run('finalise', async () => (await api.finaliseRound(round.id), 'Round finalised. The committee can now see the anonymised feedback view.'))}
            >
              Finalise round
            </button>
          ) : (
            <>
              <Link className="button secondary" to={`/feedback/${round.id}`}>
                Open feedback view
              </Link>
              <button
                disabled={Boolean(busy)}
                onClick={() =>
                  run('writeback', async () => {
                    const { entries } = await api.writeBack(round.id);
                    const ok = entries.filter((e) => e.status === 'SUCCESS').length;
                    const skipped = entries.filter((e) => e.status === 'SKIPPED').length;
                    const failed = entries.filter((e) => e.status === 'FAILED');
                    return `JIRA write-back: ${ok} written, ${skipped} skipped, ${failed.length} failed${
                      failed.length ? ` (${failed[0].reason ?? ''})` : ''
                    }.`;
                  })
                }
              >
                Write scores to JIRA
              </button>
            </>
          )}
        </div>
      </div>

      <h2>Submission progress</h2>
      <div className="card table-scroll">
        <table>
          <caption className="visually-hidden">Committee submission progress</caption>
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Team</th>
              <th scope="col">Progress</th>
              <th scope="col" className="num">
                Outstanding
              </th>
              <th scope="col">Last submitted</th>
            </tr>
          </thead>
          <tbody>
            {progress.map((row) => (
              <tr key={row.memberId}>
                <th scope="row" style={{ background: 'transparent', textTransform: 'none', letterSpacing: 0, fontSize: '0.95rem', color: 'inherit' }}>
                  {row.memberName}
                </th>
                <td>{row.team || '—'}</td>
                <td>
                  <div className="row" style={{ gap: '0.5rem' }}>
                    <span className="bar" aria-hidden="true">
                      <span style={{ width: `${tickets.length ? (row.submitted / tickets.length) * 100 : 0}%` }} />
                    </span>
                    <span>
                      {row.submitted}/{tickets.length}
                    </span>
                  </div>
                </td>
                <td className="num">{row.outstanding}</td>
                <td>{formatDateTime(row.lastSubmittedAt)}</td>
              </tr>
            ))}
            {!progress.length ? (
              <tr>
                <td colSpan={5}>No active committee members.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <h2>Results</h2>
      <div className="card table-scroll">
        <table>
          <caption className="visually-hidden">Per-ticket results</caption>
          <thead>
            <tr>
              <th scope="col">Ticket</th>
              <th scope="col" className="num">
                Responses
              </th>
              <th scope="col" className="num">
                Business score
              </th>
              <th scope="col" className="num">
                Std dev
              </th>
              <th scope="col" className="num">
                Effort
              </th>
              <th scope="col" className="num">
                Ratio
              </th>
              <th scope="col">Status</th>
              <th scope="col">Flags</th>
            </tr>
          </thead>
          <tbody>
            {results.map(({ ticket, aggregate }) => (
              <tr key={ticket.id}>
                <th scope="row" style={{ background: 'transparent', textTransform: 'none', letterSpacing: 0, fontSize: '0.95rem', color: 'inherit' }}>
                  {ticket.jiraId} – {ticket.title}
                </th>
                <td className="num">{aggregate.responsesCount}</td>
                <td className="num">{aggregate.businessScore ?? '—'}</td>
                <td className="num">{aggregate.stdDev === null ? '—' : aggregate.stdDev.toFixed(1)}</td>
                <td className="num">{aggregate.effort ?? '—'}</td>
                <td className="num">{aggregate.priorityRatio === null ? '—' : aggregate.priorityRatio.toFixed(2)}</td>
                <td>
                  <span
                    className={`badge ${
                      aggregate.priorityBand === 'HIGH'
                        ? 'high'
                        : aggregate.priorityBand === 'MEDIUM'
                          ? 'medium'
                          : aggregate.discussionRequired || aggregate.toClose
                            ? 'warn'
                            : 'low'
                    }`}
                  >
                    {aggregate.statusLabel || '—'}
                  </span>
                </td>
                <td>
                  {aggregate.sendForEstimation ? <span className="badge high">Send for Est</span> : null}{' '}
                  {aggregate.clarificationRequested ? <span className="badge">Unsure ×{aggregate.excludedCounts.UNSURE}</span> : null}{' '}
                  {aggregate.parkRequested ? <span className="badge warn">Park</span> : null}
                </td>
              </tr>
            ))}
            {!results.length ? (
              <tr>
                <td colSpan={8}>No tickets in this round yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <h2>Tickets in this round</h2>
      <div className="card">
        <div className="row">
          <button onClick={() => setEditing('new')}>Add ticket manually</button>
          <button
            className="secondary"
            disabled={Boolean(busy)}
            onClick={() =>
              run('jira', async () => {
                const { imported } = await api.importJira(jql || undefined, round.id);
                return `Imported ${imported.length} ticket(s) from JIRA.`;
              })
            }
          >
            Import from JIRA
          </button>
          <input
            type="text"
            className="grow"
            aria-label="Override JQL for the import"
            placeholder="Optional JQL override (defaults to the configured queue)"
            value={jql}
            onChange={(e) => setJql(e.target.value)}
          />
        </div>

        <details style={{ marginTop: '0.9rem' }}>
          <summary>Import from CSV instead</summary>
          <p className="hint">
            Header row required. Recognised columns: jira_id, title, type, status, created, stakeholder, affects, impacts,
            workaround, executive_summary, current, panel_impacts, future, benefits, backend_poker_score,
            frontend_poker_score, effort, original_requestor, stream.
          </p>
          <textarea aria-label="CSV content" value={csv} onChange={(e) => setCsv(e.target.value)} />
          <button
            className="secondary"
            disabled={!csv.trim() || Boolean(busy)}
            onClick={() =>
              run('csv', async () => {
                const { imported, skipped } = await api.importCsv(csv, round.id);
                setCsv('');
                return `Imported ${imported.length} ticket(s); ${skipped.length} row(s) skipped.`;
              })
            }
          >
            Import CSV
          </button>
        </details>
      </div>

      {tickets.map((ticket) => (
        <div className="card" key={ticket.id}>
          <div className="row between">
            <div>
              <h3 style={{ margin: 0 }}>
                {ticket.jiraId} – {ticket.title}
              </h3>
              <p className="hint" style={{ margin: 0 }}>
                {ticket.execSummary ? 'Card written' : 'No executive summary yet'} · Backend{' '}
                {ticket.backendPokerScore ?? '—'} · Frontend {ticket.frontendPokerScore ?? '—'} · Manual effort{' '}
                {ticket.manualEffort ?? '—'}
              </p>
            </div>
            <div className="row">
              <button className="secondary" onClick={() => setEditing(ticket)}>
                Edit card
              </button>
              <button
                className="danger"
                disabled={Boolean(busy)}
                onClick={() =>
                  run('remove', async () => {
                    await api.removeTicketFromRound(round.id, ticket.id);
                    return `${ticket.jiraId} removed from this round.`;
                  })
                }
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ))}

      {editing ? (
        <TicketEditor
          ticket={editing === 'new' ? null : editing}
          roundId={round.id}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      ) : null}

      <h2>Who scored what</h2>
      <p className="hint">
        Individual scores are visible to coordinators only, so you can chase non-responders. The committee sees the
        anonymised view after finalisation.
      </p>
      <div className="card table-scroll">
        <table>
          <caption className="visually-hidden">Individual submissions</caption>
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Ticket</th>
              <th scope="col">Answer</th>
              <th scope="col" className="num">
                Total
              </th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {submissions.map((submission) => {
              const ticket = tickets.find((t) => t.id === submission.ticketId);
              const total = categories.reduce((sum, c) => sum + (submission.scores[c.id] ?? 0), 0);
              return (
                <tr key={submission.id}>
                  <td>{submission.memberName ?? submission.memberId}</td>
                  <td>{ticket?.jiraId ?? '—'}</td>
                  <td>{submission.relevance}</td>
                  <td className="num">{submission.relevance === 'YES' ? total : '—'}</td>
                  <td>{[submission.moreInfo, submission.closureReason, submission.closureInfo].filter(Boolean).join(' · ') || '—'}</td>
                </tr>
              );
            })}
            {!submissions.length ? (
              <tr>
                <td colSpan={5}>No submissions yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="hint">Signed in as {member.email}.</p>
    </>
  );
}
