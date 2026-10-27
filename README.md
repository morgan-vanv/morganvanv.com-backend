# morganvanv.com-backend
back-end repo, don't expect it to be as pretty as the front-end

DigitalOcean Functions, deployed by hand:

```bash
doctl serverless deploy . --env .env
```

| Function | What it does |
| --- | --- |
| `ask/submit` | Takes the site's Contact form and "name a star" POSTs and forwards them to Morgan's private Discord channel. |
| `ask/publish` | Turns a question, subtitle or star name from Discord into a pull request on the site's repo ("Publish as PR"). |

Tests: `node --test` (Node 18+, no install needed).

## Publish as PR

### The flow

1. A visitor sends a question, a greeting subtitle or a star name. `ask/submit` posts it to Discord as before.
   When publishing is set up, the embed also gets a **Publish as PR** link instead of "To approve, paste this".
   The anonymous dropbox never gets one.
2. The link points to `ask/publish` and carries the item itself, signed with `PUBLISH_SECRET`
   (an HMAC, so nobody can make or change one). It's built from the form's structured fields, cleaned and held
   to the form's limits, never from the free-text message. Links last 30 days.
3. Opening the link (GET) shows what would be published, the file it goes in and one **Open the pull request**
   button. Opening it does nothing else: Discord or a browser may fetch a link by itself. A link already used
   says so and links its PR.
4. The button (POST) checks everything again, then makes branch `visitor/<kind>/<id>` from `master`, adds one
   new file and opens a PR into `master` labelled `visitor`, and takes you to it. Pressing it twice, or again
   after an error, finds what's already there and returns the same PR.
5. **Merge to publish, close to reject.** For a question, write the answer in the PR first (the body links
   straight to the file's editor on that branch); the site's checks fail on an empty answer.

One file per entry, so pending PRs never conflict. `<id>` is `YYYY-MM-DD-<slug>-<4 hex>` (UTC date):

| Kind | File | Contents |
| --- | --- | --- |
| Subtitle | `content/subtitles/<id>.json` | `{ "text", "by": "sam" \| null, "added": "YYYY-MM" }` |
| Star name | `content/stars/<id>.json` | `{ "ra", "dec", "name", "by", "added", "near"? }` |
| Question | `content/mailbag/<id>.md` | front matter `asked: YYYY-MM-DD`, the question with every line quoted (`> `), then a comment line to answer under |

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
   from above, `GITHUB_REPO` empty (it means `morgan-vanv/morganvanv.com`), `PUBLISH_URL` empty for now.
4. **Deploy:** `doctl serverless deploy . --env .env`. With `PUBLISH_URL` empty, Discord looks exactly as before.
5. **Point the links at the new function:** `doctl serverless functions get ask/publish --url`, put that in
   `.env` as `PUBLISH_URL`, and deploy again. (It's the `ask/submit` URL with `submit` swapped for `publish`, so
   you can also fill it in before the first deploy and skip the second.)
6. **Try it:** suggest a subtitle on the site. The Discord message should have a **Publish as PR** link; open it,
   press the button, and you should land on a new PR labelled `visitor`. Close it and delete its branch if it was
   only a test.

### Turning it off

- **No more links:** empty `PUBLISH_URL` in `.env` and redeploy. Embeds go back to "To approve, paste this".
- **Kill the links already in Discord too:** also empty `GITHUB_TOKEN` (or revoke the token on GitHub). Making a
  new `PUBLISH_SECRET` instead invalidates every existing link but leaves publishing on for new ones.

### When the token expires

Fine-grained tokens expire (a year at most). After that, pressing the button shows "GitHub refused the token";
submissions still reach Discord and nothing else breaks. Make a new token (step 1), put it in `.env`, redeploy,
and press the link again (links last 30 days).

### Security notes

- Links are HMAC-SHA256 signed and compared in constant time; payloads are only decoded after the signature
  checks out, then validated again against the form's limits on every request.
- GET never changes anything. Pages escape every value and send `Cache-Control: no-store`,
  `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer` and a CSP that allows no scripts.
- The token is only ever sent in the `Authorization` header to `api.github.com`, and only `ask/publish` has it.
  Nothing logs the token or a visitor's text.
- Visitor text in a PR body sits inside code, so it can't @-mention anyone.
