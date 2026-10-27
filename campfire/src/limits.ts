/**
 * The in-memory bookkeeping: rate limits per (hashed) IP and who's here now. Nothing in this file is
 * ever written to storage; it lives as long as the Durable Object stays in memory and is gone after a
 * few quiet minutes.
 */
import {
  GLOBAL_SHOUTS, GLOBAL_WINDOW_MS, HOUR, MAX_TRACKED, PRESENCE_WINDOW_MS, RATE_GAP_MS, RATE_PER_HOUR, VISIT_COOLDOWN_MS,
} from './config';

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

/**
 * One limit for everyone: at most `limit` actions per rolling `windowMs`, whoever they come from. Holds
 * only timestamps (at most `limit` of them).
 */
export class GlobalLimiter {
  private times: number[] = [];

  constructor(
    private readonly limit = GLOBAL_SHOUTS,
    private readonly windowMs = GLOBAL_WINDOW_MS,
  ) {}

  check(now: number): RateDecision {
    this.prune(now);
    if (this.times.length < this.limit) return { ok: true };
    return { ok: false, retryAfterMs: this.times[0]! + this.windowMs - now };
  }

  record(now: number): void {
    this.prune(now);
    this.times.push(now);
    if (this.times.length > this.limit) this.times.splice(0, this.times.length - this.limit);
  }

  prune(now: number): void {
    const first = this.times.findIndex(t => now - t < this.windowMs);
    this.times = first === -1 ? [] : this.times.slice(first);
  }

  get size(): number {
    return this.times.length;
  }
}

/** At most one hit per `windowMs` per key: the odometer counts an IP once per half hour. */
export class Cooldown {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly windowMs = VISIT_COOLDOWN_MS,
    private readonly maxTracked = MAX_TRACKED,
  ) {}

  /** True (and remembered) if `key` hasn't hit in the window; false if it has. */
  hit(key: string, now: number): boolean {
    const at = this.last.get(key);
    if (at !== undefined && now - at < this.windowMs) return false;
    this.last.delete(key);
    this.last.set(key, now);
    while (this.last.size > this.maxTracked) this.last.delete(this.last.keys().next().value!);
    return true;
  }

  prune(now: number): void {
    // Oldest first (hit() re-inserts), so stop at the first one still cooling down.
    for (const [key, at] of this.last) {
      if (now - at < this.windowMs) break;
      this.last.delete(key);
    }
  }

  get size(): number {
    return this.last.size;
  }
}

/** Who has polled lately (by hashed IP) and when. Counts the ones seen in the last minute. */
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
  const address = unwrapMappedIPv4(ip.trim().toLowerCase());
  if (!address.includes(':')) return address;
  const [head = '', tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '') || '0').join(':') + '::/64';
}

/** `::ffff:192.0.2.1` (or `::ffff:c000:201`) is really an IPv4 address; anything else is returned as is. */
export function unwrapMappedIPv4(address: string): string {
  const mapped = /^(?:(?:0{1,4}:){5}|::(?:0{1,4}:)?)ffff:(.+)$/i.exec(address);
  if (!mapped) return address;
  const rest = mapped[1]!;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(rest)) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!hex) return address;
  const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/** A one-way, salted hash of the IP's subject, so not even memory holds the address itself. */
export async function hashSubject(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}|${rateSubject(ip)}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Whole seconds for a Retry-After header: never less than 1. */
export const retryAfterSeconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));
