/** Everything tunable about the campfire, in one place. */

export const NAME = 'campfire';
/** Kept in step with package.json (a test checks). */
export const VERSION = '1.0.0';
export const SOURCE_URL = 'https://github.com/morgan-vanv/morganvanv.com-backend/tree/main/campfire';

/** The one Durable Object instance everything lives in. */
export const INSTANCE_NAME = 'campfire';

/** Who may call from a browser. Anything else gets no CORS headers. */
export const ALLOWED_ORIGINS: readonly string[] = [
  'https://morganvanv.com',
  'https://www.morganvanv.com',
  'http://localhost:4200',
  'http://localhost:4000',
];

/** Request bodies larger than this are refused with 413. */
export const MAX_BODY_BYTES = 2048;

export const NICK_MAX = 16;
export const TEXT_MAX = 200;
export const MAX_URLS = 1;
/** How Morgan's shouts are signed. */
export const HOST_NICK = 'morgan';
/** Nicks guests can't take (compared after folding case and leetspeak). */
export const RESERVED_NICKS: readonly string[] = ['morgan', 'morganvanv', 'admin', 'host'];

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The fire burns down: shouts older than this are gone. */
export const SHOUT_TTL_MS = 7 * DAY;
/** How many shouts GET /shouts returns at most. */
export const SHOUT_PAGE = 50;
/** How often the alarm sweeps expired shouts. */
export const SWEEP_EVERY_MS = DAY;

/** A client counts as "here" if it polled this recently (the site polls every ~20 s). */
export const PRESENCE_WINDOW_MS = 60 * SECOND;

/** Per IP: at most one shout per RATE_GAP_MS and RATE_PER_HOUR per hour. */
export const RATE_GAP_MS = 10 * SECOND;
export const RATE_PER_HOUR = 20;

/** Caps on the in-memory maps, so a flood can't grow them without bound. */
export const MAX_TRACKED = 10_000;
