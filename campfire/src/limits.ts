/**
 * The in-memory bookkeeping: rate limits per (hashed) IP and who's here now. Nothing in this file is
 * ever written to storage; it lives as long as the Durable Object stays in memory and is gone after a
 * few quiet minutes.
 */
import { HOUR, MAX_TRACKED, PRESENCE_WINDOW_MS, RATE_GAP_MS, RATE_PER_HOUR } from './config';

export type RateDecision = { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number };

/** At most one action per `gapMs` and `perHour` per rolling hour, per key. */
export class RateLimiter {
  private readonly seen = new Map<string, number[]>();

  constructor(
    private readonly gapMs = RATE_GAP_MS,
    private readonly perHour = RATE_PER_HOUR,
    private readonly maxTracked = MAX_TRACKED,
  ) {}

  /** Whether `key` may act at `now`; if not, how long until it may. Doesn't record anything. */
  check(key: string, now: number): RateDecision {
    const times = this.recent(key, now);
    const last = times.at(-1);
    if (last !== undefined && now - last < this.gapMs) return { ok: false, retryAfterMs: this.gapMs - (now - last) };
    if (times.length >= this.perHour) return { ok: false, retryAfterMs: times[0]! + HOUR - now };
    return { ok: true };
  }

  /** Notes that `key` acted at `now`. */
  record(key: string, now: number): void {
    const times = this.recent(key, now);
    times.push(now);
    this.seen.delete(key);
    this.seen.set(key, times);
    // Full: forget whoever acted longest ago (Maps keep insertion order, and record re-inserts).
    while (this.seen.size > this.maxTracked) this.seen.delete(this.seen.keys().next().value!);
  }

  /** Drops everything older than an hour. */
  prune(now: number): void {
    for (const key of [...this.seen.keys()]) {
      if (this.recent(key, now).length === 0) this.seen.delete(key);
    }
  }

  get size(): number {
    return this.seen.size;
  }

  private recent(key: string, now: number): number[] {
    const times = (this.seen.get(key) ?? []).filter(t => now - t < HOUR);
    if (times.length) this.seen.set(key, times);
    else this.seen.delete(key);
    return times;
  }
}

/** Random per-tab client ids and when each last polled. Counts the ones seen in the last minute. */
export class Presence {
  private readonly lastSeen = new Map<string, number>();

  constructor(
    private readonly windowMs = PRESENCE_WINDOW_MS,
    private readonly maxTracked = MAX_TRACKED,
  ) {}

  see(client: string, now: number): void {
    this.lastSeen.delete(client);
    this.lastSeen.set(client, now);
    while (this.lastSeen.size > this.maxTracked) this.lastSeen.delete(this.lastSeen.keys().next().value!);
  }

  count(now: number): number {
    this.prune(now);
    return this.lastSeen.size;
  }

  prune(now: number): void {
    // Oldest first (see() re-inserts), so stop at the first one still here.
    for (const [client, at] of this.lastSeen) {
      if (now - at < this.windowMs) break;
      this.lastSeen.delete(client);
    }
  }

  get size(): number {
    return this.lastSeen.size;
  }
}

/**
 * The part of an IP that identifies one visitor: all of an IPv4 address, the /64 network of an IPv6
 * one (a single connection is handed a whole /64, so per-address limits would be trivial to dodge).
 */
export function rateSubject(ip: string): string {
  const address = ip.trim().toLowerCase();
  if (!address.includes(':')) return address;
  const [head = '', tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '') || '0').join(':') + '::/64';
}

/** A one-way, salted hash of the IP's subject, so not even memory holds the address itself. */
export async function hashSubject(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}|${rateSubject(ip)}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Whole seconds for a Retry-After header: never less than 1. */
export const retryAfterSeconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));
