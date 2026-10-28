// The "Publish as PR" web function. A link in Morgan's Discord (made by ask/submit) carries one
// signed item:
//   GET  ?p=…&s=…  checks it and shows what would be published, with one button. Never acts:
//                  Discord or a browser may fetch the link on its own.
//   POST p, s      checks it all again, then opens (or finds) the PR and redirects to it.

const { readLink, usableSecret, expiresAt, methodOf } = require('./publish-link');
const { filePath, fileContent, prTitle } = require('./entry');
const { publish, existingPr, GitHubError } = require('./github');
const { confirmPage, usedPage, openedPage, errorPage } = require('./pages');

const DEFAULT_REPO = 'morgan-vanv/morganvanv.com';
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** An environment value, or '' when unset, "off", or an unfilled `${…}` placeholder. */
function setting(env, name) {
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  // "off" switches a wrangler.jsonc var off without removing it.
  return value.startsWith('${') || value.toLowerCase() === 'off' ? '' : value;
}

const LINK_ERRORS = {
  missing: [400, 'No link here', 'This page needs the whole "Publish as PR" link from Discord.'],
  signature: [403, 'Not a valid link', 'This link wasn\'t made by ask/submit, or it was changed or cut short. Copy the whole link from Discord.'],
  malformed: [400, 'Not a valid link', 'This link doesn\'t hold something that can be published.'],
  expired: [410, 'This link has expired', 'Publish links last 30 days. Add this one to the site by hand if you still want it.'],
};

function githubErrorPage(error) {
  if (error.rateLimited) {
    return errorPage(503, 'GitHub says slow down', 'GitHub\'s rate limit was hit. Try again in a minute; it won\'t open a second PR.');
  }
  if (error.timedOut) {
    return errorPage(504, 'GitHub is slow', `GitHub didn't answer in time (${error.step}). Try again in a minute; it won't open a second PR.`);
  }
  if (error.status === 401) {
    return errorPage(502, 'GitHub refused the token',
      'GITHUB_TOKEN was refused: it has probably expired (fine-grained tokens last a year at most). '
      + 'Make a new one as in the README, update the PUBLISH_GITHUB_TOKEN secret and rerun the Ask deploy (README), then press this link again. '
      + 'Submissions still reach Discord in the meantime.');
  }
  if (error.status === 403 || error.status === 404) {
    return errorPage(502, 'GitHub said no',
      `GitHub refused ${error.step} (${error.status}). Check GITHUB_REPO and GITHUB_FORK, and that the token can `
      + 'write to the fork (a classic public_repo token from the bot account), or, without a fork, covers GITHUB_REPO '
      + 'with Contents and Pull requests read/write (README).');
  }
  const detail = error.detail ? ` GitHub said: "${error.detail}"` : '';
  return errorPage(502, 'GitHub had a problem',
    `Something went wrong ${error.step} (${error.status || 'no response'}).${detail} It's safe to try again: it won't open a second PR.`);
}

/**
 * Handles one request. `deps` = { fetch, env, now } so tests can stand in for GitHub and the clock.
 */
async function handle(args, { fetch, env, now = new Date(), callTimeoutMs, budgetMs }) {
  const method = methodOf(args);
  if (method !== 'get' && method !== 'head' && method !== 'post') {
    return errorPage(405, 'Method not allowed', 'This page only takes GET, HEAD and POST.');
  }

  const secret = usableSecret(setting(env, 'PUBLISH_SECRET'));
  if (!secret) return errorPage(503, 'Publishing is off', 'PUBLISH_SECRET isn\'t set (README).');

  const link = readLink(args.p, args.s, secret, now);
  if (!link.ok) return errorPage(...LINK_ERRORS[link.reason]);
  const { item } = link;

  const token = setting(env, 'GITHUB_TOKEN');
  const repo = setting(env, 'GITHUB_REPO') || DEFAULT_REPO;
  if (!token) return errorPage(503, 'Publishing is off', 'GITHUB_TOKEN isn\'t set (README). The suggestion is still in Discord.');
  if (!REPO_NAME.test(repo)) return errorPage(503, 'Publishing is misconfigured', 'GITHUB_REPO should look like owner/repo.');
  // The bot's fork (README, "Publishing from a bot's fork"); off means the branch goes on GITHUB_REPO itself.
  const fork = setting(env, 'GITHUB_FORK') || null;
  if (fork && (!REPO_NAME.test(fork) || fork.split('/')[0].toLowerCase() === repo.split('/')[0].toLowerCase())) {
    return errorPage(503, 'Publishing is misconfigured', 'GITHUB_FORK should be the bot\'s fork, bot-account/repo, owned by a different account from GITHUB_REPO.');
  }

  const github = { fetch, token, repo, fork, callTimeoutMs, budgetMs };
  try {
    if (method !== 'post') {
      const pr = await existingPr(github, item);
      if (pr) return usedPage(pr);
      const entry = { title: prTitle(item), path: filePath(item), content: fileContent(item) };
      return confirmPage(item, entry, args.p, args.s, expiresAt(item.iat));
    }
    const { pr, existed } = await publish(github, item);
    return openedPage(pr, existed);
  } catch (error) {
    if (error instanceof GitHubError) {
      console.error(`ask/publish: ${error.message}`);
      return githubErrorPage(error);
    }
    console.error('ask/publish: unexpected error', error && error.name);
    return errorPage(500, 'Something broke', 'Publishing failed unexpectedly. It\'s safe to try again.');
  }
}

module.exports = { handle, DEFAULT_REPO };
