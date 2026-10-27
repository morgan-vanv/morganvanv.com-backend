import { checkHost } from './auth';
import { Campfire, type Env } from './campfire';
import { INSTANCE_NAME, NAME, SOURCE_URL, VERSION } from './config';
import { preflightHeaders } from './cors';
import { HttpError, declaredTooLarge, empty, failure, json, readJson } from './http';
import { retryAfterSeconds } from './limits';
import { isHoneypot, parseClientId, parseShoutId, validateShout } from './validate';

export { Campfire };

type Handler = (request: Request, env: Env, url: URL, origin: string | null) => Promise<Response>;

/** The one campfire everyone sits around. */
const campfire = (env: Env) => env.CAMPFIRE.getByName(INSTANCE_NAME);

const info: Handler = async (_request, _env, _url, origin) =>
  json({ name: NAME, version: VERSION, source: SOURCE_URL, endpoints: ['GET|POST /visit', 'GET|POST /shouts', 'DELETE /shouts/:id', 'GET /host'] }, 200, origin);

const getVisits: Handler = async (_request, env, _url, origin) =>
  json({ count: await campfire(env).visit(false) }, 200, origin);

const addVisit: Handler = async (_request, env, _url, origin) =>
  json({ count: await campfire(env).visit(true) }, 200, origin);

const getShouts: Handler = async (_request, env, url, origin) =>
  json(await campfire(env).shouts(parseClientId(url.searchParams.get('client'))), 200, origin);

const addShout: Handler = async (request, env, _url, origin) => {
  const who = await checkHost(request.headers.get('Authorization'), env.CAMPFIRE_HOST_KEY);
  if (who === 'wrong-key' || who === 'host-off') return failure(401, 'That host key doesn\'t work here.', origin);

  const body = await readJson(request);
  // Bots fill in the hidden field. Tell them it worked and keep nothing.
  if (isHoneypot(body)) return json({ shout: { id: 0, nick: 'guest', text: '', at: new Date().toISOString(), host: false } }, 201, origin);

  const checked = validateShout(body, who === 'host');
  if (!checked.ok) return failure(400, checked.error, origin);

  const result = await campfire(env).add(checked.value, request.headers.get('CF-Connecting-IP'));
  if (!result.ok) {
    const seconds = retryAfterSeconds(result.retryAfterMs);
    return failure(429, `Easy there. Try again in ${seconds} s.`, origin, { 'Retry-After': String(seconds) });
  }
  return json({ shout: result.shout }, 201, origin);
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

/** The routes: path, then method. */
function route(method: string, path: string): Handler | 'wrong-method' | null {
  const table: Record<string, Partial<Record<string, Handler>>> = {
    '/': { GET: info },
    '/visit': { GET: getVisits, POST: addVisit },
    '/shouts': { GET: getShouts, POST: addShout },
    '/host': { GET: checkHostKey },
  };
  const byMethod = table[path] ?? (/^\/shouts\/[^/]+$/.test(path) ? { DELETE: removeShout(path.slice('/shouts/'.length)) } : null);
  if (!byMethod) return null;
  // HEAD is answered like GET (the runtime drops the body).
  return byMethod[method === 'HEAD' ? 'GET' : method] ?? 'wrong-method';
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: preflightHeaders(origin) });

    const handler = route(request.method, path);
    if (handler === null) return failure(404, 'Nothing here.', origin);
    if (handler === 'wrong-method') return failure(405, 'Not like that.', origin);
    // No route wants a big body; POST /shouts also counts what actually arrives (readJson).
    if (declaredTooLarge(request)) return failure(413, 'That\'s too long for the campfire.', origin);

    try {
      return await handler(request, env, url, origin);
    } catch (error) {
      if (error instanceof HttpError) return failure(error.status, error.message, origin);
      console.error('campfire error', error instanceof Error ? error.stack ?? error.message : error);
      return failure(500, 'The campfire sputtered. Try again in a bit.', origin);
    }
  },
} satisfies ExportedHandler<Env>;
