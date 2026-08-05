import type { Ticket } from '../api';
import { formatDate } from '../api';

/**
 * §7 ticket card - the in-app equivalent of one slide in the pack.
 *
 * Designed against the complaint that the current decks are too wordy: the
 * screenshot carries as much weight as the text, each panel is a few short
 * bullets rather than a paragraph, and the metadata is reduced to chips. A
 * scorer should be able to take it in without reading a specification.
 */

const PANEL_HINTS: Record<string, string> = {
  Current: "What's happening now",
  Impacts: 'What it causes',
  Future: 'What it should be',
  Benefits: 'What we get',
};

function Bullets({ text }: { text: string }) {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^[-*•\s]+/, '').trim())
    .filter(Boolean);

  if (!lines.length) return <p className="panel-empty">—</p>;
  if (lines.length === 1) return <p>{lines[0]}</p>;
  return (
    <ul>
      {lines.map((line, index) => (
        <li key={index}>{line}</li>
      ))}
    </ul>
  );
}

export function TicketCard({ ticket, children }: { ticket: Ticket; children?: React.ReactNode }) {
  const panels: Array<[string, string]> = [
    ['Current', ticket.panelCurrent],
    ['Impacts', ticket.panelImpacts],
    ['Future', ticket.panelFuture],
    ['Benefits', ticket.panelBenefits],
  ];

  // A JIRA attachment is served through the app; a pasted URL still works.
  const screenshot = ticket.screenshotAttachmentId
    ? `/api/tickets/${ticket.id}/screenshot`
    : ticket.screenshotUrl || '';

  const chips: Array<[string, string]> = [
    ['Affects', ticket.affects],
    ['Workaround', ticket.workaround || 'None'],
    ['Raised by', ticket.stakeholder],
    ['Since', formatDate(ticket.createdDate)],
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
            <p className="nutshell">{ticket.execSummary || 'No summary written yet.'}</p>
            <div className="chips">
              {chips
                .filter(([, value]) => value && value !== '—')
                .map(([label, value]) => (
                  <span className="chip" key={label}>
                    <span className="chip-label">{label}</span> {value}
                  </span>
                ))}
            </div>
          </div>
          {screenshot ? (
            <a className="shot" href={screenshot} target="_blank" rel="noreferrer">
              <img src={screenshot} alt={`Screenshot for ${ticket.jiraId}`} loading="lazy" />
              <span className="shot-hint">Tap to enlarge</span>
            </a>
          ) : null}
        </div>

        <div className="panels">
          {panels.map(([label, value]) => (
            <section className="panel" key={label}>
              <h4>
                {label}
                <span className="panel-hint">{PANEL_HINTS[label]}</span>
              </h4>
              <Bullets text={value} />
            </section>
          ))}
        </div>

        {children}
      </div>
    </article>
  );
}
