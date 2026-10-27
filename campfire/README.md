# The campfire

The small backend behind two things on [morganvanv.com](https://morganvanv.com):

- **The odometer**: the visitor counter badge on `/now`.
- **The shoutbox**: the IRC-style log on `/social`. Messages burn down after a week.

It's one [Cloudflare Worker](https://developers.cloudflare.com/workers/) in front of one
[SQLite-backed Durable Object](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
(a single instance, named `campfire`), on the free plan. TypeScript, no framework.

```
campfire/
  src/index.ts       the Worker: routing, CORS, auth, request checks
  src/campfire.ts    the Durable Object: the count, the shouts, the limits, the daily sweep
  src/validate.ts    nick and text rules     src/blocklist.ts  the short blocklist
  src/limits.ts      rate limits + "here"    src/cors.ts       allowed origins
  src/auth.ts        the host key            src/http.ts       JSON, size limits
  src/time.ts        expiry maths            src/config.ts     every number above
  src/chars.ts       invisible characters
  test/unit/         the pure modules, in plain Node
  test/worker/       the whole Worker + Durable Object, in workerd (offline)
  scripts/smoke.sh   curl checks against `npm run dev`
```

## API

Responses are JSON (`Cache-Control: no-store`), except the empty `204`s. Errors are
`{ "error": "<short human message>" }`; a `405` also says what the path takes in `Allow`.

| Method & path | What it does | Response |
| --- | --- | --- |
| `GET /` | Name and version. | `200 { "name": "campfire", "version": "1.0.0", "source": "…", "endpoints": [ … ] }` |
| `GET /visit` | Reads the count. | `200 { "count": 1234 }` |
| `POST /visit` | Adds one (at most once per IP per 30 min) and reads it. No body. | `200 { "count": 1235 }` |
| `GET /shouts?client=<id>` | The newest 50 shouts from the last 7 days, oldest first, and how many visitors are watching. | `200 { "shouts": [Shout], "here": 3 }` |
| `POST /shouts` | Says something. Body: `{ "nick", "text", "website" }`. | `201 { "shout": Shout }` |
| `DELETE /shouts/<id>` | Host only: takes a shout down. | `204`, or `404` if it's already gone |
| `GET /host` | Is the bearer token the host key? The site asks before keeping a key. | `204` yes, `401` no, `404` with host features off |
| `OPTIONS *` | CORS preflight. | `204` |

A `Shout` is `{ "id": 12, "nick": "guest_4821", "text": "…", "at": "2026-10-27T05:12:00.000Z", "host": false }`.

**The odometer.** The site counts a visit once per tab session (sessionStorage), and only on
morganvanv.com itself, so it sends `POST /visit` once and `GET /visit` otherwise. The campfire also counts
each IP at most once per 30 minutes (hashed, in memory): past that, `POST /visit` just returns the count,
so a curl loop can't run it up.

**"Here".** `here` is how many visitors polled `GET /shouts` in the last 60 seconds (the site polls every
~20 s while the tab is visible), counted by hashed IP in memory, so one person's tabs count once and
made-up `client` ids count for nothing. It never reports more than 99. The request still needs a
`client` (a random id the site makes up per tab, 8–64 of `A–Z a–z 0–9 _ -`) to be counted; without one
it gets the shouts and isn't counted. Two people behind one IP (a household, an office) count as one.

**Shout rules** (`src/validate.ts`):

- `website` is a honeypot: humans never see it. If it holds any text, the answer is a normal-looking
  `201` echoing the cleaned nick and text with a plausible next id, and nothing is stored.
- **Invisible characters** go first, from nick and text (`src/chars.ts`): every format character
  (`\p{Cf}`: zero-width spaces and joiners, bidi controls, tag characters, U+180E), U+034F, variation
  selectors U+FE00–FE0E (U+FE0F stays), and blank-looking fillers (Hangul U+3164, U+115F, U+1160, U+FFA0
  and braille blank U+2800). Lone surrogates become U+FFFD.
- **nick**: trimmed, fullwidth letters folded, inner spaces become `_`; then 1–16 of letters, digits,
  `_ - .`, or `400`. Anything containing `morgan`, and exactly `admin` or `host`, is reserved (in any
  case or leetspeak).
- **text**: control characters removed, all whitespace (newlines included) collapsed to single spaces,
  trimmed; then 1–200 characters with at least one visible letter, number, symbol or punctuation mark,
  or `400`. At most one link (`http…`, `www.…` or a bare `something.com`).
- Both go through a short blocklist (`src/blocklist.ts`): slurs and obvious spam, folded for case,
  accents, leetspeak, stretched letters and s p a c e d letters, matched word by word. Short words only
  match as whole words, so Scunthorpe, socialism and snigger are fine. It's deliberately small; anything
  it misses, Morgan deletes.
- Bodies must be `application/json` (`415` otherwise) and under 2 KB (`413`), and must parse (`400`).
- **Rate limits**, all in memory: per client IP, 1 shout per 10 s and 20 per rolling hour; and for all
  guests together, 30 shouts per 10 minutes (so a block of IPv6 addresses can't flood it either). Past
  either: `429 { "error": "Easy there. Try again in 7 s." }` with `Retry-After` (seconds; exposed to the
  site through CORS). IPv6 addresses are limited per /64, since one connection gets a whole /64, and
  IPv4-mapped addresses (`::ffff:a.b.c.d`) as the IPv4 address. A request without `CF-Connecting-IP`
  (never the case on Cloudflare) skips the per-IP limits but not the one for everyone.
- **At most 500 shouts are kept** (only 50 are ever shown): each new shout deletes whatever falls off the
  end, by id, so no request reads more rows as the table grows. The daily alarm removes week-old ones.

**The host.** Requests with `Authorization: Bearer <CAMPFIRE_HOST_KEY>` post as `morgan` with
`host: true` (shown in gold), aren't rate limited or filtered, and may `DELETE /shouts/<id>`. A wrong key
gets `401`. Keys are compared in constant time (both sides hashed, every byte compared). If the
`CAMPFIRE_HOST_KEY` secret isn't set, host features are off: any key is refused and `DELETE` is a `404`.
On the site, Morgan visits `/social/#host=<key>` once; the key stays in his browser's localStorage.

**CORS.** Only `https://morganvanv.com`, `https://www.morganvanv.com`, `http://localhost:4200` and
`http://localhost:4000` get CORS headers (methods `GET, POST, DELETE`; headers `Content-Type,
Authorization`). Any other origin gets none, so browsers block it. (CORS isn't access control: `curl`
works from anywhere, which is why the limits above live on the server.)

## Privacy

- **No cookies**, and the campfire doesn't set or read any.
- **The odometer stores one number.** No IPs, no ids, no "unique visitor" tracking: a visit is whatever
  the site says it is.
- **Shouts store only what you typed:** nick, text, time, and whether it was Morgan. They're deleted
  after 7 days by a daily alarm (and only the newest 500 are kept). There's no archive or backup.
- **IP addresses are never stored.** For rate limits, the visit throttle and "here", the IP (an IPv6
  /64) is hashed with SHA-256 and a random salt that exists only in memory, and only the hash is kept, in
  memory: an hour at most for shouts, 30 minutes for visits, a minute for "here".
- **`client` ids are never kept**; they only decide whether a poll counts towards "here".
- In-memory data disappears whenever the Durable Object leaves memory: after a minute or two with no
  requests, or on any deploy.
- **Logs**: Workers Logs only keep the campfire's own `console` lines (errors and the daily sweep count).
  Per-request "invocation logs" are switched off in `wrangler.jsonc`, and query strings are redacted from
  logged URLs (`redact_query_string`), so Cloudflare's dashboard doesn't keep a record of each visit.
  Cloudflare itself still sees every request, as any host does. **After the first deploy, check** in the
  dashboard (Workers & Pages → campfire → Observability → Logs) that log lines carry no request metadata
  (no IP, country or user agent); if they do, Cloudflare has changed what `invocation_logs: false` means.

## Running it locally

```bash
cd campfire
nvm use                       # Node 24
npm ci
cp .dev.vars.example .dev.vars    # host key for local dev: local-host-key
npm run dev
```

The campfire is then at **http://localhost:8787** (`wrangler dev` runs workerd and the SQLite Durable
Object offline; data lives in `.wrangler/state/` and survives restarts; delete that folder to start
over). To point the site at it, set `campfireUrl` in the site's `src/shared/config/site.config.ts` to
`http://localhost:8787` and run the site on port 4200 or 4000. A warning that Wrangler is "unable to fetch
the `Request.cf` object" is harmless offline.

Checks:

```bash
npm run check                 # typecheck + all tests + a deploy dry run (what CI runs)
npm test                      # unit tests (Node) + Worker tests (workerd)
./scripts/smoke.sh            # curl every endpoint of a fresh `npm run dev`
```

Locally, the rate limiter keys on the `CF-Connecting-IP` header if you send one (the smoke test does),
so you can pretend to be several visitors. On Cloudflare that header is always set by Cloudflare.

## Setting it up (Morgan's checklist)

The deploy workflow (`.github/workflows/campfire.yml`) tests every PR into `main` (its "Campfire tests" job is a required check), and on
`main` it deploys, but only once the secrets below exist; until then it skips the deploy with a notice
and stays green.

1. **Create a free Cloudflare account** at <https://dash.cloudflare.com/sign-up>. Stay on the Workers
   Free plan; nothing here needs a paid one.
2. **Pick your workers.dev subdomain.** In the dashboard, open **Workers & Pages**. If it asks you to
   choose a subdomain, choose it there; otherwise use **Change** next to **Your subdomain**. The site already expects **`morganvanv`**, i.e.
   `https://campfire.morganvanv.workers.dev` (`campfireUrl` in the site's `site.config.ts`). If you pick
   something else, change `campfireUrl` to match.
3. **Create an API token** that can only deploy Workers. **My Profile → API Tokens → Create Token →
   Create Custom Token**. Give it one permission, *Account → Workers Scripts → Edit* (add *Account →
   Account Settings → Read* only if a deploy says it needs it), set **Account Resources** to *Include →
   your account*, and leave **Zone Resources** out. Continue, create, and copy the token (it's shown
   once). Cloudflare's "Edit Cloudflare Workers" template also works, but it adds KV, R2 and Routes
   write that the campfire never uses, so a leaked token could do more.
4. **Find your account ID.** **Workers & Pages** → **Account details** on the right → copy **Account ID**
   (or press Ctrl/Cmd-K in the dashboard and search "Copy account ID").
5. **Make a host key**, a long random string only you know:
   ```bash
   openssl rand -hex 32
   ```
6. **Add three GitHub secrets** to `morgan-vanv/morganvanv.com-backend`, in an environment so only `main`
   can use them: **Settings → Environments → New environment** named `production`; under **Deployment
   branches and tags** pick *Selected branches and tags* and add `main`; then **Add environment secret**
   for each:
   - `CLOUDFLARE_API_TOKEN`: the token from step 3
   - `CLOUDFLARE_ACCOUNT_ID`: the ID from step 4
   - `CAMPFIRE_HOST_KEY`: the key from step 5 (optional; without it, host features stay off)

   (Repository secrets work too, but then a workflow on any branch could read them.)
7. **Deploy.** **Actions → Campfire → Run workflow** on `main` (or merge anything under `campfire/`).
   The first deploy creates the Worker and its Durable Object and uploads the host key as a Worker
   secret.
8. **Check it**: open `https://campfire.<subdomain>.workers.dev/`. It should answer
   `{"name":"campfire","version":"1.0.0",…}`. A brand-new workers.dev name can take a minute or two to
   start resolving. Then `…/visit` should say `{"count":0}`.
9. **Become the host on the site**: visit `https://morganvanv.com/social/#host=<your key>` once, in each
   browser you use. The key moves into that browser's localStorage and out of the address bar;
   `#host=` with nothing after it forgets it.

To change the host key later, update the GitHub secret and re-run the workflow (or run
`npx wrangler secret put CAMPFIRE_HOST_KEY` in `campfire/` after `npx wrangler login`).

To turn host features off, **deleting the GitHub secret isn't enough**: the Worker keeps the last key it
was given. Remove it from the Worker too, in `campfire/` after `npx wrangler login`:

```bash
npx wrangler secret delete CAMPFIRE_HOST_KEY
```

(or in the dashboard: Workers & Pages → campfire → Settings → Variables and Secrets).

## Free plan limits

From Cloudflare's [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) pages,
checked October 2026. Daily limits reset at 00:00 UTC; past one, that kind of request fails until the
reset (the badge and shoutbox just hide).

| Limit (Workers Free) | Allowance |
| --- | --- |
| Worker requests | 100,000 / day |
| Worker CPU time | 10 ms per request |
| Durable Object requests | 100,000 / day |
| Durable Object duration | 13,000 GB-s / day |
| SQLite rows read | 5,000,000 / day |
| SQLite rows written | 100,000 / day |
| SQLite storage | 5 GB total |
| Workers Logs | 200,000 events / day, kept 3 days |

What the campfire uses (rows measured with the cursors' `rowsRead` / `rowsWritten`; a Worker test pins
the shout numbers):

| Action | Worker req. | DO req. | Rows written | Rows read |
| --- | --- | --- | --- | --- |
| A counted visit (`POST /visit`) | 1 | 1 | 1 | 1 |
| A repeat visit within 30 min, or `GET /visit` | 1 | 1 | 0 | 1 |
| One shoutbox poll (`GET /shouts`), every 20 s while `/social` is open and visible | 1 | 1 | 0 | ≤ 50 |
| A shout | 1 (+1 preflight) | 1 | 2 (the row + `sqlite_sequence`, from `AUTOINCREMENT`); 3 once 500 are kept | 3; 4 once 500 are kept |
| A honeypot hit | 1 (+1 preflight) | 1 | 0 | 1 |
| The daily sweep | 0 | 1 (+1 row written for `setAlarm`) | the expired rows | ≤ 500 |

CORS preflights (`OPTIONS`) count as Worker requests but never reach the Durable Object. Browsers send
them for shouts (JSON bodies) and host requests; plain `GET /visit`, `POST /visit` and `GET /shouts` don't
need them.

So a visit costs about 2 requests (one Worker, one Durable Object), and someone sitting on `/social` for
an hour costs ~180 polls, i.e. ~180 of each daily 100,000. The ceiling that matters is requests: roughly
**50,000 visits a day**, or about 550 hours of people watching the shoutbox, whichever runs out first.
Rows are far from their limits: at most 50 read per poll, and a shout costs the same few rows however
full the table is (500 rows at most; the sweep reads them once a day). Even the shout limit for everyone
(30 per 10 minutes, 4,320 a day) writes about 13,000 rows. Duration: there's one object and it leaves
memory a minute or two after the last request; even if it stayed in memory all day it would use
86,400 s × 0.125 GB = 10,800 GB-s, under the 13,000 allowance. Storage: 500 shouts is kilobytes.

**What no limit here can stop.** The quotas count every request, refused or not. One client sending
about 1.2 requests a second (100,000 a day) to anything on the Worker uses up the day's Worker quota, and
the campfire's own limits can't help, because they run inside the requests being counted. Only a custom
domain in front of the Worker, with a Cloudflare WAF rate-limiting rule, could stop that before it
counts. For a personal site that's a risk worth knowing, not worth a domain.

**What the site sees past a limit.** When the Worker quota is spent, Cloudflare answers with its own error
page (error 1027) without CORS headers, so the site's request fails as a network error. When a Durable
Object quota is spent, the Worker answers `500 { "error": "The campfire sputtered…" }`. Either way the site
already treats any failure as "no campfire": the badge hides and the shoutbox shows that it couldn't
reach the fire. Everything comes back at 00:00 UTC.

## Decisions worth knowing

- **Durable Object classes use `migrations` (`new_sqlite_classes`)**, not the newer declarative
  `exports` block Cloudflare introduced in mid-2026. Both are supported; `migrations` is the long-standing
  form and is what most docs and examples still show. Never edit the `v1` migration; add `v2` if a class
  is ever renamed or added.
- **Polling, not WebSockets.** Simpler, and well inside the free plan. If a future feature needs
  real-time (shared shooting stars, fireflies as visitors), the same Durable Object can add hibernatable
  WebSockets.
- **In-memory limits.** The 10-second limit always holds; the hourly, 10-minute and 30-minute ones hold
  while the object stays in memory, which is as long as anyone's around. Storing hashed IPs would make
  them airtight but break the "nothing about visitors is stored" promise; for a personal shoutbox with a
  host delete button, that trade is fine.
- **One Durable Object.** Everything is serialised through it, which is the point: the count can't race.
  It can handle far more than this site will ever send.
