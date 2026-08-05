import { SignJWT, jwtVerify } from 'jose';
import type { Response } from 'express';
import { env } from '../config/env.js';
import { Role } from '../domain/types.js';

export interface SessionUser {
  memberId: string;
  email: string;
  name: string;
  role: Role;
}

const secret = () => new TextEncoder().encode(env.auth.sessionSecret);

export async function issueSession(res: Response, user: SessionUser): Promise<void> {
  const token = await new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.memberId)
    .setIssuedAt()
    .setExpirationTime(`${env.auth.sessionTtlHours}h`)
    .sign(secret());

  res.cookie(env.auth.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.auth.cookieSecure,
    maxAge: env.auth.sessionTtlHours * 60 * 60 * 1000,
    path: '/',
  });
}

export async function readSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.sub) return null;
    return {
      memberId: String(payload.sub),
      email: String(payload.email ?? ''),
      name: String(payload.name ?? ''),
      role: (payload.role as Role) ?? 'COMMITTEE',
    };
  } catch {
    return null;
  }
}

export function clearSession(res: Response): void {
  res.clearCookie(env.auth.cookieName, { path: '/' });
}
