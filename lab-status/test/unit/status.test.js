const { test } = require('node:test');
const assert = require('node:assert/strict');
const { targetsFrom, checkOne, checkAll, memoized } = require('../../src/status.js');

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
  assert.deepEqual(targetsFrom({ VTT_URL: 'https://a/', JELLYFIN_HEALTH_URL: 'https://b/health' }), [
    { key: 'vtt', url: 'https://a/' },
    { key: 'jellyfin', url: 'https://b/health', keyword: 'Healthy' },
  ]);
  assert.deepEqual(targetsFrom({ VTT_URL: '', JELLYFIN_HEALTH_URL: undefined }), []);
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
