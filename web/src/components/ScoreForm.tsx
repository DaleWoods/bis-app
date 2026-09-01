import { useEffect, useMemo, useState } from 'react';
import type { Category, Relevance, Submission, Ticket } from '../api';

interface Props {
  ticket: Ticket;
  roundId: string;
  categories: Category[];
  relevanceOptions: Array<{ value: Relevance; label: string }>;
  closureReasons: string[];
  submission?: Submission;
  memberEmail: string;
  disabled: boolean;
  disabledReason?: string;
  onSave: (payload: {
    relevance: Relevance;
    scores?: Record<string, number>;
    closureReason?: string;
    closureInfo?: string;
    moreInfo?: string;
  }) => Promise<void>;
}

/** Every whole number on a category's scale, for one button per score. */
function scoreOptions(category: Category): number[] {
  const options: number[] = [];
  for (let n = category.scaleMin; n <= category.scaleMax; n += 1) options.push(n);
  return options;
}

interface Draft {
  relevance: Relevance;
  scores: Record<string, number>;
  closureReason: string;
  closureInfo: string;
  moreInfo: string;
}

function draftKey(roundId: string, ticketId: string, memberEmail: string): string {
  return `bis-draft-${roundId}-${ticketId}-${memberEmail.toLowerCase()}`;
}

/*
  Getting through a round rarely happens in one sitting - a member starts on
  their phone between meetings, gets pulled away mid-ticket, and comes back
  later to a blank form. Nothing here is submitted or scored; it is just
  today's un-submitted picks, kept on this device only, so starting over is
  never the price of an interruption.
*/
function loadDraft(key: string): Draft | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

function saveDraft(key: string, draft: Draft): void {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Private browsing or a full quota - the draft just does not persist.
  }
}

function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * The native in-app scoring form that replaces the Microsoft Form: the §8
 * relevance question first, then 0–10 for each category (§6), plus notes.
 */
export function ScoreForm({
  ticket,
  roundId,
  categories,
  relevanceOptions,
  closureReasons,
  submission,
  memberEmail,
  disabled,
  disabledReason,
  onSave,
}: Props) {
  const key = draftKey(roundId, ticket.id, memberEmail);
  // Read once, at mount - not on every render, and never once a submission exists.
  const [draftAtMount] = useState<Draft | null>(() => (submission ? null : loadDraft(key)));
  // The starting point every field is measured against - a resumed draft, a
  // submission's own answer, or the plain defaults. Kept alongside the live
  // state so the save effect can tell "still exactly what was there at
  // mount" from "the member changed something" without depending on which
  // render an effect happens to fire on - React 18 Strict Mode runs mount
  // effects twice in development, and a "first write" flag would only catch
  // one of those two runs.
  const [initialDraft] = useState<Draft>(() => ({
    relevance: draftAtMount?.relevance ?? submission?.relevance ?? 'YES',
    scores: (() => {
      const initial: Record<string, number> = {};
      for (const category of categories)
        initial[category.id] = draftAtMount?.scores?.[category.id] ?? submission?.scores?.[category.id] ?? 0;
      return initial;
    })(),
    closureReason: draftAtMount?.closureReason ?? submission?.closureReason ?? '',
    closureInfo: draftAtMount?.closureInfo ?? submission?.closureInfo ?? '',
    moreInfo: draftAtMount?.moreInfo ?? submission?.moreInfo ?? '',
  }));
  const [relevance, setRelevance] = useState<Relevance>(initialDraft.relevance);
  const [scores, setScores] = useState<Record<string, number>>(initialDraft.scores);
  const [closureReason, setClosureReason] = useState(initialDraft.closureReason);
  const [closureInfo, setClosureInfo] = useState(initialDraft.closureInfo);
  const [moreInfo, setMoreInfo] = useState(initialDraft.moreInfo);
  const [status, setStatus] = useState<{ tone: 'saved' | 'error' | ''; message: string }>({ tone: '', message: '' });
  const [saving, setSaving] = useState(false);

  /*
    A score is given once and stands - it cannot be revised.

    An answer that can be changed is an answer that can be changed after
    hearing what everyone else thought, and the spread that decides whether a
    ticket needs discussing only means anything if each score was formed
    independently. So a submitted score locks, and the way back is for the
    coordinator to exclude it.
  */
  const locked = Boolean(submission) && !submission?.archived;
  const readOnly = disabled || locked;

  // A draft can only outlive its own submission if something saved it after
  // the submit already cleared it (a second tab, an earlier device) - rare,
  // but worth sweeping up rather than leaving a dead entry in storage.
  useEffect(() => {
    if (submission) clearDraft(key);
  }, [key, submission]);

  // Only write once something differs from where the form started - an
  // untouched ticket never gets a "draft" of its own blank defaults, so the
  // resume hint only ever appears where something was actually left mid-way.
  useEffect(() => {
    if (locked) return;
    const current: Draft = { relevance, scores, closureReason, closureInfo, moreInfo };
    if (JSON.stringify(current) === JSON.stringify(initialDraft)) return;
    saveDraft(key, current);
  }, [key, locked, relevance, scores, closureReason, closureInfo, moreInfo, initialDraft]);

  const isRequestor = Boolean(ticket.originalRequestor) && ticket.originalRequestor.toLowerCase() === memberEmail.toLowerCase();
  const total = useMemo(
    () => categories.reduce((sum, category) => sum + (Number(scores[category.id]) || 0), 0),
    [categories, scores],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setStatus({ tone: '', message: '' });
    try {
      await onSave({
        relevance,
        scores: relevance === 'YES' ? scores : undefined,
        closureReason: closureReason || undefined,
        closureInfo: closureInfo || undefined,
        moreInfo: moreInfo || undefined,
      });
      clearDraft(key);
      setStatus({ tone: 'saved', message: 'Scored. That is your answer for this round.' });
    } catch (err) {
      setStatus({ tone: 'error', message: err instanceof Error ? err.message : 'Could not save' });
    } finally {
      setSaving(false);
    }
  }

  const groupName = `relevance-${ticket.id}`;

  return (
    <form onSubmit={submit} style={{ marginTop: '1rem' }}>
      {locked ? (
        <div className="notice">
          <strong>You have scored this one.</strong> Scores are given once and cannot be changed — everyone answering
          independently is what makes the spread worth reading. If yours needs correcting, ask whoever is running the
          round to exclude it and you can score it again.
        </div>
      ) : null}

      {!locked && draftAtMount ? (
        <p className="hint">Picked up where you left off on this ticket — nothing here is submitted yet.</p>
      ) : null}

      <fieldset disabled={readOnly}>
        <legend>Is this relevant?</legend>
        {relevanceOptions.map((option) => {
          const requestorOnly = option.value === 'NO_NOT_RELEVANT_TODAY';
          const blocked = requestorOnly && !isRequestor;
          return (
            <label className="relevance-option" key={option.value} htmlFor={`${groupName}-${option.value}`}>
              <input
                type="radio"
                id={`${groupName}-${option.value}`}
                name={groupName}
                value={option.value}
                checked={relevance === option.value}
                disabled={blocked}
                onChange={() => setRelevance(option.value)}
              />
              <span>
                {option.label}
                {blocked ? <span className="hint">Only the original requestor can choose this.</span> : null}
              </span>
            </label>
          );
        })}
      </fieldset>

      {relevance === 'YES' && categories.length === 0 ? (
        <div className="notice warn">
          <strong>There are no scoring categories set up.</strong> Nothing can be scored until a coordinator restores
          them (Settings → Categories → &ldquo;Restore the seven default categories&rdquo;).
        </div>
      ) : null}

      {relevance === 'YES' && categories.length > 0 ? (
        <fieldset disabled={readOnly}>
          <legend>
            Impact scores ({categories[0]?.scaleMin ?? 0}–{categories[0]?.scaleMax ?? 10})
          </legend>
          <div className="score-grid">
            {categories.map((category) => {
              const inputId = `score-${ticket.id}-${category.id}`;
              const current = scores[category.id] ?? 0;
              return (
                <div className="score-row" key={category.id}>
                  <span id={`${inputId}-label`} className="cat-name">
                    {category.name}
                    <span className="cat-desc">{category.description}</span>
                  </span>
                  {/* One click, not a drag-to-land-on-a-number - the slider
                      this replaced was real friction across seven categories
                      a ticket, and worse on a phone. */}
                  <div className="score-picker">
                    <div className="score-buttons" role="group" aria-labelledby={`${inputId}-label`}>
                      {scoreOptions(category).map((n) => (
                        <button
                          key={n}
                          type="button"
                          id={n === category.scaleMin ? inputId : undefined}
                          className={`score-btn${current === n ? ' selected' : ''}`}
                          aria-pressed={current === n}
                          disabled={readOnly}
                          onClick={() => setScores({ ...scores, [category.id]: n })}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                    <div className="scale-ends" aria-hidden="true">
                      <span>{category.zeroLabel}</span>
                      <span>{category.maxLabel}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="total-line">
            Your total for this ticket: {total} / {categories.reduce((sum, c) => sum + c.scaleMax, 0)}
          </p>
        </fieldset>
      ) : null}

      {relevance === 'NO_CLOSE' || relevance === 'NO_NOT_RELEVANT_TODAY' ? (
        <fieldset disabled={readOnly}>
          <legend>{relevance === 'NO_CLOSE' ? 'Reason for closure' : 'Why is it not relevant today?'}</legend>
          <div className="field">
            <label htmlFor={`reason-${ticket.id}`}>Reason</label>
            {relevance === 'NO_CLOSE' ? (
              <select id={`reason-${ticket.id}`} value={closureReason} onChange={(e) => setClosureReason(e.target.value)} required>
                <option value="">Choose a reason…</option>
                {closureReasons.map((reason) => (
                  <option key={reason} value={reason}>
                    {reason}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                id={`reason-${ticket.id}`}
                value={closureReason}
                onChange={(e) => setClosureReason(e.target.value)}
                required
              />
            )}
          </div>
          <div className="field">
            <label htmlFor={`info-${ticket.id}`}>Anything else? (optional)</label>
            <textarea id={`info-${ticket.id}`} value={closureInfo} onChange={(e) => setClosureInfo(e.target.value)} />
          </div>
        </fieldset>
      ) : null}

      <div className="field">
        <label htmlFor={`notes-${ticket.id}`}>Notes or questions (optional)</label>
        <textarea
          id={`notes-${ticket.id}`}
          value={moreInfo}
          disabled={readOnly}
          onChange={(e) => setMoreInfo(e.target.value)}
          placeholder="Anything the coordinator should know, or a query for the requestor"
        />
      </div>

      {locked ? (
        <p className="hint">Scored {new Date(submission!.submittedAt).toLocaleString('en-GB')}.</p>
      ) : (
        <div className="row">
          <button type="submit" disabled={readOnly || saving || (relevance === 'YES' && categories.length === 0)}>
            {saving ? 'Saving…' : 'Submit my score'}
          </button>
          <span className="hint">This cannot be changed once submitted.</span>
        </div>
      )}

      <p className={`status ${status.tone}`} role="status" aria-live="polite">
        {disabled ? disabledReason ?? 'Scoring is closed for this round.' : status.message}
      </p>
    </form>
  );
}
