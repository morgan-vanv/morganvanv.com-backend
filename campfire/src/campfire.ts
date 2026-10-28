import { DurableObject } from 'cloudflare:workers';
import { KEEP_NEWEST, MAX_HERE, MAX_ROWS, PING_LIMIT, PING_WINDOW_MS, SHOUT_PAGE } from './config';
import { Cooldown, GlobalLimiter, Presence, RateLimiter, hashSubject, type RateDecision } from './limits';
import { burning, expiryCutoff, iso, nextSweep } from './time';
import type { CleanShout } from './validate';

export interface Env {
  CAMPFIRE: DurableObjectNamespace<Campfire>;
  /** Morgan's host key. Unset means host features are off. */
  CAMPFIRE_HOST_KEY?: string;
  /** A Discord webhook to ping on every guest shout. Unset means no pings. */
  DISCORD_WEBHOOK_URL?: string;
}

/** A shout as the API returns it. */
export interface Shout {
  readonly id: number;
  readonly nick: string;
  readonly text: string;
  readonly at: string;
  readonly host: boolean;
}

export interface ShoutLog {
  readonly shouts: Shout[];
  readonly here: number;
  /** False while the host has banked the fire: guests can read but not shout. */
  readonly open: boolean;
}

/**
 * A stored shout (and whether it may ping Discord: guests only, within the ping limit), or why not:
 * said too much lately, or the fire is banked.
 */
export type AddResult =
  | { readonly ok: true; readonly shout: Shout; readonly ping: boolean }
  | { readonly ok: false; readonly retryAfterMs: number }
  | { readonly ok: false; readonly closed: true };

type ShoutRow = { id: number; nick: string; text: string; at: number; host: number };

/** Rows read and written by this object's queries since it woke (what the free plan meters). */
export interface RowUsage {
  rowsRead: number;
  rowsWritten: number;
}

const toShout = (row: ShoutRow): Shout => ({ id: row.id, nick: row.nick, text: row.text, at: iso(row.at), host: row.host === 1 });

/** While anything is held in memory, check back this often so the object doesn't hibernate and forget it. */
const KEEP_WARM_MS = 30_000;

/**
 * The campfire: one SQLite-backed Durable Object holding the visit count and the shouts still burning (a month's, and
 * always the newest 20).
 * Presence and rate limits live only in memory (see limits.ts); nothing that identifies a visitor is
 * ever written to storage.
 */
export class Campfire extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** Guest shouts per (hashed) IP. */
  private readonly limiter = new RateLimiter();
  /** Guest shouts from everyone together, so many IPs can't flood the fire either. */
  private readonly everyone = new GlobalLimiter();
  /** Counted visits per (hashed) IP. */
  private readonly visits = new Cooldown();
  /** Discord pings, so a flood can't get the webhook rate-limited. */
  private readonly pings = new GlobalLimiter(PING_LIMIT, PING_WINDOW_MS);
  /** Whether the fire is open, read from storage once and then kept here (this is the only writer). */
  private openCache: boolean | null = null;
  /** Who's polling the shoutbox, by hashed IP. */
  private readonly presence = new Presence();
  /** Salts the IP hashes; made up fresh each time the object wakes, never stored. */
  private readonly salt = crypto.randomUUID();
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  /** Running totals, for tests and the odd log line. In memory only. */
  readonly usage: RowUsage = { rowsRead: 0, rowsWritten: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    void ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS counters (
          name  TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS shouts (
          id   INTEGER PRIMARY KEY AUTOINCREMENT,
          nick TEXT    NOT NULL,
          text TEXT    NOT NULL,
          at   INTEGER NOT NULL,
          host INTEGER NOT NULL DEFAULT 0
        );
      `);
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(nextSweep(Date.now()));
    });
  }

  /**
   * The visit count, plus one first if `increment` and this IP hasn't been counted in the last half
   * hour. Without an IP (never the case on Cloudflare) the visit is simply counted.
   */
  async visit(increment: boolean, ip: string | null = null): Promise<number> {
    if (increment && ip) {
      const now = Date.now();
      increment = this.visits.hit(await this.hash(ip), now);
      if (increment) this.keepWarm();
    }
    if (increment) {
      return this.run<{ value: number }>(
        `INSERT INTO counters (name, value) VALUES ('visits', 1)
         ON CONFLICT (name) DO UPDATE SET value = value + 1
         RETURNING value`,
      )[0]!.value;
    }
    return this.run<{ value: number }>(`SELECT value FROM counters WHERE name = 'visits'`)[0]?.value ?? 0;
  }

  /**
   * The newest shouts still burning, oldest first, and how many visitors have looked in the last
   * minute. A visitor is a (hashed) IP, so one person's many tabs count once and made-up client ids
   * count for nothing; a valid `client` id is still needed to be counted, as before.
   */
  async shouts(client: string | null, ip: string | null = null): Promise<ShoutLog> {
    const now = Date.now();
    if (client && ip) {
      this.presence.see(await this.hash(ip), now);
      this.keepWarm();
    }
    // Newest first by id (an index range that stops after a page), then drop what's burned down.
    const rows = burning(this.run<ShoutRow>('SELECT id, nick, text, at, host FROM shouts ORDER BY id DESC LIMIT ?', SHOUT_PAGE), now);
    return { shouts: rows.reverse().map(toShout), here: Math.min(this.presence.count(now), MAX_HERE), open: this.isOpen() };
  }

  /**
   * Stores an already-validated shout, unless this IP, or everyone together, has said too much lately.
   * The host isn't limited. `ip` is only hashed, in memory; without one (never the case on Cloudflare)
   * only the limit for everyone applies.
   */
  async add(shout: CleanShout, ip: string | null): Promise<AddResult> {
    const now = Date.now();
    const key = !shout.host && ip ? await this.hash(ip) : null;
    if (!shout.host) {
      if (!this.isOpen()) return { ok: false, closed: true };
      const decision = firstRefusal(key ? this.limiter.check(key, now) : { ok: true }, this.everyone.check(now));
      if (!decision.ok) return decision;
    }
    const row = this.run<ShoutRow>(
      'INSERT INTO shouts (nick, text, at, host) VALUES (?, ?, ?, ?) RETURNING id, nick, text, at, host',
      shout.nick,
      shout.text,
      now,
      shout.host ? 1 : 0,
    )[0]!;
    // Keep the newest MAX_ROWS by id: an index range, so it reads only what it deletes (usually one row).
    this.run('DELETE FROM shouts WHERE id <= ?', row.id - MAX_ROWS);
    let ping = false;
    if (!shout.host) {
      if (key) this.limiter.record(key, now);
      this.everyone.record(now);
      ping = this.pings.check(now).ok;
      if (ping) this.pings.record(now);
      this.keepWarm();
    }
    return { ok: true, shout: toShout(row), ping };
  }

  /** What the next shout's id will probably be (for the honeypot's convincing fake). */
  nextId(): number {
    return (this.run<{ seq: number }>(`SELECT seq FROM sqlite_sequence WHERE name = 'shouts'`)[0]?.seq ?? 0) + 1;
  }

  /** Takes a shout down. False if there was no such shout. */
  remove(id: number): boolean {
    const cursor = this.sql.exec('DELETE FROM shouts WHERE id = ?', id);
    this.tally(cursor);
    return cursor.rowsWritten > 0;
  }

  /**
   * The host clears up after a flood: every guest shout from the last `withinMs`, in one go. The host's own
   * lines stay. Returns how many went.
   */
  clearGuests(withinMs: number, now = Date.now()): number {
    const cursor = this.sql.exec('DELETE FROM shouts WHERE host = 0 AND at >= ?', now - withinMs);
    this.tally(cursor);
    return cursor.rowsWritten;
  }

  /** Whether guests may shout. Open unless the host has banked the fire. */
  isOpen(): boolean {
    this.openCache ??= this.run<{ value: number }>(`SELECT value FROM counters WHERE name = 'banked'`).length === 0;
    return this.openCache;
  }

  /** The host opens or banks the fire. Banking deletes nothing; it only stops guests shouting. */
  setOpen(open: boolean): boolean {
    if (open) this.run(`DELETE FROM counters WHERE name = 'banked'`);
    else this.run(`INSERT INTO counters (name, value) VALUES ('banked', 1) ON CONFLICT (name) DO NOTHING`);
    this.openCache = open;
    return open;
  }

  /**
   * The daily sweep: the fire burns down. Shouts past the TTL go, except the newest KEEP_NEWEST, which
   * stay however old. The one query that reads the whole (capped) table.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const cursor = this.sql.exec(
      'DELETE FROM shouts WHERE at < ? AND id < (SELECT MIN(id) FROM (SELECT id FROM shouts ORDER BY id DESC LIMIT ?))',
      expiryCutoff(now),
      KEEP_NEWEST,
    );
    this.tally(cursor);
    if (cursor.rowsWritten) console.log(`sweep: ${cursor.rowsWritten} expired shout(s) removed`);
    await this.ctx.storage.setAlarm(nextSweep(now));
  }

  /** Runs a query to completion and adds its row counts to `usage`. */
  private run<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    this.tally(cursor);
    return rows;
  }

  private tally(cursor: { rowsRead: number; rowsWritten: number }): void {
    this.usage.rowsRead += cursor.rowsRead;
    this.usage.rowsWritten += cursor.rowsWritten;
  }

  private hash(ip: string): Promise<string> {
    return hashSubject(ip, this.salt);
  }

  /**
   * Keeps a timer pending while anything is held in memory: a pending timer stops the object
   * hibernating after 10 idle seconds, which would wipe it. It is still evicted a minute or two after
   * the last request, so the longer limits only hold while people are around (the 10 s one always
   * does). There is one object, so even kept in memory all day it stays inside the free plan's duration.
   */
  private keepWarm(): void {
    if (this.warmTimer) return;
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      const now = Date.now();
      this.presence.prune(now);
      this.limiter.prune(now);
      this.everyone.prune(now);
      this.pings.prune(now);
      this.visits.prune(now);
      if (this.presence.size || this.limiter.size || this.everyone.size || this.pings.size || this.visits.size) this.keepWarm();
    }, KEEP_WARM_MS);
  }
}

/** The refusal with the longest wait, or ok if neither refuses. */
function firstRefusal(a: RateDecision, b: RateDecision): RateDecision {
  if (a.ok) return b;
  if (b.ok) return a;
  return a.retryAfterMs >= b.retryAfterMs ? a : b;
}
