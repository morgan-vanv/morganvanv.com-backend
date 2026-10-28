// Ask Morgan as a Cloudflare Worker. Two routes, each a thin adapter over a handler that knows nothing
// about Workers (so the same code runs under node --test):
//
//   POST /submit           the site's Contact form and "name a star" panel → Morgan's Discord (submit.js)
//   GET|HEAD|POST /publish a signed "Publish as PR" link from that Discord → a PR on the site (publish.js)
//
// The handlers take `args` (the request's fields plus `http: { method }`) and return
// `{ statusCode, headers, body }`, the shape they had as DigitalOcean web actions.
import publishModule from './publish.js';
import submitModule from './submit.js';

const { handle } = publishModule;
const { handleSubmit } = submitModule;

export const NAME = 'ask';
/** Kept in step with package.json (a test checks). */
export const VERSION = '2.0.0';
export const SOURCE_URL = 'https://github.com/morgan-vanv/morganvanv.com-backend/tree/main/ask';

/** Who may call /submit from a browser. Anything else gets no CORS headers (the same list as the campfire's). */
export const ALLOWED_ORIGINS = [
  'https://morganvanv.com',
  'https://www.morganvanv.com',
  'http://localhost:4200',
  'http://localhost:4000',
];

/** Larger request bodies are refused with 413. A submission is at most a few kB; a link under 1 kB. */
export const MAX_BODY_BYTES = 16 * 1024;

function corsHeaders(origin, preflight = false) {
  if (origin === null || !ALLOWED_ORIGINS.includes(origin)) return { Vary: 'Origin' };
  const headers = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  if (!preflight) return headers;
  return {
    ...headers,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function toResponse({ statusCode, headers = {}, body }, extraHeaders = {}, method = 'GET') {
  const all = new Headers({ ...headers, ...extraHeaders });
  let payload = body ?? null;
  if (payload !== null && typeof payload !== 'string') {
    payload = JSON.stringify(payload);
    if (!all.has('Content-Type')) all.set('Content-Type', 'application/json');
  }
  // 204 and 304 can't carry a body, and HEAD never does.
  if (statusCode === 204 || statusCode === 304 || method === 'HEAD') payload = null;
  return new Response(payload, { status: statusCode, headers: all });
}

function jsonError(status, error, extraHeaders = {}) {
  return toResponse({ statusCode: status, headers: { 'Content-Type': 'application/json' }, body: { error } }, extraHeaders);
}

class TooLarge extends Error {}

/** The body as text, refusing anything over MAX_BODY_BYTES (by its header, then by what actually arrives). */
async function readBody(request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new TooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Plain fields only, and never one called `http`: that's where the method goes, and only we set it. */
function fieldsOf(record) {
  const fields = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'http' && key !== '__ow_method' && key !== '__proto__') fields[key] = value;
  }
  return fields;
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

async function submit(request, env) {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin);
  if (request.method === 'OPTIONS') return toResponse({ statusCode: 204 }, corsHeaders(origin, true));
  if (request.method !== 'POST') return jsonError(405, 'Method not allowed.', { Allow: 'POST, OPTIONS', ...cors });

  // One visitor gets a few a minute, and everyone together stays under Discord's webhook limit.
  if (!(await allowed(env.SUBMIT_PER_VISITOR, clientIp(request))) || !(await allowed(env.SUBMIT_ALL, 'all'))) {
    return jsonError(429, 'That\'s a lot of messages. Try again in a minute.', { 'Retry-After': '60', ...cors });
  }

  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    if (error instanceof TooLarge) return jsonError(413, 'That\'s too long.', cors);
    return jsonError(400, 'Send the form as JSON.', cors);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return jsonError(400, 'Send the form as JSON.', cors);

  const result = await handleSubmit({ ...fieldsOf(body), http: { method: 'post' } }, { fetch, env, now: new Date() });
  return toResponse(result, cors);
}

async function publish(request, env, url) {
  const method = request.method;
  if (!(await allowed(env.PUBLISH_PER_VISITOR, clientIp(request)))) {
    return toResponse({ statusCode: 429, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' }, body: 'Too many requests. Try again in a minute.' }, {}, method);
  }
  const fields = fieldsOf(Object.fromEntries(url.searchParams));
  if (method === 'POST') {
    let form;
    try {
      form = new URLSearchParams(await readBody(request));
    } catch (error) {
      if (error instanceof TooLarge) return toResponse({ statusCode: 413, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Too large.' });
      throw error;
    }
    Object.assign(fields, fieldsOf(Object.fromEntries(form)));
  }
  const result = await handle({ ...fields, http: { method: method.toLowerCase() } }, { fetch, env, now: new Date() });
  return toResponse(result, {}, method);
}

function info() {
  return toResponse({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: { name: NAME, version: VERSION, source: SOURCE_URL, endpoints: ['POST /submit', 'GET|HEAD|POST /publish'] },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/':
          return info();
        case '/submit':
          return await submit(request, env);
        case '/publish':
          return await publish(request, env, url);
        default:
          return jsonError(404, 'Nothing here.');
      }
    } catch (error) {
      console.error('ask: unexpected error', error && error.name);
      return jsonError(500, 'Something broke.');
    }
  },
};
