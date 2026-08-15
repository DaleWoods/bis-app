import { useMemo, useState } from 'react';
import type { Category, Relevance, Submission, Ticket } from '../api';

interface Props {
  ticket: Ticket;
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

/** How far along its own scale a score sits, for the slider's filled track. */
function fillPercent(category: Category, value: number): number {
  const span = category.scaleMax - category.scaleMin;
  if (span <= 0) return 0;
  const clamped = Math.min(Math.max(value, category.scaleMin), category.scaleMax);
  return ((clamped - category.scaleMin) / span) * 100;
}

/**
 * The native in-app scoring form that replaces the Microsoft Form: the §8
 * relevance question first, then 0–10 for each category (§6), plus notes.
 */
export function ScoreForm({
  ticket,
  categories,
  relevanceOptions,
  closureReasons,
  submission,
  memberEmail,
  disabled,
  disabledReason,
  onSave,
}: Props) {
  const [relevance, setRelevance] = useState<Relevance>(submission?.relevance ?? 'YES');
  const [scores, setScores] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const category of categories) initial[category.id] = submission?.scores?.[category.id] ?? 0;
    return initial;
  });
  const [closureReason, setClosureReason] = useState(submission?.closureReason ?? '');
  const [closureInfo, setClosureInfo] = useState(submission?.closureInfo ?? '');
  const [moreInfo, setMoreInfo] = useState(submission?.moreInfo ?? '');
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
        <fieldset disabled={disabled}>
          <legend>Impact scores (0–10)</legend>
          <div className="score-grid">
            {categories.map((category) => {
              const inputId = `score-${ticket.id}-${category.id}`;
              return (
                <div className="score-row" key={category.id}>
                  <label htmlFor={inputId} className="cat-name">
                    {category.name}
                    <span className="cat-desc">{category.description}</span>
                  </label>
                  {/* The ends of the scale belong at the ends of the slider.
                      They used to be a third line of small print under every
                      category name, seven times per ticket. */}
                  <div className="score-slider">
                    <input
                      id={inputId}
                      type="range"
                      min={category.scaleMin}
                      max={category.scaleMax}
                      step={1}
                      value={scores[category.id] ?? 0}
                      /*
                       * The filled part of the track is how a row of sliders
                       * can be read at a glance. WebKit gives no equivalent of
                       * Firefox's ::-moz-range-progress, so the proportion is
                       * handed to CSS and painted as a gradient.
                       */
                      style={{ '--fill': `${fillPercent(category, scores[category.id] ?? 0)}%` } as React.CSSProperties}
                      onChange={(event) => setScores({ ...scores, [category.id]: Number(event.target.value) })}
                      aria-describedby={`${inputId}-out`}
                    />
                    <div className="scale-ends" aria-hidden="true">
                      <span>{category.zeroLabel}</span>
                      <span>{category.maxLabel}</span>
                    </div>
                  </div>
                  <output id={`${inputId}-out`} htmlFor={inputId}>
                    {scores[category.id] ?? 0}
                  </output>
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
        <fieldset disabled={disabled}>
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
          <button
            type="submit"
            disabled={readOnly || saving || (relevance === 'YES' && categories.length === 0)}
            onClick={(event) => {
              // Said before it is irreversible, not after. The confirm is the
              // only warning that arrives while it can still be acted on.
              if (!window.confirm('Submit this score?\n\nScores cannot be changed once given.')) {
                event.preventDefault();
              }
            }}
          >
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
