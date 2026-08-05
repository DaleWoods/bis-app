import type { Ticket } from '../api';
import { formatDate } from '../api';
import { cardLines, labelsFor } from '../card';

/**
 * §7 ticket card - the in-app twin of one slide in the pack.
 *
 * Same structure as the slide, so a scorer sees the same thing whether they
 * read the deck or the app: a headline, three sections labelled for the kind of
 * ticket, and the picture given real weight beside the quantified facts.
 *
 * The complaint was that the deck told nobody what a ticket actually was. The
 * answer is structure and a captioned screenshot, not more prose - every field
 * is still clipped to a length a committee member will read.
 */

function Bullets({ text }: { text: string }) {
  const lines = cardLines(text);
  if (!lines.length) return <p className="panel-empty">Not written yet</p>;
  if (lines.length === 1) return <p>{lines[0]}</p>;
  return (
    <ul>
      {lines.map((line, index) => (
        <li key={index}>{line}</li>
      ))}
    </ul>
  );
}

/** An impact chip is "Label: value"; the label is set apart so it scans. */
function Chip({ fact }: { fact: string }) {
  const index = fact.indexOf(':');
  if (index <= 0) return <span className="fact">{fact}</span>;
  return (
    <span className="fact">
      <span className="fact-label">{fact.slice(0, index)}</span> {fact.slice(index + 1).trim()}
    </span>
  );
}

export function TicketCard({ ticket, children }: { ticket: Ticket; children?: React.ReactNode }) {
  const labels = labelsFor(ticket.cardKind);
  const sections = [
    { ...labels.current, value: ticket.panelCurrent },
    { ...labels.impacts, value: ticket.panelImpacts },
    { ...labels.future, value: ticket.panelFuture },
  ];

  const facts = cardLines(ticket.impactFacts, 4);

  // A JIRA attachment is served through the app; a pasted URL still works.
  const screenshot = ticket.screenshotAttachmentId
    ? `/api/tickets/${ticket.id}/screenshot`
    : ticket.screenshotUrl || '';

  const metadata: Array<[string, string]> = [
    ['Raised by', ticket.stakeholder],
    ['Since', formatDate(ticket.createdDate)],
    ['Affects', ticket.affects || ticket.siteAffected],
    ['Workaround', ticket.workaround || 'None'],
  ];

  return (
    <article className="ticket-card" aria-labelledby={`ticket-${ticket.id}`}>
      <header>
        <h3 id={`ticket-${ticket.id}`}>
          <span className="jira-id">{ticket.jiraId}</span> {ticket.title}
        </h3>
        <span className="badge kind">{labels.kind}</span>
      </header>

      <div className="body">
        {ticket.execSummary ? <p className="nutshell">{ticket.execSummary}</p> : null}

        <div className="card-columns">
          <div className="narrative">
            {sections.map((section) => (
              <section className="panel" key={section.label}>
                <h4>
                  {section.label}
                  <span className="panel-hint">{section.hint}</span>
                </h4>
                <Bullets text={section.value} />
              </section>
            ))}
          </div>

          {screenshot || facts.length ? (
            <aside className="card-aside">
              {screenshot ? (
                <figure className="shot">
                  <a href={screenshot} target="_blank" rel="noreferrer">
                    <img src={screenshot} alt={ticket.screenshotCaption || `Screenshot for ${ticket.jiraId}`} loading="lazy" />
                  </a>
                  <figcaption>{ticket.screenshotCaption || 'Tap to enlarge'}</figcaption>
                </figure>
              ) : null}

              {facts.length ? (
                <div className="facts">
                  <h4>The numbers</h4>
                  {facts.map((fact, index) => (
                    <Chip fact={fact} key={index} />
                  ))}
                </div>
              ) : null}
            </aside>
          ) : null}
        </div>

        {ticket.panelBenefits ? (
          <p className="benefit">
            <span className="benefit-lead">{labels.benefits}</span> {ticket.panelBenefits}
          </p>
        ) : null}

        <div className="chips">
          {metadata
            .filter(([, value]) => value && value !== '—')
            .map(([label, value]) => (
              <span className="chip" key={label}>
                <span className="chip-label">{label}</span> {value}
              </span>
            ))}
        </div>

        {children}
      </div>
    </article>
  );
}
