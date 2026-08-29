import { useEffect, useState } from 'react';
import { api, isCoordinator, type Member, type ScoringModel } from '../api';
import { Link } from '../router';
import { CARD_KINDS, KIND_HINTS, labelsFor } from '../card';

/**
 * The user guide, in the app rather than in a document nobody can find.
 *
 * Written for two readers at once. A committee member wants three paragraphs
 * and then to go and score; a coordinator needs the whole weekly cycle. So the
 * scoring half is always shown and the running-it half appears only for
 * coordinators — nobody has to read past the part that applies to them.
 *
 * KEEPING THIS HONEST: this page is part of the feature, not a description of
 * it. Any change to how the app behaves belongs here in the same commit, or the
 * guide quietly becomes a list of things that used to be true.
 *
 * Two things do that work rather than relying on anybody remembering. The
 * section labels come from CARD_KINDS and labelsFor(). The categories, the
 * marks they run to and the thresholds come from the scoring model at render
 * time - they are editable data, so a sentence saying "the seven categories"
 * or "above 16" is a sentence that goes wrong the first time somebody opens
 * Settings. Never type one in; read it from `model`.
 */

/**
 * A section you open, not a wall you scroll past. Collapsed by default (bar
 * the first) so the page's first impression is a short list of titles, not
 * eleven sections of prose stacked on top of each other - the content itself
 * is unchanged, just not all in front of you at once. A same-page link to a
 * closed section still works: browsers auto-open a <details> that contains
 * the :target.
 */
function Section({
  id,
  title,
  index,
  defaultOpen,
  children,
}: {
  id: string;
  title: string;
  index: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="card guide-section" id={id} open={defaultOpen}>
      <summary aria-labelledby={`${id}-h`}>
        <span className="guide-section-index">{index}</span>
        <h2 id={`${id}-h`}>{title}</h2>
      </summary>
      <div className="guide-section-body">{children}</div>
    </details>
  );
}

export function GuidePage({ member }: { member: Member }) {
  const coordinator = isCoordinator(member.role);
  const [model, setModel] = useState<ScoringModel | null>(null);

  // The scoring model, not the full configuration: every signed-in member can
  // read it, and the configuration endpoint is coordinator-only - reading the
  // numbers from there would have shown the committee the shipped defaults
  // rather than this instance's settings.
  useEffect(() => {
    api
      .scoringModel()
      .then(setModel)
      .catch(() => setModel(null));
  }, []);

  const categories = model?.categories.length ?? 7;
  const maxMark = model?.categories[0]?.scaleMax ?? 10;
  const maxTotal = model?.categories.reduce((sum, c) => sum + c.scaleMax, 0) ?? 70;
  const minSubmissions = model?.thresholds.minSubmissions;
  const spread = model?.thresholds.stdDevDiscussionThreshold;

  const contents: Array<[string, string]> = [
    ['scoring', 'Scoring a ticket'],
    ['answers', 'The four answers'],
    ['what-happens', 'What happens to your scores'],
    ...(coordinator
      ? ([
          ['week', 'Running the week'],
          ['cards', 'Writing a good card'],
          ['results', 'Reading the results'],
          ['discussions', 'Tickets the committee split on'],
          ['jira', 'Getting scores into JIRA'],
          ['automation', 'Letting it run itself'],
          ['settings', 'Settings worth knowing about'],
          ['problems', 'When something looks wrong'],
        ] as Array<[string, string]>)
      : []),
  ];

  return (
    <>
      <h1>User guide</h1>
      <p className="lede">
        How this works, in the order you will need it. You are signed in as <strong>{member.role}</strong>, so this is
        showing {coordinator ? 'everything, including running the round.' : 'the parts that apply to scoring.'}
      </p>

      <nav className="card guide-toc" aria-label="On this page">
        <strong>On this page</strong>
        <ul>
          {contents.map(([id, title], i) => (
            <li key={id}>
              <a
                href={`#${id}`}
                onClick={() => {
                  // The id lives on the <details> itself, not on something
                  // nested inside it - a browser only auto-opens a closed
                  // <details> for a :target buried inside, not for the
                  // <details> element being the target, so a plain anchor
                  // jump here would scroll to a section and leave it shut.
                  const el = document.getElementById(id);
                  if (el instanceof HTMLDetailsElement) el.open = true;
                }}
              >
                <span className="guide-toc-index">{i + 1}</span>
                {title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="scoring" title="Scoring a ticket" index={1} defaultOpen>
        <p>
          Open <strong>Score</strong>. You will see every ticket in the round that is open, each as a card that answers
          four questions in the same order every time: what this is, what it is costing us, what we would do about it,
          and what changes once it is live — plus, usually, a captioned screenshot and the figures behind it.
        </p>
        <p>
          The cards are written for you, not for the team that raised the ticket. If one still leaves you guessing,
          that is worth saying in the notes box rather than scoring around — the answer to a card nobody understood is
          a better card, and the notes are how that gets back to whoever is running the round.
        </p>
        <p>
          For each ticket, answer the relevance question first, then — if you answered yes — give it a mark out of{' '}
          {maxMark} in each of the {categories} categories.{' '}
          <strong>0 means not affected at all; {maxMark} means heavily affected.</strong> The {categories} marks add up
          to a total out of {maxTotal}.
        </p>
        <ul>
          <li>Score from your own team's point of view. You are not trying to guess the overall answer.</li>
          <li>
            <strong>A score is given once and cannot be changed.</strong> An answer you could revise is one you could
            revise after hearing what everyone else thought, and the spread that decides whether a ticket needs
            discussing is only worth reading if every score was formed on its own. Take the time before you submit — it
            cannot be undone. If one genuinely needs correcting, ask whoever is running the round to exclude it and you
            can score that ticket again.
          </li>
          <li>Nobody else — including whoever is running the round — sees who gave what while the round is open.</li>
          <li>There is no "save all" button. Each ticket saves on its own as you go.</li>
          <li>
            The Score page shows how many of the committee have completed the round so far — a count, never who, so
            you can see the round moving without anyone's individual answers being visible early.
          </li>
        </ul>
        <p className="hint">
          If a ticket makes no sense to you, do not guess — answer “Unsure”. A guess moves the score; an “Unsure” asks
          for a better card.
        </p>
      </Section>

      <Section id="answers" title="The four answers" index={2}>
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">What each relevance answer does</caption>
            <thead>
              <tr>
                <th scope="col">Answer</th>
                <th scope="col">Use it when</th>
                <th scope="col">What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className="plain">
                  Yes
                </th>
                <td>The ticket is relevant and you can judge it.</td>
                <td>Your {categories} scores count toward the ticket's business score.</td>
              </tr>
              <tr>
                <th scope="row" className="plain">
                  Unsure
                </th>
                <td>You do not understand the request well enough to score it.</td>
                <td>
                  Counted as a response, but no score. Flags the ticket as needing a clearer card.
                </td>
              </tr>
              <tr>
                <th scope="row" className="plain">
                  No — can be closed
                </th>
                <td>This should not be on the list at all.</td>
                <td>
                  Needs a reason. One of these flags the whole ticket as “To Close?” for the coordinator to look at.
                </td>
              </tr>
              <tr>
                <th scope="row" className="plain">
                  No — not relevant today
                </th>
                <td>You raised it, and it can wait.</td>
                <td>Only the person who raised the ticket can choose this. Needs a reason.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="what-happens" title="What happens to your scores" index={3}>
        <p>Once the round closes, each ticket's totals are combined:</p>
        <ul>
          <li>
            <strong>Business score</strong> — the average of everyone's totals who answered “Yes”, rounded to a whole
            number.
          </li>
          <li>
            <strong>Spread</strong> — how far apart the answers were. A wide spread
            {spread === undefined ? '' : ` (above ${spread}, currently)`} means the committee disagreed, and the ticket
            is flagged <strong>Discussion needed</strong>. Nothing is written to JIRA for it and it does not go for
            estimation: whoever is running the round calls a meeting, and the meeting can agree a score, send the
            ticket back to be scored again next round, or decide to close it. Whichever it is, you will see it on the
            results for that round.
          </li>
          <li>
            <strong>Priority ratio</strong> — the business score divided by the development effort. That ratio, not the
            raw score, is what sorts High, Medium and Low: a modest score for a day's work can beat a big score for
            three months.
          </li>
        </ul>
        <p>
          A ticket needs a minimum number of responses{minSubmissions === undefined ? '' : ` — ${minSubmissions} at
          the moment`}{' '}
          before it counts at all. Below that it rolls over to the next round rather than being decided by two people.
        </p>
        <p>
          After the round is finalised you can see the results. It opens with the round as a table: every ticket in
          score order, what the committee gave it, <strong>what you gave it</strong>, the difference, the spread, and
          what happened to it. Below that, each ticket in full — the averages per category, everyone's totals
          unattributed, and the notes people left.
        </p>
        <p>
          Your own scores are the only ones named, and only to you. A large difference is not a mistake: it usually
          means you were weighing something the rest of the room could not see, which is exactly what the spread exists
          to catch. Get there from the round on the <Link to="/rounds">Rounds</Link> page, or from the{' '}
          <Link to="/">Score</Link> page, which offers the last finalised round when there is nothing open to score.
        </p>
        <p className="hint">
          It is deliberately after the round rather than during it. A score given after seeing what the room already
          said is not an independent score, and the whole method rests on them being independent.
        </p>
        <p className="hint">
          You do not need to remember to check back. The next time you are in the app after a round you scored
          finishes, a banner points you straight at it — it goes away once you have seen it, or once a newer round
          finalises.
        </p>
        <p>
          Finalising <strong>freezes</strong> those numbers. They are stored as they stood at that moment, so a
          finalised round shows the same figures for good — later changes to settings or to anyone's submission do not
          rewrite history. Reopening a round for more scoring releases them again.
        </p>
      </Section>

      {coordinator ? (
        <>
          <Section id="week" title="Running the week" index={4}>
            <ol>
              <li>
                <strong>Create the round</strong> on the Rounds page, or let the app create it (see Letting it run
                itself).
              </li>
              <li>
                <strong>Put the tickets in.</strong> “Import from JIRA” pulls whatever is sitting in the configured
                queue. You can also add one by hand or paste CSV. A round only takes tickets while it is a draft or
                open — once it is closed, adding one would give the committee something nobody can score, so it is
                refused and you are pointed at the next round instead. An import also checks the incoming titles
                against everything still live in another round and says if one looks like a duplicate — worth a look
                before the same issue gets scored twice under two ticket numbers.
              </li>
              <li>
                <strong>Check the cards.</strong> This is the part that decides whether the round is any good — see
                below. A ticket with no effort figures yet is flagged “No effort set” as soon as it is in, rather than
                only once the round is nearly over, so it can be chased alongside scoring.
              </li>
              <li>
                <strong>Distribute to committee.</strong> This opens the round and emails everyone a link. Once
                something has actually been sent the button becomes “Re-send to committee” and the round is stamped
                “Distributed”. With email not yet configured the messages are composed and logged but nothing is sent,
                so the round is not stamped — share the link yourself with “Copy scoring link”.
              </li>
              <li>
                <strong>Chase non-responders</strong> as the cut-off approaches. Submission progress shows who is
                outstanding. “Send final reminder” sends a sharper-worded last chase, naming what is still outstanding.
              </li>
              <li>
                <strong>Close scoring</strong> at the cut-off — or earlier if everyone is done.
              </li>
              <li>
                <strong>Finalise.</strong> This freezes the results and opens the anonymised feedback view to the
                committee.
              </li>
              <li>
                <strong>Sort out the split tickets.</strong> Anything the committee did not agree on is held back —
                see Tickets the committee split on.
              </li>
              <li>
                <strong>Write the scores to JIRA.</strong>
              </li>
            </ol>
            <p className="hint">
              Every one of those is a button you can press yourself, whether or not automation is switched on.
            </p>
          </Section>

          <Section id="cards" title="Writing a good card" index={5}>
            <p>
              The card is all a committee member gets. A card written out of a thin JIRA title produces a guess, not a
              score. Press <strong>Edit card</strong> on any ticket — the editor opens directly underneath it.
            </p>
            <p>
              <strong>Redraft from ticket</strong> writes the whole card for you. With an Anthropic API key configured
              it reads the whole ticket — description, every comment in order, labels, priority, components, linked
              issues — works out for itself what the ticket actually is, and writes it as four answers in business
              language, picking the most explanatory screenshot and captioning it. It does not go looking for headings
              to copy; most tickets do not have them, and the real story is usually in a comment weeks after the
              description. A second pass then reads the card back the way a committee member would, cold, and fixes
              anything that only makes sense to somebody who had read the ticket. Without a key it falls back to
              matching headings, which finds much less.
            </p>
            <p>
              <strong>Every card answers the same four questions in the same order</strong>, which is what makes thirty
              of them readable in one sitting: what is this, what is it costing us, what would we do about it, and what
              changes once it is live. The wording of the first three follows the kind of ticket — a fault, a clumsy
              journey and a gap answer them differently — and the card takes its colour from the same choice, so the
              kind is readable across a room before anyone has read a word:
            </p>
            <div className="table-scroll">
              <table>
                <caption className="visually-hidden">How the card sections change by ticket kind</caption>
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col">Use it when</th>
                    <th scope="col">The first three questions become</th>
                  </tr>
                </thead>
                <tbody>
                  {CARD_KINDS.map((kind) => {
                    const labels = labelsFor(kind);
                    return (
                      <tr key={kind}>
                        <th scope="row" className="plain">
                          {labels.kind}
                        </th>
                        <td>{KIND_HINTS[kind]}</td>
                        <td>
                          {labels.current.label} · {labels.impacts.label} · {labels.future.label}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p>What makes the difference, in order:</p>
            <ul>
              <li>
                <strong>The headline.</strong> One or two plain sentences saying what this is and why a commercial
                reader should care. No jargon, no ticket numbers. This is the heading on the card and on the slide —
                the JIRA title sits underneath it in small grey text, because a title written for the team that raised
                the ticket undoes the translation the rest of the card just did.
              </li>
              <li>
                <strong>A screenshot with a caption.</strong> A picture of a broken page explains it faster than three
                bullets. Without a caption it is decoration — say what to look at.
              </li>
              <li>
                <strong>The numbers.</strong> “Manual effort: ~20 orders a morning” is weighed very differently from
                “operations are impacted”. Leave a line out rather than invent a figure.
              </li>
              <li>
                <strong>Short bullets.</strong> The standing complaint about the old decks was that they were too wordy.
                The character counters under each box are the budget, not a suggestion.
              </li>
            </ul>
            <p>
              Each ticket on the round page says either <strong>Card reads well</strong> or{' '}
              <strong>Check this card</strong> followed by what is wrong with it — a question left unanswered, no
              figures, a picture with no caption, a headline that is only the ticket title reworded, or wording that
              still reads technical. Those checks are mechanical, so they catch the obvious failures and nothing else;
              a card can pass all of them and still be vague. They matter most when the round is running itself, because
              then a weak card goes out to the committee and gets scored with nobody having read it first.
            </p>
          </Section>

          <Section id="results" title="Reading the results" index={6}>
            <p>Each ticket on the round page carries its own numbers. The ones worth understanding:</p>
            <ul>
              <li>
                <strong>Spread.</strong> Shown in red when it is over the discussion threshold, with a{' '}
                <strong>Discussion needed</strong> badge and a line saying what the scores actually ranged between. That
                ticket goes on the Discussions list below, and nothing is written to JIRA for it until you record what
                the meeting decided.
              </li>
              <li>
                <strong>Awaiting WOSG Responses</strong> — fewer responses than the minimum. It rolls over.
              </li>
              <li>
                <strong>Awaiting RA effort</strong> — nobody has estimated it, so there is no priority ratio yet. Note
                that a ticket can be awaiting effort <em>and</em> need a discussion; the badges are separate for that
                reason.
              </li>
              <li>
                <strong>To Close?</strong> — at least one member said it can be closed. That outranks everything else:
                a ticket the committee wants closed is never marked ready for estimation, and is never transitioned in
                JIRA.
              </li>
              <li>
                <strong>Send for Est</strong> — enough responses, no disagreement, nobody asking to close it: ready to
                go to RA.
              </li>
            </ul>
            <p>
              “Who scored what” lists individual submissions, coordinators only. You can <strong>Exclude</strong> a
              submission to stop it counting without deleting it — useful when someone scores the wrong ticket.
              Excluding is also the way to let somebody score again: a committee member cannot change a score once it is
              given, so if one needs correcting, exclude it and the ticket reopens for them.
            </p>
            <p>
              <strong>On a finalised round, excluding a score does not move the numbers on its own.</strong> Finalising
              freezes the results so a figure that may already be in JIRA cannot drift, which means the row greys out
              and the score and spread stay where they were. Press <strong>Recalculate results</strong> under Round
              actions to say you meant it: the exclusion then counts, the spread moves, and a ticket that has become
              too split to average is flagged for discussion and held out of the write-back like any other. It tells
              you what changed, so you are not left comparing figures yourself.
            </p>
          </Section>

          <Section id="discussions" title="Tickets the committee split on" index={7}>
            <p>
              When the committee's totals for a ticket are further apart than the spread threshold, averaging them
              produces a number nobody in the room agreed with. Those tickets collect on the{' '}
              <strong>Discussions</strong> list on the round page, and they are held out of the JIRA write-back — with
              no override, unlike the minimum-responses gate — until you record an outcome.
            </p>
            <p>
              Book the meeting however you normally would. The list gives you what you need to run it: every total that
              was given (unattributed, as always), the lowest and highest, the spread against the threshold, and any
              notes or queries left with the scores. Then record one of three answers:
            </p>
            <ul>
              <li>
                <strong>Agreed a score.</strong> The committee talked and settled on a number. Type it in — or leave it
                blank to accept the calculated average after all. That number, not the average, is what goes to JIRA,
                and the ticket then moves on like any other.
              </li>
              <li>
                <strong>Score it again next round.</strong> The ticket is added to whichever round is still taking
                tickets, so the committee sees it again. Nothing is written to JIRA for it in this round. If there is no
                such round yet, create the next one and it rolls over into it.
              </li>
              <li>
                <strong>Close the ticket.</strong> Recorded as one not to do. No score is written and the ticket is not
                moved on; closing it in JIRA is still done in JIRA.
              </li>
            </ul>
            <p>
              The note you write is shown to the whole committee on the feedback view for that round, so it is worth a
              sentence on what was concluded. You can change an outcome afterwards; changing an agreed score makes the
              next write-back send the new number rather than treating it as already written.
            </p>
            <p className="hint">
              Recording a discussion never touches the frozen results. What the committee scored stays exactly as it was
              given; the agreed number is stored alongside it as the decision it is.
            </p>
          </Section>

          <Section id="jira" title="Getting scores into JIRA" index={8}>
            <p>
              <strong>Write scores to JIRA</strong> appears once a round is finalised. It writes each ticket's business
              score to the configured field and then moves the ticket on — to <em>Ready for Estimation</em> by default,
              or whatever transition you named under Settings → JIRA.
            </p>
            <p>
              Only tickets that cleared every gate are moved: enough responses, nobody asking to close it, and no
              discussion still outstanding. The two steps are separate, so if the score writes but the workflow refuses
              the move, you are told exactly that rather than the whole ticket being reported as failed — and running
              the write-back again will finish the move without writing the score a second time.
            </p>
            <p>
              <strong>The transition name has to match JIRA exactly</strong>, and getting it wrong is quiet: the score
              writes, the move fails, and the ticket stays where it was. Either the transition’s own name or the status
              it leads to will do, and punctuation is forgiven — but nothing is guessed at, so an abbreviation the
              workflow uses has to be typed the way the workflow uses it. Rather than guessing, press{' '}
              <strong>List transitions from JIRA</strong> under Settings → JIRA: it reads a real ticket and offers what
              its workflow currently accepts, and clicking one fills the box in.
            </p>
            <p>
              Afterwards you get a row per ticket saying what happened and <em>why</em>. Most of the time “skipped” means
              one of:
            </p>
            <ul>
              <li>
                <strong>Not enough responses</strong> — the ticket rolls over rather than being decided by too few
                people. If it will never reach that number, <strong>Write the skipped scores anyway</strong> overrides
                the gate.
              </li>
              <li>
                <strong>Nobody scored it</strong>, or nobody answered “Yes” — there is no score to write.
              </li>
              <li>
                <strong>Already written</strong> — the same score has gone across before. Running it twice is safe.
              </li>
              <li>
                <strong>Held for discussion</strong> — the committee was split and the meeting has not been recorded
                yet, or it ended in a re-score or a close. See Tickets the committee split on, above.
              </li>
            </ul>
            <p className="hint">
              A failure shows the message JIRA gave. “Field is not on the screen” is the common one and is fixed in
              JIRA, not here.
            </p>
          </Section>

          <Section id="automation" title="Letting it run itself" index={9}>
            <p>
              <strong>Settings → Run the round automatically.</strong> Off until you switch it on. Every step is its own
              switch, so you can let the app create and chase a round long before you let it write to JIRA.
            </p>
            <p className="hint">
              <strong>“Create next week’s round” fires as soon as the previous one is finished</strong> — closed and
              past its cut-off, or finalised — not on the distribution day itself. That gives you the days in between
              to import from JIRA, write the cards and check them before it actually opens, rather than everything
              happening at once on the morning it goes out. A round created this way still only opens, and the
              committee only gets emailed, at the time Cadence says — check the <strong>Opens</strong> column on
              Rounds to see exactly when a draft that has already appeared will go out.
            </p>
            <p>
              <strong>Nothing here takes a button away.</strong> Doing a step yourself just means automation finds it
              already done — closing a round early is not an error, and finalising by hand still gets the scores pushed
              to JIRA. There is always a way out:
            </p>
            <ul>
              <li>
                <strong>Pause automation for this round</strong> — freezes the cycle for one round, leaving everything
                else running.
              </li>
              <li>
                <strong>Reopen for scoring</strong> — brings a finalised round back, including one the app finalised.
                The frozen results are released and recalculated when you finalise again; anything already in JIRA
                stays until you write back again.
              </li>
            </ul>
            <p>
              The round page always says what will happen next — “Finalises at Tue 11 Aug, 18:00, then the scores go to
              JIRA” — and lists everything the app has already done to it.
            </p>
            <p className="hint">
              When automation opens a round, it holds back any ticket with nothing drafted at all or that still reads
              technical — the rest of the round still opens and goes out on time. A held ticket shows on the round
              page with why, and a “Release to committee” button once you have fixed it or decided it is fine as it
              is. This is a much narrower check than the “Check this card” hint on every ticket, which flags things —
              a missing figure, no screenshot caption — worth improving but not worth holding a round up for.
            </p>
            <p className="hint">
              A step that fails gets one automatic retry after half an hour, in case it was a passing blip — the round
              page says so (“will retry automatically”). If the retry also fails, it says “retries exhausted — run
              this step by hand”, and stays that way until you do.
            </p>
            <p className="hint">
              A round automation created gets an opening time from the Cadence settings automatically. A round you
              create by hand only gets one if you give it one — set “Opens” on the New Round form, or add it
              afterwards from the round page — otherwise automation leaves it alone entirely (it will not open,
              distribute, chase or close a round it cannot see an opening time on), the same as if automation were
              switched off just for that round.
            </p>
            <p className="hint">
              Both times are set once and never move on their own — the opening and cut-off on the round page can be
              changed at any point while it is still a draft, whether that is to line an already-created round up
              with a cadence you have since changed, or to set up a short window to test the whole cycle. “In 15
              min” / “In 1 hour” / “Tomorrow 9am” fill the opening time in one click on both the New Round form and
              the round page, rather than working the date out by hand.
            </p>
            <p className="hint">
              Cadence itself also has a <strong>one-time override</strong> — an exact opens/cut-off used only for
              the very next round automation creates, then cleared automatically. That is how automation
              creates a round on a short test window (or a genuine one-off week) without touching the recurring
              weekly pattern the rest of the time: setting the override does not change the day/hour/minute
              fields, and every round after the one it applies to goes back to those.
            </p>
          </Section>

          <Section id="settings" title="Settings worth knowing about" index={10}>
            <ul>
              <li>
                <strong>Minimum responses</strong> — below this a ticket rolls over instead of being scored.
              </li>
              <li>
                <strong>Discussion threshold</strong> — how far apart the totals can be before a ticket is flagged for a
                meeting.
              </li>
              <li>
                <strong>Categories</strong> — the {categories} are data, not code. Reword, reorder or retire them. Unticking
                “Active” removes one from everybody's form. There is a “Restore the seven default categories” button if
                you go too far.
              </li>
              <li>
                <strong>Cadence</strong> — two separate settings, each its own day, hour and minute (on the hour, or a
                quarter/half past): when a round <strong>opens</strong> and goes out to the committee, and when it{' '}
                <strong>closes</strong> — the cut-off. Times are read as wall-clock time in the timezone set there, so
                they hold across the clocks changing. Cut-off always searches forward from the opening, so a close
                day earlier in the week than the open day pushes the round into the following week — Settings shows a
                live preview of exactly when the next automatically-created round would open and close, so you can
                see the effect before saving rather than after. Automation works from these; a round created by hand
                can use them too, or set its own opening time. Reminders and the “Final reminder” are set in minutes
                before the cut-off, so a short test window still gets chased in time — the final reminder sends one
                sharper-worded last chase on top of the ordinary reminders; leave it blank to turn it off.
              </li>
              <li>
                <strong>Committee</strong> — who can sign in, and which of the two roles they have.{' '}
                <strong>Committee</strong> members score; <strong>Admins</strong> run the process and deliberately do
                not score, which keeps the two jobs apart. Click any column heading to sort the list.
              </li>
              <li>
                <strong>Committee participation</strong> — completion rate over recent finalised rounds, lowest first,
                so a quiet drop-off is easy to spot rather than something you have to notice by memory.
              </li>
              <li>
                <strong>Delete a round</strong> — removes one round and everything scored against it, for a test round
                or one created twice. The tickets are kept, because a ticket comes from JIRA and usually appears in
                more than one round. One confirmation, naming the round. Anything already written to JIRA stays in
                JIRA, and the audit log records what went.
              </li>
              <li>
                <strong>Start afresh</strong> — deletes every round, ticket and score. It asks you to type the phrase
                out for a reason.
              </li>
            </ul>
          </Section>

          <Section id="problems" title="When something looks wrong" index={11}>
            <div className="table-scroll">
              <table>
                <caption className="visually-hidden">Common problems and what they mean</caption>
                <thead>
                  <tr>
                    <th scope="col">What you see</th>
                    <th scope="col">What it means</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row" className="plain">
                      “Import from JIRA” finds nothing
                    </th>
                    <td>
                      The JQL did not match. The message shows exactly what was searched — usually the status name is
                      not quite what Settings → JIRA says.
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="plain">
                      Nobody got the email
                    </th>
                    <td>
                      Check the email log at the foot of the round. “NOT SENT (email off)” means no provider is
                      configured — the messages were composed but never sent. Use “Copy scoring link” meanwhile.
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="plain">
                      A committee member sees nothing to score
                    </th>
                    <td>
                      The round has no tickets yet, or it has not been distributed. Between rounds there is genuinely
                      nothing open, and the Score page says so — with a link to the last finalised round's results.
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="plain">
                      Excluding a score changed nothing
                    </th>
                    <td>
                      The round is finalised, so its results are frozen. Press <strong>Recalculate results</strong>
                      under Round actions — see Reading the results.
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="plain">
                      A ticket was skipped as “held for discussion”
                    </th>
                    <td>
                      The committee was split on it and the meeting has not been recorded. Record the outcome under
                      Discussions on the round page and run the write-back again.
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="plain">
                      The score reached JIRA but the ticket did not move
                    </th>
                    <td>
                      The write-back row says which of the two it was. If the transition failed, the message names what
                      the workflow does offer, so you can correct the name under Settings → JIRA and run the write-back
                      again — it will move the ticket without rewriting the score. If it was never attempted, the ticket
                      had not cleared every gate, or the switch is off in Settings.
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="plain">
                      “Import from JIRA” is refused
                    </th>
                    <td>
                      The round is closed or finalised. Import into the next round — a closed round cannot be scored,
                      and a finalised one cannot have tickets taken back out.
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="plain">
                      The scoring form is empty
                    </th>
                    <td>Every category has been deactivated in Settings. Restore the defaults.</td>
                  </tr>
                  <tr>
                    <th scope="row" className="plain">
                      A card reads like the ticket title
                    </th>
                    <td>
                      Drafting fell back to the heading parser — either no API key is configured, or the call failed.
                      Settings → Card drafting says which is running.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="hint">
              The <Link to="/audit">Audit</Link> page records every action and who took it, with automation's own
              steps marked as such. It also shows each committee member's last sign-in and their completion rate
              over recent rounds, so quiet drift is visible before it becomes a pattern.
            </p>
          </Section>
        </>
      ) : null}
    </>
  );
}
