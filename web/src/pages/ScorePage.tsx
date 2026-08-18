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
  /** The round to look back at, whether or not one is currently open. */
  const [lastFinalised, setLastFinalised] = useState<Round | null>(null);
  const [lastFinalisedIncludesYou, setLastFinalisedIncludesYou] = useState(false);
  /** How many of the committee have finished so far - a count, never who. */
  const [participation, setParticipation] = useState<{ completed: number; total: number } | null>(null);
  /** Your own completion rate over recent rounds. */
  const [myParticipation, setMyParticipation] = useState<{ roundsCompleted: number; roundsConsidered: number } | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

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
        const finalised = ('lastFinalised' in data ? data.lastFinalised : null) ?? null;
        setLastFinalised(finalised);
        setLastFinalisedIncludesYou(('lastFinalisedIncludesYou' in data && data.lastFinalisedIncludesYou) ?? false);
        setBannerDismissed(finalised ? localStorage.getItem(`bis-feedback-seen-${finalised.id}`) === '1' : false);
        setMayScore(data.canScore !== false);
        setScoringOpen(Boolean(data.scoringOpen));
        setTickets(data.tickets);
        setCategories(data.categories);
        setSubmissions(data.submissions);
        setParticipation(('participation' in data && data.participation) || null);
        setMyParticipation(('myParticipation' in data && data.myParticipation) || null);
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

  function dismissBanner() {
    if (lastFinalised) localStorage.setItem(`bis-feedback-seen-${lastFinalised.id}`, '1');
    setBannerDismissed(true);
  }

  /*
    A member who scored a round only finds out what happened to it if they
    remember to go back and check - which mostly does not happen. This puts
    the invitation in front of them instead, the next time they are in the
    app, rather than leaving it to an email they may never open. It is not
    shown at all once dismissed or once a newer round has finalised, so it
    never nags about the same result twice.
  */
  const feedbackBanner =
    lastFinalised && lastFinalisedIncludesYou && !bannerDismissed ? (
      <div className="notice" role="status" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
        <span>
          <strong>The round you scored has finished.</strong> <Link to={`/feedback/${lastFinalised.id}`}>See how your scores compared to the committee’s</Link>.
        </span>
        <button type="button" className="secondary" onClick={dismissBanner} aria-label="Dismiss">
          Dismiss
        </button>
      </div>
    ) : null;

  if (!round) {
    return (
      <>
        <h1>Scoring</h1>
        {feedbackBanner}
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
        {lastFinalised && !lastFinalisedIncludesYou ? (
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
        {feedbackBanner}
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
        {feedbackBanner}
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
      {feedbackBanner}
      <p className="lede">
        Score each ticket 0–10 across the seven categories. Cut-off <strong>{formatDateTime(round.cutOffAt)}</strong>{' '}
        <Countdown target={round.cutOffAt} /> — take your time before submitting each one, since a score is given
        once and cannot be changed. Nobody else sees your individual scores while the round is open.
      </p>

      <div className="notice" role="status">
        You have scored <strong>{done}</strong> of <strong>{tickets.length}</strong>{' '}
        {tickets.length === 1 ? 'ticket' : 'tickets'}
        {outstanding > 0 ? ` — ${outstanding} to go.` : '.'}
        {participation && participation.total > 0 ? (
          <>
            {' '}
            <span className="hint">
              {participation.completed} of {participation.total} committee members have completed this round so far.
            </span>
          </>
        ) : null}
      </div>

      {/*
        The one piece of feedback that started this: people did not know what
        happened after they submitted. Shown the instant the last ticket is
        in, on the page they are already looking at - not an email they may
        never open.
      */}
      {outstanding === 0 ? (
        <div className="notice" role="status">
          <strong>That's everything — thank you.</strong> Scoring closes {formatDateTime(round.cutOffAt)}. Once
          everyone's answers are in, they're combined into a business score for each ticket — if the committee was
          too split on one, it goes to a discussion instead of straight to JIRA. You'll be able to see how your own
          scores compared to the committee's once the round is finalised.
          {myParticipation && myParticipation.roundsConsidered > 0 ? (
            <>
              {' '}
              <span className="hint">
                You've completed {myParticipation.roundsCompleted} of the last {myParticipation.roundsConsidered} rounds.
              </span>
            </>
          ) : null}
        </div>
      ) : null}

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
