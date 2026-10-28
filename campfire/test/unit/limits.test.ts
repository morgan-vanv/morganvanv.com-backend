import { describe, expect, it } from 'vitest';
import { HOUR, MINUTE, SECOND } from '../../src/config';
import {
  Cooldown, GlobalLimiter, Presence, RateLimiter, hashSubject, rateSubject, retryAfterSeconds, unwrapMappedIPv4,
} from '../../src/limits';

describe('RateLimiter', () => {
  it('allows one action per 10 s', () => {
    const limiter = new RateLimiter();
    expect(limiter.check('a', 0)).toEqual({ ok: true });
    limiter.record('a', 0);
    expect(limiter.check('a', 4 * SECOND)).toEqual({ ok: false, retryAfterMs: 6 * SECOND });
    expect(limiter.check('b', 4 * SECOND)).toEqual({ ok: true });
    expect(limiter.check('a', 10 * SECOND)).toEqual({ ok: true });
  });

  it('allows 20 an hour, then says when the oldest ages out', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 20; i++) limiter.record('a', i * 60 * SECOND);
    const now = 20 * 60 * SECOND;
    expect(limiter.check('a', now)).toEqual({ ok: false, retryAfterMs: HOUR - now });
    expect(limiter.check('a', HOUR)).toEqual({ ok: true });
  });

  it('forgets what is over an hour old', () => {
    const limiter = new RateLimiter();
    limiter.record('a', 0);
    limiter.prune(HOUR);
    expect(limiter.size).toBe(0);
  });

  it('never tracks more than its cap, dropping the stalest', () => {
    const limiter = new RateLimiter(10 * SECOND, 20, 2);
    limiter.record('a', 0);
    limiter.record('b', 1);
    limiter.record('c', 2);
    expect(limiter.size).toBe(2);
    expect(limiter.check('a', 3)).toEqual({ ok: true });
    expect(limiter.check('c', 3).ok).toBe(false);
  });
});

describe('GlobalLimiter', () => {
  it('allows 30 in 10 minutes from everyone together, then says when one ages out', () => {
    const limiter = new GlobalLimiter();
    for (let i = 0; i < 30; i++) {
      expect(limiter.check(i * SECOND).ok).toBe(true);
      limiter.record(i * SECOND);
    }
    expect(limiter.check(30 * SECOND)).toEqual({ ok: false, retryAfterMs: 10 * MINUTE - 30 * SECOND });
    expect(limiter.check(10 * MINUTE).ok).toBe(true);
    expect(limiter.size).toBe(29);
  });

  it('holds no more than its limit of timestamps', () => {
    const limiter = new GlobalLimiter(3, MINUTE);
    for (let i = 0; i < 10; i++) limiter.record(i);
    expect(limiter.size).toBe(3);
    limiter.prune(MINUTE + 10);
    expect(limiter.size).toBe(0);
  });
});

describe('Cooldown', () => {
  it('lets a key through once per 30 minutes', () => {
    const cooldown = new Cooldown();
    expect(cooldown.hit('a', 0)).toBe(true);
    expect(cooldown.hit('a', 29 * MINUTE)).toBe(false);
    expect(cooldown.hit('b', 29 * MINUTE)).toBe(true);
    expect(cooldown.hit('a', 30 * MINUTE)).toBe(true);
  });

  it('forgets keys whose cooldown is over, and never tracks more than its cap', () => {
    const cooldown = new Cooldown(MINUTE, 2);
    cooldown.hit('a', 0);
    cooldown.hit('b', 1);
    cooldown.hit('c', 2);
    expect(cooldown.size).toBe(2);
    cooldown.prune(MINUTE + 1);
    expect(cooldown.size).toBe(1);
  });
});

describe('Presence', () => {
  it('counts clients seen in the last minute', () => {
    const presence = new Presence();
    presence.see('a', 0);
    presence.see('b', 30 * SECOND);
    expect(presence.count(30 * SECOND)).toBe(2);
    expect(presence.count(60 * SECOND)).toBe(1);
    presence.see('a', 70 * SECOND);
    expect(presence.count(80 * SECOND)).toBe(2);
    expect(presence.count(200 * SECOND)).toBe(0);
    expect(presence.size).toBe(0);
  });

  it('counts a client once however often it polls', () => {
    const presence = new Presence();
    for (let t = 0; t < 60; t += 20) presence.see('a', t * SECOND);
    expect(presence.count(60 * SECOND)).toBe(1);
  });

  it('never tracks more than its cap', () => {
    const presence = new Presence(60 * SECOND, 3);
    for (const id of ['a', 'b', 'c', 'd']) presence.see(id, 0);
    expect(presence.count(0)).toBe(3);
  });
});

describe('unwrapMappedIPv4', () => {
  it('turns IPv4-mapped IPv6 back into IPv4', () => {
    expect(unwrapMappedIPv4('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(unwrapMappedIPv4('::FFFF:192.0.2.1')).toBe('192.0.2.1');
    expect(unwrapMappedIPv4('0:0:0:0:0:ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(unwrapMappedIPv4('::ffff:c000:201')).toBe('192.0.2.1');
  });

  it('leaves everything else alone', () => {
    expect(unwrapMappedIPv4('2001:db8::ffff:1:2')).toBe('2001:db8::ffff:1:2');
    expect(unwrapMappedIPv4('::1')).toBe('::1');
    expect(unwrapMappedIPv4('203.0.113.7')).toBe('203.0.113.7');
  });
});

describe('rateSubject', () => {
  it('keeps a whole IPv4 address, mapped or not', () => {
    expect(rateSubject('203.0.113.7')).toBe('203.0.113.7');
    expect(rateSubject('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('keeps only the /64 of an IPv6 address, however it is written', () => {
    expect(rateSubject('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(rateSubject('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(rateSubject('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateSubject('::1')).toBe('0:0:0:0::/64');
  });
});

describe('hashSubject', () => {
  it('hashes, salted, and treats a /64 as one visitor', async () => {
    const a = await hashSubject('2001:db8:1:2::1', 'salt');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await hashSubject('2001:db8:1:2::ffff', 'salt')).toBe(a);
    expect(await hashSubject('2001:db8:1:3::1', 'salt')).not.toBe(a);
    expect(await hashSubject('2001:db8:1:2::1', 'other')).not.toBe(a);
    expect(a).not.toContain('2001');
  });
});

describe('retryAfterSeconds', () => {
  it('rounds up, never below one', () => {
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(6001)).toBe(7);
  });
});
