import { Router } from 'express';
import { env, isEmailSignIn } from '../config/env.js';
import { getDb } from '../db/index.js';
import { audit } from '../services/auditService.js';
import { getMember, getMemberByEmail, listMembers, recordLogin, saveMember } from '../services/memberService.js';
import { AuthRequestState, buildAuthorizeUrl, createAuthRequestState, exchangeCode, logoutUrl } from '../auth/entra.js';
import { clearSession, issueSession } from '../auth/session.js';
import { asyncHandler } from './helpers.js';

const router = Router();
const STATE_COOKIE = 'bis_auth_state';

router.get('/mode', (_req, res) => {
  res.json({
    mode: isEmailSignIn() ? 'email' : 'entra',
    selfRegistration: env.allowSelfRegistration,
    tenantConfigured: Boolean(env.auth.entra.tenantId && env.auth.entra.clientId),
  });
});

/**
 * The committee, for the "who are you?" picker. Names and teams only - no
 * email addresses, so an internal URL does not hand out a staff directory.
 * Sign-in then happens by member id.
 */
router.get(
  '/members',
  asyncHandler(async (_req, res) => {
    if (!isEmailSignIn()) {
      res.json({ members: [] });
      return;
    }
    const db = await getDb();
    const members = await listMembers(db, false);
    res.json({ members: members.map((m) => ({ id: m.id, name: m.name, team: m.team, role: m.role })) });
  }),
);

/** Entra ID SSO - no separate login (§4). */
router.get('/login', async (req, res) => {
  if (env.auth.mode !== 'entra') {
    res.status(400).json({ error: 'Entra sign-in is not enabled (AUTH_MODE=dev)' });
    return;
  }
  try {
    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/';
    const state = createAuthRequestState(returnTo);
    res.cookie(STATE_COOKIE, JSON.stringify(state), {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.auth.cookieSecure,
      maxAge: 10 * 60 * 1000,
      path: '/',
    });
    res.redirect(await buildAuthorizeUrl(state));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Sign-in failed' });
  }
});

router.get('/callback', async (req, res) => {
  try {
    const raw = req.cookies?.[STATE_COOKIE];
    if (!raw) throw new Error('Sign-in state missing or expired');
    const state = JSON.parse(raw) as AuthRequestState;
    if (req.query.state !== state.state) throw new Error('Sign-in state mismatch');
    if (typeof req.query.code !== 'string') throw new Error(`Entra returned no code: ${String(req.query.error ?? '')}`);

    const identity = await exchangeCode(req.query.code, state);
    const db = await getDb();

    // Members are provisioned by the coordinator; unknown users are not
    // silently admitted (§4 RBAC).
    const member = await getMemberByEmail(db, identity.email);
    if (!member || !member.active) {
      res.status(403).send(
        `<p>${identity.email} is not on the scoring committee. Ask the coordinator to add you.</p>`,
      );
      return;
    }

    await recordLogin(db, member.id, identity.oid);
    await issueSession(res, { memberId: member.id, email: member.email, name: member.name, role: member.role });
    await audit(db, { id: member.id, email: member.email }, 'auth.login', 'member', member.id, { method: 'entra' });

    res.clearCookie(STATE_COOKIE, { path: '/' });
    const target = state.returnTo?.startsWith('/') ? state.returnTo : '/';
    res.redirect(`${env.publicWebOrigin.replace(/\/+$/, '')}${target}`);
  } catch (err) {
    res.status(401).send(`<p>Sign-in failed: ${err instanceof Error ? err.message : 'unknown error'}</p>`);
  }
});

/**
 * Name/email sign-in (AUTH_MODE=email). Identity is self-asserted - suitable
 * for an internal tool with a known committee, and a documented departure from
 * §4. Sign in by member id (the picker) or by email address.
 */
// Mounted on both /sign-in and the older /dev-login path.
const signIn = asyncHandler(async (req, res) => {
  {
    if (!isEmailSignIn()) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const db = await getDb();
    const memberId = String(req.body?.memberId ?? '').trim();
    const email = String(req.body?.email ?? '').trim();
    const name = String(req.body?.name ?? '').trim();

    let member = memberId ? await getMember(db, memberId) : email ? await getMemberByEmail(db, email) : undefined;

    // Someone new can add themselves only when self-registration is on - their
    // scores count toward the aggregates, so the committee is normally the
    // coordinator's list.
    if (!member && email && env.allowSelfRegistration) {
      member = await saveMember(db, { name: name || email.split('@')[0], email, role: 'COMMITTEE' });
      await audit(db, { id: member.id, email: member.email }, 'member.self-register', 'member', member.id, {});
    }

    if (!member || !member.active) {
      res.status(403).json({
        error: env.allowSelfRegistration
          ? 'Enter your name and email address to join the committee'
          : 'You are not on the committee yet — ask the coordinator to add you',
      });
      return;
    }

    await recordLogin(db, member.id);
    await issueSession(res, { memberId: member.id, email: member.email, name: member.name, role: member.role });
    await audit(db, { id: member.id, email: member.email }, 'auth.login', 'member', member.id, { method: 'email' });
    res.json({ member });
  }
});

router.post('/sign-in', signIn);
router.post('/dev-login', signIn);

router.post('/logout', async (req, res) => {
  if (req.member) {
    const db = await getDb();
    await audit(db, { id: req.member.id, email: req.member.email }, 'auth.logout', 'member', req.member.id, {});
  }
  clearSession(res);
  const signOut = env.auth.mode === 'entra' ? await logoutUrl(env.publicWebOrigin) : null;
  res.json({ ok: true, signOutUrl: signOut });
});

export default router;
