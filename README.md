# morganvanv.com-backend
back-end repo, don't expect it to be as pretty as the front-end

Two Cloudflare Workers, each deployed by its own workflow from `main`:

- **Ask Morgan** (`ask/`): forwards the site's Contact form to Discord and turns approved submissions into
  PRs ("Publish as PR"). [`ask/README.md`](ask/README.md); `.github/workflows/ask.yml`.
- **The campfire** (`campfire/`): a Worker + SQLite Durable Object behind the site's visitor counter and
  shoutbox. [`campfire/README.md`](campfire/README.md); `.github/workflows/campfire.yml`.

Both workflows test every PR into `main` ("Ask tests" and "Campfire tests" are required checks) and deploy
with secrets from the `production` environment, which only `main` can use.
