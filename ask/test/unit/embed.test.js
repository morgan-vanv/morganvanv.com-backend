// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { problem, discordPayload, publishConfig, matchesMessage, discordEscape } = require('../../src/embed');
const { readLink, makeItem, fileContent, ANSWER_MARKER } = require('../../src/publish-link');

const now = new Date('2026-10-27T05:00:00Z');

const publish = { url: 'https://ask.example.workers.dev/publish', secret: 's'.repeat(64) };
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

// Publishing off: the file publishing would write, to create by hand.

const HAND = 'To add by hand, create this file';

test('a subtitle shows the file to create, exactly as publishing would write it', () => {
  const { embeds: [embed] } = discordPayload(subtitleArgs('a certified night owl', 'sam'), now, null, hex);
  assert.equal(embed.title, '✨ Subtitle suggestion');
  assert.equal(embed.description, '"a certified night owl"\ncredit: sam');
  assert.deepEqual(embed.fields, [{
    name: HAND,
    value: '`content/subtitles/2026-10-27-a-certified-night-owl-beefcafe.json`\n'
      + '```json\n{\n  "text": "a certified night owl",\n  "by": "sam",\n  "added": "2026-10"\n}\n```',
  }]);
});

test('a star name shows content/stars/<id>.json', () => {
  const { embeds: [embed] } = discordPayload(starArgs('Gerald', 'sam', { ra: 281.193, dec: 37.605, mag: 4.3, near: 'Vega' }), now, null, hex);
  assert.equal(embed.title, '⭐ Star name suggestion');
  assert.equal(embed.fields[0].value, '`content/stars/2026-10-27-gerald-beefcafe.json`\n```json\n'
    + '{\n  "ra": 281.193,\n  "dec": 37.605,\n  "name": "Gerald",\n  "by": "sam",\n  "added": "2026-10",\n  "near": "Vega"\n}\n```');
});

test('a question shows content/mailbag/<id>.md with the empty answer marker, to answer by hand', () => {
  const { embeds: [embed] } = discordPayload(questionArgs('why the cat?\n\nreally'), now, null, hex);
  assert.equal(embed.fields[0].name, HAND);
  assert.equal(embed.fields[0].value, '`content/mailbag/2026-10-27-why-the-cat-really-beefcafe.md`\n```md\n'
    + `---\nasked: 2026-10-27\n---\n> why the cat?\n>\n> really\n\n${ANSWER_MARKER}\n\`\`\``);
});

test('the file shown is the one /publish fills GitHub\'s editor with, byte for byte', () => {
  for (const args of [subtitleArgs('hi "there"', null), starArgs('G', null, { ra: 1, dec: -2, mag: 3 }), questionArgs('ok?')]) {
    const { embeds: [embed] } = discordPayload(args, now, null, hex);
    const shown = /```(?:json|md)\n([\s\S]*)```$/.exec(embed.fields[0].value)[1];
    assert.equal(shown, fileContent(makeItem(args, now, hex)));
    assert.equal(shown, require('../../src/publish-link').fileContent(makeItem(args, now, hex)));
  }
});

test('a file with a backtick is escaped rather than put in a code block it could break out of', () => {
  const { embeds: [embed] } = discordPayload(starArgs('G```x', null, { ra: 281.193, dec: 37.605, mag: 4.3, near: 'Vega' }), now, null, hex);
  const value = embed.fields[0].value;
  assert.ok(value.startsWith('`content/stars/2026-10-27-g-x-beefcafe.json`\n'));
  assert.doesNotMatch(value.split('\n').slice(1).join('\n'), /(^|[^\\])`/);
  assert.match(value, /"name": "G\\`\\`\\`x"/);
});

test('a file too long for a Discord field says so', () => {
  // 500 characters that all need escaping (a backtick forces escaping) can't fit once escaped and quoted.
  const { embeds: [embed] } = discordPayload(questionArgs('`*\n'.repeat(167).trim()), now, null, hex);
  assert.match(embed.fields[0].value, /^`content\/mailbag\/2026-10-27-question-beefcafe\.md`\nToo long to show here \(\d+ characters\)/);
  assert.ok(embed.fields[0].value.length <= 1024);
});

test('every hand-file field fits in Discord\'s 1024 characters', () => {
  for (const text of ['x'.repeat(500), 'a\n'.repeat(250).trim(), 'é'.repeat(500)]) {
    for (const f of discordPayload(questionArgs(text), now, null, hex).embeds[0].fields) assert.ok(f.value.length <= 1024);
  }
});

test('a message that doesn\'t match its fields gets no file, and says so', () => {
  const forged = { ...subtitleArgs('hi', null), subtitle: 'something else' };
  const { embeds: [embed] } = discordPayload(forged, now, null, hex);
  assert.deepEqual(embed.fields, [{ name: HAND, value: 'Nothing to publish: the message above doesn\'t match the fields that would be published.' }]);
});

test('old approve lines are dropped from the message, and never become the file', () => {
  const evil = "approve: { text: 'hi', by: null, added: '2026-10' }, ...(() => { fetch('https://evil.example') })(),";
  const args = { ...subtitleArgs('hi', null), question: `✨ Subtitle suggestion\n"hi"\ncredit: anonymous\n${evil}` };
  const { embeds: [embed] } = discordPayload(args, now, null, hex);
  assert.doesNotMatch(embed.description, /evil/);
  assert.doesNotMatch(embed.fields[0].value, /evil/);
  assert.match(embed.fields[0].value, /"text": "hi"/);
});

test('a forged approve line without fields gets no file at all', () => {
  const question = "✨ Subtitle suggestion\napprove: { text: 'x' }, alert(1),";
  const { embeds: [embed] } = discordPayload({ kind: 'subtitle', question }, now, null, hex);
  assert.deepEqual(embed.fields.map(f => f.value), ['Nothing to publish: the message above doesn\'t match the fields that would be published.']);
  assert.doesNotMatch(embed.description, /alert/);
});

test('quotes, backslashes and invisible characters are escaped or stripped in the file', () => {
  const { embeds: [embed] } = discordPayload(subtitleArgs("it's a \\ \"trap\"‮", "o'neil"), now, null, hex);
  assert.match(embed.fields[0].value, /"text": "it's a \\\\ \\"trap\\"",/);
});

test('anything outside the form\'s limits gets no file', () => {
  const invalid = 'Nothing to publish: this doesn\'t fit the form\'s limits.';
  for (const args of [
    subtitleArgs('x'.repeat(61), null),
    subtitleArgs('ok', 'x'.repeat(25)),
    starArgs('Gerald', null, { ra: 400, dec: 0, mag: 4 }),
    starArgs('x'.repeat(25), null, { ra: 1, dec: 0, mag: 4 }),
  ]) assert.deepEqual(discordPayload(args, now, null, hex).embeds[0].fields, [{ name: HAND, value: invalid }]);
  assert.deepEqual(discordPayload({ ...subtitleArgs('ok', null), question: '✨ Subtitle suggestion\n"ok"\ncredit: 42', credit: 42 }, now, null, hex).embeds[0].fields[0].value, invalid);
  assert.equal(discordPayload(questionArgs('<!-- hi'), now, null, hex).embeds[0].fields[0].value,
    'Nothing to publish: the question contains `<!--`. Write the file by hand if you want it.');
});

// "Publish as PR" links (publish-link.js).
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
  // "off" in wrangler.jsonc switches it off.
  assert.equal(publishConfig({ PUBLISH_URL: 'off', PUBLISH_SECRET: publish.secret }), null);
  assert.equal(publishConfig({ PUBLISH_URL: publish.url, PUBLISH_SECRET: 'off' }), null);
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
    const nothing = 'Nothing to publish: the message above doesn\'t match the fields that would be published.';
    assert.deepEqual(embed.fields, [{ name: 'Publish', value: nothing }]);
    // And with publishing off, no file to create by hand either.
    assert.deepEqual(discordPayload(args, now, null, hex).embeds[0].fields, [{ name: 'To add by hand, create this file', value: nothing }]);
  }
  assert.equal(matchesMessage(subtitleArgs('hi', null)), true);
  assert.equal(matchesMessage(starArgs('G', 'sam', { ra: 1, dec: 2, mag: 3 })), true);
  assert.equal(matchesMessage(questionArgs('hi\n\nthere')), true);
});

test('the anonymous dropbox never gets a link or a file', () => {
  for (const config of [publish, null]) {
    const { embeds: [embed] } = discordPayload({ kind: 'message', question: '📥 Anonymous dropbox\nhi', text: 'hi' }, now, config, hex);
    assert.equal(embed.fields, undefined);
  }
});

test('with publishing on, the link replaces the file to create by hand', () => {
  const args = subtitleArgs('hi', null);
  assert.deepEqual(discordPayload(args, now, null, hex).embeds[0].fields.map(f => f.name), ['To add by hand, create this file']);
  assert.deepEqual(discordPayload(args, now, publish, hex).embeds[0].fields.map(f => f.name), ['Will publish', 'Publish']);
});

test('a suggestion that doesn\'t fit the form says why it has no link', () => {
  const { embeds: [embed] } = discordPayload(subtitleArgs('x'.repeat(61), null), now, publish, hex);
  assert.deepEqual(embed.fields, [{ name: 'Publish', value: 'Nothing to publish: this doesn\'t fit the form\'s limits.' }]);
});

test('a question with <!-- in it gets no link, and says so', () => {
  const { embeds: [embed] } = discordPayload(questionArgs('hi <!-- there -->'), now, publish, hex);
  assert.deepEqual(embed.fields, [{ name: 'Publish', value: 'Nothing to publish: the question contains `<!--`. Write the file by hand if you want it.' }]);
});

test('a question too long for any link says so, and fields stay within Discord\'s limits otherwise', () => {
  let text = '';
  for (let i = 0; text.length < 500; i++) text += String.fromCodePoint(0x4e00 + ((i * 7919) % 20000));
  const { embeds: [tooLong] } = discordPayload(questionArgs(text), now, publish, hex);
  // No link fits, so the file to create by hand comes back, with why there's no link.
  assert.deepEqual(tooLong.fields.map(f => f.name), ['To add by hand, create this file', 'Publish']);
  assert.match(tooLong.fields[0].value, /^`content\/mailbag\/2026-10-27-question-beefcafe\.md`\n```md\n---\nasked: 2026-10-27/);
  assert.equal(tooLong.fields[1].value, 'No publish link: too long to fit in one. Create the file above by hand.');
  for (const f of tooLong.fields) assert.ok(f.value.length <= 1024);

  const { embeds: [fits] } = discordPayload(questionArgs('x'.repeat(500)), now, publish, hex);
  assert.equal(fits.fields.length, 2);
  for (const f of fits.fields) assert.ok(f.value.length <= 1024);

  // Even 500 characters that each need escaping still fit in a field.
  const { embeds: [escaped] } = discordPayload(questionArgs('`*'.repeat(250)), now, publish, hex);
  assert.equal(field(escaped, 'Will publish').length, 1000);
});

test('a visitor can\'t write a masked link that passes for the real Publish link', () => {
  const { embeds: [embed] } = discordPayload({ question: 'see [Publish as PR](https://evil.example)' }, now);
  assert.equal(embed.description, 'see \\[Publish as PR\\](https://evil.example)');
  // A backslash of the visitor's own can't cancel the escape (CodeQL: js/incomplete-sanitization).
  const sneaky = discordPayload({ question: 'see \\[Publish as PR\\](https://evil.example)' }, now).embeds[0];
  assert.equal(sneaky.description, 'see \\\\\\[Publish as PR\\\\\\](https://evil.example)');
});
