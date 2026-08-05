import type { Ticket } from '../api';
import { formatDate } from '../api';

/**
 * §7 ticket card - the in-app equivalent of one slide in the distribution deck:
 * header, executive summary (+ optional screenshot), the four labelled panels,
 * and the metadata strip. The PPTX/PDF pack is generated from the same fields.
 */
export function TicketCard({ ticket, children }: { ticket: Ticket; children?: React.ReactNode }) {
  const panels: Array<[string, string]> = [
    ['Current', ticket.panelCurrent],
    ['Impacts', ticket.panelImpacts],
    ['Future', ticket.panelFuture],
    ['Benefits', ticket.panelBenefits],
  ];

  const metadata: Array<[string, string]> = [
    ['Created', formatDate(ticket.createdDate)],
    ['Type', ticket.type],
    ['Stakeholder', ticket.stakeholder],
    ['Affects', ticket.affects],
    ['Impacts', ticket.impacts],
    ['Workaround', ticket.workaround],
  ];

  return (
    <article className="ticket-card" aria-labelledby={`ticket-${ticket.id}`}>
      <header>
        <h3 id={`ticket-${ticket.id}`}>
          {ticket.jiraId} – {ticket.title}
        </h3>
        {ticket.type ? <span className="badge">{ticket.type}</span> : null}
      </header>

      <div className="body">
        <div className="summary">
          <div className="grow">
            <h4 style={{ margin: 0, fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)' }}>
              Executive summary
            </h4>
            <p>{ticket.execSummary || 'No executive summary written yet.'}</p>
          </div>
          {ticket.screenshotUrl ? (
            <img src={ticket.screenshotUrl} alt={`Screenshot for ${ticket.jiraId}`} loading="lazy" />
          ) : null}
        </div>

        <div className="panels">
          {panels.map(([label, value]) => (
            <section className="panel" key={label}>
              <h4>{label}</h4>
              <p>{value || '—'}</p>
            </section>
          ))}
        </div>

        <div className="metadata">
          {metadata.map(([label, value]) => (
            <span key={label}>
              <strong>{label}:</strong> {value || '—'}
            </span>
          ))}
        </div>

        {children}
      </div>
    </article>
  );
}
