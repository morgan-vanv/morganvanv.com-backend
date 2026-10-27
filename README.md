# morganvanv.com-backend
back-end repo, don't expect it to be as pretty as the front-end

DigitalOcean Functions (runtime pinned to `nodejs:24`, no dependencies), deployed by hand:

```bash
doctl serverless deploy . --env .env
```

| Function | What it does |
| --- | --- |
| `ask/submit` | Takes the site's Contact form and "name a star" POSTs and forwards them to Morgan's private Discord channel. |
| `ask/publish` | Turns a question, subtitle or star name from Discord into a pull request on the site's repo ("Publish as PR"). |

Tests: `node --test` (no install needed; on Node 22+ don't pass `test/`, a directory isn't accepted).

## Publish as PR

> **Not live yet: leave `PUBLISH_URL` empty until the site side is merged.** The site doesn't read `content/`
> yet, and its check that fails a mailbag PR with an empty answer is still to be built. Until both land, a
> merged visitor PR would publish nothing (or an unanswered question).

### The flow

1. A visitor sends a question, a greeting subtitle or a star name. `ask/submit` posts it to Discord as before.
   When publishing is set up, the embed also shows **Will publish** (exactly the text that would go in the file)
   and a **Publish as PR** link, instead of "To approve, paste this". The anonymous dropbox never gets one, and
   neither does a submission whose message doesn't match its fields the way the site's form builds them, or a
   question containing `<!--`; the embed says why.
2. The link points to `ask/publish` and carries the item itself, signed with `PUBLISH_SECRET`
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

**For the site side (coming):** render the quoted question as plain text, never as HTML or Markdown (it's a
visitor's exact words); find the answer marker only at the start of a line (quoted lines start with `>`, so
they can't fake it); and fail the checks when the answer under it is empty.

### Setup

1. **Create the GitHub token.** GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token.
   - Resource owner: `morgan-vanv`. Expiration: whatever you like, a year at most (put a reminder in your calendar).
   - Repository access: **Only select repositories** → `morgan-vanv/morganvanv.com`.
   - Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**.
     Metadata: Read-only is added by itself. Nothing else: the label calls accept Pull requests permission, so
     Issues isn't needed.
2. **Make the signing secret:** `openssl rand -hex 32`.
3. **Fill `.env`** (copy `.env.example`; keep every key, even empty ones): `PUBLISH_SECRET` and `GITHUB_TOKEN`
   from above, `GITHUB_REPO` empty (it means `morgan-vanv/morganvanv.com`), **`PUBLISH_URL` empty**.
4. **Deploy:** `doctl serverless deploy . --env .env`. With `PUBLISH_URL` empty, Discord looks exactly as before,
   so this is safe to do now.
5. **Note the publish URL:** `doctl serverless functions get ask/publish --url` (it's the `ask/submit` URL with
   `submit` swapped for `publish`). Keep it for step 6; don't put it in `.env` yet.
6. **Once the site side is merged** (it reads `content/` and fails a mailbag PR with an empty answer): put the
   URL in `.env` as `PUBLISH_URL` and deploy again.
7. **Try it:** suggest a subtitle on the site. The Discord message should show **Will publish** and a
   **Publish as PR** link; open it, press the button, and you should land on a new PR labelled `visitor`.
   Remember this test PR stays public even after you close it, so use text you don't mind. Then close it,
   delete its branch, and open the same link again: it should say **Already published (closed)**, not offer to
   open a second PR.

### Turning it off

- **No more links:** empty `PUBLISH_URL` in `.env` and redeploy. Embeds go back to "To approve, paste this".
- **Kill the links already in Discord too:** also empty `GITHUB_TOKEN` (or revoke the token on GitHub). Making a
  new `PUBLISH_SECRET` instead invalidates every existing link but leaves publishing on for new ones.

### When the token expires

Fine-grained tokens expire (a year at most). After that, pressing the button shows "GitHub refused the token";
submissions still reach Discord and nothing else breaks. Make a new token (step 1), put it in `.env`, redeploy,
and press the link again (links last 30 days).

### Security notes

- Links are HMAC-SHA256 signed (over `publish-link/v1\n` + the payload) and compared in constant time;
  payloads are only decoded after the signature checks out, then validated again against the form's limits on
  every request.
- GET never changes anything. Pages escape every value and send `Cache-Control: no-store`,
  `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer` and a CSP that allows no scripts.
- The token is only ever sent in the `Authorization` header to `api.github.com`, and only `ask/publish` has it.
  Nothing logs the token or a visitor's text. Each GitHub call times out after 8 s (25 s for the whole run), and
  rate limits (including secondary ones) get a "try again in a minute" page.
- Visitor text in a PR body sits inside code, so it can't @-mention anyone; it never reaches a title, branch or
  commit message. Keep the site repo's squash message on "default message" (`COMMIT_MESSAGES`): with "pull
  request title and description" the PR body, visitor text included, would land in a `master` commit.
- `ask/submit` refuses anything but POST (OPTIONS is the CORS preflight), including a request whose method the
  platform didn't report.
