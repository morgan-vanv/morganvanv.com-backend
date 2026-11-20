# Lab status

Whether the homelab's public services are up, and how many people are on the Minecraft server, for the Homelab
page on morganvanv.com (`/homelab`, and the Minecraft spots on `/social`, `/now` and Home), as one Cloudflare
Worker (`lab-status.morganvanv.workers.dev`), deployed by `.github/workflows/lab-status.yml` from `main`. No
secrets, no storage, no runtime dependencies.

| Route | What it does |
| --- | --- |
| `GET\|HEAD /status` | `{ "checkedAt": "<ISO time>", "services": { "vtt": "up", "jellyfin": "up", "desk": "up", "minecraft": "up" }, "players": { "minecraft": 3 } }` |
| `GET /` | Name and version. |

`src/status.js` does the checking and knows nothing about Workers, so it's tested in plain Node with a fake
`fetch` and a fake socket; `src/index.mjs` is routing, CORS, a per-visitor rate limit, and hands it
`cloudflare:sockets`' `connect` for the Minecraft check.

- **What "up" means:** the service's public address answers within 5 s with a 2xx or 3xx (redirects aren't
  followed). Jellyfin's `/health` must also say exactly `Healthy`. The front desk (`desk`) is Authentik's
  public `/-/health/live/`. Anything else is "down".
- **The Minecraft server** (`minecraft`) is asked the way the game's own server list asks (the Server List
  Ping over TCP: a handshake, a status request, one JSON answer). It's "up" when that answer arrives within
  5 s and says how many are on; `players.minecraft` is that number, and is left out while the server is down.
  The answer also holds a sample of player names, the MOTD and the icon: the Worker reads only the count.
- **How often it knocks:** a result is reused for two minutes per Worker isolate, and concurrent requests share
  one check, so however many people have the site open, the services see a request every couple of minutes at most.
  Browsers may cache the answer for a minute (`Cache-Control`).
- **What it says:** names, up/down and the one player count. No addresses, status codes, errors or player
  names leave the Worker.
- **The addresses** are `vars` in `wrangler.jsonc` (all of them are in public DNS anyway). A service whose var is
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
   `labStatusUrl` (`src/shared/config/site.config.ts`); until it answers, the Homelab page simply shows no lights.
4. **Optional:** add "Lab status tests" to `main`'s required checks, like the other two.
