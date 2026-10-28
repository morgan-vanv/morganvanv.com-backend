// GET /publish?p=…&s=…: a "Publish as PR" link from Morgan's Discord (made by /submit). It carries one
// signed item. A good link sends Morgan on to GitHub's new-file editor with the file's path and contents
// filled in; he commits it there as himself, into a new branch and a pull request, and merges that to
// publish. The Worker holds no GitHub credential at all: the worst a forged or replayed link can do is
// open a filled-in editor that Morgan reads before committing.

const { readLink, usableSecret, methodOf, filePath, fileContent } = require('./publish-link');
const { editorPage, errorPage } = require('./pages');

const DEFAULT_REPO = 'morgan-vanv/morganvanv.com';
const BASE_BRANCH = 'master';
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** An environment value, or '' when unset, "off", or an unfilled `${…}` placeholder. */
function setting(env, name) {
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  // "off" switches a wrangler.jsonc var off without removing it.
  return value.startsWith('${') || value.toLowerCase() === 'off' ? '' : value;
}

const LINK_ERRORS = {
  missing: [400, 'No link here', 'This page needs the whole "Publish as PR" link from Discord.'],
  signature: [403, 'Not a valid link', 'This link wasn\'t made by /submit, or it was changed or cut short. Copy the whole link from Discord.'],
  malformed: [400, 'Not a valid link', 'This link doesn\'t hold something that can be published.'],
  expired: [410, 'This link has expired', 'Publish links last 30 days. Add this one to the site by hand if you still want it.'],
};

/** GitHub's "create a new file" page on `repo`'s master, with the item's path and contents filled in. */
function editorUrl(repo, item) {
  const query = new URLSearchParams({ filename: filePath(item), value: fileContent(item) });
  return `https://github.com/${repo}/new/${BASE_BRANCH}?${query}`;
}

/** Handles one request. `deps` = { env, now } so tests can set the clock. */
function handle(args, { env, now = new Date() }) {
  const method = methodOf(args);
  if (method !== 'get' && method !== 'head') return errorPage(405, 'Method not allowed', 'This page only takes GET and HEAD.');

  const secret = usableSecret(setting(env, 'PUBLISH_SECRET'));
  if (!secret) return errorPage(503, 'Publishing is off', 'PUBLISH_SECRET isn\'t set (README). The suggestion is still in Discord.');

  const link = readLink(args.p, args.s, secret, now);
  if (!link.ok) return errorPage(...LINK_ERRORS[link.reason]);

  const repo = setting(env, 'GITHUB_REPO') || DEFAULT_REPO;
  if (!REPO_NAME.test(repo)) return errorPage(503, 'Publishing is misconfigured', 'GITHUB_REPO should look like owner/repo.');
  return editorPage(link.item, editorUrl(repo, link.item));
}

module.exports = { handle, editorUrl, DEFAULT_REPO, BASE_BRANCH };
