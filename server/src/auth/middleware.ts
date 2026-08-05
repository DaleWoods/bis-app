import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { Role, isCoordinator } from '../domain/types.js';
import { getDb } from '../db/index.js';
import { Member, getMember } from '../services/memberService.js';
import { readSession } from './session.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      member?: Member;
    }
  }
}

/** Resolves the signed-in member from the session cookie. Never trusts client claims. */
export async function attachMember(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await readSession(req.cookies?.[env.auth.cookieName]);
    if (session) {
      const db = await getDb();
      // Role is re-read from the database on every request, so a revoked or
      // downgraded role takes effect immediately rather than at token expiry.
      const member = await getMember(db, session.memberId);
      if (member && member.active) req.member = member;
    }
  } catch {
    // fall through as anonymous
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.member) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  next();
}

/** §4/§14: RBAC enforced server-side, not in the UI. */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.member) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    if (!roles.includes(req.member.role)) {
      res.status(403).json({ error: 'You do not have permission to do that' });
      return;
    }
    next();
  };
}

export function requireCoordinator(req: Request, res: Response, next: NextFunction): void {
  if (!req.member) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  if (!isCoordinator(req.member.role)) {
    res.status(403).json({ error: 'Coordinator access required' });
    return;
  }
  next();
}
