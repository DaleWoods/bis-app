import { useState } from 'react';
import { api, type Ticket } from '../api';

interface Props {
  ticket: Ticket | null;
  roundId?: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

/**
 * Coordinator authoring for the ticket card / slide (§7). In the foundation the
 * executive summary and four panels are written here; AI-assisted drafting from
 * the raw JIRA description is Phase 2.
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
    execSummary: ticket?.execSummary ?? '',
    panelCurrent: ticket?.panelCurrent ?? '',
    panelImpacts: ticket?.panelImpacts ?? '',
    panelFuture: ticket?.panelFuture ?? '',
    panelBenefits: ticket?.panelBenefits ?? '',
    screenshotUrl: ticket?.screenshotUrl ?? '',
    originalRequestor: ticket?.originalRequestor ?? '',
    backendPokerScore: ticket?.backendPokerScore ?? '',
    frontendPokerScore: ticket?.frontendPokerScore ?? '',
    manualEffort: ticket?.manualEffort ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

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
    <section className="card" aria-label={ticket ? `Edit ${ticket.jiraId}` : 'Add a ticket'}>
      <div className="row between">
        <h2 style={{ marginTop: 0 }}>{ticket ? `Edit ${ticket.jiraId}` : 'Add a ticket'}</h2>
        <button className="secondary" onClick={onClose} type="button">
          Close
        </button>
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
          <label htmlFor="t-summary">Executive summary</label>
          <textarea
            id="t-summary"
            value={form.execSummary}
            onChange={(e) => set('execSummary', e.target.value)}
            placeholder="2–4 sentences: what the item is and the value of resolving it"
          />
          <p className="hint">Shown at the top of the ticket card and on the slide.</p>
        </div>

        <div className="row">
          {(
            [
              ['panelCurrent', 'Current', 'The present situation / problem'],
              ['panelImpacts', 'Impacts', 'What the problem causes'],
              ['panelFuture', 'Future', 'The target / desired state'],
              ['panelBenefits', 'Benefits', 'What resolving it delivers'],
            ] as const
          ).map(([key, label, hint]) => (
            <div className="grow field" key={key}>
              <label htmlFor={`t-${key}`}>{label}</label>
              <textarea id={`t-${key}`} value={form[key]} onChange={(e) => set(key, e.target.value)} placeholder={hint} />
            </div>
          ))}
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
            <label htmlFor="t-screenshot">Screenshot URL (optional)</label>
            <input id="t-screenshot" type="url" value={form.screenshotUrl} onChange={(e) => set('screenshotUrl', e.target.value)} />
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
