import { KEEP_NEWEST, SHOUT_TTL_MS, SWEEP_EVERY_MS } from './config';

/** Shouts said before this moment have burned down. */
export const expiryCutoff = (now: number, ttlMs = SHOUT_TTL_MS): number => now - ttlMs;

/** Whether a shout said at `at` is still warm at `now`. */
export const isLive = (at: number, now: number, ttlMs = SHOUT_TTL_MS): boolean => at >= expiryCutoff(now, ttlMs);

/** When the next sweep should run. */
export const nextSweep = (now: number, everyMs = SWEEP_EVERY_MS): number => now + everyMs;

/** Milliseconds to the ISO string the API returns. */
export const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The shouts still burning, from a list ordered newest first: the newest `keep` whatever their age,
 * then any others said within the TTL.
 */
export function burning<T extends { readonly at: number }>(newestFirst: readonly T[], now: number, keep = KEEP_NEWEST, ttlMs = SHOUT_TTL_MS): T[] {
  return newestFirst.filter((row, i) => i < keep || isLive(row.at, now, ttlMs));
}
