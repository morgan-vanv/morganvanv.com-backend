// Run with: npm run test:unit (node --test)
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeItem, publishLink, ANSWER_MARKER, filePath, fileContent } = require('../../src/publish-link');
const { escapeHtml, editorPage } = require('../../src/pages');
const { handle, editorUrl } = require('../../src/publish');

const SECRET = 'a'.repeat(64);
const PUBLISH_URL = 'https://ask.example.workers.dev/publish';
const REPO = 'morgan-vanv/morganvanv.com';
const now = new Date('2026-10-27T05:00:00Z');
const hex = () => '3f2a9c1b';
const env = { PUBLISH_SECRET: SECRET };

const subtitle = makeItem({ kind: 'subtitle', subtitle: 'a certified night owl', credit: 'sam' }, now, hex);
const star = makeItem({ kind: 'star', name: 'Gerald', credit: null, star: { ra: 283.626, dec: 36.899, near: 'Vega' } }, now, hex);
const question = makeItem({ kind: 'question', text: 'why the cat?\n\n---\nalso: <b>hi</b>' }, now, hex);

function linkArgs(item, method = 'GET') {
  const query = new URL(publishLink(item, PUBLISH_URL, SECRET)).searchParams;
  return { p: query.get('p'), s: query.get('s'), http: { method } };
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

// The editor

test('a good link goes to GitHub\'s new-file editor on master, with the file filled in', () => {
  for (const item of [subtitle, star, question]) {
    const page = handle(linkArgs(item), { env, now });
    assert.equal(page.statusCode, 303);
    const url = new URL(page.headers.Location);
    assert.equal(url.origin, 'https://github.com');
    assert.equal(url.pathname, `/${REPO}/new/master`);
    assert.equal(url.searchParams.get('filename'), filePath(item));
    assert.equal(url.searchParams.get('value'), fileContent(item));
    assert.equal(page.headers.Location, editorUrl(REPO, item));
  }
});

test('a question arrives with the answer marker last, ready for Morgan\'s answer', () => {
  const value = new URL(handle(linkArgs(question), { env, now }).headers.Location).searchParams.get('value');
  assert.ok(value.endsWith(`${ANSWER_MARKER}\n`));
});

test('HEAD answers the same; nothing else is allowed', () => {
  assert.equal(handle(linkArgs(subtitle, 'HEAD'), { env, now }).statusCode, 303);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const page = handle(linkArgs(subtitle, method), { env, now });
    assert.equal(page.statusCode, 405, method);
    assert.equal(page.headers.Allow, 'GET, HEAD');
  }
  assert.equal(handle({ ...linkArgs(subtitle), http: 'GET' }, { env, now }).statusCode, 405);
});

test('GITHUB_REPO picks the repository; "off" or unset means the site', () => {
  assert.match(handle(linkArgs(star), { env: { ...env, GITHUB_REPO: 'someone/fork' }, now }).headers.Location, /^https:\/\/github\.com\/someone\/fork\/new\/master\?/);
  assert.match(handle(linkArgs(star), { env: { ...env, GITHUB_REPO: 'off' }, now }).headers.Location, new RegExp(`^https://github\\.com/${REPO}/new/`));
  assert.equal(handle(linkArgs(star), { env: { ...env, GITHUB_REPO: 'not a repo/../x' }, now }).statusCode, 503);
});

test('bad links, expired links and publishing off each get their own page', () => {
  assert.equal(handle({ http: { method: 'GET' } }, { env, now }).statusCode, 400);
  assert.equal(handle({ p: 'x', s: 'y', http: { method: 'GET' } }, { env, now }).statusCode, 403);
  const tampered = linkArgs(subtitle);
  assert.equal(handle({ ...tampered, s: tampered.s.replace(/.$/, c => (c === 'A' ? 'B' : 'A')) }, { env, now }).statusCode, 403);
  const later = new Date(now.getTime() + 31 * 24 * 3600 * 1000);
  assert.equal(handle(linkArgs(subtitle), { env, now: later }).statusCode, 410);
  assert.equal(handle(linkArgs(subtitle), { env: {}, now }).statusCode, 503);
  assert.equal(handle(linkArgs(subtitle), { env: { PUBLISH_SECRET: 'short' }, now }).statusCode, 503);
  // Signed with another secret: not ours.
  assert.equal(handle(linkArgs(subtitle), { env: { PUBLISH_SECRET: 'b'.repeat(64) }, now }).statusCode, 403);
});

// Pages

test('HTML is escaped everywhere', () => {
  assert.equal(escapeHtml('<a href="x">\'&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  const page = editorPage(subtitle, 'https://github.com/x/y/new/master?value="><script>alert(1)</script>');
  assert.doesNotMatch(page.body, /<script/i);
  assert.match(page.body, /href="https:\/\/github\.com\/x\/y\/new\/master\?value=&quot;&gt;&lt;script&gt;/);
});

test('pages are not cached, indexed or leaking referrers, and run no scripts', () => {
  const page = handle(linkArgs(subtitle), { env, now });
  assert.equal(page.headers['Cache-Control'], 'no-store');
  assert.match(page.headers['X-Robots-Tag'], /noindex/);
  assert.equal(page.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(page.headers['Content-Type'], 'text/html; charset=utf-8');
  const csp = page.headers['Content-Security-Policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /style-src 'sha256-[A-Za-z0-9+/]+=*'/);
  assert.doesNotMatch(csp, /script-src|unsafe/);
  assert.doesNotMatch(page.body, /<script|<form/i);
});

test('even the longest question makes an editor URL GitHub accepts (well under 8 kB)', () => {
  for (const text of ['a'.repeat(500), 'é'.repeat(500), '😀'.repeat(250), 'x\n'.repeat(250)]) {
    const item = makeItem({ kind: 'question', text }, now, hex);
    assert.ok(item);
    assert.ok(editorUrl(REPO, item).length < 6000, text.slice(0, 4));
  }
});
