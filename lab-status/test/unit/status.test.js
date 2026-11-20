const { test } = require('node:test');
const assert = require('node:assert/strict');
const { targetsFrom, parseAddress, pingRequest, statusJson, checkOne, checkMinecraft, checkAll, memoized } = require('../../src/status.js');

const VTT = { key: 'vtt', url: 'https://vtt.example/' };
const JELLYFIN = { key: 'jellyfin', url: 'https://tv.example/health', keyword: 'Healthy' };

/** A fake fetch that answers each URL from a table: a Response, or an Error to throw. */
function fakeFetch(table, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const answer = table[url];
    if (answer instanceof Error) throw answer;
    return answer ?? new Response('', { status: 404 });
  };
}

test('targets come from the vars, and a missing var leaves its service out', () => {
  assert.deepEqual(
    targetsFrom({ VTT_URL: 'https://a/', JELLYFIN_HEALTH_URL: 'https://b/health', DESK_HEALTH_URL: 'https://c/-/health/live/', MINECRAFT_ADDRESS: 'mc.example:25565' }),
    [
      { key: 'vtt', url: 'https://a/' },
      { key: 'jellyfin', url: 'https://b/health', keyword: 'Healthy' },
      { key: 'desk', url: 'https://c/-/health/live/' },
      { key: 'minecraft', hostname: 'mc.example', port: 25565 },
    ],
  );
  assert.deepEqual(targetsFrom({ VTT_URL: '', JELLYFIN_HEALTH_URL: undefined, DESK_HEALTH_URL: '', MINECRAFT_ADDRESS: '' }), []);
});

test('a server address is host or host:port, and nothing else', () => {
  assert.deepEqual(parseAddress('MC.Example'), { hostname: 'mc.example', port: 25565 });
  assert.deepEqual(parseAddress(' mc.example:25570 '), { hostname: 'mc.example', port: 25570 });
  for (const bad of ['', 'mc.example:0', 'mc.example:70000', 'https://mc.example', 'mc example', undefined]) {
    assert.equal(parseAddress(bad), null, String(bad));
  }
});

test('a 2xx or 3xx is up; 4xx and 5xx are down', async () => {
  for (const [status, expected] of [[200, 'up'], [302, 'up'], [404, 'down'], [502, 'down'], [503, 'down']]) {
    const fetchFn = fakeFetch({ [VTT.url]: new Response(status === 302 ? null : 'ok', { status, headers: status === 302 ? { Location: '/join' } : {} }) });
    assert.equal(await checkOne(VTT, fetchFn), expected, `status ${status}`);
  }
});

test('redirects are not followed, and every check has a timeout', async () => {
  const calls = [];
  await checkOne(VTT, fakeFetch({ [VTT.url]: new Response('ok') }, calls));
  assert.equal(calls[0].init.redirect, 'manual');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('a keyword must be the whole body', async () => {
  assert.equal(await checkOne(JELLYFIN, fakeFetch({ [JELLYFIN.url]: new Response('Healthy') })), 'up');
  assert.equal(await checkOne(JELLYFIN, fakeFetch({ [JELLYFIN.url]: new Response('Healthy\n') })), 'up');
  assert.equal(await checkOne(JELLYFIN, fakeFetch({ [JELLYFIN.url]: new Response('Unhealthy') })), 'down');
  assert.equal(await checkOne(JELLYFIN, fakeFetch({ [JELLYFIN.url]: new Response('Degraded') })), 'down');
});

test('a network error or a timeout is down, never an exception', async () => {
  assert.equal(await checkOne(VTT, fakeFetch({ [VTT.url]: new TypeError('fetch failed') })), 'down');
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.equal(await checkOne(VTT, fakeFetch({ [VTT.url]: timeout })), 'down');
});

test('checkAll answers with names and up/down only', async () => {
  const fetchFn = fakeFetch({ [VTT.url]: new Response('ok'), [JELLYFIN.url]: new Response('nope', { status: 502 }) });
  const result = await checkAll([VTT, JELLYFIN], fetchFn, () => Date.UTC(2026, 10, 5, 19, 40));
  assert.deepEqual(result, { checkedAt: '2026-11-05T19:40:00.000Z', services: { vtt: 'up', jellyfin: 'down' } });
  assert.ok(!JSON.stringify(result).includes('example'), 'no addresses in the answer');
});

test('memoized reuses a fresh result and shares one check between concurrent callers', async () => {
  let clock = 0;
  let checks = 0;
  const get = memoized(async () => ({ n: ++checks }), () => clock, 1000);
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(checks, 1);
  assert.equal(a, b);
  clock = 999;
  assert.equal((await get()).n, 1);
  clock = 1000;
  assert.equal((await get()).n, 2);
});

test('memoized tries again after a failed check', async () => {
  let fail = true;
  const get = memoized(async () => {
    if (fail) throw new Error('boom');
    return 'ok';
  });
  await assert.rejects(get());
  fail = false;
  assert.equal(await get(), 'ok');
});

// The Minecraft ping. A fake socket stands in for cloudflare:sockets: it records what's written and answers
// with whatever chunks it's given, like the network can (split anywhere).
const SERVER = { key: 'minecraft', hostname: 'mc.example', port: 25565 };

function varInt(n) {
  let v = n >>> 0;
  const out = [];
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

/** A status answer as a server sends it: length, packet id 0, then the JSON as a string. */
function statusAnswer(json) {
  const text = [...new TextEncoder().encode(typeof json === 'string' ? json : JSON.stringify(json))];
  const body = [...varInt(0), ...varInt(text.length), ...text];
  return Uint8Array.from([...varInt(body.length), ...body]);
}

function fakeConnect(chunks, record = {}) {
  return address => {
    record.address = address;
    record.written = [];
    record.closed = false;
    const readable = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (!record.hang) controller.close();
      },
    });
    const writable = new WritableStream({ write(chunk) { record.written.push(...chunk); } });
    return { readable, writable, close: async () => { record.closed = true; } };
  };
}

const REAL_ANSWER = {
  version: { name: 'Velocity 3.4.0', protocol: 772 },
  players: { max: 100, online: 3, sample: [{ name: 'SomePlayer', id: '00000000-0000-0000-0000-000000000000' }] },
  description: { text: 'mc.example' },
  favicon: 'data:image/png;base64,AAAA',
};

test('the ping is a handshake (protocol -1, the host, the port, next state 1) then a status request', () => {
  const bytes = [...pingRequest('mc.example', 25565)];
  const host = [...new TextEncoder().encode('mc.example')];
  const handshakeBody = [0x00, 0xff, 0xff, 0xff, 0xff, 0x0f, host.length, ...host, 0x63, 0xdd, 0x01];
  assert.deepEqual(bytes, [handshakeBody.length, ...handshakeBody, 0x01, 0x00]);
});

test('a status answer is read whole, and only once all of it has arrived', () => {
  const answer = statusAnswer({ players: { online: 2 } });
  assert.equal(statusJson(answer.subarray(0, 3)), null);
  assert.equal(JSON.parse(statusJson(answer)).players.online, 2);
  assert.throws(() => statusJson(Uint8Array.from([2, 0x01, 0x00])), /not a status answer/);
});

test('the server is up with its player count, and nothing else from its answer leaves', async () => {
  const record = {};
  const answer = statusAnswer(REAL_ANSWER);
  const chunks = [answer.subarray(0, 2), answer.subarray(2, 40), answer.subarray(40)];
  const result = await checkMinecraft(SERVER, fakeConnect(chunks, record));
  assert.deepEqual(result, { status: 'up', online: 3 });
  assert.deepEqual(record.address, { hostname: 'mc.example', port: 25565 });
  assert.deepEqual(record.written, [...pingRequest('mc.example', 25565)]);
  assert.equal(record.closed, true, 'the socket is closed after');
});

test('nobody on is still up', async () => {
  assert.deepEqual(await checkMinecraft(SERVER, fakeConnect([statusAnswer({ players: { max: 100, online: 0 } })])), { status: 'up', online: 0 });
});

test('a server that closes early, talks nonsense, hangs or refuses is down', async () => {
  assert.deepEqual(await checkMinecraft(SERVER, fakeConnect([])), { status: 'down' });
  assert.deepEqual(await checkMinecraft(SERVER, fakeConnect([Uint8Array.from([5, 0x07, 1, 2, 3, 4])])), { status: 'down' });
  assert.deepEqual(await checkMinecraft(SERVER, fakeConnect([statusAnswer('not json')])), { status: 'down' });
  assert.deepEqual(await checkMinecraft(SERVER, fakeConnect([statusAnswer({ players: { online: -1 } })])), { status: 'down' });
  assert.deepEqual(await checkMinecraft(SERVER, fakeConnect([statusAnswer({ description: 'no players' })])), { status: 'down' });
  const record = { hang: true };
  assert.deepEqual(await checkMinecraft(SERVER, fakeConnect([], record), 50), { status: 'down' });
  assert.equal(record.closed, true, 'a hung socket is closed too');
  const refused = () => { throw new Error('connection refused'); };
  assert.deepEqual(await checkMinecraft(SERVER, refused), { status: 'down' });
});

test('checkAll adds the player count while the server is up, and no names', async () => {
  const fetchFn = fakeFetch({ [VTT.url]: new Response('ok') });
  const now = () => Date.UTC(2026, 10, 20, 15);
  const up = await checkAll([VTT, SERVER], fetchFn, now, fakeConnect([statusAnswer(REAL_ANSWER)]));
  assert.deepEqual(up, { checkedAt: '2026-11-20T15:00:00.000Z', services: { vtt: 'up', minecraft: 'up' }, players: { minecraft: 3 } });
  assert.ok(!JSON.stringify(up).includes('SomePlayer'), 'no player names');
  assert.ok(!JSON.stringify(up).includes('example'), 'no addresses');
  const down = await checkAll([VTT, SERVER], fetchFn, now, fakeConnect([]));
  assert.deepEqual(down, { checkedAt: '2026-11-20T15:00:00.000Z', services: { vtt: 'up', minecraft: 'down' } });
  const noSockets = await checkAll([SERVER], fetchFn, now);
  assert.deepEqual(noSockets.services, { minecraft: 'down' });
});
