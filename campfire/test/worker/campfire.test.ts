import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Campfire, Shout, ShoutLog } from '../../src/campfire';
import { DAY } from '../../src/config';

// Requests go through the real Worker and its Durable Object in workerd. State is shared within this file,
// so each test uses its own IPs and only compares counts before and after.
const SITE = 'https://morganvanv.com';
const worker = (exports as unknown as { default: Fetcher }).default;

function call(path: string, init: RequestInit & { ip?: string; key?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Origin', SITE);
  if (init.ip) headers.set('CF-Connecting-IP', init.ip);
  if (init.key) headers.set('Authorization', `Bearer ${init.key}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  return worker.fetch(`https://campfire.test${path}`, { ...init, headers });
}

const shout = (body: object, ip: string, key?: string) => call('/shouts', { method: 'POST', body: JSON.stringify(body), ip, key });
const log = async (client?: string) => (await (await call(`/shouts${client ? `?client=${client}` : ''}`)).json()) as ShoutLog;
const stub = () => env.CAMPFIRE.getByName('campfire');

describe('the campfire Worker', () => {
  it('says what it is', async () => {
    const response = await call('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'campfire', version: expect.any(String) });
  });

  it('counts visits, and only when asked to', async () => {
    const before = ((await (await call('/visit')).json()) as { count: number }).count;
    expect(await (await call('/visit', { method: 'POST' })).json()).toEqual({ count: before + 1 });
    expect(await (await call('/visit')).json()).toEqual({ count: before + 1 });
  });

  it('answers preflights for the site and nobody else', async () => {
    const ok = await worker.fetch('https://campfire.test/shouts', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:4200', 'Access-Control-Request-Method': 'POST' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4200');
    expect(ok.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');

    const evil = await worker.fetch('https://campfire.test/visit', { headers: { Origin: 'https://evil.example' } });
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('takes a shout and shows it, cleaned up', async () => {
    const response = await shout({ nick: ' owl ', text: ' hello \n fire ', website: '' }, '198.51.100.1');
    expect(response.status).toBe(201);
    const { shout: said } = (await response.json()) as { shout: Shout };
    expect(said).toMatchObject({ nick: 'owl', text: 'hello fire', host: false });
    expect(Date.parse(said.at)).not.toBeNaN();
    expect((await log()).shouts.at(-1)).toEqual(said);
  });

  it('pretends to take a honeypot shout and keeps nothing', async () => {
    const before = (await log()).shouts.length;
    const response = await shout({ nick: 'bot', text: 'spam', website: 'http://spam.example' }, '198.51.100.2');
    expect(response.status).toBe(201);
    expect((await log()).shouts.length).toBe(before);
  });

  it('rate limits per IP: once per 10 s', async () => {
    expect((await shout({ nick: 'a', text: 'one' }, '198.51.100.3')).status).toBe(201);
    const second = await shout({ nick: 'a', text: 'two' }, '198.51.100.3');
    expect(second.status).toBe(429);
    expect(Number(second.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await second.json()).toEqual({ error: expect.any(String) });
    expect((await shout({ nick: 'b', text: 'other ip' }, '198.51.100.4')).status).toBe(201);
  });

  it('turns away bad shouts with a reason', async () => {
    const ip = '198.51.100.5';
    expect((await shout({ nick: 'bad nick!', text: 'x' }, ip)).status).toBe(400);
    expect((await shout({ nick: 'morgan', text: 'x' }, ip)).status).toBe(400);
    expect((await shout({ nick: 'a', text: 'x'.repeat(201) }, ip)).status).toBe(400);
    const big = await call('/shouts', { method: 'POST', body: JSON.stringify({ nick: 'a', text: 'x'.repeat(3000) }), ip });
    expect(big.status).toBe(413);
    const notJson = await worker.fetch('https://campfire.test/shouts', { method: 'POST', body: 'hi', headers: { 'Content-Type': 'text/plain' } });
    expect(notJson.status).toBe(415);
  });

  it('lets the host post as morgan and take shouts down', async () => {
    const posted = await shout({ text: 'welcome' }, '198.51.100.6', 'test-host-key');
    expect(posted.status).toBe(201);
    const { shout: said } = (await posted.json()) as { shout: Shout };
    expect(said).toMatchObject({ nick: 'morgan', host: true });

    expect((await call(`/shouts/${said.id}`, { method: 'DELETE' })).status).toBe(401);
    expect((await call(`/shouts/${said.id}`, { method: 'DELETE', key: 'wrong' })).status).toBe(401);
    expect((await call(`/shouts/${said.id}`, { method: 'DELETE', key: 'test-host-key' })).status).toBe(204);
    expect((await call(`/shouts/${said.id}`, { method: 'DELETE', key: 'test-host-key' })).status).toBe(404);
    expect((await log()).shouts.some(s => s.id === said.id)).toBe(false);
  });

  it('refuses a wrong host key outright', async () => {
    expect((await shout({ nick: 'a', text: 'hi' }, '198.51.100.7', 'nope')).status).toBe(401);
  });

  it('counts who is here by client id, once each', async () => {
    const before = (await log()).here;
    await log('client-aaaa-0001');
    await log('client-aaaa-0001');
    const after = await log('client-bbbb-0002');
    expect(after.here).toBe(before + 2);
    expect((await log('bad id')).here).toBe(before + 2);
  });

  it('lets the fire burn down: the alarm sweeps week-old shouts', async () => {
    await runInDurableObject(stub(), (_instance: Campfire, state) => {
      state.storage.sql.exec('INSERT INTO shouts (nick, text, at, host) VALUES (?, ?, ?, 0)', 'old', 'ashes', Date.now() - 8 * DAY);
    });
    expect((await log()).shouts.some(s => s.text === 'ashes')).toBe(false);

    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const left = await runInDurableObject(stub(), (_instance: Campfire, state) =>
      state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM shouts WHERE text = ?', 'ashes').one().n);
    expect(left).toBe(0);
    // ...and sets itself again for tomorrow.
    const next = await runInDurableObject(stub(), (_instance: Campfire, state) => state.storage.getAlarm());
    expect(next).toBeGreaterThan(Date.now() + DAY - 60_000);
  });

  it('stores nothing about visitors: just the count and the shouts', async () => {
    const tables = await runInDurableObject(stub(), (_instance: Campfire, state) =>
      state.storage.sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'`).toArray().map(r => r.name).sort());
    expect(tables).toEqual(['counters', 'shouts']);
    const columns = await runInDurableObject(stub(), (_instance: Campfire, state) =>
      state.storage.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('shouts')`).toArray().map(r => r.name));
    expect(columns).toEqual(['id', 'nick', 'text', 'at', 'host']);
  });
});
