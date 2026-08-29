import { useEffect, useState } from 'react';
import { api, formatDateTime, isCoordinator, toDatetimeLocalValue, type Member, type Round } from '../api';
import { Link, useRouter } from '../router';
import { Countdown } from '../components/Countdown';

export function RoundsPage({ member }: { member: Member }) {
  const { navigate } = useRouter();
  const [rounds, setRounds] = useState<Round[]>([]);
  const [error, setError] = useState('');
  const [weekLabel, setWeekLabel] = useState(defaultWeekLabel());
  const [opensAt, setOpensAt] = useState('');
  const [cutOffAt, setCutOffAt] = useState(defaultCutOff());
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api
      .rounds()
      .then(({ rounds }) => setRounds(rounds))
      .catch((err) => setError(err.message));
  }, []);

  async function createRound(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError('');
    try {
      const { round } = await api.createRound({
        weekLabel,
        cutOffAt: new Date(cutOffAt).toISOString(),
        opensAt: opensAt ? new Date(opensAt).toISOString() : null,
      });
      navigate(`/rounds/${round.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the round');
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <h1>Scoring rounds</h1>
      <p className="lede">One round per week. Add the tickets due, write the cards, distribute, then finalise.</p>

      {isCoordinator(member.role) ? (
        <form className="card" onSubmit={createRound}>
          <h2 style={{ marginTop: 0 }}>New round</h2>
          <div className="row">
            <div className="grow">
              <label htmlFor="week-label">Round name</label>
              <input id="week-label" type="text" value={weekLabel} onChange={(e) => setWeekLabel(e.target.value)} required />
            </div>
            <div className="grow">
              <label htmlFor="opens-at">Opens (optional)</label>
              <input id="opens-at" type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
            </div>
            <div className="grow">
              <label htmlFor="cut-off">Cut-off</label>
              <input id="cut-off" type="datetime-local" value={cutOffAt} onChange={(e) => setCutOffAt(e.target.value)} required />
            </div>
            <div style={{ alignSelf: 'end' }}>
              <button type="submit" disabled={creating}>
                {creating ? 'Creating…' : 'Create round'}
              </button>
            </div>
          </div>
          <div className="row" style={{ gap: '0.35rem', marginTop: '0.4rem' }}>
            <span className="hint" style={{ alignSelf: 'center' }}>
              Quick test window, both fields at once:
            </span>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setOpensAt(toDatetimeLocalValue(new Date(Date.now() + 15 * 60_000)));
                setCutOffAt(toDatetimeLocalValue(new Date(Date.now() + 30 * 60_000)));
              }}
            >
              Opens in 15 min, closes in 30
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setOpensAt(toDatetimeLocalValue(new Date(Date.now() + 5 * 60_000)));
                setCutOffAt(toDatetimeLocalValue(new Date(Date.now() + 10 * 60_000)));
              }}
            >
              Opens in 5 min, closes in 10
            </button>
          </div>
          <p className="hint">
            Leave &ldquo;Opens&rdquo; blank if you will open and distribute this round yourself. Set it if you want
            automation to open and email the committee at that time — without it, automation leaves a round it did
            not create alone, the same as one with no opening time set at all.
          </p>
        </form>
      ) : null}

      {error ? <p className="status error">{error}</p> : null}

      <div className="card table-scroll">
        <table>
          <caption className="visually-hidden">Scoring rounds</caption>
          <thead>
            <tr>
              <th scope="col">Round</th>
              <th scope="col">Status</th>
              <th scope="col">Opens</th>
              <th scope="col">Cut-off</th>
              <th scope="col">Time left</th>
              <th scope="col" className="num">
                Tickets
              </th>
              <th scope="col">Distributed</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rounds.map((round) => (
              <tr key={round.id}>
                <th scope="row" style={{ background: 'transparent', textTransform: 'none', letterSpacing: 0, fontSize: '0.95rem', color: 'inherit' }}>
                  <Link to={`/rounds/${round.id}`}>{round.weekLabel}</Link>
                </th>
                <td>
                  <span className={`badge ${round.status === 'OPEN' ? 'open' : round.status === 'CLOSED' ? 'closed' : ''}`}>
                    {round.status}
                  </span>
                </td>
                <td>
                  {round.status === 'DRAFT'
                    ? round.opensAt
                      ? formatDateTime(round.opensAt)
                      : "Manual — won't open on its own"
                    : '—'}
                </td>
                <td>{formatDateTime(round.cutOffAt)}</td>
                <td>{round.status === 'OPEN' ? <Countdown target={round.cutOffAt} /> : '—'}</td>
                <td className="num">{round.ticketCount}</td>
                <td>{round.distributionSentAt ? formatDateTime(round.distributionSentAt) : '—'}</td>
                <td>
                  {round.status === 'FINALISED' ? <Link to={`/feedback/${round.id}`}>Feedback view</Link> : null}
                  {round.status === 'OPEN' ? <Link to={`/score/${round.id}`}>Score</Link> : null}
                </td>
              </tr>
            ))}
            {!rounds.length ? (
              <tr>
                <td colSpan={8}>No rounds yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function defaultWeekLabel(): string {
  const now = new Date();
  return `Week commencing ${now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`;
}

/** Next Tuesday 17:00 - the cadence default, overridable per round (§11). */
function defaultCutOff(): string {
  const date = new Date();
  const daysUntilTuesday = (2 - date.getDay() + 7) % 7 || 7;
  date.setDate(date.getDate() + daysUntilTuesday);
  date.setHours(17, 0, 0, 0);
  return toDatetimeLocalValue(date);
}
