import { useEffect, useRef, useState } from 'react';
import { api, type Ticket } from '../api';
import { CARD_KINDS, CARD_LIMITS as LIMITS, KIND_HINTS, labelsFor, type CardKind } from '../card';

function Counter({ value, limit }: { value: string; limit: number }) {
  const used = value.trim().length;
  const over = used > limit;
  return (
    <p className="hint" style={{ color: over ? 'var(--danger)' : undefined, fontWeight: over ? 600 : 400 }}>
      {used} / {limit} characters{over ? ' — too long for a slide, trim it' : ''}
    </p>
  );
}

interface Props {
  ticket: Ticket | null;
  roundId?: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

/**
 * Coordinator authoring for the ticket card / slide (§7). The executive summary
 * and four panels are written here, and "Redraft from ticket" replaces them with
 * a fresh draft read out of the JIRA ticket.
 */
export function TicketEditor({ ticket, roundId, onClose, onSaved }: Props) {
  const [form, setForm] = useState({
    jiraId: ticket?.jiraId ?? '',
    title: ticket?.title ?? '',
    type: ticket?.type ?? '',
    createdDate: ticket?.createdDate ?? '',
    stakeholder: ticket?.stakeholder ?? '',
    affects: ticket?.affects ?? '',
    impacts: ticket?.impacts ?? '',
    workaround: ticket?.workaround ?? '',
    cardKind: (ticket?.cardKind || 'PROBLEM') as CardKind,
    execSummary: ticket?.execSummary ?? '',
    panelCurrent: ticket?.panelCurrent ?? '',
    panelImpacts: ticket?.panelImpacts ?? '',
    panelFuture: ticket?.panelFuture ?? '',
    panelBenefits: ticket?.panelBenefits ?? '',
    impactFacts: ticket?.impactFacts ?? '',
    screenshotCaption: ticket?.screenshotCaption ?? '',
    screenshotUrl: ticket?.screenshotUrl ?? '',
    screenshotAttachmentId: ticket?.screenshotAttachmentId ?? '',
    originalRequestor: ticket?.originalRequestor ?? '',
    backendPokerScore: ticket?.backendPokerScore ?? '',
    frontendPokerScore: ticket?.frontendPokerScore ?? '',
    manualEffort: ticket?.manualEffort ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  /** Non-failure feedback, e.g. which drafter wrote the card just loaded. */
  const [note, setNote] = useState('');
  const root = useRef<HTMLElement | null>(null);
  // Section labels follow the kind, and the kind is editable, so this is read
  // from the form rather than from the ticket as loaded.
  const labels = labelsFor(form.cardKind);

  // The editor opens beside the ticket it belongs to, which on a long round can
  // be anywhere on the page. Bring it into view on open so the first field is
  // where you are looking, however far down the list you pressed Edit.
  useEffect(() => {
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    root.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  }, []);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.saveTicket({
        ...form,
        createdDate: form.createdDate || null,
        backendPokerScore: form.backendPokerScore === '' ? null : Number(form.backendPokerScore),
        frontendPokerScore: form.frontendPokerScore === '' ? null : Number(form.frontendPokerScore),
        manualEffort: form.manualEffort === '' ? null : Number(form.manualEffort),
        roundId: ticket ? undefined : roundId,
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the ticket');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card editor" ref={root} aria-label={ticket ? `Edit ${ticket.jiraId}` : 'Add a ticket'}>
      <div className="row between">
        <h2 style={{ marginTop: 0 }}>{ticket ? `Edit ${ticket.jiraId}` : 'Add a ticket'}</h2>
        <div className="row">
          {ticket ? (
            <button
              className="secondary"
              type="button"
              disabled={saving}
              onClick={async () => {
                if (!window.confirm('Redraft this card from the JIRA ticket? Anything written here is replaced.')) return;
                setSaving(true);
                setError('');
                setNote('');
                try {
                  const { ticket: drafted, empty, drafter } = await api.redraftTicket(ticket.id);
                  setForm((current) => ({
                    ...current,
                    cardKind: (drafted.cardKind || current.cardKind) as CardKind,
                    execSummary: drafted.execSummary,
                    panelCurrent: drafted.panelCurrent,
                    panelImpacts: drafted.panelImpacts,
                    panelFuture: drafted.panelFuture,
                    panelBenefits: drafted.panelBenefits,
                    impactFacts: drafted.impactFacts,
                    screenshotCaption: drafted.screenshotCaption,
                    // The drafter may also have picked a more telling image.
                    screenshotAttachmentId: drafted.screenshotAttachmentId || current.screenshotAttachmentId,
                  }));
                  if (empty) setError('Nothing could be pulled from the JIRA ticket — write the card by hand.');
                  else if (drafter === 'ai')
                    setNote('Drafted from the whole ticket, comments included. Check it before you save.');
                  else setNote('Drafted from the headings in the description. Check it before you save.');
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Could not redraft the card');
                } finally {
                  setSaving(false);
                }
              }}
            >
              Redraft from ticket
            </button>
          ) : null}
          <button className="secondary" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>

      <form onSubmit={save}>
        <div className="row">
          <div className="grow field">
            <label htmlFor="t-jira">JIRA ID</label>
            <input id="t-jira" type="text" value={form.jiraId} required readOnly={Boolean(ticket)} onChange={(e) => set('jiraId', e.target.value)} />
          </div>
          <div className="grow field" style={{ flexGrow: 3 }}>
            <label htmlFor="t-title">Title</label>
            <input id="t-title" type="text" value={form.title} required onChange={(e) => set('title', e.target.value)} />
          </div>
          <div className="grow field">
            <label htmlFor="t-type">Type</label>
            <input id="t-type" type="text" value={form.type} onChange={(e) => set('type', e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="t-kind">What kind of ticket is this?</label>
          <select id="t-kind" value={form.cardKind || 'PROBLEM'} onChange={(e) => set('cardKind', e.target.value as CardKind)}>
            {CARD_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {labelsFor(kind).kind} — {KIND_HINTS[kind]}
              </option>
            ))}
          </select>
          <p className="hint">Sets how the slide labels its three sections. A committee scores a fault and a gap differently.</p>
        </div>

        <div className="field">
          <label htmlFor="t-summary">Headline</label>
          <textarea
            id="t-summary"
            value={form.execSummary}
            onChange={(e) => set('execSummary', e.target.value)}
            placeholder="One or two plain sentences a non-specialist would understand. What this is, and why it matters commercially."
          />
          <Counter value={form.execSummary} limit={LIMITS.execSummary} />
          <p className="hint">
            Set large at the top of the slide — the line read if nothing else is. No jargon, no ticket numbers, no
            implementation detail.
          </p>
        </div>

        <div className="row">
          {(
            [
              ['panelCurrent', labels.current],
              ['panelImpacts', labels.impacts],
              ['panelFuture', labels.future],
            ] as const
          ).map(([key, section]) => (
            <div className="grow field" key={key}>
              <label htmlFor={`t-${key}`}>
                {section.label} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>— {section.hint}</span>
              </label>
              <textarea
                id={`t-${key}`}
                value={form[key]}
                onChange={(e) => set(key, e.target.value)}
                placeholder={'One short point per line.\nUp to three lines.'}
              />
              <Counter value={form[key]} limit={LIMITS.panel} />
            </div>
          ))}
        </div>

        <div className="row">
          <div className="grow field">
            <label htmlFor="t-panelBenefits">{labels.benefits}…</label>
            <input
              id="t-panelBenefits"
              type="text"
              value={form.panelBenefits}
              onChange={(e) => set('panelBenefits', e.target.value)}
              placeholder="…every promotion we pay for actually gets seen."
            />
            <Counter value={form.panelBenefits} limit={LIMITS.benefit} />
            <p className="hint">One line along the foot of the slide. The single strongest reason to prioritise it.</p>
          </div>
          <div className="grow field">
            <label htmlFor="t-facts">The numbers</label>
            <textarea
              id="t-facts"
              value={form.impactFacts}
              onChange={(e) => set('impactFacts', e.target.value)}
              placeholder={'Affects: all mobile customers\nFrequency: every homepage visit\nOpen since: March'}
            />
            <p className="hint">
              One per line as “Label: value”, up to four. Shown as chips beside the screenshot. Leave a line out rather
              than guessing a figure.
            </p>
          </div>
        </div>

        <h3>Metadata strip</h3>
        <div className="row">
          <div className="grow field">
            <label htmlFor="t-created">Created</label>
            <input id="t-created" type="text" value={form.createdDate ?? ''} onChange={(e) => set('createdDate', e.target.value)} placeholder="ISO date" />
          </div>
          <div className="grow field">
            <label htmlFor="t-stakeholder">Stakeholder</label>
            <input id="t-stakeholder" type="text" value={form.stakeholder} onChange={(e) => set('stakeholder', e.target.value)} />
          </div>
          <div className="grow field">
            <label htmlFor="t-affects">Affects</label>
            <input id="t-affects" type="text" value={form.affects} onChange={(e) => set('affects', e.target.value)} />
          </div>
          <div className="grow field">
            <label htmlFor="t-impacts">Impacts</label>
            <input id="t-impacts" type="text" value={form.impacts} onChange={(e) => set('impacts', e.target.value)} />
          </div>
          <div className="grow field">
            <label htmlFor="t-workaround">Workaround</label>
            <input id="t-workaround" type="text" value={form.workaround} onChange={(e) => set('workaround', e.target.value)} />
          </div>
        </div>

        <div className="row">
          <div className="grow field">
            <label htmlFor="t-shot">Screenshot</label>
            {ticket?.attachments?.some((a) => a.isImage) ? (
              <>
                <select
                  id="t-shot"
                  value={form.screenshotAttachmentId}
                  onChange={(e) => set('screenshotAttachmentId', e.target.value)}
                >
                  <option value="">No screenshot</option>
                  {ticket.attachments
                    .filter((a) => a.isImage)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.filename}
                      </option>
                    ))}
                </select>
                <p className="hint">Images attached to the JIRA ticket. A picture saves a paragraph.</p>
                {form.screenshotAttachmentId ? (
                  <img
                    src={`/api/tickets/${ticket.id}/screenshot?attachmentId=${form.screenshotAttachmentId}`}
                    alt="Selected screenshot"
                    style={{ marginTop: '0.5rem', maxWidth: '100%', maxHeight: 180, border: '1px solid var(--line)', borderRadius: 'var(--radius)' }}
                  />
                ) : null}
                <label htmlFor="t-caption" style={{ marginTop: '0.6rem' }}>
                  What are we looking at?
                </label>
                <input
                  id="t-caption"
                  type="text"
                  value={form.screenshotCaption}
                  onChange={(e) => set('screenshotCaption', e.target.value)}
                  placeholder="The banner never advances past the first promotion"
                />
                <Counter value={form.screenshotCaption} limit={LIMITS.screenshotCaption} />
                <p className="hint">Printed under the image. A screenshot nobody can read is decoration.</p>
              </>
            ) : (
              <>
                <input
                  id="t-shot"
                  type="url"
                  value={form.screenshotUrl}
                  onChange={(e) => set('screenshotUrl', e.target.value)}
                  placeholder="https://…"
                />
                <p className="hint">
                  No images on the JIRA ticket. Attach one there and re-import, or paste a URL.
                </p>
              </>
            )}
          </div>
          <div className="grow field">
            <label htmlFor="t-requestor">Original requestor email</label>
            <input id="t-requestor" type="email" value={form.originalRequestor} onChange={(e) => set('originalRequestor', e.target.value)} />
            <p className="hint">Only this person may answer “This ticket isn’t relevant today”.</p>
          </div>
        </div>

        <h3>RA effort</h3>
        <div className="row">
          <div className="grow field">
            <label htmlFor="t-backend">Backend poker score</label>
            <input id="t-backend" type="number" step="0.5" value={form.backendPokerScore} onChange={(e) => set('backendPokerScore', e.target.value as never)} />
          </div>
          <div className="grow field">
            <label htmlFor="t-frontend">Frontend poker score</label>
            <input id="t-frontend" type="number" step="0.5" value={form.frontendPokerScore} onChange={(e) => set('frontendPokerScore', e.target.value as never)} />
          </div>
          <div className="grow field">
            <label htmlFor="t-manual">Manual effort override</label>
            <input id="t-manual" type="number" step="0.5" value={form.manualEffort} onChange={(e) => set('manualEffort', e.target.value as never)} />
            <p className="hint">Overrides the configured poker mapping for this ticket.</p>
          </div>
        </div>

        {error ? (
          <p className="status error" role="alert">
            {error}
          </p>
        ) : null}
        {note ? (
          <p className="status" role="status">
            {note}
          </p>
        ) : null}

        <div className="row">
          <button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save ticket'}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
