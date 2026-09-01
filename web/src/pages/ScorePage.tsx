import { useEffect, useRef, useState } from 'react';
import {
  api,
  formatDateTime,
  isCoordinator,
  type Category,
  type Member,
  type MemberRecord,
  type Participation,
  type Relevance,
  type Round,
  type Submission,
  type Ticket,
} from '../api';
import { Link } from '../router';
import { TicketCard } from '../components/TicketCard';
import { ScoreForm } from '../components/ScoreForm';
import { Countdown } from '../components/Countdown';

interface Props {
  member: Member;
  roundId?: string;
}

/**
 * What the work left actually costs, in minutes, so somebody deciding whether
 * to start now has the number in front of them instead of guessing high. A
 * minute a ticket is a display estimate and decides nothing, so it stays a
 * constant here rather than becoming another setting to maintain.
 */
const SECONDS_PER_TICKET = 60;

function estimatedMinutes(ticketCount: number): string {
  const minutes = Math.max(1, Math.round((ticketCount * SECONDS_PER_TICKET) / 60));
  return minutes === 1 ? 'about a minute' : `about ${minutes} minutes`;
}

function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  if (n % 10 === 1) return `${n}st`;
  if (n % 10 === 2) return `${n}nd`;
  if (n % 10 === 3) return `${n}rd`;
  return `${n}th`;
}

/**
 * The committee's progress as a bar rather than a sentence. Still a count and
 * never who - but a round that is visibly half done is harder to leave than
 * the same fact in prose, and being last is the thing people notice.
 */
function CommitteeBar({ completed, total }: { completed: number; total: number }) {
  if (total <= 0) return null;
  const percent = Math.round((completed / total) * 100);
  return (
    <div className="committee-progress">
      <div
        className="committee-bar"
        role="img"
        aria-label={`${completed} of ${total} committee members have finished this round`}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      {/* The noun follows the group, the verb follows the count: "1 of 5
          members has finished", "3 of 5 members have". */}
      <span className="hint">
        {completed} of {total} {total === 1 ? 'member' : 'members'} {completed === 1 ? 'has' : 'have'} finished this
        round
      </span>
    </div>
  );
}

/**
 * What this member's scoring has actually moved.
 *
 * The reason given for not scoring is rarely that it is hard - it is that it
 * does not appear to lead anywhere. Answers go in, and nothing visible comes
 * back. This is the answer to that, and it is the one number here that gets
 * better the longer somebody keeps turning up.
 */
function RecordLine({ record }: { record: MemberRecord }) {
  if (record.ticketsScored === 0) return null;
  return (
    <p className="record-line">
      You have scored <strong>{record.ticketsScored}</strong>{' '}
      {record.ticketsScored === 1 ? 'ticket' : 'tickets'} across{' '}
      <strong>
        {record.roundsScored} {record.roundsScored === 1 ? 'round' : 'rounds'}
      </strong>
      {record.sentForEstimation > 0 ? (
        <>
          , and <strong>{record.sentForEstimation}</strong> of them went on to be estimated for building.
        </>
      ) : (
        '.'
      )}
    </p>
  );
}

/**
 * Purely decorative, and shown once - at the moment the last ticket goes in,
 * never again on a revisit. Finishing should feel like finishing.
 */
function Confetti() {
  return (
    <div className="confetti" aria-hidden="true">
      {Array.from({ length: 14 }, (_, i) => (
        <span key={i} style={{ left: `${i * 7 + 3}%`, animationDelay: `${(i % 5) * 0.12}s` }} />
      ))}
    </div>
  );
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
  /** This round's completion count, and the reader's own position and run. */
  const [participation, setParticipation] = useState<Participation | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  /** True only for the visit in which the last ticket was submitted. */
  const [justFinished, setJustFinished] = useState(false);
  /** What this member's scoring has moved, across every finalised round. */
  const [record, setRecord] = useState<MemberRecord | null>(null);
  const progressRailRef = useRef<HTMLElement | null>(null);

  /*
    The progress rail is `position: sticky; top: 0`, so once you have scrolled
    past it, it stays pinned over whatever `scrollIntoView` puts at the very
    top of the viewport - the ticket heading lands right underneath it,
    invisible, and what you actually see is however far down the card the
    rail's own height happens to reach. Scrolling to `top - railHeight`
    instead leaves room for it. Measured live rather than a fixed constant,
    because the rail wraps to more than one line once a round has enough
    tickets.
  */
  function scrollToTicket(ticketId: string) {
    const target = document.getElementById(`ticket-${ticketId}`);
    if (!target) return;
    const railHeight = progressRailRef.current?.getBoundingClientRect().height ?? 0;
    const gap = 16;
    const top = target.getBoundingClientRect().top + window.scrollY - railHeight - gap;
    window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
  }

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
        setRecord(('record' in data && data.record) || null);
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

  /**
   * Re-read just the counts after a submission. A failure here costs the
   * reader a stale number on a panel, which is not worth an error message
   * over the score they successfully gave.
   */
  async function refreshParticipation() {
    try {
      const data = roundId ? await api.myRoundSubmissions(roundId) : await api.myRound();
      setParticipation(('participation' in data && data.participation) || null);
    } catch {
      /* keep the number that is already on screen */
    }
  }

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
          Between rounds this page was a dead end - the one screen that told a
          member nothing at all. It is the natural place to say what their
          scoring has added up to, which is the question the ones who have
          stopped scoring are really asking.
        */}
        {record ? (
          <div className="record-card">
            <h2>Your record</h2>
            <RecordLine record={record} />
          </div>
        ) : null}
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
  // The scale is configurable, so the lede reads it rather than claiming 0-10.
  const scaleMin = categories[0]?.scaleMin ?? 0;
  const scaleMax = categories[0]?.scaleMax ?? 10;

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
        Score each ticket {scaleMin}–{scaleMax} across the {categories.length} categories. Cut-off{' '}
        <strong>{formatDateTime(round.cutOffAt)}</strong> <Countdown target={round.cutOffAt} /> — take your time before
        submitting each one, since a score is given once and cannot be changed. Nobody else sees your individual scores
        while the round is open.
      </p>

      {outstanding === 0 ? (
        /*
          Finishing is the only part of this that is anybody's own achievement,
          and it used to read the same as being half way through. The run and
          the finishing position are the reader's own record - the point is to
          give somebody who has just finished a reason to do it again, which is
          the actual problem here rather than the scoring itself.
        */
        <div className={`round-done${justFinished ? ' celebrate' : ''}`} role="status">
          {justFinished ? <Confetti /> : null}
          <h2>That is {round.weekLabel} done.</h2>
          <p>
            {tickets.length === 1 ? 'The ticket is scored' : `All ${tickets.length} tickets scored`}
            {participation?.yourPosition ? (
              <>
                {' '}
                — you were <strong>{ordinal(participation.yourPosition)}</strong> of {participation.total} to finish
              </>
            ) : null}
            .{' '}
            {participation && participation.streak > 0 ? (
              <>
                That is <strong>{participation.streak + 1} rounds in a row</strong>, counting this one.
              </>
            ) : null}
          </p>
          {participation ? <CommitteeBar completed={participation.completed} total={participation.total} /> : null}
          {record ? <RecordLine record={record} /> : null}
          <p className="hint">
            Nothing else is outstanding from you. You will get an email when the round is finalised, and the feedback
            for it shows how your scores sat against the committee's.
          </p>
        </div>
      ) : (
        <div className="notice" role="status">
          You have scored <strong>{done}</strong> of <strong>{tickets.length}</strong>{' '}
          {tickets.length === 1 ? 'ticket' : 'tickets'} — <strong>{outstanding} to go</strong>,{' '}
          {estimatedMinutes(outstanding)}.
          {participation ? <CommitteeBar completed={participation.completed} total={participation.total} /> : null}
          {participation && participation.streak >= 2 ? (
            <p className="streak">
              You have finished the last <strong>{participation.streak}</strong> rounds in a row.
            </p>
          ) : null}
        </div>
      )}

      {!scoringOpen ? (
        <div className="notice warn">
          Scoring is closed for this round ({round.status === 'OPEN' ? 'the cut-off has passed' : round.status.toLowerCase()}).
        </div>
      ) : null}

      {scoringOpen && tickets.length > 1 ? (
        <nav className="progress-rail" aria-label="Tickets in this round" ref={progressRailRef}>
          <div className="progress-rail-badges">
            {tickets.map((ticket) => {
              const isDone = submissions.some((s) => s.ticketId === ticket.id);
              return (
                <button
                  key={ticket.id}
                  type="button"
                  className={`progress-badge${isDone ? ' done' : ''}`}
                  onClick={() => scrollToTicket(ticket.id)}
                  title={`${ticket.jiraId} — ${isDone ? 'scored' : 'not yet scored'}`}
                >
                  {ticket.jiraId}
                </button>
              );
            })}
          </div>
          {outstanding > 0 ? (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                const next = tickets.find((t) => !submissions.some((s) => s.ticketId === t.id));
                if (next) scrollToTicket(next.id);
              }}
            >
              Jump to next unscored ({outstanding} left)
            </button>
          ) : null}
        </nav>
      ) : null}

      {tickets.map((ticket) => {
        const submission = submissions.find((s) => s.ticketId === ticket.id);
        return (
          <TicketCard ticket={ticket} key={ticket.id}>
            <ScoreForm
              ticket={ticket}
              roundId={round.id}
              categories={categories}
              relevanceOptions={relevanceOptions}
              closureReasons={closureReasons}
              submission={submission}
              memberEmail={member.email}
              disabled={!scoringOpen}
              disabledReason="Scoring is closed for this round."
              onSave={async (payload) => {
                const { submission: saved } = await api.saveSubmission(round.id, ticket.id, payload);
                const next = [...submissions.filter((s) => s.ticketId !== ticket.id), saved];
                // The "that's everything" panel lives at the top of the page -
                // easy to miss if the last ticket scored was the one at the
                // bottom of a long list, and it is the whole payoff.
                if (next.length === tickets.length && submissions.length < tickets.length) {
                  setJustFinished(true);
                  requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
                }
                setSubmissions(next);
                // The committee's count moves while you are on the page, and
                // your own finishing position only exists once you finish.
                refreshParticipation();
              }}
            />
          </TicketCard>
        );
      })}
    </>
  );
}
