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
  src/campfire.ts    the Durable Object: the count, the shouts, the daily sweep
  src/validate.ts    nick and text rules     src/blocklist.ts  the short blocklist
  src/limits.ts      rate limits + "here"    src/cors.ts       allowed origins
  src/auth.ts        the host key            src/http.ts       JSON, size limits
  src/time.ts        expiry maths            src/config.ts     every number above
  test/unit/         the pure modules, in plain Node
  test/worker/       the whole Worker + Durable Object, in workerd (offline)
  scripts/smoke.sh   curl checks against `npm run dev`
```

## API

Every response is JSON (`Cache-Control: no-store`). Errors are `{ "error": "<short human message>" }`.

| Method & path | What it does | Response |
| --- | --- | --- |
| `GET /` | Name and version. | `200 { "name": "campfire", "version": "1.0.0", "source": "…", "endpoints": [ … ] }` |
| `GET /visit` | Reads the count. | `200 { "count": 1234 }` |
| `POST /visit` | Adds one and reads it. No body. | `200 { "count": 1235 }` |
| `GET /shouts?client=<id>` | The newest 50 shouts from the last 7 days, oldest first, and how many tabs are watching. | `200 { "shouts": [Shout], "here": 3 }` |
| `POST /shouts` | Says something. Body: `{ "nick", "text", "website" }`. | `201 { "shout": Shout }` |
| `DELETE /shouts/<id>` | Host only: takes a shout down. | `204`, or `404` if it's already gone |
| `OPTIONS *` | CORS preflight. | `204` |

A `Shout` is `{ "id": 12, "nick": "guest_4821", "text": "…", "at": "2026-10-27T05:12:00.000Z", "host": false }`.

**The odometer.** The site counts a visit once per tab session (sessionStorage), and only on
morganvanv.com itself, so it sends `POST /visit` once and `GET /visit` otherwise.

**"Here".** `client` is a random id the site makes up per tab. The campfire remembers, in memory only,
when each id last polled, and `here` is how many polled in the last 60 seconds (the site polls every
~20 s while the tab is visible). A missing or odd-looking `client` (not 8–64 of `A–Z a–z 0–9 _ -`) still
gets the shouts; it just isn't counted.

**Shout rules** (`src/validate.ts`):

- `website` is a honeypot: humans never see it. If it's filled in, the answer is a normal-looking `201`
  and nothing is stored.
- **nick**: trimmed, fullwidth letters folded, inner spaces become `_`; then 1–16 of letters, digits,
  `_ - .`, or `400`. `morgan`, `morganvanv`, `admin` and `host` are reserved (in any case or leetspeak).
- **text**: control and invisible characters removed, all whitespace (newlines included) collapsed to
  single spaces, trimmed; then 1–200 characters, or `400`. At most one link (`http…`, `www.…` or a bare
  `something.com`).
- Both go through a short blocklist (`src/blocklist.ts`): slurs and obvious spam, folded for case,
  accents, leetspeak, stretched letters and s p a c e d letters. Short words only match as whole words,
  so Scunthorpe is fine. It's deliberately small; anything it misses, Morgan deletes.
- Bodies must be `application/json` (`415` otherwise) and under 2 KB (`413`), and must parse (`400`).
- **Rate limit**, per client IP: 1 shout per 10 s and 20 per rolling hour, then
  `429 { "error": "Easy there. Try again in 7 s." }` with `Retry-After` (seconds; exposed to the site
  through CORS). IPv6 addresses are limited per /64, since one connection gets a whole /64.

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
  after 7 days, on every new shout and by a daily alarm. There's no archive or backup.
- **IP addresses are never stored.** For rate limiting, the IP (an IPv6 /64) is hashed with SHA-256 and a
  random salt that exists only in memory, and only the hash is kept, in memory, for at most an hour.
- **"Here" ids are never stored.** They're random per tab, held in memory for a minute after each poll.
- In-memory data disappears whenever the Durable Object leaves memory: after a minute or two with no
  requests, or on any deploy.
- **Logs**: Workers Logs only keep the campfire's own `console` lines (errors and the daily sweep count).
  Per-request "invocation logs" are switched off in `wrangler.jsonc`, so Cloudflare's dashboard doesn't
  keep a record of each visit. Cloudflare itself still sees every request, as any host does.

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

The deploy workflow (`.github/workflows/campfire.yml`) tests every PR that touches `campfire/`, and on
`main` it deploys, but only once the secrets below exist; until then it skips the deploy with a notice
and stays green.

1. **Create a free Cloudflare account** at <https://dash.cloudflare.com/sign-up>. Stay on the Workers
   Free plan; nothing here needs a paid one.
2. **Pick your workers.dev subdomain.** In the dashboard, open **Workers & Pages**. If it asks you to
   choose a subdomain, choose it there; otherwise use **Change** next to **Your subdomain**. The site already expects **`morganvanv`**, i.e.
   `https://campfire.morganvanv.workers.dev` (`campfireUrl` in the site's `site.config.ts`). If you pick
   something else, change `campfireUrl` to match.
3. **Create an API token.** **My Profile → API Tokens → Create Token**, use the **Edit Cloudflare
   Workers** template. Under **Account Resources** choose *Include → your account* (only this one), and
   under **Zone Resources** *Include → All zones* is fine (you have none; the template's only zone
   permission is Workers Routes, which the campfire doesn't use). Continue, create, and copy the token
   (it's shown once). The template grants Workers Scripts, KV, R2 and Routes write, Workers Tail read,
   Account Settings read and User Details/Memberships read: more than the campfire needs, but it's
   Cloudflare's recommended setup for CI deploys.
4. **Find your account ID.** **Workers & Pages** → **Account details** on the right → copy **Account ID**
   (or press Ctrl/Cmd-K in the dashboard and search "Copy account ID").
5. **Make a host key**, a long random string only you know:
   ```bash
   openssl rand -hex 32
   ```
6. **Add three GitHub secrets** to `morgan-vanv/morganvanv.com-backend`: **Settings → Secrets and
   variables → Actions → New repository secret**:
   - `CLOUDFLARE_API_TOKEN`: the token from step 3
   - `CLOUDFLARE_ACCOUNT_ID`: the ID from step 4
   - `CAMPFIRE_HOST_KEY`: the key from step 5 (optional; without it, host features stay off)
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

What the campfire uses:

| Action | Worker req. | DO req. | Rows written | Rows read |
| --- | --- | --- | --- | --- |
| A visit (`POST /visit`) | 1 | 1 | 1 | ~1 |
| Showing the count again (`GET /visit`) | 1 | 1 | 0 | 1 |
| One shoutbox poll (`GET /shouts`), every 20 s while `/social` is open and visible | 1 | 1 | 0 | ≤ 50 |
| A shout | 1 (+1 preflight) | 1 | 1 (+ expired rows deleted) | ~1 |
| The daily sweep | 0 | 1 | 1 + expired rows | ≤ the expired rows |

CORS preflights (`OPTIONS`) count as Worker requests but never reach the Durable Object. Browsers send
them for shouts (JSON bodies) and host requests; plain `GET /visit`, `POST /visit` and `GET /shouts` don't
need them.

So a visit costs about 2 requests (one Worker, one Durable Object), and someone sitting on `/social` for
an hour costs ~180 polls, i.e. ~180 of each daily 100,000. The ceiling that matters is requests: roughly
**50,000 visits a day**, or about 550 hours of people watching the shoutbox, whichever runs out first.
Rows written (one per visit or shout) and reads (at most 50 per poll) are far from their limits.
Duration: there's one object and it leaves memory a minute or two after the last request; even if it
stayed in memory all day it would use 86,400 s × 0.125 GB = 10,800 GB-s, under the 13,000 allowance.
Storage: a week of shouts is kilobytes.

## Decisions worth knowing

- **Durable Object classes use `migrations` (`new_sqlite_classes`)**, not the newer declarative
  `exports` block Cloudflare introduced in mid-2026. Both are supported; `migrations` is the long-standing
  form and is what most docs and examples still show. Never edit the `v1` migration; add `v2` if a class
  is ever renamed or added.
- **Polling, not WebSockets.** Simpler, and well inside the free plan. If a future feature needs
  real-time (shared shooting stars, fireflies as visitors), the same Durable Object can add hibernatable
  WebSockets.
- **In-memory rate limits.** The 10-second limit always holds; the hourly limit holds while the object
  stays in memory, which is as long as anyone's around. Storing hashed IPs would make it airtight but
  break the "nothing about visitors is stored" promise; for a personal shoutbox with a host delete button,
  that trade is fine.
- **One Durable Object.** Everything is serialised through it, which is the point: the count can't race.
  It can handle far more than this site will ever send.
