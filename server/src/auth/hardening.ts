import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';

/**
 * Response headers and a sign-in throttle.
 *
 * Written out rather than pulled in from helmet and express-rate-limit: this is
 * about thirty lines, it is the same thirty lines either way, and the app
 * deliberately keeps its dependency list short enough to read.
 *
 * The session cookie is already httpOnly, secure and SameSite=lax, which is
 * what actually stops cross-site request forgery. These headers cover the rest:
 * a page that cannot be framed cannot be clickjacked, a response that cannot be
 * sniffed cannot be re-typed into a script, and a referrer that stays on the
 * origin does not leak round ids into other people's logs.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  // The built SPA loads one external module and one stylesheet, both from this
  // origin, and has no inline <script> - so script-src can be strict. Inline
  // style *attributes* are used throughout the React components, which is what
  // 'unsafe-inline' on style-src is for; it does not weaken script execution.
  // Images include data: URIs for JIRA screenshots embedded in the packs.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );

  // Only over HTTPS, and only in production: sent on a local http:// dev server
  // it would pin the browser to a scheme that is not being served.
  if (env.nodeEnv === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * A fixed-window throttle, per IP, held in memory.
 *
 * In-memory is the honest scope for it: one instance drives this app (the
 * scheduler comment says why), so a shared store would be ceremony around a
 * Map. It is not a defence against a determined attacker with a botnet - it
 * stops a script guessing addresses against the sign-in endpoint, which in
 * name/email mode is the whole of the front door.
 */
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }) {
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();

    // Opportunistic sweep, so the map cannot grow without bound on a long
    // uptime. Cheap: it only runs when a bucket has expired anyway.
    if (buckets.size > 1000) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
    }

    const key = req.ip ?? 'unknown';
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: `Too many attempts. Try again in ${retryAfter} second(s).` });
      return;
    }
    next();
  };
}
