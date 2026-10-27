import { DurableObject } from 'cloudflare:workers';
import { SHOUT_PAGE } from './config';
import { Presence, RateLimiter, hashSubject } from './limits';
import { expiryCutoff, iso, nextSweep } from './time';
import type { CleanShout } from './validate';

export interface Env {
  CAMPFIRE: DurableObjectNamespace<Campfire>;
  /** Morgan's host key. Unset means host features are off. */
  CAMPFIRE_HOST_KEY?: string;
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
}

export type AddResult = { readonly ok: true; readonly shout: Shout } | { readonly ok: false; readonly retryAfterMs: number };

type ShoutRow = { id: number; nick: string; text: string; at: number; host: number };

const toShout = (row: ShoutRow): Shout => ({ id: row.id, nick: row.nick, text: row.text, at: iso(row.at), host: row.host === 1 });

/** While anything is held in memory, check back this often so the object doesn't hibernate and forget it. */
const KEEP_WARM_MS = 30_000;

/**
 * The campfire: one SQLite-backed Durable Object holding the visit count and the last week of shouts.
 * Presence and rate limits live only in memory (see limits.ts); nothing that identifies a visitor is
 * ever written to storage.
 */
export class Campfire extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly limiter = new RateLimiter();
  private readonly presence = new Presence();
  /** Salts the IP hashes; made up fresh each time the object wakes, never stored. */
  private readonly salt = crypto.randomUUID();
  private warmTimer: ReturnType<typeof setTimeout> | null = null;

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

  /** The visit count, plus one first if `increment`. */
  visit(increment: boolean): number {
    if (increment) {
      return this.sql.exec<{ value: number }>(
        `INSERT INTO counters (name, value) VALUES ('visits', 1)
         ON CONFLICT (name) DO UPDATE SET value = value + 1
         RETURNING value`,
      ).one().value;
    }
    return this.sql.exec<{ value: number }>(`SELECT value FROM counters WHERE name = 'visits'`).toArray()[0]?.value ?? 0;
  }

  /** The newest shouts still burning, oldest first, and how many tabs have looked in the last minute. */
  shouts(client: string | null): ShoutLog {
    const now = Date.now();
    if (client) {
      this.presence.see(client, now);
      this.keepWarm();
    }
    const rows = this.sql.exec<ShoutRow>(
      'SELECT id, nick, text, at, host FROM shouts WHERE at >= ? ORDER BY id DESC LIMIT ?',
      expiryCutoff(now),
      SHOUT_PAGE,
    ).toArray();
    return { shouts: rows.reverse().map(toShout), here: this.presence.count(now) };
  }

  /**
   * Stores an already-validated shout, unless this IP has said too much lately. The host isn't rate
   * limited. `ip` is only hashed, in memory.
   */
  async add(shout: CleanShout, ip: string | null): Promise<AddResult> {
    const now = Date.now();
    let key: string | null = null;
    if (!shout.host) {
      key = await hashSubject(ip ?? 'unknown', this.salt);
      const decision = this.limiter.check(key, now);
      if (!decision.ok) return decision;
    }
    this.sweep(now);
    const row = this.sql.exec<ShoutRow>(
      'INSERT INTO shouts (nick, text, at, host) VALUES (?, ?, ?, ?) RETURNING id, nick, text, at, host',
      shout.nick,
      shout.text,
      now,
      shout.host ? 1 : 0,
    ).one();
    if (key) {
      this.limiter.record(key, now);
      this.keepWarm();
    }
    return { ok: true, shout: toShout(row) };
  }

  /** Takes a shout down. False if there was no such shout. */
  remove(id: number): boolean {
    return this.sql.exec('DELETE FROM shouts WHERE id = ?', id).rowsWritten > 0;
  }

  /** The daily sweep: the fire burns down. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const removed = this.sweep(now);
    if (removed) console.log(`sweep: ${removed} expired shout(s) removed`);
    await this.ctx.storage.setAlarm(nextSweep(now));
  }

  /** Deletes shouts past their week. Returns how many went. */
  private sweep(now: number): number {
    return this.sql.exec('DELETE FROM shouts WHERE at < ?', expiryCutoff(now)).rowsWritten;
  }

  /**
   * Keeps a timer pending while presence or rate limits hold anything: a pending timer stops the object
   * hibernating after 10 idle seconds, which would wipe them. It is still evicted a minute or two after
   * the last request, so the hourly limit only holds while people are around (the 10 s one always
   * does). There is one object, so even kept in memory all day it stays inside the free plan's duration.
   */
  private keepWarm(): void {
    if (this.warmTimer) return;
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      const now = Date.now();
      this.presence.prune(now);
      this.limiter.prune(now);
      if (this.presence.size || this.limiter.size) this.keepWarm();
    }, KEEP_WARM_MS);
  }
}
