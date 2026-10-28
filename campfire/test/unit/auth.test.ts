import { describe, expect, it } from 'vitest';
import { MIN_HOST_KEY_LENGTH, bearerToken, checkHost, constantTimeEqual } from '../../src/auth';

const KEY = 's3cret-'.padEnd(MIN_HOST_KEY_LENGTH, 'x');

describe('bearerToken', () => {
  it('reads a bearer token', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('bearer  abc123 ')).toBe('abc123');
  });

  it('ignores anything else', () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
  });
});

describe('constantTimeEqual', () => {
  it('compares strings of any length', async () => {
    expect(await constantTimeEqual('key', 'key')).toBe(true);
    expect(await constantTimeEqual('key', 'kez')).toBe(false);
    expect(await constantTimeEqual('key', 'key-longer')).toBe(false);
    expect(await constantTimeEqual('', '')).toBe(true);
  });
});

describe('checkHost', () => {
  it('tells the host, guests and wrong keys apart', async () => {
    expect(await checkHost(`Bearer ${KEY}`, KEY)).toBe('host');
    expect(await checkHost(null, KEY)).toBe('guest');
    expect(await checkHost('Bearer nope', KEY)).toBe('wrong-key');
  });

  it('turns host features off without a secret', async () => {
    expect(await checkHost('Bearer anything', undefined)).toBe('host-off');
    expect(await checkHost('Bearer anything', '')).toBe('host-off');
    expect(await checkHost(null, undefined)).toBe('guest');
  });

  it('treats a secret too short to be unguessable as no secret', async () => {
    const short = 'x'.repeat(MIN_HOST_KEY_LENGTH - 1);
    expect(await checkHost(`Bearer ${short}`, short)).toBe('host-off');
    expect(await checkHost(`Bearer ${KEY}`, KEY)).toBe('host');
  });
});
