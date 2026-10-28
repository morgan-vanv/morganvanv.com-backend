import { checkHost } from './auth';
import { Campfire, type Env } from './campfire';
import { INSTANCE_NAME, NAME, SOURCE_URL, VERSION } from './config';
import { preflightHeaders } from './cors';
import { sendPing, webhookUrl } from './discord';
import { HttpError, declaredTooLarge, empty, failure, json, readJson } from './http';
import { retryAfterSeconds } from './limits';
import { decoyShout, isHoneypot, parseClientId, parseShoutId, validateShout } from './validate';

export { Campfire };

type Handler = (request: Request, env: Env, url: URL, origin: string | null, ctx: ExecutionContext) => Promise<Response>;

/** The one campfire everyone sits around. */
const campfire = (env: Env) => env.CAMPFIRE.getByName(INSTANCE_NAME);

/** The visitor's IP, set by Cloudflare. Only ever hashed, in memory, inside the Durable Object. */
const clientIp = (request: Request): string | null => request.headers.get('CF-Connecting-IP');

const info: Handler = async (_request, _env, _url, origin) =>
  json({ name: NAME, version: VERSION, source: SOURCE_URL, endpoints: ['GET|POST /visit', 'GET|POST /shouts', 'DELETE /shouts?within=<minutes>', 'DELETE /shouts/:id', 'GET|PUT /fire', 'GET /host'] }, 200, origin);

const getVisits: Handler = async (_request, env, _url, origin) =>
  json({ count: await campfire(env).visit(false) }, 200, origin);

/** Counts a visit, at most once per IP per half hour; either way, answers with the count. */
const addVisit: Handler = async (request, env, _url, origin) =>
  json({ count: await campfire(env).visit(true, clientIp(request)) }, 200, origin);

const getShouts: Handler = async (request, env, url, origin) =>
  json(await campfire(env).shouts(parseClientId(url.searchParams.get('client')), clientIp(request)), 200, origin);

const addShout: Handler = async (request, env, _url, origin, ctx) => {
  const who = await checkHost(request.headers.get('Authorization'), env.CAMPFIRE_HOST_KEY);
  if (who === 'wrong-key' || who === 'host-off') return failure(401, 'That host key doesn\'t work here.', origin);

  const body = await readJson(request);
  // Bots fill in the hidden field. Tell them it worked and keep nothing.
  if (isHoneypot(body)) {
    const id = await campfire(env).nextId();
    return json({ shout: { id, ...decoyShout(body), at: new Date().toISOString(), host: false } }, 201, origin);
  }

  const checked = validateShout(body, who === 'host');
  if (!checked.ok) return failure(400, checked.error, origin);

  const result = await campfire(env).add(checked.value, clientIp(request));
  if (!result.ok && 'closed' in result) return failure(423, 'The fire\'s banked for now. Try again later.', origin);
  if (!result.ok) {
    const seconds = retryAfterSeconds(result.retryAfterMs);
    return failure(429, `Easy there. Try again in ${seconds} s.`, origin, { 'Retry-After': String(seconds) });
  }
  // Ping Morgan's Discord after answering, so a slow or failing webhook never touches the shout.
  const webhook = webhookUrl(env.DISCORD_WEBHOOK_URL);
  if (webhook && result.ping) ctx.waitUntil(sendPing(webhook, result.shout));
  return json({ shout: result.shout }, 201, origin);
};

/** Whether the fire is open: `{ "open": true }`. Anyone may ask (GET /shouts says it too). */
const getFire: Handler = async (_request, env, _url, origin) => json({ open: await campfire(env).isOpen() }, 200, origin);

/**
 * The host banks the fire (`{ "open": false }`: guests can still read, but not shout) or opens it again
 * (`{ "open": true }`). Nothing is deleted either way. Answers with the new state.
 */
const setFire: Handler = async (request, env, _url, origin) => {
  const who = await checkHost(request.headers.get('Authorization'), env.CAMPFIRE_HOST_KEY);
  if (who === 'host-off') return failure(404, 'Nothing here.', origin);
  if (who !== 'host') return failure(401, 'Only the host can do that.', origin);
  const body = await readJson(request);
  const open = (body as { open?: unknown } | null)?.open;
  if (typeof open !== 'boolean') return failure(400, 'Send { "open": true } or { "open": false }.', origin);
  return json({ open: await campfire(env).setOpen(open) }, 200, origin);
};

/** The longest stretch one clear-up reaches back: a day. */
const MAX_CLEAR_MINUTES = 24 * 60;

/**
 * Host only: takes down every guest shout from the last `?within=<minutes>` (1 to 1440), for cleaning up
 * after a flood in one go. The host's own lines stay. Answers `{ "removed": n }`.
 */
const clearShouts: Handler = async (request, env, url, origin) => {
  const who = await checkHost(request.headers.get('Authorization'), env.CAMPFIRE_HOST_KEY);
  if (who === 'host-off') return failure(404, 'Nothing here.', origin);
  if (who !== 'host') return failure(401, 'Only the host can do that.', origin);
  const raw = url.searchParams.get('within') ?? '';
  const minutes = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!(minutes >= 1 && minutes <= MAX_CLEAR_MINUTES)) {
    return failure(400, `Say how far back to clear: ?within=<minutes>, 1 to ${MAX_CLEAR_MINUTES}.`, origin);
  }
  return json({ removed: await campfire(env).clearGuests(minutes * 60_000) }, 200, origin);
};

const removeShout = (rawId: string): Handler => async (request, env, _url, origin) => {
  const who = await checkHost(request.headers.get('Authorization'), env.CAMPFIRE_HOST_KEY);
  if (who === 'host-off') return failure(404, 'Nothing here.', origin);
  if (who !== 'host') return failure(401, 'Only the host can do that.', origin);
  const id = parseShoutId(rawId);
  if (id === null) return failure(400, 'That isn\'t a shout id.', origin);
  return (await campfire(env).remove(id)) ? empty(204, origin) : failure(404, 'No such shout.', origin);
};

/**
 * Is this the host key? 204 if so, 401 if not, 404 with host features off. The site checks a key here
 * before keeping it, so a link carrying a wrong key can't overwrite the real one in Morgan's browser.
 */
const checkHostKey: Handler = async (request, env, _url, origin) => {
  const who = await checkHost(request.headers.get('Authorization'), env.CAMPFIRE_HOST_KEY);
  if (who === 'host-off') return failure(404, 'Nothing here.', origin);
  return who === 'host' ? empty(204, origin) : failure(401, 'That host key doesn\'t work here.', origin);
};

type Route = Handler | { readonly wrongMethod: string } | null;

/** The routes: path, then method. A known path with the wrong method says which methods it takes. */
function route(method: string, path: string): Route {
  const table: Record<string, Partial<Record<string, Handler>>> = {
    '/': { GET: info },
    '/visit': { GET: getVisits, POST: addVisit },
    '/shouts': { GET: getShouts, POST: addShout, DELETE: clearShouts },
    '/fire': { GET: getFire, PUT: setFire },
    '/host': { GET: checkHostKey },
  };
  const byMethod = table[path] ?? (/^\/shouts\/[^/]+$/.test(path) ? { DELETE: removeShout(path.slice('/shouts/'.length)) } : null);
  if (!byMethod) return null;
  // HEAD is answered like GET (the runtime drops the body).
  const methods = Object.keys(byMethod);
  return byMethod[method === 'HEAD' ? 'GET' : method] ?? { wrongMethod: [...methods, ...(methods.includes('GET') ? ['HEAD'] : []), 'OPTIONS'].join(', ') };
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: preflightHeaders(origin) });

    const handler = route(request.method, path);
    if (handler === null) return failure(404, 'Nothing here.', origin);
    if ('wrongMethod' in handler) return failure(405, 'Not like that.', origin, { Allow: handler.wrongMethod });
    // No route wants a big body; POST /shouts also counts what actually arrives (readJson).
    if (declaredTooLarge(request)) return failure(413, 'That\'s too long for the campfire.', origin);

    try {
      return await handler(request, env, url, origin, ctx);
    } catch (error) {
      if (error instanceof HttpError) return failure(error.status, error.message, origin);
      console.error('campfire error', error instanceof Error ? error.stack ?? error.message : error);
      return failure(500, 'The campfire sputtered. Try again in a bit.', origin);
    }
  },
} satisfies ExportedHandler<Env>;
