import { useEffect, useState } from 'react';
import { api, type AnalyticsSummary } from '../api';

/**
 * A minimal inline line chart - no charting library, consistent with the
 * rest of the app. `aria-hidden`, because the numbers it draws are also in
 * the table underneath it, which is what a screen reader actually reads.
 */
function LineChart({
  points,
  color = 'var(--brand)',
}: {
  points: Array<{ label: string; value: number | null }>;
  color?: string;
}) {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (!values.length) return null;

  const width = 640;
  const height = 140;
  const pad = 24;
  const min = Math.min(0, ...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;

  const coords = points.map((p, i) => ({
    x: pad + i * stepX,
    y: p.value === null ? null : height - pad - ((p.value - min) / range) * (height - pad * 2),
    value: p.value,
  }));
  const plotted = coords.filter((c): c is { x: number; y: number; value: number } => c.y !== null);
  const path = plotted.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-hidden="true"
      style={{ width: '100%', height: 'auto', maxWidth: width, display: 'block' }}
    >
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#e0dad2" strokeWidth={1} />
      <path d={path} fill="none" stroke={color} strokeWidth={2} />
      {plotted.map((c, i) => (
        <circle key={i} cx={c.x} cy={c.y} r={3} fill={color} />
      ))}
    </svg>
  );
}

function roundHeadCell(weekLabel: string) {
  return (
    <th
      scope="row"
      style={{ background: 'transparent', textTransform: 'none', letterSpacing: 0, fontSize: '0.95rem', color: 'inherit' }}
    >
      {weekLabel}
    </th>
  );
}

interface AskEntry {
  question: string;
  answer?: string;
  error?: string;
  pending?: boolean;
}

const EXAMPLE_QUESTIONS = [
  'Which categories have been scoring lowest lately?',
  'How many tickets were sent for estimation last round?',
  'Which team has raised the most tickets that needed a discussion?',
];

/**
 * A coordinator's own question, answered by Claude reading the same frozen
 * per-round history the charts below are drawn from — nothing it can say
 * goes beyond what is already on this page, just faster to get to. One
 * question at a time: there is no server-side memory of earlier answers, so
 * the transcript here is a convenience for scrolling back, not a
 * conversation the model itself remembers.
 */
function AskTheData() {
  const [question, setQuestion] = useState('');
  const [entries, setEntries] = useState<AskEntry[]>([]);
  const [asking, setAsking] = useState(false);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || asking) return;
    setAsking(true);
    setQuestion('');
    setEntries((prev) => [...prev, { question: q, pending: true }]);
    try {
      const { answer } = await api.askAnalytics(q);
      setEntries((prev) => prev.map((e) => (e.question === q && e.pending ? { question: q, answer } : e)));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not get an answer';
      setEntries((prev) => prev.map((e) => (e.question === q && e.pending ? { question: q, error: message } : e)));
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Ask the data</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        A question in plain English, answered from the same finalised round history as the charts below — nothing it
        says goes beyond what is already on this page.
      </p>

      {entries.length ? (
        <ul style={{ listStyle: 'none', margin: '0 0 0.75rem', padding: 0 }}>
          {entries.map((entry, i) => (
            <li key={i} style={{ marginBottom: '0.75rem' }}>
              <p style={{ margin: '0 0 0.2rem', fontWeight: 600 }}>{entry.question}</p>
              {entry.pending ? <p className="hint">Thinking…</p> : null}
              {entry.answer ? <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{entry.answer}</p> : null}
              {entry.error ? <p className="status error" style={{ margin: 0 }}>{entry.error}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="row" style={{ gap: '0.4rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          {EXAMPLE_QUESTIONS.map((q) => (
            <button key={q} type="button" className="secondary" onClick={() => ask(q)} disabled={asking}>
              {q}
            </button>
          ))}
        </div>
      )}

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question about past rounds…"
          aria-label="Ask a question about past rounds"
          className="grow"
          disabled={asking}
        />
        <button type="submit" disabled={asking || !question.trim()}>
          {asking ? 'Asking…' : 'Ask'}
        </button>
      </form>
    </div>
  );
}

/**
 * Cross-round trends, read live from what each round already froze at
 * finalisation (§14) — nothing is stored separately here, so it can never
 * disagree with the Feedback page or JIRA write-back for the same round.
 */
export function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .analytics()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load analytics'));
  }, []);

  if (error) return <p className="status error">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const { rounds, categoryDrivers } = data;

  if (rounds.length < 2) {
    return (
      <>
        <h1>Trends</h1>
        <p className="lede">How scoring moves across rounds — business score, category drivers, and participation.</p>
        <AskTheData />
        <div className="notice">
          Not enough finalised rounds yet to show a chart. This fills in on its own as rounds finalise — check back
          after a couple more. Ask the data above still works with what has finalised so far.
        </div>
      </>
    );
  }

  const scorePoints = rounds.map((r) => ({ label: r.weekLabel, value: r.avgBusinessScore }));
  const participationPoints = rounds.map((r) => ({ label: r.weekLabel, value: r.scorers }));
  const maxCategoryAvg = Math.max(1, ...categoryDrivers.map((d) => d.avgScore ?? 0));

  return (
    <>
      <h1>Trends</h1>
      <p className="lede">
        Across the last {rounds.length} finalised rounds — read live from what each round already froze when it
        finalised, so this can never disagree with what actually went to JIRA.
      </p>

      <AskTheData />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Business score over time</h2>
        <LineChart points={scorePoints} />
        <div className="table-scroll" style={{ marginTop: '0.75rem' }}>
          <table>
            <caption className="visually-hidden">Business score by round</caption>
            <thead>
              <tr>
                <th scope="col">Round</th>
                <th scope="col" className="num">
                  Tickets
                </th>
                <th scope="col" className="num">
                  Avg score
                </th>
                <th scope="col" className="num">
                  Sent for Est
                </th>
                <th scope="col" className="num">
                  To close
                </th>
                <th scope="col" className="num">
                  Discussion
                </th>
              </tr>
            </thead>
            <tbody>
              {rounds.map((r) => (
                <tr key={r.roundId}>
                  {roundHeadCell(r.weekLabel)}
                  <td className="num">{r.ticketCount}</td>
                  <td className="num">{r.avgBusinessScore === null ? '—' : r.avgBusinessScore.toFixed(1)}</td>
                  <td className="num">{r.sentForEstimation}</td>
                  <td className="num">{r.toClose}</td>
                  <td className="num">{r.discussionRequired}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Participation over time</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          How many committee members took part in each round, and how many of them answered the average ticket.
        </p>
        <LineChart points={participationPoints} color="var(--gold-text)" />
        <div className="table-scroll" style={{ marginTop: '0.75rem' }}>
          <table>
            <caption className="visually-hidden">Participation by round</caption>
            <thead>
              <tr>
                <th scope="col">Round</th>
                <th scope="col" className="num">
                  Scorers
                </th>
                <th scope="col" className="num">
                  Avg responses / ticket
                </th>
              </tr>
            </thead>
            <tbody>
              {rounds.map((r) => (
                <tr key={r.roundId}>
                  {roundHeadCell(r.weekLabel)}
                  <td className="num">{r.scorers}</td>
                  <td className="num">{r.avgResponsesPerTicket === null ? '—' : r.avgResponsesPerTicket.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Which categories drive the score</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          The average each category lands on across every ticket the committee actually scored, and how often it came
          out the highest or the lowest of that ticket's categories.
        </p>
        {categoryDrivers.length ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {categoryDrivers.map((d) => (
              <li key={d.categoryId} style={{ marginBottom: '0.7rem' }}>
                <div className="row between" style={{ marginBottom: '0.25rem' }}>
                  <strong>{d.name}</strong>
                  <span className="hint">{d.avgScore === null ? '—' : d.avgScore.toFixed(1)} avg</span>
                </div>
                <span className="bar" style={{ display: 'block', width: '100%' }}>
                  <span style={{ width: `${Math.round(((d.avgScore ?? 0) / maxCategoryAvg) * 100)}%` }} />
                </span>
                <p className="hint" style={{ margin: '0.25rem 0 0' }}>
                  Scored on {d.ticketsScored} ticket{d.ticketsScored === 1 ? '' : 's'} · highest on {d.timesHighest} ·
                  lowest on {d.timesLowest}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">No scored tickets yet to compare categories on.</p>
        )}
      </div>

      <Disagreement drivers={categoryDrivers} />
    </>
  );
}

/**
 * Which categories split the room. Each category's marks on a ticket have a
 * spread; a category whose spread is consistently wide is usually one people
 * read differently, and the fix is its wording in Settings, not anybody's
 * scoring.
 */
function Disagreement({ drivers }: { drivers: AnalyticsSummary['categoryDrivers'] }) {
  const rows = drivers
    .filter((d) => d.avgSpread !== null)
    .sort((a, b) => (b.avgSpread ?? 0) - (a.avgSpread ?? 0));
  if (!rows.length) return null;
  const max = Math.max(0.1, ...rows.map((d) => d.avgSpread ?? 0));
  const [top, second] = rows;
  const clearLead = second ? (top.avgSpread ?? 0) - (second.avgSpread ?? 0) >= 0.5 : true;

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Where the committee disagrees</h2>
      <p style={{ marginTop: 0 }}>
        {clearLead ? (
          <>
            <strong>{top.name}</strong> splits the room most — marks for it are typically{' '}
            <strong>{(top.avgSpread ?? 0).toFixed(1)}</strong> apart on the same ticket, and it was the category people
            disagreed on most for <strong>{top.timesMostSplit}</strong> ticket{top.timesMostSplit === 1 ? '' : 's'}.
            A category that keeps topping this is usually worded loosely enough to be read in different ways — its
            description in Settings is the place to tighten it.
          </>
        ) : (
          <>No single category stands out — disagreement is spread fairly evenly across them.</>
        )}
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((d) => (
          <li key={d.categoryId} style={{ marginBottom: '0.6rem' }}>
            <div className="row between" style={{ marginBottom: '0.25rem' }}>
              <strong>{d.name}</strong>
              <span className="hint">{(d.avgSpread ?? 0).toFixed(1)} typical spread</span>
            </div>
            <span className="bar" style={{ display: 'block', width: '100%' }}>
              <span style={{ width: `${Math.round(((d.avgSpread ?? 0) / max) * 100)}%`, background: 'var(--gold)' }} />
            </span>
            <p className="hint" style={{ margin: '0.25rem 0 0' }}>
              The most-split category on {d.timesMostSplit} ticket{d.timesMostSplit === 1 ? '' : 's'}
            </p>
          </li>
        ))}
      </ul>
      <p className="hint" style={{ marginBottom: 0 }}>
        Spread is the standard deviation of one category's marks across everyone who answered “Yes” on a ticket,
        averaged over the tickets. Higher means people read that category differently.
      </p>
    </div>
  );
}
