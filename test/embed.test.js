// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { problem, discordPayload } = require('../packages/ask/submit/embed');

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
  const { embeds: [embed] } = discordPayload({ kind: 'subtitle', question }, now);
  assert.equal(embed.title, '✨ Subtitle suggestion');
  assert.equal(embed.description, '"a certified night owl"\ncredit: sam');
  assert.deepEqual(embed.fields, [{ name: 'To approve, paste this', value: "```\n{ text: 'a certified night owl', by: 'sam', added: '2026-10' },\n```" }]);
});

test('a star suggestion', () => {
  const question = '⭐ Star name suggestion\n"Gerald" for the unnamed star near Vega (magnitude 4.3)\nnamed by: sam\napprove: [281.193, 37.605, "Gerald", "sam", "2026-10"]';
  const { embeds: [embed] } = discordPayload({ kind: 'star', question }, now);
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
  const { embeds: [embed] } = discordPayload({ kind: 'star', question }, now);
  assert.equal(embed.fields[0].value, '[281.193, 37.605, "G```x", null, "2026-10"]');
});

test('nobody gets pinged by a visitor\'s text', () => {
  assert.deepEqual(discordPayload({ question: '@everyone hi' }, now).allowed_mentions, { parse: [] });
});
