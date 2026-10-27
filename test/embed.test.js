// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { problem, discordPayload, approveEntry, publishConfig } = require('../packages/ask/submit/embed');

const now = new Date('2026-10-27T05:00:00Z');

test('a submission from the old form keeps the old generic embed', () => {
  const { embeds: [embed] } = discordPayload({ question: '  why the cat?  ' }, now);
  assert.equal(embed.title, '📬 New Anonymous Submission');
  assert.equal(embed.description, 'why the cat?');
  assert.equal(embed.color, 5814783);
  assert.equal(embed.timestamp, '2026-10-27T05:00:00.000Z');
});

test('a known kind gets its own title, without repeating the label line', () => {
  const { embeds: [embed] } = discordPayload({ kind: 'message', question: '📥 Anonymous dropbox\nlove the campfire' }, now);
  assert.equal(embed.title, '📥 Anonymous dropbox');
  assert.equal(embed.description, 'love the campfire');
});

test('the approve line becomes its own copyable field', () => {
  const question = [
    '✨ Subtitle suggestion',
    '"a certified night owl"',
    'credit: sam',
    "approve: { text: 'a certified night owl', by: 'sam', added: '2026-10' },",
  ].join('\n');
  const { embeds: [embed] } = discordPayload({ kind: 'subtitle', question, subtitle: 'a certified night owl', credit: 'sam' }, now);
  assert.equal(embed.title, '✨ Subtitle suggestion');
  assert.equal(embed.description, '"a certified night owl"\ncredit: sam');
  assert.deepEqual(embed.fields, [{ name: 'To approve, paste this', value: "```\n{ text: 'a certified night owl', by: 'sam', added: '2026-10' },\n```" }]);
});

test('a star suggestion', () => {
  const question = '⭐ Star name suggestion\n"Gerald" for the unnamed star near Vega (magnitude 4.3)\nnamed by: sam\napprove: [281.193, 37.605, "Gerald", "sam", "2026-10"]';
  const { embeds: [embed] } = discordPayload({ kind: 'star', question, name: 'Gerald', credit: 'sam', star: { ra: 281.193, dec: 37.605, mag: 4.3, near: 'Vega' } }, now);
  assert.equal(embed.title, '⭐ Star name suggestion');
  assert.match(embed.fields[0].value, /\[281\.193, 37\.605, "Gerald", "sam", "2026-10"\]/);
});

test('an unknown kind falls back to the generic title and keeps every line', () => {
  const { embeds: [embed] } = discordPayload({ kind: 'toString', question: 'a\nb' }, now);
  assert.equal(embed.title, '📬 New Anonymous Submission');
  assert.equal(embed.description, 'a\nb');
});

test('empty and oversized submissions are refused', () => {
  assert.equal(problem({}), 'Question field cannot be empty.');
  assert.equal(problem({ question: '   ' }), 'Question field cannot be empty.');
  assert.equal(problem({ question: 'x'.repeat(1501) }), 'Submission is too long.');
  assert.equal(problem({ question: 'fine' }), null);
});

test('an approve entry with a backtick is not put in a code block it could break out of', () => {
  const question = '⭐ Star name suggestion\n"G```x" for the unnamed star near Vega (magnitude 4.3)\napprove: [281.193, 37.605, "G```x", null, "2026-10"]';
  const { embeds: [embed] } = discordPayload({ kind: 'star', question, name: 'G```x', credit: null, star: { ra: 281.193, dec: 37.605 } }, now);
  assert.equal(embed.fields[0].value, '[281.193, 37.605, "G```x", null, "2026-10"]');
});

test('nobody gets pinged by a visitor\'s text', () => {
  assert.deepEqual(discordPayload({ question: '@everyone hi' }, now).allowed_mentions, { parse: [] });
});

test('the approve entry is built from the fields, never taken from the visitor\'s text', () => {
  const evil = "approve: { text: 'hi', by: null, added: '2026-10' }, ...(() => { fetch('https://evil.example') })(),";
  const question = `✨ Subtitle suggestion\n"hi"\ncredit: anonymous\n${evil}`;
  const { embeds: [embed] } = discordPayload({ kind: 'subtitle', question, subtitle: 'hi', credit: null }, now);
  assert.deepEqual(embed.fields, [{ name: 'To approve, paste this', value: "```\n{ text: 'hi', by: null, added: '2026-10' },\n```" }]);
  assert.doesNotMatch(embed.description, /evil/);
});

test('a forged approve line without fields gets no entry at all', () => {
  const question = "✨ Subtitle suggestion\napprove: { text: 'x' }, alert(1),";
  const { embeds: [embed] } = discordPayload({ kind: 'subtitle', question }, now);
  assert.equal(embed.fields, undefined);
  assert.doesNotMatch(embed.description, /alert/);
});

test('quotes, backslashes and invisible characters in a subtitle are escaped or stripped', () => {
  assert.equal(
    approveEntry({ kind: 'subtitle', subtitle: "it's a \\ trap\u202e\n', x: 1 //", credit: "o'neil" }, now),
    "{ text: 'it\\'s a \\\\ trap \\', x: 1 //', by: 'o\\'neil', added: '2026-10' },",
  );
});

test('anything outside the form\'s limits gets no entry', () => {
  assert.equal(approveEntry({ kind: 'subtitle', subtitle: 'x'.repeat(61) }, now), null);
  assert.equal(approveEntry({ kind: 'subtitle', subtitle: 'ok', credit: 'x'.repeat(25) }, now), null);
  assert.equal(approveEntry({ kind: 'subtitle', subtitle: 'ok', credit: 42 }, now), null);
  assert.equal(approveEntry({ kind: 'star', name: 'Gerald', star: { ra: '1);alert(1', dec: 0 } }, now), null);
  assert.equal(approveEntry({ kind: 'star', name: 'Gerald', star: { ra: 400, dec: 0 } }, now), null);
  assert.equal(approveEntry({ kind: 'star', name: 'x'.repeat(25), star: { ra: 1, dec: 0 } }, now), null);
  assert.equal(approveEntry({ kind: 'question', subtitle: 'ok' }, now), null);
});

// "Publish as PR" links (publish-link.js); every test above runs with publishing off.
const { readLink } = require('../packages/ask/submit/publish-link');

const publish = { url: 'https://faas-nyc1-x.doserverless.co/api/v1/web/fn-x/ask/publish', secret: 's'.repeat(64) };
const hex = () => 'beef';

function linkIn(embed) {
  const field = embed.fields.find(f => f.name === 'Publish');
  const match = /^\[Publish as PR\]\((https:\/\/[^)]+)\)$/.exec(field.value);
  assert.ok(match, field.value);
  const query = new URL(match[1]).searchParams;
  return readLink(query.get('p'), query.get('s'), publish.secret, now);
}

test('publishing is on only with an https PUBLISH_URL and a long enough PUBLISH_SECRET', () => {
  assert.equal(publishConfig({}), null);
  assert.equal(publishConfig({ PUBLISH_URL: publish.url }), null);
  assert.equal(publishConfig({ PUBLISH_SECRET: publish.secret }), null);
  assert.equal(publishConfig({ PUBLISH_URL: publish.url, PUBLISH_SECRET: 'short' }), null);
  assert.equal(publishConfig({ PUBLISH_URL: 'http://insecure.example', PUBLISH_SECRET: publish.secret }), null);
  assert.equal(publishConfig({ PUBLISH_URL: '${PUBLISH_URL}', PUBLISH_SECRET: '${PUBLISH_SECRET}' }), null);
  assert.deepEqual(publishConfig({ PUBLISH_URL: ` ${publish.url} `, PUBLISH_SECRET: publish.secret }), publish);
});

test('with publishing on, a subtitle gets a Publish as PR link instead of the entry to paste', () => {
  const args = { kind: 'subtitle', question: '✨ Subtitle suggestion\n"a certified night owl"', subtitle: 'a certified night owl', credit: 'sam' };
  const { embeds: [embed] } = discordPayload(args, now, publish, hex);
  assert.deepEqual(embed.fields.map(f => f.name), ['Publish']);
  const link = linkIn(embed);
  assert.equal(link.ok, true);
  assert.deepEqual(link.item.fields, { text: 'a certified night owl', by: 'sam' });
  assert.equal(link.item.id, '2026-10-27-a-certified-night-owl-beef');
});

test('with publishing on, a star name and a question get links too', () => {
  const starArgs = { kind: 'star', question: '⭐ Star name suggestion', name: 'Gerald', credit: null, star: { ra: 283.626, dec: 36.899, mag: 4.3, near: 'Vega' } };
  assert.deepEqual(linkIn(discordPayload(starArgs, now, publish, hex).embeds[0]).item.fields, { ra: 283.626, dec: 36.899, name: 'Gerald', by: null, near: 'Vega' });
  const questionArgs = { kind: 'question', question: '❓ Question\nwhy the cat?', text: 'why the cat?' };
  assert.deepEqual(linkIn(discordPayload(questionArgs, now, publish, hex).embeds[0]).item.fields, { text: 'why the cat?' });
});

test('the anonymous dropbox never gets a link', () => {
  const { embeds: [embed] } = discordPayload({ kind: 'message', question: '📥 Anonymous dropbox\nhi', text: 'hi' }, now, publish, hex);
  assert.equal(embed.fields, undefined);
});

test('with publishing off, nothing changes', () => {
  const args = { kind: 'subtitle', question: '✨ Subtitle suggestion\n"hi"', subtitle: 'hi', credit: null };
  assert.deepEqual(discordPayload(args, now, null), discordPayload(args, now));
  assert.deepEqual(discordPayload(args, now).embeds[0].fields.map(f => f.name), ['To approve, paste this']);
});

test('a suggestion that doesn\'t fit the form says why it has no link', () => {
  const { embeds: [embed] } = discordPayload({ kind: 'subtitle', question: '✨ Subtitle suggestion\nx', subtitle: 'x'.repeat(61) }, now, publish, hex);
  assert.deepEqual(embed.fields, [{ name: 'Publish', value: 'No publish link: this doesn\'t match what the form sends.' }]);
});

test('a question too long for any link says so, and the link stays within Discord\'s limits otherwise', () => {
  let text = '';
  for (let i = 0; text.length < 500; i++) text += String.fromCodePoint(0x4e00 + ((i * 7919) % 20000));
  const { embeds: [tooLong] } = discordPayload({ kind: 'question', question: '❓ Question\n…', text }, now, publish, hex);
  assert.match(tooLong.fields[0].value, /^No publish link: too long/);

  const { embeds: [fits] } = discordPayload({ kind: 'question', question: '❓ Question\n…', text: 'x'.repeat(500) }, now, publish, hex);
  assert.ok(fits.fields[0].value.length <= 1024);
});
