import { describe, expect, it } from 'vitest';
import { bearerToken, checkHost, constantTimeEqual } from '../../src/auth';

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
    expect(await checkHost('Bearer s3cret', 's3cret')).toBe('host');
    expect(await checkHost(null, 's3cret')).toBe('guest');
    expect(await checkHost('Bearer nope', 's3cret')).toBe('wrong-key');
  });

  it('turns host features off without a secret', async () => {
    expect(await checkHost('Bearer anything', undefined)).toBe('host-off');
    expect(await checkHost('Bearer anything', '')).toBe('host-off');
    expect(await checkHost(null, undefined)).toBe('guest');
  });
});
