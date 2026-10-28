// Run with: node --test 'test/**/*.test.js'
// Publishing from a bot's fork (GITHUB_FORK): the branch and file go on the fork, the PR is opened from
// it into the site's repo, and nothing is ever written to the site's repo itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeItem, publishLink } = require('../../src/publish-link');
const { filePath, fileContent, branchName, prTitle } = require('../../src/entry');
const { handle } = require('../../src/publish');

const SECRET = 'a'.repeat(64);
const BOT_TOKEN = 'ghp_BOTTOKEN';
const PUBLISH_URL = 'https://faas-nyc1-x.doserverless.co/api/v1/web/fn-x/ask/publish';
const REPO = 'morgan-vanv/morganvanv.com';
const FORK = 'vanv-bot/morganvanv.com';
const now = new Date('2026-10-27T05:00:00Z');
const hex = () => '3f2a9c1b';
const env = { PUBLISH_SECRET: SECRET, GITHUB_TOKEN: BOT_TOKEN, GITHUB_FORK: FORK };

const subtitle = makeItem({ kind: 'subtitle', subtitle: 'a certified night owl', credit: 'sam' }, now, hex);
const question = makeItem({ kind: 'question', text: 'why the cat?' }, now, hex);

function linkArgs(item, method = 'GET') {
  const query = new URL(publishLink(item, PUBLISH_URL, SECRET)).searchParams;
  return { p: query.get('p'), s: query.get('s'), http: { method, headers: {}, path: '' } };
}

/**
 * Two repos in one network: the site's (which the bot can only open PRs on) and the bot's fork.
 * Any write to the site's repo other than opening a PR fails the test.
 */
function fakeGitHub(options = {}) {
  const site = { refs: new Map([['master', 'livesha']]) };
  const fork = { refs: new Map([['master', options.forkMaster || 'oldsha']]), files: new Map(), diverged: !!options.diverged };
  const pulls = [];
  const calls = [];
  const reply = (status, data) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => data });

  async function fetch(url, init) {
    const method = init.method;
    const { pathname, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname, search: searchParams.toString(), body });
    let match;

    if (pathname.startsWith(`/repos/${REPO}/`)) {
      const path = pathname.slice(`/repos/${REPO}`.length);
      if (method === 'GET' && path === '/pulls') {
        const head = searchParams.get('head');
        return reply(200, pulls.filter(pr => `${pr.headOwner}:${pr.headRef}` === head && fork.refs.has(pr.headRef)).slice(0, 1));
      }
      if (method === 'POST' && path === '/pulls') {
        const [headOwner, headRef] = body.head.split(':');
        if (!headRef) return reply(422, { message: 'head must be owner:branch for a fork' });
        if (headOwner !== FORK.split('/')[0] || !fork.refs.has(headRef)) return reply(422, { message: 'head not found' });
        if (pulls.some(pr => pr.headRef === headRef)) return reply(422, { message: 'A pull request already exists' });
        const pr = { number: 50 + pulls.length, html_url: `https://github.com/${REPO}/pull/${50 + pulls.length}`, state: 'open', merged_at: null, headOwner, headRef, ...body };
        pulls.push(pr);
        return reply(201, pr);
      }
      // Anything else on the site's repo is what fork mode must never do; siteCalls() reports it.
      return reply(403, { message: 'Resource not accessible by personal access token' });
    }

    if (pathname === '/search/issues') {
      const phrase = /"([^"]+)"/.exec(searchParams.get('q'))[1];
      const items = pulls.filter(pr => pr.body.includes(phrase)).map(pr => ({
        number: pr.number, html_url: pr.html_url, state: pr.state, body: pr.body, pull_request: { merged_at: pr.merged_at },
      }));
      return reply(200, { total_count: items.length, items });
    }

    assert.ok(pathname.startsWith(`/repos/${FORK}/`), `unexpected ${method} ${pathname}`);
    const path = pathname.slice(`/repos/${FORK}`.length);
    if (method === 'POST' && path === '/merge-upstream') {
      assert.equal(body.branch, 'master');
      if (fork.diverged) return reply(409, { message: 'There are merge conflicts' });
      fork.refs.set('master', site.refs.get('master'));
      return reply(200, { merge_type: 'fast-forward' });
    }
    if (method === 'GET' && (match = /^\/git\/ref\/heads\/(.+)$/.exec(path))) {
      return fork.refs.has(match[1]) ? reply(200, { object: { sha: fork.refs.get(match[1]) } }) : reply(404, { message: 'Not Found' });
    }
    if (method === 'POST' && path === '/git/refs') {
      const name = body.ref.replace('refs/heads/', '');
      if (fork.refs.has(name)) return reply(422, { message: 'Reference already exists' });
      fork.refs.set(name, body.sha);
      return reply(201, {});
    }
    if ((match = /^\/contents\/(.+)$/.exec(path))) {
      const key = method === 'GET' ? `${searchParams.get('ref')}:${match[1]}` : `${body.branch}:${match[1]}`;
      if (method === 'GET') return fork.files.has(key) ? reply(200, {}) : reply(404, { message: 'Not Found' });
      if (fork.files.has(key)) return reply(422, { message: '"sha" wasn\'t supplied.' });
      fork.files.set(key, Buffer.from(body.content, 'base64').toString('utf8'));
      return reply(201, {});
    }
    return reply(500, { message: `unexpected ${method} ${path}` });
  }
  /** Calls to the site's repo other than listing and opening PRs: always empty in fork mode. */
  const siteCalls = () => calls.filter(call => call.pathname.startsWith(`/repos/${REPO}/`) && call.pathname !== `/repos/${REPO}/pulls`);
  return { fetch, calls, site, fork, pulls, siteCalls };
}

function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  return fn().finally(() => { console.error = original; });
}

test('a fork PR: synced fork, branch from what\'s live, the file on the fork, the PR into the site', async () => {
  const gh = fakeGitHub();
  const response = await handle(linkArgs(subtitle, 'POST'), { fetch: gh.fetch, env, now });
  assert.equal(response.statusCode, 303);
  assert.equal(response.headers.Location, `https://github.com/${REPO}/pull/50`);

  // The fork was brought level first, so the branch starts from the site's live master.
  assert.equal(gh.fork.refs.get(branchName(subtitle)), 'livesha');
  assert.equal(gh.fork.files.get(`${branchName(subtitle)}:${filePath(subtitle)}`), fileContent(subtitle));

  const [pr] = gh.pulls;
  assert.equal(pr.head, `vanv-bot:${branchName(subtitle)}`);
  assert.equal(pr.base, 'master');
  assert.equal(pr.title, prTitle(subtitle));
  assert.equal(pr.maintainer_can_modify, true);
  // Nothing touched the site's repo but the PR itself: no branch, no file, no label.
  assert.deepEqual(gh.siteCalls(), []);
});

test('a question\'s "answer it here" link edits the fork\'s branch', async () => {
  const gh = fakeGitHub();
  await handle(linkArgs(question, 'POST'), { fetch: gh.fetch, env, now });
  assert.match(gh.pulls[0].body, new RegExp(`https://github\\.com/${FORK}/edit/${branchName(question)}/`));
});

test('pressing the button twice finds the fork PR instead of opening another', async () => {
  const gh = fakeGitHub();
  await handle(linkArgs(subtitle, 'POST'), { fetch: gh.fetch, env, now });
  const again = await handle(linkArgs(subtitle, 'POST'), { fetch: gh.fetch, env, now });
  assert.equal(again.statusCode, 303);
  assert.equal(gh.pulls.length, 1);
  const page = await handle(linkArgs(subtitle, 'GET'), { fetch: gh.fetch, env, now });
  assert.match(page.body, /pull\/50/);
});

test('a fork whose master has commits of its own is an error, not a PR from the wrong base', async () => {
  const gh = fakeGitHub({ diverged: true });
  const response = await quietly(() => handle(linkArgs(subtitle, 'POST'), { fetch: gh.fetch, env, now }));
  assert.equal(response.statusCode, 502);
  assert.match(response.body, /syncing the fork/);
  assert.equal(gh.pulls.length, 0);
  assert.deepEqual(gh.siteCalls(), []);
});

test('GITHUB_FORK must be someone else\'s owner/repo; "off" means no fork', async () => {
  for (const bad of ['morgan-vanv/morganvanv.com', 'Morgan-Vanv/fork', 'no-slash', 'a/b/c']) {
    const response = await handle(linkArgs(subtitle, 'POST'), { fetch: fakeGitHub().fetch, env: { ...env, GITHUB_FORK: bad }, now });
    assert.equal(response.statusCode, 503, bad);
    assert.match(response.body, /GITHUB_FORK/);
  }
  // "off": the old way, with the branch on GITHUB_REPO itself (which this bot's token can't do).
  const gh = fakeGitHub();
  const response = await quietly(() => handle(linkArgs(subtitle, 'POST'), { fetch: gh.fetch, env: { ...env, GITHUB_FORK: 'off' }, now }));
  assert.equal(response.statusCode, 502);
  assert.ok(gh.siteCalls().some(call => call.pathname.includes('/git/ref')));
});
