# Lab status

Whether the homelab's public services are up, for the Lab page on morganvanv.com (`/lab`), as one Cloudflare
Worker (`lab-status.morganvanv.workers.dev`), deployed by `.github/workflows/lab-status.yml` from `main`. No
secrets, no storage, no runtime dependencies.

| Route | What it does |
| --- | --- |
| `GET\|HEAD /status` | `{ "checkedAt": "<ISO time>", "services": { "vtt": "up", "jellyfin": "down" } }` |
| `GET /` | Name and version. |

`src/status.js` does the checking and knows nothing about Workers, so it's tested in plain Node with a fake
`fetch`; `src/index.mjs` is routing, CORS and a per-visitor rate limit.

- **What "up" means:** the service's public address answers within 5 s with a 2xx or 3xx (redirects aren't
  followed). Jellyfin's `/health` must also say exactly `Healthy`. Anything else is "down".
- **How often it knocks:** a result is reused for two minutes per Worker isolate, and concurrent requests share
  one check, so however many people open `/lab`, the services see a request every couple of minutes at most.
  Browsers may cache the answer for a minute (`Cache-Control`).
- **What it says:** names and up/down only. No addresses, status codes or errors leave the Worker.
- **The addresses** are `vars` in `wrangler.jsonc` (both are in public DNS anyway). A service whose var is
  removed drops out of the answer, and the site shows no light for it.

```bash
npm ci --ignore-scripts
npm test          # node --test (status.js, with a fake fetch), then Vitest in workerd (the Worker, offline)
npm run dev       # http://localhost:8787/status (checks the real services)
npm run build     # wrangler deploy --dry-run
```

## Setting it up (Morgan's checklist)

1. **Secrets:** none of its own. It deploys with the `production` environment's `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`, which the campfire and Ask Morgan already use.
2. **Deploy:** merge this, or **Actions → Lab status → Run workflow** on `main`. The deploy ends by printing
   `/status`'s answer in the run's summary.
3. **Check it:** `https://lab-status.morganvanv.workers.dev/status`. The site reads it from
   `labStatusUrl` (`src/shared/config/site.config.ts`); until it answers, the Lab page simply shows no lights.
4. **Optional:** add "Lab status tests" to `main`'s required checks, like the other two.
