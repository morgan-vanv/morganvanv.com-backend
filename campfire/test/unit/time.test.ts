import { describe, expect, it } from 'vitest';
import { DAY } from '../../src/config';
import { expiryCutoff, iso, isLive, nextSweep } from '../../src/time';

describe('expiry', () => {
  const now = Date.parse('2026-10-27T05:12:00.000Z');

  it('keeps a week of shouts', () => {
    expect(expiryCutoff(now)).toBe(now - 7 * DAY);
    expect(isLive(now - 7 * DAY, now)).toBe(true);
    expect(isLive(now - 7 * DAY - 1, now)).toBe(false);
    expect(isLive(now, now)).toBe(true);
  });

  it('sweeps daily', () => {
    expect(nextSweep(now)).toBe(now + DAY);
  });

  it('formats times as ISO strings', () => {
    expect(iso(now)).toBe('2026-10-27T05:12:00.000Z');
  });
});
