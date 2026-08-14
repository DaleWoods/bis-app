import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  api,
  formatDateTime,
  type Category,
  type Member,
  type MemberProgress,
  type Round,
  type AutomationStatus,
  type Submission,
  type Ticket,
  type DiscussionItem,
  type TicketResult,
  type WriteBackEntry,
} from '../api';
import { cardWarnings } from '../card';
import { Link } from '../router';
import { DiscussionPanel } from '../components/DiscussionPanel';
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
  /**
   * The ticket id being edited, or 'new'. An id rather than the ticket object,
   * because the editor is rendered from the list and so always gets the freshly
   * loaded ticket rather than the copy captured when Edit was pressed.
   */
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [csv, setCsv] = useState('');
  const [jql, setJql] = useState('');
  const [integrations, setIntegrations] = useState<{ jiraConfigured: boolean; graphSendEnabled: boolean } | null>(null);
  /** From Settings, so the spread numbers on screen can say what they are measured against. */
  const [discussionThreshold, setDiscussionThreshold] = useState(16);
  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  const [showAutomationLog, setShowAutomationLog] = useState(false);
  const [writeBackEntries, setWriteBackEntries] = useState<WriteBackEntry[]>([]);
  /** §10.4: the tickets the committee split on, and what the meeting decided. */
  const [discussions, setDiscussions] = useState<DiscussionItem[]>([]);
  const [emails, setEmails] = useState<
    Array<{ id: string; kind: string; toAddress: string; subject: string; status: string; error: string; sentAt: string }>
  >([]);

  /**
   * The four requests the page needs, in flight together and all awaited.
   *
   * They used to be fired without awaiting, so switching rounds quickly left
   * the previous round's replies to land in this round's state. `cancelled`
   * closes that: a load whose round is no longer on screen resolves and is
   * discarded.
   */
  const load = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      // Integration status drives the notices below, so the coordinator knows
      // what a button will actually do before pressing it.
      const [config, emailLog, automationStatus, agenda, data] = await Promise.all([
        api.config().catch(() => null),
        api.emails(roundId).catch(() => null),
        api.automationStatus(roundId).catch(() => null),
        api.discussions(roundId).catch(() => null),
        api.round(roundId).then(
          (value) => ({ ok: true as const, value }),
          (err: unknown) => ({ ok: false as const, err }),
        ),
      ]);
      if (!isCurrent()) return;

      setIntegrations(config?.integrations ?? null);
      if (config) setDiscussionThreshold(config.config.scoring.stdDevDiscussionThreshold);
      setEmails(emailLog?.emails ?? []);
      setAutomation(automationStatus ?? null);
      setDiscussions(agenda?.items ?? []);

      if (!data.ok) {
        setError(data.err instanceof Error ? data.err.message : 'Could not load the round');
        return;
      }
      setRound(data.value.round);
      setTickets(data.value.tickets);
      setCategories(data.value.categories);
      setProgress(data.value.progress ?? []);
      setResults(data.value.results ?? []);
      setSubmissions(data.value.submissions ?? []);
      setError('');
    },
    [roundId],
  );

  useEffect(() => {
    let cancelled = false;
    load(() => !cancelled);
    return () => {
      cancelled = true;
    };
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

  /**
   * Runs the write-back and keeps the per-ticket answer on screen. The toast
   * gives the count; the table below gives the reasons, which is what a
   * coordinator actually needs when nothing was written.
   */
  function writeBack(ignoreMinSubmissions: boolean) {
    if (
      ignoreMinSubmissions &&
      !window.confirm('Write these scores to JIRA on fewer responses than the minimum? The score goes across as it stands.')
    ) {
      return;
    }
    return run('writeback', async () => {
      const { entries } = await api.writeBack(round!.id, { ignoreMinSubmissions });
      setWriteBackEntries(entries);
      const ok = entries.filter((e) => e.status === 'SUCCESS').length;
      const skipped = entries.filter((e) => e.status === 'SKIPPED').length;
      const failed = entries.filter((e) => e.status === 'FAILED').length;
      if (!entries.length) return 'No tickets in this round to write back.';
      if (!ok) return `Nothing written — ${skipped} skipped, ${failed} failed. See why below.`;
      return `JIRA write-back: ${ok} written${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}.`;
    });
  }

  if (error && !round) return <p className="status error">{error}</p>;
  if (!round) return <p>Loading…</p>;

  const scored = results.filter((r) => r.aggregate.responsesCount > 0).length;
  const readyForEstimation = results.filter((r) => r.aggregate.sendForEstimation).length;
  const needDiscussion = results.filter((r) => r.aggregate.discussionRequired);

  return (
    <>
      <div className="row between">
        <div>
          <h1>{round.weekLabel}</h1>
          <p className="lede">
            <span className={`badge ${round.status === 'OPEN' ? 'open' : ''}`}>{round.status}</span> · Cut-off{' '}
            {formatDateTime(round.cutOffAt)} · {tickets.length} tickets · {scored} with responses · {readyForEstimation}{' '}
            ready to send for estimation
            {needDiscussion.length ? (
              <>
                {' · '}
                <span className="badge warn">
                  {needDiscussion.length} need{needDiscussion.length === 1 ? 's' : ''} discussion
                </span>
              </>
            ) : null}
            {round.distributionSentAt ? (
              <>
                {' · '}
                <span className="badge open">Distributed {formatDateTime(round.distributionSentAt)}</span>
              </>
            ) : null}
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

      {integrations && !integrations.graphSendEnabled ? (
        <div className="notice warn">
          <strong>Email is not switched on.</strong> “Distribute” and “Chase non-responders” compose the messages and
          record them in the email log below, but send nothing. Share the scoring link with the committee yourself for
          now — they can sign in and score straight away.
          <div className="row" style={{ marginTop: '0.6rem' }}>
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                const link = `${window.location.origin}/score/${round.id}`;
                try {
                  await navigator.clipboard.writeText(link);
                  setMessage(`Scoring link copied: ${link}`);
                } catch {
                  setMessage(`Scoring link: ${link}`);
                }
              }}
            >
              Copy scoring link
            </button>
          </div>
        </div>
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
                onClick={() => {
                  if (
                    round.distributionSentAt &&
                    !window.confirm(
                      `This round was already distributed on ${formatDateTime(round.distributionSentAt)}. Send it again to the whole committee?`,
                    )
                  ) {
                    return;
                  }
                  return run('distribute', async () => {
                    const { results } = await api.distribute(round.id, true);
                    const sent = results.filter((r) => r.status === 'SENT').length;
                    const suppressed = results.filter((r) => r.status === 'SUPPRESSED').length;
                    const failed = results.filter((r) => r.status === 'FAILED').length;
                    if (suppressed && !sent) {
                      return `Round opened, but NO EMAIL WAS SENT — email is not configured. ${suppressed} message(s) were composed and logged. Use "Copy scoring link" to share it yourself.`;
                    }
                    return `Distribution: ${sent} sent${suppressed ? `, ${suppressed} not sent (email off)` : ''}${
                      failed ? `, ${failed} failed` : ''
                    }.`;
                  });
                }}
              >
                {round.distributionSentAt ? 'Re-send to committee' : 'Distribute to committee'}
              </button>
              <button
                className="secondary"
                disabled={Boolean(busy)}
                onClick={() =>
                  run('remind', async () => {
                    const { results } = await api.remind(round.id, false);
                    const sent = results.filter((r) => r.status === 'SENT').length;
                    if (results.length && !sent) {
                      return `NO EMAIL WAS SENT — email is not configured. ${results.length} reminder(s) were composed and logged.`;
                    }
                    return `Reminded ${sent} member(s) with outstanding tickets.`;
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
              <button disabled={Boolean(busy)} onClick={() => writeBack(false)}>
                Write scores to JIRA
              </button>
              {/*
                Finalising freezes the results, so excluding a submission
                afterwards changes nothing until this is pressed. Without it the
                row greyed out and the numbers sat still, with nothing saying
                why.
              */}
              <button
                className="secondary"
                disabled={Boolean(busy)}
                onClick={() =>
                  run('recalculate', async () => {
                    const { scoresChanged, newlySplit } = await api.recalculateRound(round.id);
                    if (!scoresChanged && !newlySplit.length) return 'Recalculated — nothing changed.';
                    return `Recalculated: ${scoresChanged} score(s) changed${
                      newlySplit.length
                        ? `, and ${newlySplit.join(', ')} ${newlySplit.length === 1 ? 'is' : 'are'} now too split to average — held for discussion.`
                        : '.'
                    }`;
                  })
                }
              >
                Recalculate results
              </button>
              {/*
                Reopening is deliberately not styled as a primary action: the
                results are frozen and may already be in JIRA. The confirm says
                so rather than the button trying to.
              */}
              <button
                className="secondary"
                disabled={Boolean(busy)}
                onClick={() => {
                  if (
                    !window.confirm(
                      'Reopen this round for scoring?\n\nThe frozen results are released and will be recalculated when you finalise it again. Any scores already written to JIRA stay there until you write back a second time.',
                    )
                  ) {
                    return;
                  }
                  return run('reopen', async () => {
                    await api.setRoundStatus(round.id, 'CLOSED');
                    await api.setRoundStatus(round.id, 'OPEN');
                    return 'Round reopened — the committee can score it again.';
                  });
                }}
              >
                Reopen for scoring
              </button>
            </>
          )}
        </div>

        {/* What the app will do next, and the way to overrule it. */}
        {automation ? (
          <div className="automation">
            <p className="next">
              <span className={`dot ${automation.paused || !automation.enabled ? 'off' : 'on'}`} aria-hidden="true" />
              {automation.next}
            </p>
            <div className="row">
              {automation.enabled ? (
                <button
                  className="secondary"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    run('pause', async () => {
                      await api.setRoundAutomation(round.id, !automation.paused);
                      return automation.paused
                        ? 'Automation resumed for this round.'
                        : 'Automation paused for this round — every step is yours to run.';
                    })
                  }
                >
                  {automation.paused ? 'Resume automation' : 'Pause automation for this round'}
                </button>
              ) : null}
              {automation.log.length ? (
                <button className="secondary" type="button" onClick={() => setShowAutomationLog((v) => !v)}>
                  {showAutomationLog ? 'Hide' : 'Show'} what the app has done ({automation.log.length})
                </button>
              ) : null}
            </div>

            {showAutomationLog ? (
              <ul className="automation-log">
                {automation.log.map((entry) => (
                  <li key={entry.action}>
                    <strong>{entry.action}</strong> <span className="hint">{formatDateTime(entry.ranAt)}</span>
                    <div>{entry.outcome || 'In progress…'}</div>
                    {entry.detail ? <pre>{entry.detail}</pre> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      {/*
        The write-back result, per ticket. "1 skipped" on its own tells a
        coordinator nothing - the reason is the whole answer, and it used to be
        thrown away.
      */}
      {writeBackEntries.length ? (
        <div className="card">
          <div className="row between">
            <h2 style={{ marginTop: 0 }}>JIRA write-back</h2>
            <button className="secondary" type="button" onClick={() => setWriteBackEntries([])}>
              Dismiss
            </button>
          </div>
          <div className="table-scroll">
            <table>
              <caption className="visually-hidden">What happened to each ticket</caption>
              <thead>
                <tr>
                  <th scope="col">Ticket</th>
                  <th scope="col" className="num">
                    Score
                  </th>
                  <th scope="col">Result</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {writeBackEntries.map((entry) => (
                  <tr key={entry.jiraId}>
                    <th scope="row" className="plain">
                      {entry.jiraId}
                    </th>
                    <td className="num">{entry.businessScore ?? '—'}</td>
                    <td>
                      <span
                        className={`badge ${entry.status === 'SUCCESS' ? 'high' : entry.status === 'FAILED' ? 'warn' : ''}`}
                      >
                        {entry.status === 'SUCCESS' ? 'Written' : entry.status === 'FAILED' ? 'Failed' : 'Skipped'}
                      </span>
                      {entry.transitionedTo ? <div className="hint">Moved to {entry.transitionedTo}</div> : null}
                    </td>
                    <td>{entry.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {writeBackEntries.some((e) => e.status === 'SKIPPED' && e.businessScore !== null) ? (
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <button className="secondary" disabled={Boolean(busy)} onClick={() => writeBack(true)}>
                Write the skipped scores anyway
              </button>
              <p className="hint" style={{ margin: 0 }}>
                Overrides the minimum-responses gate. The score goes to JIRA as it stands, on fewer responses than the
                settings ask for.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <DiscussionPanel
        roundId={round.id}
        items={discussions}
        threshold={discussionThreshold}
        onChanged={setDiscussions}
      />

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

      <h2>Tickets &amp; results</h2>
      <p className="hint">Each ticket appears once, with its card content and its live score together.</p>
      <div className="card">
        <div className="row">
          <button onClick={() => setEditing('new')}>Add ticket manually</button>
          <button
            className="secondary"
            disabled={Boolean(busy)}
            onClick={() =>
              run('jira', async () => {
                const result = await api.importJira(jql || undefined, round.id);
                if (!result.imported.length) {
                  return `No tickets matched. JIRA was searched with: ${result.jql} — check the status name is exactly right (Settings → JIRA).`;
                }
                const drafted = result.aiDrafted
                  ? ` ${result.aiDrafted} card(s) drafted from the full ticket — review them before you distribute.`
                  : '';
                return `Imported ${result.imported.length} ticket(s) from JIRA.${drafted}`;
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

      {/* A new ticket opens where the button that created it is, not at the
          bottom of the list. */}
      {editing === 'new' ? (
        <TicketEditor
          ticket={null}
          roundId={round.id}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      ) : null}

      {tickets.map((ticket) => {
        const result = results.find((r) => r.ticket.id === ticket.id)?.aggregate;
        /*
          The card is all a committee member gets, and once the round runs
          itself nobody is necessarily reading them before they go out. So the
          checks that can be made mechanically are made here, in the words a
          coordinator would use, rather than leaving a weak card to be found by
          the committee scoring it.
        */
        const gaps = cardWarnings({
          ...ticket,
          hasUnusedImage: ticket.attachments.some((a) => a.isImage),
        });

        const isEditing = editing === ticket.id;

        return (
        <Fragment key={ticket.id}>
        <div className={`card ticket-row${isEditing ? ' editing' : ''}`} id={`ticket-${ticket.id}`}>
          <div className="row between">
            <div className="grow">
              <h3 style={{ margin: 0 }}>
                {ticket.jiraId} – {ticket.title}
              </h3>

              {/* Everything about this ticket lives here - it is not listed twice. */}
              <div className="metrics">
                <span className={`badge ${
                  result?.priorityBand === 'HIGH'
                    ? 'high'
                    : result?.priorityBand === 'MEDIUM'
                      ? 'medium'
                      : result?.discussionRequired || result?.toClose
                        ? 'warn'
                        : ''
                }`}>
                  {result?.statusLabel || 'Not scored yet'}
                </span>
                <span className="metric">
                  <b>{result?.responsesCount ?? 0}</b> responses
                </span>
                <span className="metric">
                  <b>{result?.businessScore ?? '—'}</b> score
                </span>
                <span className={`metric${result?.discussionRequired ? ' over' : ''}`}>
                  <b>{result?.stdDev === null || result?.stdDev === undefined ? '—' : result.stdDev.toFixed(1)}</b> spread
                </span>
                <span className="metric">
                  <b>{result?.effort ?? '—'}</b> effort
                </span>
                <span className="metric">
                  <b>{result?.priorityRatio === null || result?.priorityRatio === undefined ? '—' : result.priorityRatio.toFixed(2)}</b> ratio
                </span>
                {/*
                  Its own badge, not just a tint on the status label. The §10.3
                  status gate puts "Awaiting RA effort" ahead of "Pending
                  discussion", so a ticket the committee flatly disagreed on
                  showed no sign of it until RA had estimated it — and
                  disagreement about value has nothing to do with effort.
                */}
                {result?.discussionRequired ? (
                  <span className="badge warn" title={`Spread ${result.stdDev?.toFixed(1)} is over the threshold of ${discussionThreshold}`}>
                    Discussion needed
                  </span>
                ) : null}
                {result?.sendForEstimation ? <span className="badge high">Send for Est</span> : null}
                {result?.clarificationRequested ? <span className="badge">Unsure ×{result.excludedCounts.UNSURE}</span> : null}
                {result?.parkRequested ? <span className="badge warn">Park</span> : null}
              </div>

              {result?.discussionRequired ? (
                <p className="hint" style={{ margin: '0.4rem 0 0' }}>
                  The committee is split on this one — scores ranged {Math.min(...result.totalsDistribution)} to{' '}
                  {Math.max(...result.totalsDistribution)} out of 70, a spread of {result.stdDev?.toFixed(1)} against a
                  threshold of {discussionThreshold}. It will not go for estimation, and nothing is written to JIRA for
                  it, until the meeting about it is recorded under Discussions below.
                </p>
              ) : null}

              <p className={`hint${gaps.length ? ' card-gaps' : ''}`} style={{ margin: '0.4rem 0 0' }}>
                {gaps.length ? `Check this card — ${gaps.join('; ')}` : 'Card reads well'} · Backend{' '}
                {ticket.backendPokerScore ?? '—'} · Frontend {ticket.frontendPokerScore ?? '—'} · Manual effort{' '}
                {ticket.manualEffort ?? '—'}
              </p>
            </div>
            <div className="row">
              <button className="secondary" onClick={() => setEditing(isEditing ? null : ticket.id)}>
                {isEditing ? 'Close editor' : 'Edit card'}
              </button>
              <button
                className="danger"
                disabled={Boolean(busy)}
                onClick={() => {
                  const scored = submissions.filter((s) => s.ticketId === ticket.id && !s.archived).length;
                  if (
                    scored > 0 &&
                    !window.confirm(
                      `Remove ${ticket.jiraId} from this round? The ${scored} score(s) already given to it will be deleted.`,
                    )
                  ) {
                    return;
                  }
                  return run('remove', async () => {
                    const { submissionsRemoved } = await api.removeTicketFromRound(round.id, ticket.id);
                    return `${ticket.jiraId} removed from this round${
                      submissionsRemoved ? `, along with ${submissionsRemoved} score(s) for it` : ''
                    }.`;
                  });
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>

        {/* The editor opens under the ticket it belongs to, so a card near the
            top of a thirty-ticket round does not send you to the bottom of the
            page to edit it. Rendering it inside this ticket's Fragment also
            remounts the form when you switch cards - React cannot reuse an
            instance across two different parents. */}
        {isEditing ? (
          <TicketEditor
            ticket={ticket}
            roundId={round.id}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await load();
            }}
          />
        ) : null}
        </Fragment>
        );
      })}

      <h2>Email log</h2>
      <p className="hint">
        Every distribution and reminder attempt, whether it was sent or only composed. Failures stay visible here and
        can be re-triggered from Round actions.
      </p>
      <div className="card table-scroll">
        <table>
          <caption className="visually-hidden">Email attempts for this round</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Kind</th>
              <th scope="col">To</th>
              <th scope="col">Subject</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {emails.map((entry) => (
              <tr key={entry.id}>
                <td>{formatDateTime(entry.sentAt)}</td>
                <td>{entry.kind}</td>
                <td>{entry.toAddress}</td>
                <td>{entry.subject}</td>
                <td>
                  <span className={`badge ${entry.status === 'SENT' ? 'high' : entry.status === 'FAILED' ? 'warn' : ''}`}>
                    {entry.status === 'SUPPRESSED' ? 'NOT SENT (email off)' : entry.status}
                  </span>
                  {entry.error && entry.status === 'FAILED' ? <div className="hint">{entry.error}</div> : null}
                </td>
              </tr>
            ))}
            {!emails.length ? (
              <tr>
                <td colSpan={5}>Nothing attempted yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <h2>Who scored what</h2>
      <p className="hint">
        Individual scores are visible to coordinators only, so you can chase non-responders. The committee sees the
        anonymised view after finalisation.
      </p>
      {round.status === 'FINALISED' ? (
        <div className="notice warn">
          <strong>This round’s results are frozen.</strong> Excluding or restoring a score here will not change the
          business score or the spread until you press <strong>Recalculate results</strong> under Round actions. That is
          deliberate — a finalised figure may already be in JIRA — but it does mean an exclusion sits there doing
          nothing until you say so.
        </div>
      ) : null}
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
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {submissions.map((submission) => {
              const ticket = tickets.find((t) => t.id === submission.ticketId);
              const total = categories.reduce((sum, c) => sum + (submission.scores[c.id] ?? 0), 0);
              return (
                <tr key={submission.id} style={submission.archived ? { opacity: 0.55 } : undefined}>
                  <td>
                    {submission.memberName ?? submission.memberId}
                    {submission.archived ? <span className="badge"> excluded</span> : null}
                  </td>
                  <td>{ticket?.jiraId ?? '—'}</td>
                  <td>{submission.relevance}</td>
                  <td className="num">{submission.relevance === 'YES' ? total : '—'}</td>
                  <td>{[submission.moreInfo, submission.closureReason, submission.closureInfo].filter(Boolean).join(' · ') || '—'}</td>
                  <td>
                    <button
                      className="secondary"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        run('archive', async () => {
                          await api.archiveSubmission(round.id, submission.id, !submission.archived);
                          return submission.archived
                            ? `Restored ${submission.memberName ?? 'that'} submission — it counts again.`
                            : `Excluded ${submission.memberName ?? 'that'} submission from the score.`;
                        })
                      }
                    >
                      {submission.archived ? 'Restore' : 'Exclude'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {!submissions.length ? (
              <tr>
                <td colSpan={6}>No submissions yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="hint">Signed in as {member.email}.</p>
    </>
  );
}
