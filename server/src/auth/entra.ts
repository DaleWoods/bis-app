import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../config/env.js';

/**
 * Entra ID (Azure AD) OpenID Connect authorisation-code flow with PKCE (§12.3).
 * Deliberately dependency-light: discovery + token exchange over fetch, id_token
 * verified against the tenant JWKS.
 */

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
  end_session_endpoint?: string;
}

let discoveryCache: { at: number; value: Discovery } | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function authority(): string {
  return `https://login.microsoftonline.com/${env.auth.entra.tenantId}/v2.0`;
}

export async function discover(): Promise<Discovery> {
  const oneHour = 60 * 60 * 1000;
  if (discoveryCache && Date.now() - discoveryCache.at < oneHour) return discoveryCache.value;

  const res = await fetch(`${authority()}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Entra discovery failed: ${res.status} ${await res.text()}`);
  const value = (await res.json()) as Discovery;
  discoveryCache = { at: Date.now(), value };
  return value;
}

export interface AuthRequestState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

export function createAuthRequestState(returnTo: string): AuthRequestState {
  return {
    state: randomBytes(16).toString('hex'),
    nonce: randomBytes(16).toString('hex'),
    codeVerifier: randomBytes(32).toString('base64url'),
    returnTo,
  };
}

export async function buildAuthorizeUrl(request: AuthRequestState): Promise<string> {
  const { authorization_endpoint } = await discover();
  const challenge = createHash('sha256').update(request.codeVerifier).digest('base64url');
  const url = new URL(authorization_endpoint);
  url.searchParams.set('client_id', env.auth.entra.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', env.auth.entra.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', 'openid profile email offline_access');
  url.searchParams.set('state', request.state);
  url.searchParams.set('nonce', request.nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface EntraIdentity {
  oid: string;
  email: string;
  name: string;
}

export async function exchangeCode(code: string, request: AuthRequestState): Promise<EntraIdentity> {
  const { token_endpoint, issuer } = await discover();

  const body = new URLSearchParams({
    client_id: env.auth.entra.clientId,
    client_secret: env.auth.entra.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.auth.entra.redirectUri,
    code_verifier: request.codeVerifier,
    scope: 'openid profile email offline_access',
  });

  const res = await fetch(token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error('Entra did not return an id_token');

  const { jwks_uri } = await discover();
  if (!jwks) jwks = createRemoteJWKSet(new URL(jwks_uri));

  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer,
    audience: env.auth.entra.clientId,
  });

  if (payload.nonce && payload.nonce !== request.nonce) throw new Error('id_token nonce mismatch');

  const email = String(payload.preferred_username ?? payload.email ?? payload.upn ?? '').toLowerCase();
  if (!email) throw new Error('id_token carried no email/UPN claim');

  const allowed = env.auth.entra.allowedEmailDomains;
  if (allowed.length && !allowed.some((domain) => email.endsWith(`@${domain}`))) {
    throw new Error(`Sign-in is restricted to: ${allowed.join(', ')}`);
  }

  return {
    oid: String(payload.oid ?? payload.sub ?? ''),
    email,
    name: String(payload.name ?? email),
  };
}

export async function logoutUrl(postLogoutRedirect: string): Promise<string | null> {
  try {
    const { end_session_endpoint } = await discover();
    if (!end_session_endpoint) return null;
    const url = new URL(end_session_endpoint);
    url.searchParams.set('post_logout_redirect_uri', postLogoutRedirect);
    return url.toString();
  } catch {
    return null;
  }
}
