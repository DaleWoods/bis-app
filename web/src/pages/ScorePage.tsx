import { useEffect, useState } from 'react';
import { api, formatDateTime, isCoordinator, type Category, type Member, type Relevance, type Round, type Submission, type Ticket } from '../api';
import { Link } from '../router';
import { TicketCard } from '../components/TicketCard';
import { ScoreForm } from '../components/ScoreForm';
import { Countdown } from '../components/Countdown';

interface Props {
  member: Member;
  roundId?: string;
}

/** The committee member's view: score the open round, see only your own answers (§9). */
export function ScorePage({ member, roundId }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [round, setRound] = useState<Round | null>(null);
  const [scoringOpen, setScoringOpen] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [relevanceOptions, setRelevanceOptions] = useState<Array<{ value: Relevance; label: string }>>([]);
  const [closureReasons, setClosureReasons] = useState<string[]>([]);
  const [mayScore, setMayScore] = useState(true);
  /** The round to look back at when there is nothing to score right now. */
  const [lastFinalised, setLastFinalised] = useState<Round | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [model, data] = await Promise.all([
          api.scoringModel(),
          roundId ? api.myRoundSubmissions(roundId) : api.myRound(),
        ]);
        if (cancelled) return;
        setRelevanceOptions(model.relevanceOptions);
        setClosureReasons(model.closureReasons);
        setRound(data.round);
        setLastFinalised(('lastFinalised' in data ? data.lastFinalised : null) ?? null);
        setMayScore(data.canScore !== false);
        setScoringOpen(Boolean(data.scoringOpen));
        setTickets(data.tickets);
        setCategories(data.categories);
        setSubmissions(data.submissions);
        setError('');
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the round');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roundId]);

  if (loading) return <p>Loading…</p>;
  if (error) return <p className="status error">{error}</p>;

  if (!round) {
    return (
      <>
        <h1>Scoring</h1>
        <div className="notice">
          {mayScore
            ? 'There is no open scoring round at the moment. You will get an email when the next round opens.'
            : 'There is no open scoring round at the moment.'}
        </div>
        {/*
          Without this, a member who signed in the day after a round was
          finalised was told there was nothing open and left with nowhere to
          go - not even to the results of the round they had just scored.
        */}
        {lastFinalised ? (
          <p>
            The last round, <strong>{lastFinalised.weekLabel}</strong>, finished
            {lastFinalised.finalisedAt ? ` on ${formatDateTime(lastFinalised.finalisedAt)}` : ''}.{' '}
            <Link to={`/feedback/${lastFinalised.id}`}>See how the committee scored it</Link>.
          </p>
        ) : null}
        <p>
          <Link to="/rounds">Go to the rounds dashboard</Link>
        </p>
      </>
    );
  }

  // Coordinators run the round; the committee scores it. Showing them a form
  // they cannot submit was the confusing part.
  if (!mayScore) {
    return (
      <>
        <h1>{round.weekLabel}</h1>
        <p className="lede">
          You are signed in as a {isCoordinator(member.role) ? 'coordinator' : 'viewer'}, so you do not score tickets —
          the committee does. This is the round they are working on.
        </p>
        <div className="notice">
          <Link to={isCoordinator(member.role) ? `/rounds/${round.id}` : '/rounds'}>
            {isCoordinator(member.role) ? 'Open the round dashboard' : 'See the rounds'}
          </Link>{' '}
          for submission progress and results.
        </div>
        {tickets.map((ticket) => (
          <TicketCard ticket={ticket} key={ticket.id} />
        ))}
      </>
    );
  }

  const done = submissions.length;
  const outstanding = Math.max(tickets.length - done, 0);

  // An empty round is not a finished one. "0 of 0 — all done, thank you" read
  // as "you have nothing left to do" when it actually meant the coordinator had
  // not put the tickets in yet.
  if (!tickets.length) {
    return (
      <>
        <h1>{round.weekLabel}</h1>
        <p className="lede">
          Cut-off <strong>{formatDateTime(round.cutOffAt)}</strong> <Countdown target={round.cutOffAt} />
        </p>
        <div className="notice" role="status">
          <strong>Nothing to score yet.</strong> This round has no tickets in it — the coordinator is still putting it
          together. You will get an email when it is ready, and nothing is outstanding from you in the meantime.
        </div>
      </>
    );
  }

  return (
    <>
      <h1>{round.weekLabel}</h1>
      <p className="lede">
        Score each ticket 0–10 across the seven categories. Cut-off <strong>{formatDateTime(round.cutOffAt)}</strong>{' '}
        <Countdown target={round.cutOffAt} /> — take your time before submitting each one, since a score is given
        once and cannot be changed. Nobody else sees your individual scores while the round is open.
      </p>

      <div className="notice" role="status">
        You have scored <strong>{done}</strong> of <strong>{tickets.length}</strong>{' '}
        {tickets.length === 1 ? 'ticket' : 'tickets'}
        {outstanding > 0 ? ` — ${outstanding} to go.` : ' — all done, thank you.'}
      </div>

      {!scoringOpen ? (
        <div className="notice warn">
          Scoring is closed for this round ({round.status === 'OPEN' ? 'the cut-off has passed' : round.status.toLowerCase()}).
        </div>
      ) : null}

      {tickets.map((ticket) => {
        const submission = submissions.find((s) => s.ticketId === ticket.id);
        return (
          <TicketCard ticket={ticket} key={ticket.id}>
            <ScoreForm
              ticket={ticket}
              categories={categories}
              relevanceOptions={relevanceOptions}
              closureReasons={closureReasons}
              submission={submission}
              memberEmail={member.email}
              disabled={!scoringOpen}
              disabledReason="Scoring is closed for this round."
              onSave={async (payload) => {
                const { submission: saved } = await api.saveSubmission(round.id, ticket.id, payload);
                setSubmissions((current) => [...current.filter((s) => s.ticketId !== ticket.id), saved]);
              }}
            />
          </TicketCard>
        );
      })}
    </>
  );
}
