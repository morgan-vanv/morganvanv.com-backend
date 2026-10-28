# Ask Morgan

The site's Contact form, its "name a star" panel and "Publish as PR", as one Cloudflare Worker
(`ask.morganvanv.workers.dev`), deployed by `.github/workflows/ask.yml` from `main`. No runtime dependencies.

| Route | What it does |
| --- | --- |
| `POST /submit` | Takes the site's Contact form and "name a star" POSTs and forwards them to Morgan's private Discord channel (`src/submit.js`, `src/embed.js`). |
| `GET\|HEAD\|POST /publish` | Turns a question, subtitle or star name from Discord into a pull request on the site's repo (`src/publish.js`, `src/github.js`). |
| `GET /` | Name and version. |

`src/index.mjs` is the only Workers-specific file: routing, CORS, body limits and rate limits. The handlers take
the request's fields and return `{ statusCode, headers, body }` (the shape they had as DigitalOcean functions,
before 2.0), so they're tested in plain Node.

```bash
npm ci --ignore-scripts
npm test          # node --test (the handlers, with fake Discord and GitHub), then Vitest in workerd (the Worker)
npm run dev       # http://localhost:8788; copy .dev.vars.example to .dev.vars first
npm run build     # wrangler deploy --dry-run
```

## Setting it up (Morgan's checklist)

The campfire's Cloudflare account, token and `production` environment do for this too (campfire/README.md).

1. **Add the secrets** to the `production` environment (Settings → Environments → production → Add
   environment secret). Names differ from the Worker's so they can't collide with the campfire's:
   - `ASK_DISCORD_WEBHOOK_URL`: the Ask Morgan channel's webhook (the `DISCORD_WEBHOOK_URL` from your old
     DigitalOcean `.env`). Required: without it the deploy is skipped.
   - `PUBLISH_SECRET`: the same value as in that `.env`, so links already in Discord keep working (below).
     Without it, no "Publish as PR" links.
   - `PUBLISH_GITHUB_TOKEN`: the publishing token (`GITHUB_TOKEN` in that `.env`; better, the bot's, see
     "Publishing from a bot's fork"). Without it, the links show "Publishing is off".
2. **Deploy:** merge anything under `ask/`, or **Actions → Ask Morgan → Run workflow** on `main`. The deploy
   uploads the three as the Worker secrets `DISCORD_WEBHOOK_URL`, `PUBLISH_SECRET` and `GITHUB_TOKEN`.
3. **Check it:** `https://ask.morganvanv.workers.dev/` answers `{"name":"ask","version":"2.0.0",…}` and
   `/publish` shows "No link here". (A brand-new workers.dev name can take a minute.)
4. **Point the site at it:** the site's `askMorganSubmitUrl` (`src/shared/config/site.config.ts`) becomes
   `https://ask.morganvanv.workers.dev/submit`.
5. **Try it:** suggest a subtitle on the site. The Discord message should show **Will publish** and a
   **Publish as PR** link to `ask.morganvanv.workers.dev/publish`; open it, press the button, and you should
   land on a new PR. This test PR stays public even after you close it, so use text you don't mind. Close it,
   delete its branch, and open the same link again: it should say **Already published (closed)**.
6. **Retire DigitalOcean** (below).

### Leaving DigitalOcean

Links already in Discord point at the old `…/ask/publish` URL. With the same `PUBLISH_SECRET`, each still
works here: keep everything from `?p=` on and put `https://ask.morganvanv.workers.dev/publish` in front. Then
delete the `ask` namespace's functions in DigitalOcean (`doctl serverless undeploy ask/submit ask/publish`, or
the Functions page), delete your local `.env` (it holds the token and the secret), and revoke the token it held
if the Worker uses a different one.

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
3. Opening the link (GET) shows what would be published, the PR title, the file it goes in and one
   **Open the pull request** button. Opening it does nothing else: Discord or a browser may fetch a link by
   itself. A link already used says so and links its PR (open, closed or merged).
4. The button (POST) checks everything again, then makes branch `visitor/<kind>/<id>` from `master`, adds one
   new file and opens a PR into `master` labelled `visitor`, and takes you to it. Pressing it twice, or again
   after an error, finds what's already there and returns the same PR, even one that was closed and had its
   branch deleted (it's found by the `Visitor item:` line in its body).
5. **Merge to publish, close to reject.** For a question, write the answer in the PR first (the body links
   straight to the file's editor on that branch).

**Pressing the button makes the text public.** The site's repo is public: the PR's body, its branch and its
commit are visible on GitHub as soon as it opens, and closing it doesn't remove them (GitHub keeps the commit
under `refs/pull/N/head`). Only press it for text you're happy to have out there, even if you then reject it.
PR titles, branch names and commit messages hold only the kind and id (`visitor: subtitle
2026-10-27-a-certified-night-owl-3fa9c1b2`), never the visitor's text: the site squash-merges with the PR
title, so a title lands on `master`, where "fixes #12" would close an issue.

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

### Publishing from a bot's fork (recommended)

With a fine-grained token of Morgan's (Contents and Pull requests read/write on the site repo, as `ask-publish` is), whoever holds the token can do what Morgan can on the
site repo: open a PR **and merge it**, which deploys. The site's ruleset needs no approvals, and a token
acting as Morgan inherits his admin bypass. The fork mode removes that: a separate bot account forks the
site, `/publish` puts the branch and file on the fork and opens the PR from there. The bot's token has no
access to the site repo at all, so a leaked token can open PRs like any GitHub user, and nothing else.

1. **Make the bot account** (signed out of your own, or in a private window): a new GitHub account, e.g.
   `morganvanv-bot`, with its own email (a `+bot` alias of yours works) and two-factor on. GitHub allows one
   free machine account per person.
2. **Fork the site** as the bot: `morgan-vanv/morganvanv.com` → **Fork**, keeping the name and copying only
   `master`. In the fork, leave **Actions disabled** (forks start that way) so nothing runs there.
3. **Make the bot's token** (as the bot): Settings → Developer settings → Personal access tokens →
   **Tokens (classic)** → Generate new token, scope **`public_repo` only**, with an expiry (90 days is
   reasonable; put a reminder in your calendar). A classic token, because fine-grained tokens can't open PRs on
   a repo their owner doesn't belong to.
4. **Switch over:** replace the `PUBLISH_GITHUB_TOKEN` secret (production environment) with the bot's token,
   and open a PR setting `"GITHUB_FORK": "morganvanv-bot/morganvanv.com"` (the bot's name) in
   `wrangler.jsonc`. Merging it deploys with both.
5. **Revoke your own publishing token** (your account → Fine-grained tokens), so the only token that could
   merge is gone.
6. **Try it** as in Setting it up, step 5. The PR now comes from `morganvanv-bot:visitor/...`. The first time, the
   site's Actions may ask you to **Approve and run** the checks for a new contributor; after that they run on
   their own. Fork PRs aren't labelled `visitor` (the bot can't label on the site repo); their `visitor:` title
   and the site's **Visitor scope** check say what they are. For a question, the PR's "edit the file" link
   opens the fork's branch, which you can edit because the PR allows maintainer edits.

`GITHUB_FORK` must be `owner/repo` under a different account from `GITHUB_REPO`; anything else shows
"Publishing is misconfigured". If the fork's `master` ever has commits of its own, syncing fails and the page
says so (`syncing the fork`): reset the fork's `master` to the site's (Sync fork → Discard commits).


### Turning it off

- **No more links:** set `"PUBLISH_URL": "off"` in `wrangler.jsonc` (by PR). Embeds go back to the file to
  create by hand.
- **Kill the links already in Discord too:** revoke the token on GitHub. Making a new `PUBLISH_SECRET` instead
  invalidates every existing link but leaves publishing on for new ones.
- **Stop submissions:** delete the Worker's `DISCORD_WEBHOOK_URL` (Cloudflare → Workers & Pages → ask →
  Settings → Variables and Secrets); `/submit` then answers 503 and the site shows its error.

### When the token expires

Pressing a link shows "GitHub refused the token"; submissions still reach Discord and nothing else breaks.
Make a new token, replace `PUBLISH_GITHUB_TOKEN`, run the deploy again, and press the link again (links last
30 days).

### Security notes

- Links are HMAC-SHA256 signed (over `publish-link/v1\n` + the payload) and compared in constant time;
  payloads are only decoded after the signature checks out, then validated again against the form's limits on
  every request.
- GET never changes anything. Pages escape every value and send `Cache-Control: no-store`,
  `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer` and a CSP that allows no scripts.
- With `GITHUB_FORK` set, the token is the bot's and can't write to or merge into the site repo; without it,
  the token can (see "Publishing from a bot's fork").
- The token is only ever sent in the `Authorization` header to `api.github.com`, and only `/publish` uses it.
  Nothing logs the token or a visitor's text. Each GitHub call times out after 8 s (25 s for the whole run), and
  rate limits (including secondary ones) get a "try again in a minute" page.
- Visitor text in a PR body sits inside code, so it can't @-mention anyone; it never reaches a title, branch or
  commit message. Keep the site repo's squash message on "default message" (`COMMIT_MESSAGES`): with "pull
  request title and description" the PR body, visitor text included, would land in a `master` commit.
- `/submit` refuses anything but a JSON POST (OPTIONS is the CORS preflight; only the site's origins get CORS
  headers) and bodies over 16 kB. A field called `http` can't change the method the handlers see.
- Rate limits (Workers Rate Limiting, approximate and per Cloudflare location): 5 submissions a minute per
  visitor, 20 a minute in all (under Discord's webhook limit), 20 publish requests a minute per visitor. The
  IP is only the limiter's key: nothing stores or logs it, and invocation logs are off.
