import { useState } from 'react';
import {
  DISCUSSION_OUTCOMES,
  DISCUSSION_OUTCOME_LABELS,
  api,
  formatDateTime,
  type DiscussionItem,
  type DiscussionOutcome,
} from '../api';

/**
 * §10.4: the meeting about the tickets the committee could not agree on.
 *
 * The app used to flag a split ticket and stop there. The coordinator then held
 * the meeting off-app, and nothing came back — so the average of two people who
 * said 1 and 70 went to JIRA as if it were a settled number. This is where the
 * meeting's answer is written down, and until it is, the ticket is held out of
 * the write-back.
 */
export function DiscussionPanel({
  roundId,
  items,
  threshold,
  onChanged,
}: {
  roundId: string;
  items: DiscussionItem[];
  threshold: number;
  onChanged: (items: DiscussionItem[]) => void;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  if (!items.length) return null;

  // Two different things, and saying so matters: a ticket sent back to be
  // scored again has an outcome recorded and is still held out of JIRA.
  const undecided = items.filter((item) => !item.discussion?.outcome).length;
  const held = items.filter((item) => item.blockingWriteBack).length;

  async function save(item: DiscussionItem, form: FormData) {
    const outcome = String(form.get('outcome') ?? '') as DiscussionOutcome | '';
    const rawScore = String(form.get('agreedScore') ?? '').trim();
    const meetingAt = String(form.get('meetingAt') ?? '').trim();

    setBusy(item.ticketId);
    setError('');
    setMessage('');
    try {
      const result = await api.recordDiscussion(roundId, item.ticketId, {
        outcome,
        // Left blank on an agreed outcome, the server falls back to the
        // calculated average - which is a legitimate answer to "we talked and
        // the number was right after all".
        agreedScore: outcome === 'AGREED' && rawScore ? Number(rawScore) : null,
        // datetime-local has no timezone; the browser's is the right one here.
        meetingAt: meetingAt ? new Date(meetingAt).toISOString() : null,
        note: String(form.get('note') ?? ''),
      });
      onChanged(result.items);
      setMessage(
        outcome === 'AGREED'
          ? `${item.jiraId}: agreed ${result.discussion.agreedScore}. It will go to JIRA on the next write-back.`
          : outcome === 'RESCORE'
            ? `${item.jiraId}: going back to the committee${
                result.rescoredInto ? ` in ${result.rescoredInto.weekLabel}` : ' — add it to the next round when you create one'
              }.`
            : outcome === 'CLOSE'
              ? `${item.jiraId}: recorded as one to close. No score will be written for it.`
              : `${item.jiraId}: meeting noted. The ticket stays held until an outcome is recorded.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record that');
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <h2>Discussions</h2>
      <div className="card">
        <p className="lede" style={{ marginTop: 0 }}>
          {items.length} ticket{items.length === 1 ? '' : 's'} the committee did not agree on — scores further apart than
          the threshold of {threshold}.{' '}
          {undecided
            ? `${undecided} still ${undecided === 1 ? 'has' : 'have'} no outcome recorded.`
            : 'Every one of them has an outcome recorded.'}{' '}
          {held
            ? `${held} ${held === 1 ? 'is' : 'are'} held out of the JIRA write-back.`
            : 'None of them is holding up the write-back.'}
        </p>
        <p className="hint">
          Book the meeting in Outlook as usual — this is where what it decided gets written down. Scores stay
          unattributed here, the same as everywhere else.
        </p>

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

        {items.map((item) => {
          const recorded = item.discussion?.outcome ?? '';
          return (
            <div key={item.ticketId} className="discussion-item">
              <div className="row between">
                <h3 style={{ margin: 0 }}>
                  {item.jiraId} – {item.title}
                </h3>
                {recorded ? (
                  // Green only for the outcome that releases the ticket. A
                  // re-score or a close is a decision, not a success.
                  <span className={`badge ${recorded === 'AGREED' ? 'high' : ''}`}>
                    {DISCUSSION_OUTCOME_LABELS[recorded as DiscussionOutcome]}
                  </span>
                ) : (
                  <span className="badge warn">Waiting on the meeting</span>
                )}
              </div>

              <div className="metrics">
                <span className="metric">
                  <b>{item.responsesCount}</b> responses
                </span>
                <span className="metric">
                  <b>{item.lowest ?? '—'}</b> lowest
                </span>
                <span className="metric">
                  <b>{item.highest ?? '—'}</b> highest
                </span>
                <span className="metric over">
                  <b>{item.stdDev === null ? '—' : item.stdDev.toFixed(1)}</b> spread
                </span>
                <span className="metric">
                  <b>{item.calculatedScore ?? '—'}</b> average
                </span>
                {item.discussion?.agreedScore !== null && item.discussion?.agreedScore !== undefined ? (
                  <span className="metric">
                    <b>{item.discussion.agreedScore}</b> agreed
                  </span>
                ) : null}
              </div>

              <p className="hint" style={{ margin: '0.3rem 0 0' }}>
                Every score given: {item.totals.join(', ') || 'none'}
              </p>
              {item.notes.length ? (
                <ul className="hint" style={{ margin: '0.3rem 0 0' }}>
                  {item.notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              ) : null}
              {item.discussion?.resolvedAt ? (
                <p className="hint" style={{ margin: '0.3rem 0 0' }}>
                  Recorded by {item.discussion.resolvedBy || 'a coordinator'} on{' '}
                  {formatDateTime(item.discussion.resolvedAt)}
                  {item.discussion.note ? ` — “${item.discussion.note}”` : ''}
                </p>
              ) : null}

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(item, new FormData(event.currentTarget));
                }}
              >
                <div className="row">
                  <div className="grow field">
                    <label htmlFor={`meetingAt-${item.ticketId}`}>Meeting</label>
                    <input
                      id={`meetingAt-${item.ticketId}`}
                      name="meetingAt"
                      type="datetime-local"
                      defaultValue={toLocalInput(item.discussion?.meetingAt ?? null)}
                    />
                  </div>
                  <div className="grow field">
                    <label htmlFor={`outcome-${item.ticketId}`}>What was decided</label>
                    <select id={`outcome-${item.ticketId}`} name="outcome" defaultValue={recorded}>
                      <option value="">Not yet — meeting still to happen</option>
                      {DISCUSSION_OUTCOMES.map((outcome) => (
                        <option key={outcome} value={outcome}>
                          {DISCUSSION_OUTCOME_LABELS[outcome]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grow field">
                    <label htmlFor={`agreedScore-${item.ticketId}`}>Agreed score</label>
                    <input
                      id={`agreedScore-${item.ticketId}`}
                      name="agreedScore"
                      type="number"
                      min={0}
                      step={1}
                      placeholder={item.calculatedScore === null ? '' : String(item.calculatedScore)}
                      defaultValue={item.discussion?.agreedScore ?? ''}
                    />
                    <p className="hint">Used only for “{DISCUSSION_OUTCOME_LABELS.AGREED}”. Blank keeps the average.</p>
                  </div>
                </div>
                <label htmlFor={`note-${item.ticketId}`}>Note</label>
                <textarea
                  id={`note-${item.ticketId}`}
                  name="note"
                  rows={2}
                  defaultValue={item.discussion?.note ?? ''}
                  placeholder="What the committee concluded, in a sentence — the whole committee sees this on the feedback view."
                />
                <div className="row" style={{ marginTop: '0.5rem' }}>
                  <button type="submit" disabled={busy === item.ticketId}>
                    {busy === item.ticketId ? 'Saving…' : 'Record outcome'}
                  </button>
                </div>
              </form>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** An ISO instant as the local wall-clock string `datetime-local` expects. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}
