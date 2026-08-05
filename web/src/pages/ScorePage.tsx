import { useEffect, useState } from 'react';
import { api, formatDateTime, type Category, type Member, type Relevance, type Round, type Submission, type Ticket } from '../api';
import { TicketCard } from '../components/TicketCard';
import { ScoreForm } from '../components/ScoreForm';

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
        <div className="notice">There is no open scoring round at the moment. You will get an email when the next round opens.</div>
      </>
    );
  }

  const done = submissions.length;
  const outstanding = Math.max(tickets.length - done, 0);

  return (
    <>
      <h1>{round.weekLabel}</h1>
      <p className="lede">
        Score each ticket 0–10 across the seven categories. Cut-off <strong>{formatDateTime(round.cutOffAt)}</strong>. You
        can change your answers until then. Nobody else sees your individual scores while the round is open.
      </p>

      <div className="notice" role="status">
        You have scored <strong>{done}</strong> of <strong>{tickets.length}</strong> tickets
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
