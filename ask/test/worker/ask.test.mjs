import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import packageJson from '../../package.json';
import { VERSION } from '../../src/index.mjs';
import publishLink from '../../src/publish-link.js';

// The whole Worker in workerd. DISCORD_WEBHOOK_URL is "off" here (vitest.config.mjs),
// so nothing ever leaves: these check the routing, CORS, limits and that the Node APIs the links need work.
const SITE = 'https://morganvanv.com';
const worker = exports.default;
const SECRET = 'test-publish-secret-0123456789abcdef-0123';

function call(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set('Origin', init.origin ?? SITE);
  headers.set('CF-Connecting-IP', init.ip ?? '203.0.113.1');
  return worker.fetch(`https://ask.test${path}`, { ...init, headers });
}

const submit = (body, init = {}) =>
  call('/submit', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, ...init });

describe('the ask Worker', () => {
  it('says what it is, and its version matches package.json', async () => {
    const response = await call('/');
    expect(await response.json()).toMatchObject({ name: 'ask', version: VERSION });
    expect(VERSION).toBe(packageJson.version);
    expect((await call('/nope')).status).toBe(404);
  });

  it('has the Node APIs publish links use (nodejs_compat)', () => {
    const mac = createHmac('sha256', 'k').update('x').digest();
    expect(timingSafeEqual(mac, Buffer.from(mac))).toBe(true);
    expect(inflateRawSync(deflateRawSync(Buffer.from('hello'))).toString()).toBe('hello');
  });

  it('answers the site\'s preflight, and no one else\'s', async () => {
    const ok = await call('/submit', { method: 'OPTIONS' });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    expect(ok.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    const other = await call('/submit', { method: 'OPTIONS', origin: 'https://evil.example' });
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('takes only a JSON POST at /submit', async () => {
    const get = await call('/submit?question=hi');
    expect(get.status).toBe(405);
    expect(get.headers.get('Allow')).toBe('POST, OPTIONS');
    expect((await submit('not json', { ip: '203.0.113.2' })).status).toBe(400);
    expect((await submit('[1]', { ip: '203.0.113.2' })).status).toBe(400);
    expect((await submit({ question: 'x'.repeat(20_000) }, { ip: '203.0.113.2' })).status).toBe(413);
  });

  it('checks the submission, then (with no webhook set) says the mailbox is closed', async () => {
    const bad = await submit({ question: '' }, { ip: '203.0.113.3' });
    expect(bad.status).toBe(400);
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    const honeypot = await submit({ question: 'hi', username_honey: 'bot' }, { ip: '203.0.113.3' });
    expect(await honeypot.json()).toMatchObject({ success: true });
    expect((await submit({ question: 'hi' }, { ip: '203.0.113.3' })).status).toBe(503);
  });

  it('can\'t be told it\'s a GET by a field called http', async () => {
    const response = await submit({ question: 'hi', http: { method: 'GET' } }, { ip: '203.0.113.4' });
    expect(response.status).toBe(503); // got as far as Discord: still a POST
  });

  it('slows down one visitor who sends a lot', async () => {
    const statuses = [];
    for (let i = 0; i < 8; i++) statuses.push((await submit({ question: '' }, { ip: '198.51.100.9' })).status);
    expect(statuses).toContain(429);
    // Someone else isn't affected.
    expect((await submit({ question: '' }, { ip: '198.51.100.10' })).status).toBe(400);
  });

  it('serves the publish pages: no link, a forged link, and a real one (on to GitHub\'s editor)', async () => {
    const empty = await call('/publish', { origin: null });
    expect(empty.status).toBe(400);
    expect(empty.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(await empty.text()).toContain('No link here');
    expect((await call('/publish', { method: 'HEAD', origin: null })).status).toBe(400);
    expect((await call('/publish?p=abc&s=def', { origin: null })).status).toBe(403);

    const item = publishLink.makeItem({ kind: 'subtitle', question: '✨ …', subtitle: 'a certified night owl', credit: 'sam' }, new Date(), () => 'abcdef12');
    const link = new URL(publishLink.publishLink(item, 'https://ask.test/publish', SECRET));
    const page = await call(`/publish${link.search}`, { origin: null, redirect: 'manual' });
    // The signature checks out in workerd, so it's off to the editor.
    expect(page.status).toBe(303);
    const editor = new URL(page.headers.get('Location'));
    expect(editor.origin + editor.pathname).toBe('https://github.com/morgan-vanv/morganvanv.com/new/master');
    expect(editor.searchParams.get('filename')).toBe(publishLink.filePath(item));
    expect(editor.searchParams.get('value')).toBe(publishLink.fileContent(item));
    expect((await call(`/publish${link.search}`, { method: 'POST', origin: null })).status).toBe(405);
  });
});
