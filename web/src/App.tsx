import { useEffect, useState } from 'react';
import { api, canScore, isCoordinator, type Member, type PendingDiscussion, type StuckAutomationStep } from './api';
import { Link, matchRoute, useRouter } from './router';
import { LoginPage } from './pages/LoginPage';
import { ScorePage } from './pages/ScorePage';
import { RoundsPage } from './pages/RoundsPage';
import { QueuePage } from './pages/QueuePage';
import { RoundDetailPage } from './pages/RoundDetailPage';
import { FeedbackPage } from './pages/FeedbackPage';
import { SettingsPage } from './pages/SettingsPage';
import { AuditPage } from './pages/AuditPage';
import { GuidePage } from './pages/GuidePage';

export function App() {
  const { path, navigate } = useRouter();
  const [member, setMember] = useState<Member | null>(null);
  const [loading, setLoading] = useState(true);
  const [stuckSteps, setStuckSteps] = useState<StuckAutomationStep[]>([]);
  const [pendingDiscussions, setPendingDiscussions] = useState<PendingDiscussion[]>([]);

  useEffect(() => {
    api
      .me()
      .then(({ member }) => setMember(member))
      .catch(() => setMember(null))
      .finally(() => setLoading(false));
  }, []);

  const coordinator = Boolean(member && isCoordinator(member.role));

  useEffect(() => {
    if (!coordinator) return;
    api
      .automationFailures()
      .then(({ failures }) => setStuckSteps(failures))
      .catch(() => {});
    api
      .pendingDiscussions()
      .then(({ discussions }) => setPendingDiscussions(discussions))
      .catch(() => {});
  }, [coordinator]);

  if (loading) return <main>Loading…</main>;
  if (!member) return <LoginPage onSignedIn={setMember} />;

  const scorer = canScore(member.role);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <span className="brand">
          <span className="brand-mark">WOSG</span>
          <span className="brand-divider" aria-hidden="true" />
          <span className="brand-name">Business Impact Scoring</span>
        </span>
        <nav aria-label="Main">
          {scorer ? <Link to="/">Score</Link> : null}
          <Link to="/rounds">Rounds</Link>
          <Link to="/queue">Queue</Link>
          {coordinator ? <Link to="/settings">Settings</Link> : null}
          {coordinator ? <Link to="/audit">Audit</Link> : null}
          <Link to="/guide">Guide</Link>
        </nav>
        <div className="who">
          <span>
            {member.name} · {member.role}
          </span>
          <button
            className="secondary"
            onClick={async () => {
              const { signOutUrl } = await api.logout();
              if (signOutUrl) window.location.href = signOutUrl;
              else {
                setMember(null);
                navigate('/');
              }
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main id="main">
        {coordinator && stuckSteps.length ? (
          <div className="notice warn" role="alert" style={{ marginBottom: '1rem' }}>
            <strong>
              {stuckSteps.length === 1 ? 'One automated step is' : `${stuckSteps.length} automated steps are`} stuck
              and needs attention:
            </strong>
            <ul style={{ margin: '0.4rem 0 0' }}>
              {stuckSteps.map((step) => (
                <li key={`${step.roundId}-${step.action}-${step.ranAt}`}>
                  <Link to={`/rounds/${step.roundId}`}>{step.weekLabel}</Link> — {step.action}: {step.outcome}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {coordinator && pendingDiscussions.length ? (
          <div className="notice warn" role="alert" style={{ marginBottom: '1rem' }}>
            <strong>
              {pendingDiscussions.length === 1 ? 'One ticket needs' : `${pendingDiscussions.length} tickets need`} a
              discussion:
            </strong>
            <ul style={{ margin: '0.4rem 0 0' }}>
              {pendingDiscussions.map((item) => (
                <li key={`${item.roundId}-${item.ticketId}`}>
                  <Link to={`/rounds/${item.roundId}`}>{item.jiraId}</Link> — {item.title} ({item.weekLabel})
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <Routes path={path} member={member} coordinator={coordinator} scorer={scorer} />
      </main>
    </>
  );
}

function Routes({
  path,
  member,
  coordinator,
  scorer,
}: {
  path: string;
  member: Member;
  coordinator: boolean;
  scorer: boolean;
}) {
  // Coordinators land on the dashboard, which is their job; scorers land on
  // the round they need to score.
  if (path === '/' || path === '/score') {
    return scorer ? <ScorePage member={member} /> : <RoundsPage member={member} />;
  }

  const score = matchRoute('/score/:id', path);
  if (score) return <ScorePage member={member} roundId={score.id} />;

  if (path === '/rounds') return <RoundsPage member={member} />;
  if (path === '/queue') return <QueuePage />;

  const round = matchRoute('/rounds/:id', path);
  if (round) {
    return coordinator ? (
      <RoundDetailPage member={member} roundId={round.id} />
    ) : (
      <ScorePage member={member} roundId={round.id} />
    );
  }

  const feedback = matchRoute('/feedback/:id', path);
  if (feedback) return <FeedbackPage roundId={feedback.id} />;

  // Everyone gets the guide; it shows the coordinator half only to coordinators.
  if (path === '/guide') return <GuidePage member={member} />;

  if (path === '/settings') return coordinator ? <SettingsPage member={member} /> : <Forbidden />;
  if (path === '/audit') return coordinator ? <AuditPage /> : <Forbidden />;

  return (
    <>
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to scoring</Link>
      </p>
    </>
  );
}

function Forbidden() {
  return (
    <>
      <h1>Not available</h1>
      <p>That area is for coordinators. (Access is enforced on the server too — this is just the friendly version.)</p>
    </>
  );
}
