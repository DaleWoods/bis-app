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
 *
 * The scoring rounds are deliberately calm - a score is serious, one-shot,
 * anonymous. This page is the payoff for that seriousness, so it is allowed
 * to be the fun one: watching your ticket move up a pack is a small, genuine
 * pleasure, and there is no reason this screen should read like the rest of
 * the paperwork.
 */

function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  if (n % 10 === 1) return `${n}st`;
  if (n % 10 === 2) return `${n}nd`;
  if (n % 10 === 3) return `${n}rd`;
  return `${n}th`;
}

/** A friendly read on a position, not just the number - "3rd" alone says nothing about whether that is good. */
function proximityLabel(rank: number, outOf: number): string {
  if (outOf <= 1) return 'Only one in the queue';
  if (rank === 1) return 'Leading the queue';
  const fraction = (rank - 1) / (outOf - 1);
  if (fraction <= 0.15) return 'Near the front';
  if (fraction <= 0.5) return 'Solidly placed';
  if (fraction <= 0.85) return 'Mid-pack';
  return 'Near the back';
}

/** How far through the queue a ticket has already got, as a fill from the front. */
function proximityPercent(rank: number, outOf: number): number {
  if (outOf <= 0) return 0;
  return Math.round(((outOf - rank + 1) / outOf) * 100);
}

/**
 * 1st/2nd/3rd get a medal - still just a coloured ring around the same
 * number, so nothing here relies on colour alone to be understood.
 */
function RankBadge({ rank }: { rank: number }) {
  const medal = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : null;
  return <span className={`rank-badge${medal ? ` medal-${medal}` : ''}`}>{rank}</span>;
}

function ProximityBar({ rank, outOf }: { rank: number; outOf: number }) {
  const percent = proximityPercent(rank, outOf);
  return (
    <div className="proximity">
      <div className="proximity-bar" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="hint">{proximityLabel(rank, outOf)}</span>
    </div>
  );
}

/**
 * A leader board is more fun to skim than a table nobody reads past row two.
 * The tie case gets its own line because "1st" for two different tickets at
 * once is the single most confusing thing this page could say without one.
 */
function queueHeadline(title: string, tickets: RankedTicket[]): string {
  if (!tickets.length) return `Nothing waiting in the ${title.toLowerCase()} queue right now.`;
  const leaders = tickets.filter((t) => t.rank === 1);
  if (leaders.length > 1) {
    return `Photo finish: ${leaders.length} tickets are tied for the lead.`;
  }
  return `${leaders[0].key} is out in front.`;
}

function QueueTable({
  title,
  tickets,
  highlightKey,
}: {
  title: string;
  tickets: RankedTicket[];
  highlightKey: string | null;
}) {
  return (
    <section className="card" aria-labelledby={`queue-${title}`}>
      <div className="row between">
        <div>
          <h2 id={`queue-${title}`} style={{ margin: 0 }}>
            {title} queue
          </h2>
          <p className="hint" style={{ margin: '0.15rem 0 0' }}>
            {queueHeadline(title, tickets)}
          </p>
        </div>
        <span className="badge">
          {tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'}
        </span>
      </div>
      {tickets.length ? (
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">The {title} queue, highest business score first</caption>
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
                <th scope="col">How close</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr
                  id={`queue-row-${title}-${ticket.key}`}
                  key={ticket.key}
                  className={ticket.key === highlightKey ? 'row-highlight' : undefined}
                >
                  <td className="num">
                    <RankBadge rank={ticket.rank} />
                  </td>
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
                  <td>
                    <ProximityBar rank={ticket.rank} outOf={tickets.length} />
                  </td>
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

interface LookupResult {
  key: string;
  found: boolean;
  summary?: string;
  status?: string;
  businessScore?: number;
  /** Genuinely scored and waiting, but on neither side yet - not a "not found". */
  awaitingEffort?: boolean;
  placements: Array<{ queue: 'Frontend' | 'Backend'; rank: number; outOf: number }>;
}

function lookupTicket(view: QueueView, rawKey: string): LookupResult | null {
  const key = rawKey.trim().toUpperCase();
  if (!key) return null;
  const fe = view.split.frontend.find((t) => t.key.toUpperCase() === key);
  const be = view.split.backend.find((t) => t.key.toUpperCase() === key);
  const nq = view.split.notQueued.find((t) => t.key.toUpperCase() === key);
  const base = fe ?? be ?? nq;
  if (!base) return { key, found: false, placements: [] };
  return {
    key: base.key,
    found: true,
    summary: base.summary,
    status: base.status,
    businessScore: base.businessScore,
    awaitingEffort: Boolean(nq) && !fe && !be,
    placements: [
      ...(fe ? [{ queue: 'Frontend' as const, rank: fe.rank, outOf: view.split.frontend.length }] : []),
      ...(be ? [{ queue: 'Backend' as const, rank: be.rank, outOf: view.split.backend.length }] : []),
    ],
  };
}

export function QueuePage() {
  const [view, setView] = useState<QueueView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<LookupResult | null>(null);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);

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

  // The flash fades on its own, rather than needing to be dismissed.
  useEffect(() => {
    if (!highlightKey) return;
    const timer = window.setTimeout(() => setHighlightKey(null), 2500);
    return () => window.clearTimeout(timer);
  }, [highlightKey]);

  function findMyTicket(event: React.FormEvent) {
    event.preventDefault();
    if (!view?.available) return;
    setResult(lookupTicket(view, query));
  }

  function jumpTo(queue: 'Frontend' | 'Backend', key: string) {
    setHighlightKey(key);
    document
      .getElementById(`queue-row-${queue}-${key}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

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
  const allKeys = [...frontend, ...backend, ...notQueued];
  const total = new Set(allKeys.map((t) => t.key)).size;

  return (
    <>
      <h1>The queue</h1>
      <p className="lede">
        Every ticket the committee has scored that is still waiting to be built, and how close each one is to the
        front. Tickets with effort on both sides race in both queues at once. Tickets on the same score are tied, fair
        and square, and share a place.
      </p>

      <form className="lookup card" onSubmit={findMyTicket}>
        <label htmlFor="ticket-lookup">Where's my ticket?</label>
        <div className="row" style={{ gap: '0.5rem' }}>
          <input
            id="ticket-lookup"
            className="grow"
            list="queue-tickets"
            type="text"
            placeholder="e.g. ECOM-1466"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <datalist id="queue-tickets">
            {allKeys.map((t) => (
              <option key={t.key} value={t.key}>
                {t.summary}
              </option>
            ))}
          </datalist>
          <button type="submit">Look up</button>
        </div>

        {result ? (
          result.found ? (
            <div className="lookup-result">
              <p style={{ margin: '0 0 0.4rem' }}>
                <span className="jira-id">{result.key}</span> {result.summary}
              </p>
              {result.awaitingEffort ? (
                <p className="hint" style={{ margin: 0 }}>
                  Scored {result.businessScore} and waiting in {result.status}, but nobody has put an effort estimate
                  on it yet — there is nothing to race it against until then.
                </p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                  {result.placements.map((placement) => (
                    <li key={placement.queue}>
                      <strong>
                        Currently {ordinal(placement.rank)} in the {placement.queue} queue
                      </strong>{' '}
                      of {placement.outOf} —{' '}
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => jumpTo(placement.queue, result.key)}
                      >
                        show me
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="hint" style={{ margin: '0.5rem 0 0' }}>
              {result.key} isn't in the queue right now — either it hasn't been scored, it's already built, or the
              key doesn't match anything waiting.
            </p>
          )
        ) : null}
      </form>

      <div className="notice" role="status">
        <strong>{total}</strong> scored {total === 1 ? 'ticket' : 'tickets'} in the running — {frontend.length} on the
        frontend, {backend.length} on the backend.
        {notQueued.length ? ` ${notQueued.length} scored but not yet off the starting line.` : ''}
        <span className="hint" style={{ display: 'block', marginTop: '0.35rem' }}>
          Read from JIRA just now. Nothing here is stored — the order changes as things are built and estimated.{' '}
          <button type="button" className="linkish" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </span>
      </div>

      <QueueTable title="Frontend" tickets={frontend} highlightKey={highlightKey} />
      <QueueTable title="Backend" tickets={backend} highlightKey={highlightKey} />

      {/*
        A scored ticket with no effort on either side is in no queue at all -
        it is waiting on an estimate nobody has given. Left out of the tables
        it would simply vanish, which is the opposite of what somebody looking
        for their ticket needs.
      */}
      {notQueued.length ? (
        <section className="card" aria-labelledby="queue-not-queued">
          <h2 id="queue-not-queued" style={{ marginTop: 0 }}>
            Scored, but not off the starting line
          </h2>
          <p className="hint">
            These have a business score but no effort estimate on either side, so there is nothing to race them
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
