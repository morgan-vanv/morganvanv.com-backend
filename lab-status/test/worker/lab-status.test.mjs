import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';
import { VERSION } from '../../src/index.mjs';

// The whole Worker in workerd. The service URLs are blank here (vitest.config.mjs), so it checks nothing
// and answers with no services: these cover routing, CORS and the shape of the answer.
const SITE = 'https://morganvanv.com';
const worker = exports.default;

function call(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set('Origin', init.origin ?? SITE);
  headers.set('CF-Connecting-IP', init.ip ?? '203.0.113.1');
  return worker.fetch(`https://lab-status.test${path}`, { ...init, headers });
}

describe('the lab-status Worker', () => {
  it('says what it is, and its version matches package.json', async () => {
    const response = await call('/');
    expect(await response.json()).toMatchObject({ name: 'lab-status', version: VERSION });
    expect(VERSION).toBe(packageJson.version);
    expect((await call('/nope')).status).toBe(404);
  });

  it('answers /status with a time and the services it checked', async () => {
    const response = await call('/status');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    const body = await response.json();
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
    expect(body.services).toEqual({});
  });

  it('lets the site read it, and no one else', async () => {
    expect((await call('/status')).headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    expect((await call('/status', { origin: 'http://localhost:4200' })).headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4200');
    expect((await call('/status', { origin: 'https://evil.example' })).headers.get('Access-Control-Allow-Origin')).toBeNull();
    const preflight = await call('/status', { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  it('only reads', async () => {
    const response = await call('/status', { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
    const head = await call('/status', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});
