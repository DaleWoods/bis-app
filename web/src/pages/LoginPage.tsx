import { useEffect, useState } from 'react';
import { api, type Member, type SignInMember } from '../api';

/**
 * Sign-in. In `email` mode you pick your name from the committee - the app is
 * internal and the committee is known, so identity is self-asserted. In
 * `entra` mode this hands off to Microsoft 365 single sign-on.
 */
export function LoginPage({ onSignedIn }: { onSignedIn: (member: Member) => void }) {
  const [mode, setMode] = useState<'entra' | 'email' | null>(null);
  const [selfRegistration, setSelfRegistration] = useState(false);
  const [committee, setCommittee] = useState<SignInMember[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .authMode()
      .then(({ mode, selfRegistration }) => {
        setMode(mode);
        setSelfRegistration(selfRegistration);
        if (mode === 'email') api.signInMembers().then(({ members }) => setCommittee(members)).catch(() => setCommittee([]));
      })
      .catch(() => setMode('entra'));
  }, []);

  async function signIn(payload: { memberId?: string; email?: string; name?: string }) {
    setBusy(true);
    setError('');
    try {
      const { member } = await api.signIn(payload);
      onSignedIn(member);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="card">
        <h1>Business Impact Scoring</h1>

        {mode === null ? <p className="lede">Loading…</p> : null}

        {mode === 'entra' ? (
          <>
            <p className="lede">Sign in with your Microsoft 365 account.</p>
            <a className="button" href={`/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`}>
              Sign in with Microsoft
            </a>
          </>
        ) : null}

        {mode === 'email' ? (
          <>
            <p className="lede">Who are you?</p>

            {committee.length ? (
              <ul className="signin-list">
                {committee.map((member) => (
                  <li key={member.id}>
                    <button type="button" className="secondary" disabled={busy} onClick={() => signIn({ memberId: member.id })}>
                      <span className="signin-name">{member.name}</span>
                      {member.team ? <span className="signin-team">{member.team}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No committee members yet — sign in with your email address to get started.</p>
            )}

            <details style={{ marginTop: '1rem' }}>
              <summary>{selfRegistration ? 'Not on the list? Add yourself' : 'Sign in with an email address instead'}</summary>
              <form
                style={{ marginTop: '0.75rem' }}
                onSubmit={(event) => {
                  event.preventDefault();
                  signIn({ email, name });
                }}
              >
                {selfRegistration ? (
                  <div className="field">
                    <label htmlFor="signin-name">Your name</label>
                    <input id="signin-name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
                  </div>
                ) : null}
                <div className="field">
                  <label htmlFor="signin-email">Your email address</label>
                  <input
                    id="signin-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                </div>
                <button type="submit" disabled={busy}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            </details>
          </>
        ) : null}

        {error ? (
          <p className="status error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
