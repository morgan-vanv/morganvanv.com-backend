import { ALLOWED_ORIGINS } from './config';

/** The origin to echo back, or null when this origin isn't one of the site's. */
export function allowedOrigin(origin: string | null, allowed: readonly string[] = ALLOWED_ORIGINS): string | null {
  return origin !== null && allowed.includes(origin) ? origin : null;
}

/** CORS headers for an ordinary response: none at all for unknown origins. */
export function corsHeaders(origin: string | null): Record<string, string> {
  const allow = allowedOrigin(origin);
  if (!allow) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Expose-Headers': 'Retry-After',
    Vary: 'Origin',
  };
}

/** CORS headers for an OPTIONS preflight. */
export function preflightHeaders(origin: string | null): Record<string, string> {
  const allow = allowedOrigin(origin);
  if (!allow) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    // Browsers cap this (Chrome at 2 h), but every preflight saved is a request off the daily quota.
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
