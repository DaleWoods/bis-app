import { useEffect, useState } from 'react';
import { api, type QueueView, type RankedTicket } from '../api';
import { Link } from '../router';

/**
 * Where the tickets this committee has scored currently sit in the dev queue.
 *
 * The scoring rounds end at a number written to JIRA, and until now that was
 * where the committee's sight of it stopped - the thing they actually want to
 * know, "so what happened to it", lived in a separate tool. This is that tool,
 * reading the same JIRA fields.
 *
 * Nothing here is stored. Every position is recomputed on load, because a
 * queue position stops being true the moment anything is built, scored or
 * estimated - a remembered one would just be a confident lie.
 */

function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  if (n % 10 === 1) return `${n}st`;
  if (n % 10 === 2) return `${n}nd`;
  if (n % 10 === 3) return `${n}rd`;
  return `${n}th`;
}

function QueueTable({ title, tickets }: { title: string; tickets: RankedTicket[] }) {
  return (
    <section className="card" aria-labelledby={`queue-${title}`}>
      <div className="row between">
        <h2 id={`queue-${title}`} style={{ margin: 0 }}>
          {title} queue
        </h2>
        <span className="badge">
          {tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'}
        </span>
      </div>
      {tickets.length ? (
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">
              The {title} queue, highest business score first
            </caption>
            <thead>
              <tr>
                <th scope="col" className="num">
                  #
                </th>
                <th scope="col">Ticket</th>
                <th scope="col" className="num">
                  Score
                </th>
                <th scope="col" className="num">
                  Effort
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr key={ticket.key}>
                  <td className="num">{ticket.rank}</td>
                  <th
                    scope="row"
                    style={{
                      background: 'transparent',
                      textTransform: 'none',
                      letterSpacing: 0,
                      fontSize: '0.95rem',
                      color: 'inherit',
                    }}
                  >
                    <span className="jira-id">{ticket.key}</span> {ticket.summary}
                  </th>
                  <td className="num">{ticket.businessScore}</td>
                  <td className="num">{title === 'Frontend' ? ticket.frontendEffort : ticket.backendEffort}</td>
                  <td>{ticket.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="hint">Nothing is waiting in this queue.</p>
      )}
    </section>
  );
}

export function QueuePage() {
  const [view, setView] = useState<QueueView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setView(await api.queue());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the queue');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading && !view) return <p>Loading…</p>;
  if (error) return <p className="status error">{error}</p>;
  if (!view) return null;

  if (!view.available) {
    return (
      <>
        <h1>The queue</h1>
        <div className="notice warn">
          {view.reason === 'DISABLED' ? (
            <>
              <strong>The queue is switched off.</strong> It needs a JQL that describes which scored tickets are
              waiting to be built — the statuses differ per workflow, and a queue built on the wrong ones would give
              confident positions that mean nothing. A coordinator can set it in Settings.
            </>
          ) : view.reason === 'JIRA_NOT_CONFIGURED' ? (
            <>
              <strong>JIRA is not connected.</strong> Queue positions are read live from JIRA, so there is nothing to
              show until the connection is set up.
            </>
          ) : (
            <>
              <strong>The JIRA fields are not set.</strong> The queue needs the business score field and at least one
              effort field before it can rank anything. A coordinator can set them in Settings.
            </>
          )}
        </div>
      </>
    );
  }

  const { frontend, backend, notQueued } = view.split;
  const total = new Set([...frontend, ...backend, ...notQueued].map((t) => t.key)).size;

  return (
    <>
      <h1>The queue</h1>
      <p className="lede">
        Every ticket the committee has scored that is still waiting to be built, and where it currently sits. Tickets
        with effort on both sides are in both queues and ranked separately in each, because they are waiting on two
        different people. Tickets on the same score share a place.
      </p>

      <div className="notice" role="status">
        <strong>{total}</strong> scored {total === 1 ? 'ticket' : 'tickets'} waiting — {frontend.length} in the
        frontend queue, {backend.length} in the backend queue.
        {notQueued.length ? ` ${notQueued.length} not in either yet.` : ''}
        <span className="hint" style={{ display: 'block', marginTop: '0.35rem' }}>
          Read from JIRA just now. Nothing here is stored — the order changes as things are built and estimated.{' '}
          <button type="button" className="linkish" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </span>
      </div>

      <QueueTable title="Frontend" tickets={frontend} />
      <QueueTable title="Backend" tickets={backend} />

      {/*
        A scored ticket with no effort on either side is in no queue at all -
        it is waiting on an estimate nobody has given. Left out of the tables
        it would simply vanish, which is the opposite of what somebody looking
        for their ticket needs.
      */}
      {notQueued.length ? (
        <section className="card" aria-labelledby="queue-not-queued">
          <h2 id="queue-not-queued" style={{ marginTop: 0 }}>
            Scored, but not in a queue yet
          </h2>
          <p className="hint">
            These have a business score but no effort estimate on either side, so there is nothing to rank them
            against yet.
          </p>
          <ul>
            {notQueued.map((ticket) => (
              <li key={ticket.key}>
                <span className="jira-id">{ticket.key}</span> {ticket.summary}{' '}
                <span className="hint">— scored {ticket.businessScore}, {ticket.status}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.unscored ? (
        <p className="hint">
          {view.unscored} {view.unscored === 1 ? 'ticket' : 'tickets'} matched the queue's JQL but had no business
          score, so {view.unscored === 1 ? 'it is' : 'they are'} left out. If that number is large the JQL is
          probably selecting more than it should.
        </p>
      ) : null}

      <p className="hint">
        Positions come from the business score written back to JIRA by these rounds.{' '}
        <Link to="/rounds">See the rounds</Link> for how each one was scored.
      </p>
    </>
  );
}

export { ordinal };
