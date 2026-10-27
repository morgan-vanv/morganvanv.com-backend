import { describe, expect, it } from 'vitest';
import { DAY } from '../../src/config';
import { burning, expiryCutoff, iso, isLive, nextSweep } from '../../src/time';

describe('expiry', () => {
  const now = Date.parse('2026-10-27T05:12:00.000Z');

  it('keeps a month of shouts', () => {
    expect(expiryCutoff(now)).toBe(now - 30 * DAY);
    expect(isLive(now - 30 * DAY, now)).toBe(true);
    expect(isLive(now - 30 * DAY - 1, now)).toBe(false);
    expect(isLive(now, now)).toBe(true);
  });

  it('keeps the newest 20 however old, and anything newer than a month', () => {
    // Newest first: 5 fresh, then 30 from two months ago.
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: 100 - i, at: now - i * DAY })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: 95 - i, at: now - 60 * DAY })),
    ];
    const kept = burning(rows, now);
    expect(kept).toHaveLength(20);
    expect(kept[0]!.id).toBe(100);
    expect(kept.at(-1)!.id).toBe(81);
    // A quiet stretch never empties the log...
    expect(burning(rows.slice(5), now)).toHaveLength(20);
    // ...and a busy month shows everything it said.
    const busy = Array.from({ length: 40 }, (_, i) => ({ at: now - i * 1000 }));
    expect(burning(busy, now)).toHaveLength(40);
  });

  it('sweeps daily', () => {
    expect(nextSweep(now)).toBe(now + DAY);
  });

  it('formats times as ISO strings', () => {
    expect(iso(now)).toBe('2026-10-27T05:12:00.000Z');
  });
});
