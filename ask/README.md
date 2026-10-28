# Ask Morgan

The site's Contact form, its "name a star" panel and "Publish as PR", as one Cloudflare Worker
(`ask.morganvanv.workers.dev`), deployed by `.github/workflows/ask.yml` from `main`. No runtime dependencies.

| Route | What it does |
| --- | --- |
| `POST /submit` | Takes the site's Contact form and "name a star" POSTs and forwards them to Morgan's private Discord channel (`src/submit.js`, `src/embed.js`). |
| `GET\|HEAD /publish` | Checks a signed "Publish as PR" link from Discord and sends Morgan on to GitHub's new-file editor with the file filled in (`src/publish.js`). |
| `GET /` | Name and version. |

`src/index.mjs` is the only Workers-specific file: routing, CORS, body limits and rate limits. The handlers take
the request's fields and return `{ statusCode, headers, body }`, so they're tested in plain Node.

```bash
npm ci --ignore-scripts
npm test          # node --test (the handlers, with a fake Discord), then Vitest in workerd (the Worker)
npm run dev       # http://localhost:8788; copy .dev.vars.example to .dev.vars first
npm run build     # wrangler deploy --dry-run
```

## Setting it up (Morgan's checklist)

The campfire's Cloudflare account, token and `production` environment do for this too (campfire/README.md).
This is how it's set up today; use it to rebuild or rotate.

1. **Secrets** in the `production` environment (Settings → Environments → production). The names differ from
   the Worker's so they can't collide with the campfire's:
   - `ASK_DISCORD_WEBHOOK_URL`: the Ask Morgan channel's webhook, the whole `https://discord.com/api/webhooks/…`
     URL. Required: without it the deploy is skipped. If Discord answers 404 (the Worker's logs say
     "Discord responded with status 404"), the URL is wrong or the webhook was deleted.
   - `PUBLISH_SECRET`: `openssl rand -hex 32` (at least 32 characters, or links are left off). Changing it
     invalidates every link already in Discord. Without it, no "Publish as PR" links.

   No GitHub token: since 2.1 the Worker never writes to GitHub (below).
2. **Deploy:** merge anything under `ask/`, or **Actions → Ask Morgan → Run workflow** on `main`. The deploy
   uploads the two as the Worker secrets `DISCORD_WEBHOOK_URL` and `PUBLISH_SECRET`, then
   checks that `/publish` answers 400 ("No link here"; a warning means `PUBLISH_SECRET` didn't take).
3. **Check it:** `https://ask.morganvanv.workers.dev/` answers `{"name":"ask","version":"2.1.0",…}`. The site's
   `askMorganSubmitUrl` (`src/shared/config/site.config.ts`) is `https://ask.morganvanv.workers.dev/submit`.
4. **Try it:** suggest a subtitle on the site. The Discord message should show **Will publish** and a
   **Publish as PR** link; open it and you should land in GitHub's editor with the file filled in. Commit it
   to a new branch and open the PR (below). A test PR stays public even after you close it, so use text you
   don't mind.

Errors are in Cloudflare → Workers & Pages → ask → Observability (only our own `console.error` lines; nothing
about visitors is logged).

**Links from before 2.0** (Ask Morgan ran on DigitalOcean until 2026-10-28) point at a `…doserverless.co/…/ask/publish`
address that no longer answers. They're signed with the same secret, so keep everything from `?p=` on and put
`https://ask.morganvanv.workers.dev/publish` in front. They expire 30 days after they were sent.

## Publish as PR

### The flow

1. A visitor sends a question, a greeting subtitle or a star name. `/submit` posts it to Discord.
   When publishing is set up, the embed also shows **Will publish** (exactly the text that would go in the file)
   and a **Publish as PR** link; without it, the file to create by hand (see [Without publishing](#without-publishing)).
   The anonymous dropbox never gets either, and neither does a submission whose message doesn't match its
   fields the way the site's form builds them, or a question containing `<!--`; the embed says why.
2. The link points to `/publish` and carries the item itself, signed with `PUBLISH_SECRET`
   (an HMAC, so nobody can make or change one). It's built from the form's structured fields, cleaned and held
   to the form's limits, never from the free-text message. Links last 30 days.
3. Opening the link checks the signature and the expiry, then sends you (303) to GitHub's **new file** page on
   the site's `master`, with the path and the file's contents filled in
   (`github.com/<repo>/new/master?filename=…&value=…`). Opening it changes nothing: Discord or a browser may
   fetch a link by itself, and GitHub's editor does nothing until you commit.
4. In the editor, for a question, **write your answer under the marker line**. Then **Commit changes… →
   Create a new branch → Propose changes → Create pull request** (the ruleset doesn't allow committing straight
   to `master`). You're signed in as yourself, so the PR is yours: the Worker holds no GitHub credential.
5. **Merge to publish, close to reject.**

**Committing makes the text public.** The site's repo is public: the branch and commit are visible as soon as
you commit, and closing the PR doesn't remove them (GitHub keeps the commit under `refs/pull/N/head`). Only
commit text you're happy to have out there, even if you then reject it. GitHub's default commit message and
PR title are `Create <id>.json` (or `.md`): the id, never the visitor's text. Keep them that way; the site
squash-merges with the PR title, so a title lands on `master`.

GitHub's editor puts a filled-in `.json` file on one line (`{"text":"…","by":"sam","added":"2026-10"}`);
that's fine, the site only parses it. Markdown (a question) arrives exactly as written.

A link opened twice opens the editor twice; committing the same file again fails ("A file with the same name
already exists" once the first is merged), and an open PR for it shows up in the repo's pull requests.

One file per entry, so pending PRs never conflict. `<id>` is `YYYY-MM-DD-<slug>-<8 hex>` (UTC date):

| Kind | File | Contents |
| --- | --- | --- |
| Subtitle | `content/subtitles/<id>.json` | `{ "text", "by": "sam" \| null, "added": "YYYY-MM" }` |
| Star name | `content/stars/<id>.json` | `{ "ra", "dec", "name", "by", "added", "near"? }` |
| Question | `content/mailbag/<id>.md` | front matter `asked: YYYY-MM-DD`, the question with every line quoted (`> `, or `>` for a blank line), a blank line, then the answer marker comment to write under |

**On the site side** (done, site #109): render the quoted question as plain text, never as HTML or Markdown (it's a
visitor's exact words); find the answer marker only at the start of a line (quoted lines start with `>`, so
they can't fake it); and fail the checks when the answer under it is empty.

### Without publishing

With `PUBLISH_URL` set to `"off"` in `wrangler.jsonc`, or no `PUBLISH_SECRET`, a question, subtitle or star name gets a
**To add by hand, create this file** field instead: the path (`content/subtitles/<id>.json`,
`content/stars/<id>.json` or `content/mailbag/<id>.md`) and the file's exact contents, built by the same code
publishing uses (`src/publish-link.js`). Create that file in the site repo to approve it; for a question, write
your answer under the marker line first. The same field appears with publishing on when a link would be too
long. If the file won't fit in a Discord field (1024 characters, after escaping), the field says so and gives
the path. No file is shown when the message doesn't match its fields, for the dropbox, or for anything
outside the form's limits.

### Turning it off

- **No more links:** set `"PUBLISH_URL": "off"` in `wrangler.jsonc` (by PR). Embeds go back to the file to
  create by hand.
- **Kill the links already in Discord too:** make a new `PUBLISH_SECRET` and run the deploy. Every existing link
  then says "Not a valid link"; new ones work.
- **Stop submissions:** delete the Worker's `DISCORD_WEBHOOK_URL` (Cloudflare → Workers & Pages → ask →
  Settings → Variables and Secrets); `/submit` then answers 503 and the site shows its error.

### Security notes

- Links are HMAC-SHA256 signed (over `publish-link/v1\n` + the payload) and compared in constant time;
  payloads are only decoded after the signature checks out, then validated again against the form's limits on
  every request.
- GET never changes anything. Pages escape every value and send `Cache-Control: no-store`,
  `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer` and a CSP that allows no scripts.
- The Worker holds no GitHub credential and makes no GitHub calls. A link only ever leads to GitHub's editor,
  where nothing happens until Morgan, signed in as himself, reads the file and commits it. The worst a leaked
  `PUBLISH_SECRET` allows is forged links that open a filled-in editor, and only for someone with write
  access to the site to commit. Nothing logs a visitor's text.
- The editor URL only ever points at `https://github.com/<GITHUB_REPO>/new/master`, with the path and contents
  as query parameters (at most about 3.3 kB for the longest question).
- `/submit` refuses anything but a JSON POST (OPTIONS is the CORS preflight; only the site's origins get CORS
  headers) and bodies over 16 kB. A field called `http` can't change the method the handlers see.
- Rate limits (Workers Rate Limiting, approximate and per Cloudflare location): 5 submissions a minute per
  visitor, 20 a minute in all (under Discord's webhook limit), 20 publish link opens a minute per visitor. The
  IP is only the limiter's key: nothing stores or logs it, and invocation logs are off.
