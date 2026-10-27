# morganvanv.com-backend
back-end repo, don't expect it to be as pretty as the front-end

Two pieces, deployed separately:

- **Ask Morgan** (`packages/ask/submit`, `project.yml`): a DigitalOcean Function that forwards the site's Ask Morgan form to Discord.
- **The campfire** (`campfire/`): a Cloudflare Worker + SQLite Durable Object behind the site's visitor counter and shoutbox. API, privacy notes, local dev and setup: [`campfire/README.md`](campfire/README.md). Deployed by `.github/workflows/campfire.yml`.
