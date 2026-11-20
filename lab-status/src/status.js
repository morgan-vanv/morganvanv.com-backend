// Is each of the homelab's public services up? One plain function per question, no Workers APIs, so it runs
// (and is tested) under node --test with a fake fetch and a fake socket.
//
// A web service is "up" when its public address answers within TIMEOUT_MS with a 2xx or 3xx (redirects are
// not followed: Foundry's gate sends visitors to sign in), and, when a keyword is given, the body is exactly
// that word (Jellyfin's /health says "Healthy", or "Degraded" or "Unhealthy" otherwise). Anything else, a
// timeout or a network error included, is "down".
//
// The Minecraft server is asked the way the game's own server list asks (the Server List Ping: a handshake,
// a status request, one JSON answer back), over a TCP socket the caller hands in. It's "up" when that answer
// arrives and parses within TIMEOUT_MS, and then the one number kept from it is how many players are on.
// The answer also carries a sample of player names, the MOTD and the icon: all of it is dropped here.
//
// Only names, up/down and that one count leave this Worker: never an address, a status code, an error
// message or a player's name.

/** How long one check may take before it counts as down. */
const TIMEOUT_MS = 5000;

/** The protocol version a status ping sends; -1 is the convention for "just asking, any version". */
const PING_PROTOCOL = -1;

/** The most a status answer may be (the server's icon rides in it as base64, so it isn't tiny). */
const MAX_STATUS_BYTES = 256 * 1024;

/** How long a result is reused before anyone checks again (per Worker isolate). */
const FRESH_MS = 2 * 60 * 1000;

/**
 * The services the Lab page shows, by the key the site reads. URLs come from the Worker's vars
 * (wrangler.jsonc), so a change of address is a config change, not a code change.
 * @param {Record<string, string | undefined>} env
 * @returns {({ key: string, url: string, keyword?: string } | { key: string, hostname: string, port: number })[]}
 */
function targetsFrom(env) {
  const targets = [];
  if (env.VTT_URL) targets.push({ key: 'vtt', url: env.VTT_URL });
  if (env.JELLYFIN_HEALTH_URL) targets.push({ key: 'jellyfin', url: env.JELLYFIN_HEALTH_URL, keyword: 'Healthy' });
  if (env.DESK_HEALTH_URL) targets.push({ key: 'desk', url: env.DESK_HEALTH_URL });
  const server = parseAddress(env.MINECRAFT_ADDRESS);
  if (server) targets.push({ key: 'minecraft', ...server });
  return targets;
}

/**
 * "host" or "host:port" (the game's default port when there's none); null for anything else.
 * @param {string | undefined} address
 * @returns {{ hostname: string, port: number } | null}
 */
function parseAddress(address) {
  const match = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec((address ?? '').trim());
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : 25565;
  return port >= 1 && port <= 65535 ? { hostname: match[1].toLowerCase(), port } : null;
}

/** A VarInt, the protocol's variable-length int: 7 bits a byte, low bits first; negatives take five bytes. */
function varInt(value) {
  let n = value >>> 0;
  const bytes = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0);
  return bytes;
}

/** One packet: its length, then its id and payload. */
function packet(id, payload) {
  const body = [...varInt(id), ...payload];
  return Uint8Array.from([...varInt(body.length), ...body]);
}

/** The handshake (next state 1, status) and the status request, sent together. */
function pingRequest(hostname, port) {
  const host = new TextEncoder().encode(hostname);
  const handshake = packet(0x00, [...varInt(PING_PROTOCOL), ...varInt(host.length), ...host, (port >> 8) & 0xff, port & 0xff, ...varInt(1)]);
  const status = packet(0x00, []);
  const both = new Uint8Array(handshake.length + status.length);
  both.set(handshake);
  both.set(status, handshake.length);
  return both;
}

/** Reads a VarInt at `offset`: its value and where it ends, or null if the bytes run out first. */
function readVarInt(bytes, offset) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= bytes.length) return null;
    const byte = bytes[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value, end: offset + i + 1 };
  }
  throw new Error('VarInt too long');
}

/**
 * The status answer's JSON text once a whole packet is in `bytes`, null while more is needed.
 * Throws on anything that isn't a status answer.
 */
function statusJson(bytes) {
  const length = readVarInt(bytes, 0);
  if (!length) return null;
  if (length.value <= 0 || length.value > MAX_STATUS_BYTES) throw new Error('bad length');
  if (bytes.length < length.end + length.value) return null;
  const id = readVarInt(bytes, length.end);
  if (!id || id.value !== 0x00) throw new Error('not a status answer');
  const text = readVarInt(bytes, id.end);
  if (!text || text.end + text.value > length.end + length.value) throw new Error('bad string');
  return new TextDecoder().decode(bytes.subarray(text.end, text.end + text.value));
}

/** How many players the answer says are on: a whole number, or null if it doesn't say. Nothing else is read. */
function playersOnline(json) {
  const online = JSON.parse(json)?.players?.online;
  return Number.isInteger(online) && online >= 0 ? online : null;
}

/**
 * Asks the Minecraft server for its status, as the game's server list does.
 * @param {{ hostname: string, port: number }} target
 * @param {(address: { hostname: string, port: number }) => { readable: ReadableStream, writable: WritableStream, close: () => Promise<void> }} connectFn
 * @returns {Promise<{ status: 'up', online: number } | { status: 'down' }>}
 */
async function checkMinecraft(target, connectFn, timeoutMs = TIMEOUT_MS) {
  let socket = null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  const ping = async () => {
    socket = connectFn({ hostname: target.hostname, port: target.port });
    const writer = socket.writable.getWriter();
    await writer.write(pingRequest(target.hostname, target.port));
    writer.releaseLock();
    const reader = socket.readable.getReader();
    let bytes = new Uint8Array(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('closed early');
      const next = new Uint8Array(bytes.length + value.length);
      next.set(bytes);
      next.set(value, bytes.length);
      bytes = next;
      if (bytes.length > MAX_STATUS_BYTES + 10) throw new Error('too long');
      const json = statusJson(bytes);
      if (json !== null) return json;
    }
  };
  try {
    const online = playersOnline(await Promise.race([ping(), timeout]));
    return online === null ? { status: 'down' } : { status: 'up', online };
  } catch {
    return { status: 'down' };
  } finally {
    clearTimeout(timer);
    try {
      await socket?.close();
    } catch {
      // Already closed, or never opened: nothing to tidy.
    }
  }
}

/**
 * Checks one target.
 * @param {{ url: string, keyword?: string }} target
 * @param {typeof fetch} fetchFn
 * @returns {Promise<'up' | 'down'>}
 */
async function checkOne(target, fetchFn) {
  try {
    const response = await fetchFn(target.url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'morganvanv.com lab-status' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status < 200 || response.status >= 400) {
      await response.body?.cancel();
      return 'down';
    }
    if (!target.keyword) {
      await response.body?.cancel();
      return 'up';
    }
    const text = await response.text();
    return text.trim() === target.keyword ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

/**
 * Checks every target at once. `players` is there only while the server is up and said how many are on.
 * @returns {Promise<{ checkedAt: string, services: Record<string, 'up' | 'down'>, players?: { minecraft: number } }>}
 */
async function checkAll(targets, fetchFn, now = () => Date.now(), connectFn = null) {
  const results = await Promise.all(
    targets.map(target => {
      if (!('hostname' in target)) return checkOne(target, fetchFn);
      return connectFn ? checkMinecraft(target, connectFn) : Promise.resolve({ status: 'down' });
    }),
  );
  const services = {};
  let players;
  targets.forEach((target, i) => {
    const result = results[i];
    if (typeof result === 'string') {
      services[target.key] = result;
      return;
    }
    services[target.key] = result.status;
    if (result.status === 'up') players = { [target.key]: result.online };
  });
  return { checkedAt: new Date(now()).toISOString(), services, ...(players ? { players } : {}) };
}

/**
 * Wraps checkAll so a result is reused for FRESH_MS and concurrent callers share one check: however many
 * visitors have the site open, each isolate knocks on Morgan's services at most once every two minutes.
 */
function memoized(check, now = () => Date.now(), freshMs = FRESH_MS) {
  let last = null;
  let lastAt = 0;
  let inFlight = null;
  return () => {
    if (last && now() - lastAt < freshMs) return Promise.resolve(last);
    if (!inFlight) {
      inFlight = check().then(
        result => {
          last = result;
          lastAt = now();
          inFlight = null;
          return result;
        },
        error => {
          inFlight = null;
          throw error;
        },
      );
    }
    return inFlight;
  };
}

module.exports = {
  TIMEOUT_MS,
  FRESH_MS,
  targetsFrom,
  parseAddress,
  pingRequest,
  statusJson,
  checkOne,
  checkMinecraft,
  checkAll,
  memoized,
};
