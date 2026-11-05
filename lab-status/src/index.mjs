// The Lab page's up/down lights as a Cloudflare Worker. One route, a thin adapter over status.js, which
// knows nothing about Workers (so it runs under node --test):
//
//   GET|HEAD /status   { checkedAt, services: { vtt: 'up' | 'down', jellyfin: 'up' | 'down' } }
//   GET /              name and version
//
// No secrets, no storage, no bindings but a rate limit: results are kept in memory for two minutes per isolate.
import statusModule from './status.js';

const { targetsFrom, checkAll, memoized } = statusModule;

export const NAME = 'lab-status';
/** Kept in step with package.json (a test checks). */
export const VERSION = '1.0.1';
export const SOURCE_URL = 'https://github.com/morgan-vanv/morganvanv.com-backend/tree/main/lab-status';

/** Who may read /status from a browser (the same list as the ask Worker's and the campfire's). */
export const ALLOWED_ORIGINS = [
  'https://morganvanv.com',
  'https://www.morganvanv.com',
  'http://localhost:4200',
  'http://localhost:4000',
];

function corsHeaders(origin, preflight = false) {
  if (origin === null || !ALLOWED_ORIGINS.includes(origin)) return { Vary: 'Origin' };
  const headers = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  if (!preflight) return headers;
  return { ...headers, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': '86400' };
}

function json(status, body, headers = {}, method = 'GET') {
  return new Response(method === 'HEAD' ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** The visitor's IP, set by Cloudflare: only ever a rate-limit key, never stored or logged. */
const clientIp = request => request.headers.get('CF-Connecting-IP') || 'unknown';

/** True when the limiter lets this through. A missing binding or a limiter error never blocks anyone. */
async function allowed(limiter, key) {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

// One memo per isolate and per target list: env is only known inside fetch, and a config-only deploy can
// land in a reused isolate, so a changed list starts a fresh memo rather than checking the old addresses.
let current = null;
let currentKey = '';
function statusFor(env) {
  const targets = targetsFrom(env);
  const key = JSON.stringify(targets);
  if (!current || key !== currentKey) {
    current = memoized(() => checkAll(targets, fetch));
    currentKey = key;
  }
  return current();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (url.pathname === '/') {
      return json(200, { name: NAME, version: VERSION, source: SOURCE_URL, routes: ['GET /status'] }, cors);
    }
    if (url.pathname !== '/status') return json(404, { error: 'Not found.' }, cors);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin, true) });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD, OPTIONS', ...cors });
    }
    if (!(await allowed(env.STATUS_PER_VISITOR, clientIp(request)))) {
      return json(429, { error: 'Slow down a little.' }, { 'Retry-After': '60', ...cors });
    }

    // The check is shared with other visitors, so it must finish even if this one leaves mid-request.
    const pending = statusFor(env);
    ctx?.waitUntil(pending.catch(() => {}));
    const result = await pending;
    return json(200, result, { 'Cache-Control': 'public, max-age=60', ...cors }, request.method);
  },
};
