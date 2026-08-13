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
 *
 * On colour: one accent per card, taken from the kind of ticket. The three
 * sections used to be red, amber and green in fixed order, which read as
 * severity to everyone who saw it and encoded nothing - every card carried the
 * same traffic light. The thing that actually varies between cards is whether
 * this is a fault, a clumsy journey or a gap, so that is what is coloured.
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

  // The drafter puts what it could quantify into the impact chips, and those
  // labels overlap with the metadata strip. Showing "Affects" twice on one card
  // is the sort of thing that makes a screen look unconsidered, so the strip
  // yields to the chips rather than repeating them.
  const claimed = new Set(
    facts.map((fact) => fact.slice(0, Math.max(fact.indexOf(':'), 0)).trim().toLowerCase()).filter(Boolean),
  );
  const metadata = ([
    ['Raised by', ticket.stakeholder],
    ['Since', formatDate(ticket.createdDate)],
    ['Affects', ticket.affects || ticket.siteAffected],
    ['Workaround', ticket.workaround || 'None'],
  ] as Array<[string, string]>).filter(
    ([label, value]) => value && value !== '—' && !claimed.has(label.toLowerCase()),
  );

  return (
    <article
      className="ticket-card"
      data-kind={ticket.cardKind || 'PROBLEM'}
      aria-labelledby={`ticket-${ticket.id}`}
    >
      {/*
        The drafted headline is the heading, not the JIRA title.

        The title is developer shorthand - "Aurora banner carousel component, no
        rotation delay" - and putting it in bold at the top of the card undid
        the translation everything below it had done: the first thing a buyer
        read was the one line written for somebody else. It is still here,
        small, because a coordinator cross-referencing JIRA needs it.
      */}
      <header>
        <div className="head-line">
          <span className="jira-id">{ticket.jiraId}</span>
          <span className="badge kind">{labels.kind}</span>
        </div>
        <h3 id={`ticket-${ticket.id}`}>{ticket.execSummary || ticket.title}</h3>
        {ticket.execSummary ? <p className="raw-title">{ticket.title}</p> : null}
      </header>

      <div className="body">

        {/* Without a screenshot the aside is a column of chips beside a void,
            so the layout drops to one column and the figures run along the
            foot instead. */}
        <div className={`card-columns${screenshot ? '' : ' no-shot'}`}>
          <div className="narrative">
            {sections.map((section, index) => (
              <section className="panel" key={section.label}>
                <h4>
                  <span className="panel-step" aria-hidden="true">
                    {index + 1}
                  </span>
                  {section.label}
                  <span className="panel-hint">{section.hint}</span>
                </h4>
                <Bullets text={section.value} />
              </section>
            ))}
          </div>

          {screenshot ? (
            <aside className="card-aside">
              <figure className="shot">
                <a href={screenshot} target="_blank" rel="noreferrer">
                  <img
                    src={screenshot}
                    alt={ticket.screenshotCaption || `Screenshot for ${ticket.jiraId}`}
                    loading="lazy"
                  />
                </a>
                <figcaption>{ticket.screenshotCaption || 'Tap to enlarge'}</figcaption>
              </figure>

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

        {!screenshot && facts.length ? (
          <div className="facts facts-strip">
            <h4>The numbers</h4>
            <div className="facts-row">
              {facts.map((fact, index) => (
                <Chip fact={fact} key={index} />
              ))}
            </div>
          </div>
        ) : null}

        {ticket.panelBenefits ? (
          <p className="benefit">
            <span className="benefit-lead">{labels.benefits}</span> {ticket.panelBenefits}
          </p>
        ) : null}

        {metadata.length ? (
          <div className="chips">
            {metadata.map(([label, value]) => (
              <span className="chip" key={label}>
                <span className="chip-label">{label}</span> {value}
              </span>
            ))}
          </div>
        ) : null}

        {children}
      </div>
    </article>
  );
}
