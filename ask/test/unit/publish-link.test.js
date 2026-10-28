// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  makeItem, readLink, publishLink, encodeItem, sign, slugify, cleanFields, oneLine, block, isValidItem, usableSecret, methodOf, MAX_LINK_LENGTH,
} = require('../../src/publish-link');

const SECRET = 'a'.repeat(64);
const PUBLISH_URL = 'https://faas-nyc1-x.doserverless.co/api/v1/web/fn-x/ask/publish';
const now = new Date('2026-10-27T05:00:00Z');
const hex = () => '3f2a9c1b';

const subtitle = { kind: 'subtitle', question: '✨ …', subtitle: 'a certified night owl', credit: 'sam' };
const star = { kind: 'star', question: '⭐ …', name: 'Gerald', credit: null, star: { ra: 283.626, dec: 36.899, mag: 4.3, near: 'Vega' } };
const question = { kind: 'question', question: '❓ Question\nwhy the cat?', text: 'why the cat?' };

function parts(url) {
  const query = new URL(url).searchParams;
  return { p: query.get('p'), s: query.get('s') };
}

test('an item per publishable kind, built from the cleaned fields', () => {
  assert.deepEqual(makeItem(subtitle, now, hex), {
    kind: 'subtitle', id: '2026-10-27-a-certified-night-owl-3f2a9c1b', iat: 1793077200, fields: { text: 'a certified night owl', by: 'sam' },
  });
  assert.deepEqual(makeItem(star, now, hex), {
    kind: 'star', id: '2026-10-27-gerald-3f2a9c1b', iat: 1793077200, fields: { ra: 283.626, dec: 36.899, name: 'Gerald', by: null, near: 'Vega' },
  });
  assert.deepEqual(makeItem(question, now, hex), {
    kind: 'question', id: '2026-10-27-why-the-cat-3f2a9c1b', iat: 1793077200, fields: { text: 'why the cat?' },
  });
});

test('the dropbox, unknown kinds and the old form never make an item', () => {
  assert.equal(makeItem({ kind: 'message', question: '📥 …', text: 'hi' }, now, hex), null);
  assert.equal(makeItem({ kind: 'toString', text: 'hi' }, now, hex), null);
  assert.equal(makeItem({ question: 'why the cat?' }, now, hex), null);
});

test('an item never comes from the free-text message, only from the structured fields', () => {
  assert.equal(makeItem({ kind: 'question', question: '❓ Question\nwhy the cat?' }, now, hex), null);
  assert.equal(makeItem({ kind: 'subtitle', question: '✨ …\napprove: { text: \'x\' }' }, now, hex), null);
});

test('fields that don\'t fit the form get no item', () => {
  assert.equal(cleanFields('question', { text: 'x'.repeat(501) }), null);
  assert.equal(cleanFields('question', { text: '  \n ' }), null);
  assert.equal(cleanFields('subtitle', { subtitle: 'x'.repeat(61) }), null);
  assert.equal(cleanFields('subtitle', { subtitle: 'ok', credit: 42 }), null);
  assert.equal(cleanFields('star', { name: 'Gerald', star: { ra: '1', dec: 0 } }), null);
  assert.equal(cleanFields('star', { name: 'Gerald', star: { ra: 360, dec: 0 } }), null);
  assert.equal(cleanFields('star', { name: 'Gerald', star: { ra: 1, dec: -91 } }), null);
  assert.equal(cleanFields('star', { name: 'x'.repeat(25), star: { ra: 1, dec: 0 } }), null);
  assert.deepEqual(cleanFields('question', { text: 'x'.repeat(500) }), { text: 'x'.repeat(500) });
});

test('a star\'s neighbour is optional, and dropped rather than refused when it doesn\'t fit', () => {
  assert.deepEqual(cleanFields('star', { name: 'G', star: { ra: 1, dec: 2 } }), { ra: 1, dec: 2, name: 'G', by: null });
  assert.deepEqual(cleanFields('star', { name: 'G', star: { ra: 1, dec: 2, near: 'x'.repeat(41) } }), { ra: 1, dec: 2, name: 'G', by: null });
  assert.deepEqual(cleanFields('star', { name: 'G', star: { ra: 1, dec: 2, near: { evil: 1 } } }), { ra: 1, dec: 2, name: 'G', by: null });
});

test('a question keeps its line breaks but loses control and invisible characters', () => {
  assert.equal(block('  hi\r\n\r\n\r\n\r\nthere‮\u0007\tyou  \n'), 'hi\n\nthere you');
});

test('slugs are ASCII, lowercase, hyphenated and at most 40 characters', () => {
  assert.equal(slugify('A Certified Night-Owl!', 'subtitle'), 'a-certified-night-owl');
  assert.equal(slugify('Café Ñandú', 'star'), 'cafe-nandu');
  assert.equal(slugify('★☾ 🙂', 'star'), 'star');
  assert.equal(slugify('', 'question'), 'question');
  const long = slugify('what is the best thing about living near the river in cincinnati', 'question');
  assert.equal(long, 'what-is-the-best-thing-about-living-near');
  assert.ok(long.length <= 40);
  assert.equal(slugify('x'.repeat(60), 'q'), 'x'.repeat(40));
});

test('a link round-trips', () => {
  const item = makeItem(star, now, hex);
  const url = publishLink(item, PUBLISH_URL, SECRET);
  assert.ok(url.startsWith(`${PUBLISH_URL}?p=`));
  const { p, s } = parts(url);
  assert.deepEqual(readLink(p, s, SECRET, now), { ok: true, item });
});

test('a tampered payload or signature, or another secret, is refused', () => {
  const item = makeItem(subtitle, now, hex);
  const { p, s } = parts(publishLink(item, PUBLISH_URL, SECRET));
  const forged = encodeItem({ ...item, fields: { text: 'something else', by: null } });
  assert.equal(readLink(forged, s, SECRET, now).reason, 'signature');
  assert.equal(readLink(p, s.replace(/^./, c => (c === 'A' ? 'B' : 'A')), SECRET, now).reason, 'signature');
  assert.equal(readLink(p, s.slice(1), SECRET, now).reason, 'signature');
  assert.equal(readLink(p, s, 'b'.repeat(64), now).reason, 'signature');
  assert.equal(readLink(p.slice(0, -2), s, SECRET, now).reason, 'signature');
  assert.equal(readLink(undefined, s, SECRET, now).reason, 'missing');
  assert.equal(readLink(p, ['x'], SECRET, now).reason, 'missing');
});

test('a signed payload that isn\'t a valid item is still refused', () => {
  const sneaky = (raw) => {
    const p = Buffer.from(JSON.stringify(raw)).toString('base64url');
    return readLink(p, sign(p, SECRET), SECRET, now).reason;
  };
  const t = 1793077200;
  assert.equal(sneaky({ k: 'message', id: '2026-10-27-hi-3f2a9c1b', t, f: { text: 'hi' } }), 'malformed');
  assert.equal(sneaky({ k: 'subtitle', id: '2026-10-27-hi-3f2a9c1b', t, f: { text: 'x'.repeat(61), by: null } }), 'malformed');
  assert.equal(sneaky({ k: 'subtitle', id: '2026-10-27-hi-3f2a9c1b', t, f: { text: ' hi', by: null } }), 'malformed');
  assert.equal(sneaky({ k: 'subtitle', id: '2026-10-27-hi-3f2a9c1b', t, f: { text: 'hi', by: null, extra: 1 } }), 'malformed');
  assert.equal(sneaky({ k: 'subtitle', id: '../../etc-3f2a9c1b', t, f: { text: 'hi', by: null } }), 'malformed');
  assert.equal(sneaky({ k: 'subtitle', id: '2026-10-28-hi-3f2a9c1b', t, f: { text: 'hi', by: null } }), 'malformed');
  assert.equal(sneaky({ k: 'subtitle', id: '2026-10-27-hi-3f2a9c1b', t: '1793077200', f: { text: 'hi', by: null } }), 'malformed');
  assert.equal(sneaky([1, 2]), 'malformed');
  assert.equal(sneaky({ k: 'subtitle', id: '2026-10-27-hi-3f2a9c1b', t, f: { text: 'hi', by: null } }), undefined);
  const notJson = Buffer.from('{nope').toString('base64url');
  assert.equal(readLink(notJson, sign(notJson, SECRET), SECRET, now).reason, 'malformed');
});

test('links expire after 30 days, and can\'t be dated in the future', () => {
  const item = makeItem(subtitle, now, hex);
  const { p, s } = parts(publishLink(item, PUBLISH_URL, SECRET));
  const day = 24 * 60 * 60 * 1000;
  assert.equal(readLink(p, s, SECRET, new Date(now.getTime() + 30 * day)).ok, true);
  assert.equal(readLink(p, s, SECRET, new Date(now.getTime() + 30 * day + 1000)).reason, 'expired');
  assert.equal(readLink(p, s, SECRET, new Date(now.getTime() - 60 * 60 * 1000)).reason, 'expired');
});

test('the signature is checked in constant time', () => {
  const calls = [];
  const original = crypto.timingSafeEqual;
  crypto.timingSafeEqual = (a, b) => { calls.push([a.length, b.length]); return original(a, b); };
  try {
    const { p, s } = parts(publishLink(makeItem(subtitle, now, hex), PUBLISH_URL, SECRET));
    readLink(p, s, SECRET, now);
  } finally {
    crypto.timingSafeEqual = original;
  }
  assert.deepEqual(calls, [[43, 43]]);
});

test('a long question is compressed to fit, and one that can\'t fit gets no link', () => {
  // Accented text is two bytes a character: too long plain, but it compresses.
  const english = makeItem({ kind: 'question', text: 'pourquoi brûle-t-il ? éèàüöçñ âêîôû ëïÿœæ '.repeat(15).slice(0, 500).trim() }, now, hex);
  const plain = `${PUBLISH_URL}?p=${encodeItem(english)}`;
  assert.ok(plain.length > MAX_LINK_LENGTH);
  const url = publishLink(english, PUBLISH_URL, SECRET);
  assert.ok(url && url.length <= MAX_LINK_LENGTH);
  const { p, s } = parts(url);
  assert.ok(p.startsWith('z.'));
  assert.deepEqual(readLink(p, s, SECRET, now).item, english);

  // 500 characters that don't compress: random CJK.
  let text = '';
  const random = crypto.createHash('sha256');
  for (let i = 0; text.length < 500; i++) text += String.fromCharCode(0x4e00 + (random.copy().update(String(i)).digest()[0] * 80 + i) % 20000);
  assert.equal(publishLink(makeItem({ kind: 'question', text }, now, hex), PUBLISH_URL, SECRET), null);
});

test('a short secret, or an unfilled template, is not a secret', () => {
  assert.equal(usableSecret('short'), null);
  assert.equal(usableSecret('${PUBLISH_SECRET}'), null);
  assert.equal(usableSecret(undefined), null);
  assert.equal(usableSecret(SECRET), SECRET);
});

test('isValidItem accepts exactly what makeItem makes', () => {
  for (const args of [subtitle, star, question]) assert.equal(isValidItem(makeItem(args, now, hex)), true);
  assert.equal(isValidItem(null), false);
  assert.equal(isValidItem({ ...makeItem(star, now, hex), kind: 'subtitle' }), false);
});

test('cleaning twice changes nothing, so a link always matches its item when publish cleans it again', () => {
  assert.equal(oneLine('a \u0007 b'), 'a b');
  assert.equal(block('a \u0007 b\n\u0007\n\n\nc'), 'a b\n\nc');
  const pieces = ['a', ' ', '\t', '\n', '\r\n', '\u0007', '\u0000', '​', '‮', ' ', ' ', '\u0085', 'é', '<!', '`'];
  let seed = 7;
  const next = () => (seed = (seed * 48271) % 2147483647);
  for (let i = 0; i < 2000; i++) {
    let text = '';
    for (let j = next() % 12; j > 0; j--) text += pieces[next() % pieces.length];
    assert.equal(oneLine(oneLine(text)), oneLine(text), JSON.stringify(text));
    assert.equal(block(block(text)), block(text), JSON.stringify(text));
    for (const args of [{ kind: 'subtitle', subtitle: `x${text}`, credit: text || null }, { kind: 'question', text: `x${text}` }, { kind: 'star', name: `x${text}`, star: { ra: 1, dec: 1, near: text } }]) {
      const item = makeItem(args, now, hex);
      if (item) assert.equal(isValidItem(item), true, JSON.stringify(args));
    }
  }
});

test('makeItem never returns an item that publish would refuse', () => {
  assert.equal(makeItem(subtitle, now, () => 'xyz'), null);
  assert.equal(makeItem(subtitle, now, () => '3f2a'), null);
  assert.equal(makeItem(subtitle, new Date(NaN), hex), null);
});

test('ids end in 8 random hex characters', () => {
  assert.match(makeItem(star).id, /^\d{4}-\d{2}-\d{2}-gerald-[0-9a-f]{8}$/);
});

test('the signature covers a version prefix, so a bare HMAC of p is not a signature', () => {
  const { p } = parts(publishLink(makeItem(subtitle, now, hex), PUBLISH_URL, SECRET));
  const bare = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  assert.equal(readLink(p, bare, SECRET, now).reason, 'signature');
  assert.equal(sign(p, SECRET), crypto.createHmac('sha256', SECRET).update(`publish-link/v1\n${p}`).digest('base64url'));
});

test('methodOf reads http.method when http is sent, else __ow_method, lowercased', () => {
  assert.equal(methodOf({ http: { method: 'POST' } }), 'post');
  assert.equal(methodOf({ __ow_method: 'get' }), 'get');
  // A non-object `http` (say, a query parameter) says nothing, and never falls back to __ow_method.
  assert.equal(methodOf({ http: 'POST', __ow_method: 'get' }), '');
  assert.equal(methodOf({ http: '1', __ow_method: 'post' }), '');
  assert.equal(methodOf({ http: ['POST'] }), '');
  assert.equal(methodOf({ http: { method: 7 } }), '');
  assert.equal(methodOf({}), '');
  assert.equal(methodOf(undefined), '');
});

test('the secret is trimmed, so a stray space or CR in .env still signs the same', () => {
  const secret = 'x'.repeat(40);
  assert.equal(usableSecret(` ${secret}\r\n`), secret);
  assert.equal(usableSecret(' '.repeat(10) + 'x'.repeat(31)), null);
});

test('a lone surrogate is made well-formed before it reaches a file', () => {
  assert.equal(cleanFields('subtitle', { subtitle: 'hi \ud800 there' }).text, 'hi \ufffd there');
});
