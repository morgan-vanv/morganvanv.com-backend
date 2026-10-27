// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { problem, discordPayload, approveEntry, publishConfig, matchesMessage, discordEscape } = require('../packages/ask/submit/embed');

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
const hex = () => 'beefcafe';

// Exactly what the site's form sends (contact-submission.ts, sky-naming.ts).
function subtitleArgs(subtitle, credit) {
  const entry = `{ text: '${subtitle}', by: ${credit === null ? 'null' : `'${credit}'`}, added: '2026-10' },`;
  return { kind: 'subtitle', question: `✨ Subtitle suggestion\n"${subtitle}"\ncredit: ${credit ?? 'anonymous'}\napprove: ${entry}`, subtitle, credit };
}
function starArgs(name, credit, star) {
  const where = star.near ? `unnamed star near ${star.near}` : 'unnamed star';
  const question = [
    '⭐ Star name suggestion',
    `${JSON.stringify(name)} for the ${where} (magnitude ${star.mag.toFixed(1)})`,
    `named by: ${credit ?? 'anonymous'}`,
    `approve: [${[star.ra, star.dec, name, credit, '2026-10'].map(v => JSON.stringify(v)).join(', ')}]`,
  ].join('\n');
  return { kind: 'star', question, name, credit, star };
}
function questionArgs(text) {
  return { kind: 'question', question: `❓ Question\n${text}`, text };
}

function field(embed, name) {
  return embed.fields.find(f => f.name === name)?.value;
}

function linkIn(embed) {
  const match = /^\[Publish as PR\]\((https:\/\/[^)]+)\)$/.exec(field(embed, 'Publish'));
  assert.ok(match, field(embed, 'Publish'));
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

test('with publishing on, a subtitle shows exactly what it publishes and a link, instead of the entry to paste', () => {
  const { embeds: [embed] } = discordPayload(subtitleArgs('a certified night owl', 'sam'), now, publish, hex);
  assert.deepEqual(embed.fields.map(f => f.name), ['Will publish', 'Publish']);
  assert.equal(field(embed, 'Will publish'), '```\ntext: "a certified night owl"\nby: "sam"\n```');
  const link = linkIn(embed);
  assert.equal(link.ok, true);
  assert.deepEqual(link.item.fields, { text: 'a certified night owl', by: 'sam' });
  assert.equal(link.item.id, '2026-10-27-a-certified-night-owl-beefcafe');
});

test('with publishing on, a star name and a question get links too', () => {
  const { embeds: [starred] } = discordPayload(starArgs('Gerald', null, { ra: 283.626, dec: 36.899, mag: 4.3, near: 'Vega' }), now, publish, hex);
  assert.deepEqual(linkIn(starred).item.fields, { ra: 283.626, dec: 36.899, name: 'Gerald', by: null, near: 'Vega' });
  assert.equal(field(starred, 'Will publish'), '```\nname: "Gerald"\nby: null\nra: 283.626, dec: 36.899\nnear: "Vega"\n```');

  const { embeds: [asked] } = discordPayload(questionArgs('why the cat?\nreally'), now, publish, hex);
  assert.deepEqual(linkIn(asked).item.fields, { text: 'why the cat?\nreally' });
  assert.equal(field(asked, 'Will publish'), '```\nwhy the cat?\nreally\n```');
});

test('what it publishes is escaped, not put in a code block, when it has a backtick', () => {
  const { embeds: [embed] } = discordPayload(questionArgs('is `code` *bold* <@123> [x](y)?'), now, publish, hex);
  assert.equal(field(embed, 'Will publish'), 'is \\`code\\` \\*bold\\* \\<@123\\> \\[x\\]\\(y\\)?');
  assert.equal(discordEscape('a_b~c|d#e-f\\g'), 'a\\_b\\~c\\|d\\#e\\-f\\\\g');
});

test('no link when the message doesn\'t say what the fields would publish', () => {
  const differs = [
    { ...subtitleArgs('a certified night owl', 'sam'), subtitle: 'something else' },
    { ...subtitleArgs('a certified night owl', 'sam'), credit: 'mallory' },
    { ...subtitleArgs('hi', null), question: '✨ Subtitle suggestion\n"hi"\ncredit: anonymous\nand an extra line' },
    { ...starArgs('Gerald', null, { ra: 1, dec: 2, mag: 4.3, near: 'Vega' }), name: 'Mallory' },
    { ...starArgs('Gerald', null, { ra: 1, dec: 2, mag: 4.3, near: 'Vega' }), star: { ra: 1, dec: 2, near: 'Vega' } },
    { ...questionArgs('why the cat?'), text: 'something else entirely' },
    { kind: 'question', question: 'why the cat?', text: 'why the cat?' },
  ];
  for (const args of differs) {
    const { embeds: [embed] } = discordPayload(args, now, publish, hex);
    assert.deepEqual(embed.fields.filter(f => f.name !== 'To approve, paste this'), [
      { name: 'Publish', value: 'No publish link: the message above doesn\'t match the fields that would be published.' },
    ]);
  }
  assert.equal(matchesMessage(subtitleArgs('hi', null)), true);
  assert.equal(matchesMessage(starArgs('G', 'sam', { ra: 1, dec: 2, mag: 3 })), true);
  assert.equal(matchesMessage(questionArgs('hi\n\nthere')), true);
});

test('the anonymous dropbox never gets a link', () => {
  const { embeds: [embed] } = discordPayload({ kind: 'message', question: '📥 Anonymous dropbox\nhi', text: 'hi' }, now, publish, hex);
  assert.equal(embed.fields, undefined);
});

test('with publishing off, nothing changes', () => {
  const args = subtitleArgs('hi', null);
  assert.deepEqual(discordPayload(args, now, null), discordPayload(args, now));
  assert.deepEqual(discordPayload(args, now).embeds[0].fields.map(f => f.name), ['To approve, paste this']);
});

test('a suggestion that doesn\'t fit the form says why it has no link', () => {
  const { embeds: [embed] } = discordPayload(subtitleArgs('x'.repeat(61), null), now, publish, hex);
  assert.deepEqual(embed.fields, [{ name: 'Publish', value: 'No publish link: this doesn\'t fit the form\'s limits.' }]);
});

test('a question with <!-- in it gets no link, and says so', () => {
  const { embeds: [embed] } = discordPayload(questionArgs('hi <!-- there -->'), now, publish, hex);
  assert.deepEqual(embed.fields, [{ name: 'Publish', value: 'No publish link: the question contains `<!--`. Add it to the site by hand.' }]);
});

test('a question too long for any link says so, and fields stay within Discord\'s limits otherwise', () => {
  let text = '';
  for (let i = 0; text.length < 500; i++) text += String.fromCodePoint(0x4e00 + ((i * 7919) % 20000));
  const { embeds: [tooLong] } = discordPayload(questionArgs(text), now, publish, hex);
  assert.match(tooLong.fields[0].value, /^No publish link: too long/);

  const { embeds: [fits] } = discordPayload(questionArgs('x'.repeat(500)), now, publish, hex);
  assert.equal(fits.fields.length, 2);
  for (const f of fits.fields) assert.ok(f.value.length <= 1024);

  // Even 500 characters that each need escaping still fit in a field.
  const { embeds: [escaped] } = discordPayload(questionArgs('`*'.repeat(250)), now, publish, hex);
  assert.equal(field(escaped, 'Will publish').length, 1000);
});
