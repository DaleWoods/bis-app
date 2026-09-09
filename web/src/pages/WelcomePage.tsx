import type { Member } from '../api';

/**
 * Shown once, the moment a committee member's very first sign-in lands -
 * `member.lastLoginAt` is only ever null on that one request, since the
 * server stamps it before the response goes out. Nothing to persist and
 * nothing to reset: by their second visit it is simply never null again.
 */
export function WelcomePage({ member, onContinue }: { member: Member; onContinue: () => void }) {
  const firstName = member.name.split(' ')[0] || member.name;
  return (
    <div className="login-wrap" style={{ maxWidth: 540 }}>
      <div className="card">
        <h1>Welcome, {firstName}</h1>
        <p className="lede">
          You're on the Business Impact Scoring committee. A minute before your first round:
        </p>
        <ul>
          <li>
            Every ticket gets a short card written in plain language — what it is, what it's costing, what
            would change. You don't need to have seen the original request.
          </li>
          <li>Score each of the seven categories 0–10, based on the card alone.</li>
          <li>
            Your answers are never shown to anyone with your name on them — only the committee's combined
            average, once everyone's in.
          </li>
          <li>You can save your picks and come back to a ticket later — nothing submits until you say so.</li>
        </ul>
        <button onClick={onContinue}>Start scoring</button>
        <p className="hint" style={{ marginTop: '0.75rem' }}>
          You can come back to this any time from the Guide tab.
        </p>
      </div>
    </div>
  );
}
