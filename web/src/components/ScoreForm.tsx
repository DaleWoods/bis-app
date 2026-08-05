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
      setStatus({ tone: 'saved', message: 'Saved. You can change your answer until the cut-off.' });
    } catch (err) {
      setStatus({ tone: 'error', message: err instanceof Error ? err.message : 'Could not save' });
    } finally {
      setSaving(false);
    }
  }

  const groupName = `relevance-${ticket.id}`;

  return (
    <form onSubmit={submit} style={{ marginTop: '1rem' }}>
      <fieldset disabled={disabled}>
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

      {relevance === 'YES' ? (
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
                    <span className="cat-desc">
                      {category.scaleMin} = {category.zeroLabel} · {category.scaleMax} = {category.maxLabel}
                    </span>
                  </label>
                  <input
                    id={inputId}
                    type="range"
                    min={category.scaleMin}
                    max={category.scaleMax}
                    step={1}
                    value={scores[category.id] ?? 0}
                    onChange={(event) => setScores({ ...scores, [category.id]: Number(event.target.value) })}
                    aria-describedby={`${inputId}-out`}
                  />
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
          disabled={disabled}
          onChange={(e) => setMoreInfo(e.target.value)}
          placeholder="Anything the coordinator should know, or a query for the requestor"
        />
      </div>

      <div className="row">
        <button type="submit" disabled={disabled || saving}>
          {saving ? 'Saving…' : submission ? 'Update my score' : 'Submit my score'}
        </button>
        {submission ? <span className="hint">Last saved {new Date(submission.updatedAt).toLocaleString('en-GB')}</span> : null}
      </div>

      <p className={`status ${status.tone}`} role="status" aria-live="polite">
        {disabled ? disabledReason ?? 'Scoring is closed for this round.' : status.message}
      </p>
    </form>
  );
}
