// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeItem, publishLink } = require('../packages/ask/publish/publish-link');
const { ANSWER_MARKER, filePath, fileContent, branchName, prTitle, prBody, commitMessage, codeSpan, codeBlock } = require('../packages/ask/publish/entry');
const { escapeHtml, confirmPage } = require('../packages/ask/publish/pages');
const { handle } = require('../packages/ask/publish/publish');

const SECRET = 'a'.repeat(64);
const TOKEN = 'github_pat_SECRETTOKEN';
const PUBLISH_URL = 'https://faas-nyc1-x.doserverless.co/api/v1/web/fn-x/ask/publish';
const REPO = 'morgan-vanv/morganvanv.com';
const now = new Date('2026-10-27T05:00:00Z');
const hex = () => '3f2a9c1b';
const env = { PUBLISH_SECRET: SECRET, GITHUB_TOKEN: TOKEN };

const subtitle = makeItem({ kind: 'subtitle', subtitle: 'a certified night owl', credit: 'sam' }, now, hex);
const star = makeItem({ kind: 'star', name: 'Gerald', credit: null, star: { ra: 283.626, dec: 36.899, near: 'Vega' } }, now, hex);
const question = makeItem({ kind: 'question', text: 'why the cat?\n\n---\nalso: <b>hi</b>' }, now, hex);

function linkArgs(item, method = 'GET') {
  const query = new URL(publishLink(item, PUBLISH_URL, SECRET)).searchParams;
  return { p: query.get('p'), s: query.get('s'), http: { method, headers: {}, path: '' } };
}

/** A small in-memory GitHub: just the endpoints publishing uses. Records every call. */
function fakeGitHub(options = {}) {
  const state = {
    refs: new Map([['master', 'basesha']]),
    files: new Map(),
    pulls: [],
    labels: new Set(options.labels || []),
    issueLabels: new Map(),
  };
  const calls = [];
  const reply = (status, data, headers = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    json: async () => (data === undefined ? Promise.reject(new Error('no body')) : data),
  });

  async function fetch(url, init) {
    const method = init.method;
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(`/repos/${REPO}`, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, search: searchParams.toString(), body, auth: init.headers.Authorization });
    if (options.hang && options.hang(method, path)) {
      // Never answers; only the caller's AbortSignal ends it.
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (options.fail) {
      const failure = options.fail(method, path);
      if (failure) return reply(...failure);
    }

    if (method === 'GET' && path === '/pulls') {
      // Like GitHub may: a PR whose branch was deleted isn't found by its head any more.
      const head = searchParams.get('head');
      return reply(200, state.pulls.filter(pr => `morgan-vanv:${pr.head}` === head && state.refs.has(pr.head)).slice(0, 1));
    }
    if (method === 'GET' && path === '/search/issues') {
      const q = searchParams.get('q');
      const phrase = /"([^"]+)"/.exec(q)[1];
      assert.ok(q.startsWith(`repo:${REPO} is:pr in:body `));
      const items = state.pulls.filter(pr => pr.body.includes(phrase)).map(pr => ({
        number: pr.number, html_url: pr.html_url, state: pr.state, body: pr.body, pull_request: { merged_at: pr.merged_at },
      }));
      return reply(200, { total_count: items.length, items });
    }
    let match;
    if (method === 'GET' && (match = /^\/git\/ref\/heads\/(.+)$/.exec(path))) {
      return state.refs.has(match[1]) ? reply(200, { object: { sha: state.refs.get(match[1]) } }) : reply(404, { message: 'Not Found' });
    }
    if (method === 'POST' && path === '/git/refs') {
      const name = body.ref.replace('refs/heads/', '');
      if (state.refs.has(name)) return reply(422, { message: 'Reference already exists' });
      state.refs.set(name, body.sha);
      return reply(201, {});
    }
    if ((match = /^\/contents\/(.+)$/.exec(path))) {
      const key = method === 'GET' ? `${searchParams.get('ref')}:${match[1]}` : `${body.branch}:${match[1]}`;
      if (method === 'GET') return state.files.has(key) ? reply(200, {}) : reply(404, { message: 'Not Found' });
      if (!state.refs.has(body.branch)) return reply(404, { message: 'Branch not found' });
      if (state.files.has(key)) return reply(422, { message: '"sha" wasn\'t supplied.' });
      state.files.set(key, Buffer.from(body.content, 'base64').toString('utf8'));
      return reply(201, {});
    }
    if (method === 'POST' && path === '/pulls') {
      if (state.pulls.some(pr => pr.head === body.head)) return reply(422, { message: 'A pull request already exists' });
      const pr = { number: 40 + state.pulls.length, html_url: `https://github.com/${REPO}/pull/${40 + state.pulls.length}`, state: 'open', merged_at: null, head: body.head, ...body };
      state.pulls.push(pr);
      return reply(201, pr);
    }
    if (method === 'GET' && (match = /^\/labels\/(.+)$/.exec(path))) {
      return state.labels.has(match[1]) ? reply(200, { name: match[1] }) : reply(404, { message: 'Not Found' });
    }
    if (method === 'POST' && path === '/labels') {
      state.labels.add(body.name);
      return reply(201, body);
    }
    if (method === 'POST' && (match = /^\/issues\/(\d+)\/labels$/.exec(path))) {
      state.issueLabels.set(Number(match[1]), body.labels);
      return reply(200, []);
    }
    return reply(500, { message: `unexpected ${method} ${path}` });
  }
  /** Morgan closes the PR (and maybe deletes its branch). */
  function close(number, { merged = false, deleteBranch = false } = {}) {
    const pr = state.pulls.find(candidate => candidate.number === number);
    pr.state = 'closed';
    pr.merged_at = merged ? '2026-10-28T00:00:00Z' : null;
    if (deleteBranch) state.refs.delete(pr.head);
  }
  return { fetch, calls, state, close };
}

function quietly(fn) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  return Promise.resolve(fn()).finally(() => { console.error = original; }).then(result => ({ result, logged }));
}

// Files

test('a subtitle becomes content/subtitles/<id>.json', () => {
  assert.equal(filePath(subtitle), 'content/subtitles/2026-10-27-a-certified-night-owl-3f2a9c1b.json');
  assert.equal(fileContent(subtitle), '{\n  "text": "a certified night owl",\n  "by": "sam",\n  "added": "2026-10"\n}\n');
  const anonymous = makeItem({ kind: 'subtitle', subtitle: 'hi "there"', credit: '' }, now, hex);
  assert.deepEqual(JSON.parse(fileContent(anonymous)), { text: 'hi "there"', by: null, added: '2026-10' });
});

test('a star name becomes content/stars/<id>.json, with near only when sent', () => {
  assert.equal(filePath(star), 'content/stars/2026-10-27-gerald-3f2a9c1b.json');
  assert.equal(fileContent(star), '{\n  "ra": 283.626,\n  "dec": 36.899,\n  "name": "Gerald",\n  "by": null,\n  "added": "2026-10",\n  "near": "Vega"\n}\n');
  const alone = makeItem({ kind: 'star', name: 'Gerald', credit: 'sam', star: { ra: 1.5, dec: -2 } }, now, hex);
  assert.deepEqual(JSON.parse(fileContent(alone)), { ra: 1.5, dec: -2, name: 'Gerald', by: 'sam', added: '2026-10' });
});

test('a question becomes content/mailbag/<id>.md, every line quoted', () => {
  assert.equal(filePath(question), 'content/mailbag/2026-10-27-why-the-cat-also-b-hi-b-3f2a9c1b.md');
  assert.equal(fileContent(question), [
    '---',
    'asked: 2026-10-27',
    '---',
    '> why the cat?',
    '>',
    '> ---',
    '> also: <b>hi</b>',
    '',
    '<!-- Write your answer below this line, then merge. Leave it empty and the site\'s checks will fail. -->',
    '',
  ].join('\n'));
});

test('a question can\'t forge the answer marker or the front matter', () => {
  // A question with the marker in it gets no item at all (and so no link).
  assert.equal(makeItem({ kind: 'question', text: `---\n${ANSWER_MARKER}\nmy answer` }, now, hex), null);
  assert.equal(makeItem({ kind: 'question', text: 'hi <!-- there' }, now, hex), null);
  const sneaky = makeItem({ kind: 'question', text: '---\nWrite your answer below this line, then merge. -->\nmy answer' }, now, hex);
  const lines = fileContent(sneaky).split('\n');
  assert.equal(lines.filter(line => line === '---').length, 2);
  assert.deepEqual(lines.filter(line => line.includes('Write your answer')), ['> Write your answer below this line, then merge. -->', ANSWER_MARKER]);
  assert.equal(lines.filter(line => line === ANSWER_MARKER).length, 1);
});

test('branches are visitor/<kind>/<id>', () => {
  assert.equal(branchName(star), 'visitor/star/2026-10-27-gerald-3f2a9c1b');
});

// PR text

test('PR titles and commit messages are the kind and id only, never visitor text', () => {
  assert.equal(prTitle(subtitle), 'visitor: subtitle 2026-10-27-a-certified-night-owl-3f2a9c1b');
  assert.equal(prTitle(star), 'visitor: star 2026-10-27-gerald-3f2a9c1b');
  assert.equal(commitMessage(star), 'visitor: add star 2026-10-27-gerald-3f2a9c1b');
  const sneaky = makeItem({ kind: 'subtitle', subtitle: 'fixes #12 and owner/repo#3 @morgan-vanv', credit: 'x' }, now, hex);
  for (const text of [prTitle(sneaky), commitMessage(sneaky), branchName(sneaky)]) {
    // No `#` (closing keywords and cross-references need one) and no `@`.
    assert.match(text, /^visitor[: /][a-z0-9 :/-]+$/);
  }
});

test('PR bodies say how to publish or reject, with the details per kind', () => {
  const body = prBody(star, REPO);
  assert.match(body, /Merge to publish it\. Close to reject it\./);
  assert.match(body, /RA 283\.626°, Dec \+36\.899°, near `Vega`/);
  assert.match(body, /content\/stars\/2026-10-27-gerald-3f2a9c1b\.json/);
  assert.match(body, /Opened by `ask\/publish`/);
  assert.match(body, /stay public on GitHub/);
  assert.match(body, /\nVisitor item: `2026-10-27-gerald-3f2a9c1b`\n/);

  const asked = prBody(question, REPO);
  assert.match(asked, /Answer it before merging/);
  assert.match(asked, /https:\/\/github\.com\/morgan-vanv\/morganvanv\.com\/edit\/visitor\/question\/2026-10-27-why-the-cat-also-b-hi-b-3f2a9c1b\/content\/mailbag\/2026-10-27-why-the-cat-also-b-hi-b-3f2a9c1b\.md/);
  assert.match(prBody(subtitle, REPO), /credit: `sam`/);
});

test('visitor text in a PR body is only ever inside code, so it can\'t @-mention anyone', () => {
  const pinging = makeItem({ kind: 'subtitle', subtitle: '@morgan-vanv hi ```', credit: '@github' }, now, hex);
  const body = prBody(pinging, REPO);
  const outsideCode = body.replace(/(`{3,})json\n[\s\S]*?\n\1/g, '').replace(/`[^`]*`/g, '');
  assert.doesNotMatch(outsideCode, /@/);
  assert.match(body, /````json\n/);
  assert.equal(codeSpan('a`b'), '``a`b``');
  assert.equal(codeSpan('`x'), '`` `x ``');
  assert.equal(codeBlock('```', 'md'), '````md\n```\n````');
});

// Pages

test('HTML is escaped everywhere', () => {
  assert.equal(escapeHtml('<a href="x">\'&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  const evil = makeItem({ kind: 'subtitle', subtitle: '</pre><script>alert(1)</script>', credit: '"><img src=x>' }, now, hex);
  const page = confirmPage(evil, { title: prTitle(evil), path: filePath(evil), content: fileContent(evil) }, 'p"><x', 's', new Date());
  assert.doesNotMatch(page.body, /<script>|<img/);
  assert.match(page.body, /&lt;\/pre&gt;&lt;script&gt;/);
  assert.match(page.body, /value="p&quot;&gt;&lt;x"/);
});

test('pages are not cached, indexed or leaking referrers, and run no scripts', () => {
  const page = confirmPage(subtitle, { title: prTitle(subtitle), path: filePath(subtitle), content: fileContent(subtitle) }, 'p', 's', new Date());
  assert.equal(page.headers['Cache-Control'], 'no-store');
  assert.match(page.headers['X-Robots-Tag'], /noindex/);
  assert.equal(page.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(page.headers['Content-Type'], 'text/html; charset=utf-8');
  const csp = page.headers['Content-Security-Policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /style-src 'sha256-[A-Za-z0-9+/]+=*'/);
  assert.doesNotMatch(csp, /script-src|unsafe/);
  assert.doesNotMatch(page.body, /<script/);
});

// GET

test('GET shows what will be published and one POST button, and touches nothing', async () => {
  const github = fakeGitHub();
  const page = await handle(linkArgs(subtitle), { fetch: github.fetch, env, now });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /content\/subtitles\/2026-10-27-a-certified-night-owl-3f2a9c1b\.json/);
  assert.match(page.body, /&quot;text&quot;: &quot;a certified night owl&quot;/);
  assert.match(page.body, /<form method="post">/);
  assert.match(page.body, /<button type="submit">Open the pull request<\/button>/);
  assert.match(page.body, /works until 2026-11-26/);
  assert.match(page.body, /<code>visitor: subtitle 2026-10-27-a-certified-night-owl-3f2a9c1b<\/code>/);
  assert.match(page.body, /<button type="submit">Open the pull request<\/button>\n<p class="warn">Opening the PR makes this text public on GitHub, even if you close it later\.<\/p>/);
  assert.deepEqual(github.calls.map(c => `${c.method} ${c.path}`), ['GET /pulls', 'GET /search/issues']);
});

test('GET on a link already used says so and links the PR', async () => {
  const github = fakeGitHub();
  await handle(linkArgs(subtitle, 'POST'), { fetch: github.fetch, env, now });
  const page = await handle(linkArgs(subtitle), { fetch: github.fetch, env, now });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<h1>Already published \(open\)<\/h1>/);
  assert.match(page.body, /<a href="https:\/\/github\.com\/morgan-vanv\/morganvanv\.com\/pull\/40">PR #40<\/a>, which is open/);
});

test('the legacy __ow_method works too', async () => {
  const github = fakeGitHub();
  const { http, ...args } = linkArgs(subtitle);
  assert.ok(http);
  const page = await handle({ ...args, __ow_method: 'get' }, { fetch: github.fetch, env, now });
  assert.match(page.body, /Open the pull request/);
});

// POST

test('POST opens the PR: branch from master, one new file, the PR, the label', async () => {
  const github = fakeGitHub();
  const response = await handle(linkArgs(star, 'POST'), { fetch: github.fetch, env, now });
  assert.equal(response.statusCode, 303);
  assert.equal(response.headers.Location, 'https://github.com/morgan-vanv/morganvanv.com/pull/40');

  assert.deepEqual(github.calls.map(c => `${c.method} ${c.path}`), [
    'GET /pulls',
    'GET /search/issues',
    'GET /git/ref/heads/visitor/star/2026-10-27-gerald-3f2a9c1b',
    'GET /git/ref/heads/master',
    'POST /git/refs',
    'GET /contents/content/stars/2026-10-27-gerald-3f2a9c1b.json',
    'PUT /contents/content/stars/2026-10-27-gerald-3f2a9c1b.json',
    'POST /pulls',
    'GET /labels/visitor',
    'POST /labels',
    'POST /issues/40/labels',
  ]);
  assert.equal(github.calls[0].search, 'head=morgan-vanv%3Avisitor%2Fstar%2F2026-10-27-gerald-3f2a9c1b&state=all&per_page=1');
  assert.equal(github.calls[1].search, `q=${encodeURIComponent(`repo:${REPO} is:pr in:body "2026-10-27-gerald-3f2a9c1b"`).replace(/%20/g, '+')}&per_page=10`);
  assert.deepEqual(github.calls[4].body, { ref: 'refs/heads/visitor/star/2026-10-27-gerald-3f2a9c1b', sha: 'basesha' });
  assert.equal(github.calls[6].body.branch, 'visitor/star/2026-10-27-gerald-3f2a9c1b');
  assert.equal(github.calls[6].body.message, 'visitor: add star 2026-10-27-gerald-3f2a9c1b');
  const pr = github.calls[7].body;
  assert.equal(pr.title, 'visitor: star 2026-10-27-gerald-3f2a9c1b');
  assert.equal(pr.base, 'master');
  assert.equal(pr.head, 'visitor/star/2026-10-27-gerald-3f2a9c1b');

  assert.deepEqual([...github.state.files], [['visitor/star/2026-10-27-gerald-3f2a9c1b:content/stars/2026-10-27-gerald-3f2a9c1b.json', fileContent(star)]]);
  assert.deepEqual(github.state.issueLabels.get(40), ['visitor']);
  for (const call of github.calls) assert.equal(call.auth, `Bearer ${TOKEN}`);
});

test('the label is only created when it\'s missing', async () => {
  const github = fakeGitHub({ labels: ['visitor'] });
  await handle(linkArgs(subtitle, 'POST'), { fetch: github.fetch, env, now });
  assert.ok(!github.calls.some(c => c.method === 'POST' && c.path === '/labels'));
});

test('POST again for the same link returns the same PR and changes nothing', async () => {
  const github = fakeGitHub();
  await handle(linkArgs(subtitle, 'POST'), { fetch: github.fetch, env, now });
  const before = github.calls.length;
  const again = await handle(linkArgs(subtitle, 'POST'), { fetch: github.fetch, env, now });
  assert.equal(again.statusCode, 303);
  assert.equal(again.headers.Location, 'https://github.com/morgan-vanv/morganvanv.com/pull/40');
  assert.deepEqual(github.calls.slice(before).map(c => `${c.method} ${c.path}`), ['GET /pulls']);
  assert.equal(github.state.pulls.length, 1);
});

test('a run cut short part way is finished by the next, reusing the branch and file', async () => {
  const github = fakeGitHub({ fail: (method, path) => (method === 'POST' && path === '/pulls' && github.calls.filter(c => c.path === '/pulls' && c.method === 'POST').length === 1 ? [502, { message: 'Server Error' }] : null) });
  const { result: first } = await quietly(() => handle(linkArgs(question, 'POST'), { fetch: github.fetch, env, now }));
  assert.equal(first.statusCode, 502);
  assert.match(first.body, /safe to try again/);
  assert.equal(github.state.files.size, 1);

  const second = await handle(linkArgs(question, 'POST'), { fetch: github.fetch, env, now });
  assert.equal(second.statusCode, 303);
  const secondCalls = github.calls.slice(github.calls.findIndex((c, i) => i > 0 && c.path === '/pulls' && c.method === 'GET'));
  assert.ok(!secondCalls.some(c => c.path === '/git/refs' || c.method === 'PUT'));
  assert.equal(github.state.files.size, 1);
  assert.equal(github.state.pulls.length, 1);
});

test('a PR opened a moment ago by a double click is returned, not duplicated', async () => {
  const github = fakeGitHub();
  // Both clicks look for a PR before either opens one.
  const [a, b] = await Promise.all([
    handle(linkArgs(subtitle, 'POST'), { fetch: github.fetch, env, now }),
    handle(linkArgs(subtitle, 'POST'), { fetch: github.fetch, env, now }),
  ]);
  assert.equal(a.statusCode, 303);
  assert.equal(b.statusCode, 303);
  assert.equal(a.headers.Location, b.headers.Location);
  assert.equal(github.state.pulls.length, 1);
  assert.equal(github.state.files.size, 1);
});

test('a failing label never fails the publish', async () => {
  const github = fakeGitHub({ fail: (method, path) => (path.includes('labels') ? [403, { message: 'Resource not accessible' }] : null) });
  const { result } = await quietly(() => handle(linkArgs(subtitle, 'POST'), { fetch: github.fetch, env, now }));
  assert.equal(result.statusCode, 303);
});

test('POST checks the link again', async () => {
  const github = fakeGitHub();
  const args = linkArgs(subtitle, 'POST');
  const forged = await handle({ ...args, s: 'A'.repeat(43) }, { fetch: github.fetch, env, now });
  assert.equal(forged.statusCode, 403);
  const late = await handle(args, { fetch: github.fetch, env, now: new Date(now.getTime() + 31 * 86400000) });
  assert.equal(late.statusCode, 410);
  assert.equal(github.calls.length, 0);
});

// Errors

test('error pages: bad links, publishing off, methods', async () => {
  const github = fakeGitHub();
  const deps = { fetch: github.fetch, env, now };
  assert.equal((await handle({ http: { method: 'GET' } }, deps)).statusCode, 400);
  assert.equal((await handle({ p: 'x', s: 'y', http: { method: 'GET' } }, deps)).statusCode, 403);
  assert.equal((await handle({ ...linkArgs(subtitle), http: { method: 'DELETE' } }, deps)).statusCode, 405);
  assert.equal((await handle({ ...linkArgs(subtitle), http: { method: 'DELETE' } }, deps)).headers.Allow, 'GET, HEAD, POST');
  assert.equal((await handle({ ...linkArgs(subtitle), http: 'GET' }, deps)).statusCode, 405);
  const noSecret = await handle(linkArgs(subtitle), { ...deps, env: { GITHUB_TOKEN: TOKEN } });
  assert.equal(noSecret.statusCode, 503);
  const noToken = await handle(linkArgs(subtitle, 'POST'), { ...deps, env: { PUBLISH_SECRET: SECRET, GITHUB_TOKEN: '${GITHUB_TOKEN}' } });
  assert.equal(noToken.statusCode, 503);
  assert.match(noToken.body, /GITHUB_TOKEN isn&#39;t set/);
  const tokenOff = await handle(linkArgs(subtitle, 'POST'), { ...deps, env: { PUBLISH_SECRET: SECRET, GITHUB_TOKEN: 'off' } });
  assert.match(tokenOff.body, /GITHUB_TOKEN isn&#39;t set/);
  const badRepo = await handle(linkArgs(subtitle, 'POST'), { ...deps, env: { ...env, GITHUB_REPO: 'nope' } });
  assert.equal(badRepo.statusCode, 503);
  assert.equal(github.calls.length, 0);
});

test('GITHUB_REPO picks the repository, and defaults to the site', async () => {
  const github = fakeGitHub();
  await handle(linkArgs(subtitle), { fetch: github.fetch, env, now });
  const urls = [];
  await handle(linkArgs(subtitle), { fetch: async (url, init) => { urls.push(url); return github.fetch(url, init); }, env: { ...env, GITHUB_REPO: 'someone/fork' }, now });
  assert.match(urls[0], /^https:\/\/api\.github\.com\/repos\/someone\/fork\/pulls\?/);
});

test('an expired or refused token gets a clear page, without the token', async () => {
  const github = fakeGitHub({ fail: () => [401, { message: 'Bad credentials' }] });
  const { result, logged } = await quietly(() => handle(linkArgs(subtitle, 'POST'), { fetch: github.fetch, env, now }));
  assert.equal(result.statusCode, 502);
  assert.match(result.body, /GitHub refused the token/);
  assert.match(result.body, /expired/);
  assert.doesNotMatch(result.body + logged.join('\n'), /SECRETTOKEN/);
  assert.doesNotMatch(logged.join('\n'), /night owl/);
});

test('missing permissions, rate limits and outages each get their own page', async () => {
  const forbidden = fakeGitHub({ fail: (method, path) => (path === '/git/refs' ? [403, { message: 'Resource not accessible by personal access token' }] : null) });
  const { result: noPermission } = await quietly(() => handle(linkArgs(subtitle, 'POST'), { fetch: forbidden.fetch, env, now }));
  assert.match(noPermission.body, /GitHub refused creating the branch \(403\)/);

  const limited = fakeGitHub({ fail: () => [403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }] });
  const { result: slow } = await quietly(() => handle(linkArgs(subtitle, 'POST'), { fetch: limited.fetch, env, now }));
  assert.equal(slow.statusCode, 503);
  assert.match(slow.body, /rate limit/);

  const secondary = fakeGitHub({ fail: () => [403, { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }] });
  const { result: slower } = await quietly(() => handle(linkArgs(subtitle, 'POST'), { fetch: secondary.fetch, env, now }));
  assert.equal(slower.statusCode, 503);
  assert.match(slower.body, /Try again in a minute/);

  const retryAfter = fakeGitHub({ fail: () => [403, { message: 'Forbidden' }, { 'retry-after': '60' }] });
  const { result: later } = await quietly(() => handle(linkArgs(subtitle, 'POST'), { fetch: retryAfter.fetch, env, now }));
  assert.equal(later.statusCode, 503);

  const down = async () => { throw new Error('ECONNRESET with token github_pat_SECRETTOKEN'); };
  const { result: offline, logged } = await quietly(() => handle(linkArgs(subtitle, 'POST'), { fetch: down, env, now }));
  assert.equal(offline.statusCode, 502);
  assert.match(offline.body, /GitHub could not be reached/);
  assert.doesNotMatch(offline.body + logged.join('\n'), /SECRETTOKEN/);
});

test('a GitHub error message with markup is escaped', async () => {
  const github = fakeGitHub({ fail: (method) => (method === 'PUT' ? [500, { message: '<script>x</script>' }] : null) });
  const { result } = await quietly(() => handle(linkArgs(subtitle, 'POST'), { fetch: github.fetch, env, now }));
  assert.match(result.body, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(result.body, /<script>/);
});

test('a used link whose PR was closed and its branch deleted is still found (by its id), never reopened', async () => {
  const github = fakeGitHub();
  await handle(linkArgs(subtitle, 'POST'), { fetch: github.fetch, env, now });
  github.close(40, { deleteBranch: true });

  const page = await handle(linkArgs(subtitle), { fetch: github.fetch, env, now });
  assert.match(page.body, /<h1>Already published \(closed\)<\/h1>/);

  const again = await handle(linkArgs(subtitle, 'POST'), { fetch: github.fetch, env, now });
  assert.equal(again.statusCode, 303);
  assert.match(again.body, /<h1>Already published \(closed\)<\/h1>/);
  assert.equal(github.state.pulls.length, 1);
  assert.ok(!github.state.refs.has(branchName(subtitle)));
});

test('a merged PR reads as merged', async () => {
  const github = fakeGitHub();
  await handle(linkArgs(star, 'POST'), { fetch: github.fetch, env, now });
  github.close(40, { merged: true, deleteBranch: true });
  const page = await handle(linkArgs(star), { fetch: github.fetch, env, now });
  assert.match(page.body, /<h1>Already published \(merged\)<\/h1>/);
});

test('search only counts a PR whose body has the exact id line', async () => {
  const github = fakeGitHub();
  // Another PR that merely mentions the id in passing.
  github.state.pulls.push({ number: 7, html_url: `https://github.com/${REPO}/pull/7`, state: 'closed', merged_at: null, head: 'other', body: `see ${subtitle.id}` });
  const page = await handle(linkArgs(subtitle), { fetch: github.fetch, env, now });
  assert.match(page.body, /Open the pull request/);
});

test('a GitHub call that hangs times out with a friendly page', async () => {
  const github = fakeGitHub({ hang: (method, path) => path === '/git/refs' });
  const { result } = await quietly(() => handle(linkArgs(subtitle, 'POST'), { fetch: github.fetch, env, now, callTimeoutMs: 20 }));
  assert.equal(result.statusCode, 504);
  assert.match(result.body, /GitHub didn&#39;t answer in time \(creating the branch\)/);
});

test('the whole run has a budget, so it ends before DigitalOcean\'s timeout', async () => {
  const slow = fakeGitHub();
  const fetch = (url, init) => new Promise(resolve => setTimeout(() => resolve(slow.fetch(url, init)), 15));
  const { result } = await quietly(() => handle(linkArgs(subtitle, 'POST'), { fetch, env, now, budgetMs: 40 }));
  assert.equal(result.statusCode, 504);
  assert.ok(slow.calls.length < 5);
});
