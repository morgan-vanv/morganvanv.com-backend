// Turns a submission from the site's Contact form (or the sky's "name a star") into a Discord embed.
//
// The site always sends `question`: a complete, human-readable message whose first line names
// what it is ("❓ Question", "✨ Subtitle suggestion", ...). It also sends `kind`. Older versions of
// this function only knew `question`, so a submission without a known kind still works and gets
// the old generic title.

const { PUBLISHABLE_KINDS, cleanFields, makeItem, publishLink, usableSecret } = require('./publish-link');

const MAX_QUESTION_LENGTH = 1500;

const KINDS = {
  question: { title: '❓ Question', color: 0x58b9ff },
  message: { title: '📥 Anonymous dropbox', color: 0x8a8f98 },
  subtitle: { title: '✨ Subtitle suggestion', color: 0xc9922a },
  star: { title: '⭐ Star name suggestion', color: 0xffd76a },
};

const LEGACY = { title: '📬 New Anonymous Submission', color: 5814783 };

/** Returns an error message for a submission that shouldn't be sent, or null when it's fine. */
function problem(args) {
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (!question) return 'Question field cannot be empty.';
  if (question.length > MAX_QUESTION_LENGTH) return 'Submission is too long.';
  return null;
}

/** A single-quoted TypeScript string literal (as the site's tsString). */
function tsString(text) {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
}

/**
 * The exact entry Morgan pastes into the site's source to approve a suggestion, or null.
 *
 * Built here from the structured fields, never taken from the visitor's text: whatever is pasted
 * goes into a file that ships to the live site (subtitles.const.ts is code), so a visitor who skips
 * the form must not be able to choose it. Anything that doesn't fit the form's limits gets no entry.
 */
function approveEntry(args, now) {
  const added = now.toISOString().slice(0, 7);
  const fields = args.kind === 'subtitle' || args.kind === 'star' ? cleanFields(args.kind, args) : null;
  if (!fields) return null;

  if (args.kind === 'subtitle') {
    return `{ text: ${tsString(fields.text)}, by: ${fields.by === null ? 'null' : tsString(fields.by)}, added: '${added}' },`;
  }
  return `[${[fields.ra, fields.dec, fields.name, fields.by, added].map(value => JSON.stringify(value)).join(', ')}]`;
}

/**
 * Where "Publish as PR" links point and what signs them, or null when publishing isn't set up
 * (then every embed is exactly as before). Both come from the environment (README).
 */
function publishConfig(env) {
  const url = typeof env.PUBLISH_URL === 'string' ? env.PUBLISH_URL.trim() : '';
  const secret = usableSecret(env.PUBLISH_SECRET);
  return /^https:\/\/[^\s"'<>()]+$/.test(url) && secret ? { url, secret } : null;
}

/**
 * True when the message shown in Discord says what the structured fields say, built the way the
 * site's form builds it (contact-submission.ts, sky-naming.ts). The link publishes the fields, so
 * someone who skips the form must not get a link for text that differs from the message above it.
 */
function matchesMessage(args) {
  if (typeof args.question !== 'string') return false;
  const message = args.question.trim();
  const lines = message.split('\n');
  const rest = lines.slice(3).every(line => line.startsWith('approve: '));
  const credit = args.credit === null || args.credit === undefined ? 'anonymous' : args.credit;

  if (args.kind === 'question') {
    return typeof args.text === 'string' && message === `${KINDS.question.title}\n${args.text}`.trim();
  }
  if (args.kind === 'subtitle') {
    return typeof args.subtitle === 'string' && rest
      && lines[0] === KINDS.subtitle.title
      && lines[1] === `"${args.subtitle}"`
      && lines[2] === `credit: ${credit}`;
  }
  if (args.kind === 'star') {
    const star = args.star && typeof args.star === 'object' ? args.star : {};
    if (typeof args.name !== 'string' || typeof star.mag !== 'number' || !Number.isFinite(star.mag)) return false;
    const where = star.near ? `unnamed star near ${star.near}` : 'unnamed star';
    return rest
      && lines[0] === KINDS.star.title
      && lines[1] === `${JSON.stringify(args.name)} for the ${where} (magnitude ${star.mag.toFixed(1)})`
      && lines[2] === `named by: ${credit}`;
  }
  return false;
}

/** Discord Markdown escaped, so text shows exactly as typed outside a code block. */
function discordEscape(text) {
  return text.replace(/[\\`*_~|<>#\-[\]()]/g, '\\$&');
}

/** What the link would publish, exactly: in a code block, or escaped when a backtick could break one. */
function publishPreview(item) {
  const { fields } = item;
  let text;
  if (item.kind === 'question') text = fields.text;
  else if (item.kind === 'subtitle') text = `text: ${JSON.stringify(fields.text)}\nby: ${JSON.stringify(fields.by)}`;
  else {
    text = `name: ${JSON.stringify(fields.name)}\nby: ${JSON.stringify(fields.by)}\nra: ${fields.ra}, dec: ${fields.dec}`;
    if (fields.near) text += `\nnear: ${JSON.stringify(fields.near)}`;
  }
  return text.includes('`') ? discordEscape(text) : '```\n' + text + '\n```';
}

const NO_LINK = {
  mismatch: 'No publish link: the message above doesn\'t match the fields that would be published.',
  comment: 'No publish link: the question contains `<!--`. Add it to the site by hand.',
  invalid: 'No publish link: this doesn\'t fit the form\'s limits.',
  tooLong: 'No publish link: too long to fit in one. Add it to the site by hand.',
};

/**
 * The fields for a question, subtitle or star name when publishing is set up: "Will publish" (the
 * exact text) and "Publish" (the link), or one "Publish" field saying why there's no link.
 * Nothing for the anonymous dropbox, or when publishing is off.
 */
function publishFields(args, now, publish, randomHex) {
  if (!publish || !PUBLISHABLE_KINDS.includes(args.kind)) return [];
  const why = reason => [{ name: 'Publish', value: NO_LINK[reason] }];
  if (!matchesMessage(args)) return why('mismatch');
  if (args.kind === 'question' && typeof args.text === 'string' && args.text.includes('<!--')) return why('comment');
  const item = makeItem(args, now, randomHex);
  if (!item) return why('invalid');
  const url = publishLink(item, publish.url, publish.secret);
  const preview = publishPreview(item);
  if (!url || preview.length > 1024) return why('tooLong');
  return [{ name: 'Will publish', value: preview }, { name: 'Publish', value: `[Publish as PR](${url})` }];
}

/**
 * The Discord webhook payload for a valid submission. With `publish` (see publishConfig), a
 * question, subtitle or star name gets a "Publish as PR" link in place of the entry to paste.
 */
function discordPayload(args, now = new Date(), publish = null, randomHex = undefined) {
  const kind = Object.prototype.hasOwnProperty.call(KINDS, args.kind) ? KINDS[args.kind] : null;
  // The site ends a suggestion with its own "approve:" line; drop any (it's rebuilt below), so
  // nothing a visitor typed can pose as the line to paste.
  const lines = args.question.trim().split('\n').filter(line => !line.trimStart().startsWith('approve:'));

  // The title already says what it is, so drop the matching label line.
  if (kind && lines[0]?.trim() === kind.title) lines.shift();

  const fields = [];
  const publishing = publishFields(args, now, publish, randomHex);
  const linked = publishing.some(field => field.value.startsWith('[Publish as PR]'));
  const entry = approveEntry(args, now);
  // The entry to paste is the fallback: it goes when there's a link to press instead.
  if (entry && !linked) {
    // A backtick in a visitor's text could close the code block early, so such entries go in as plain text.
    const value = entry.includes('`') ? entry : '```\n' + entry + '\n```';
    fields.push({ name: 'To approve, paste this', value: value.slice(0, 1024) });
  }
  fields.push(...publishing);

  const { title, color } = kind ?? LEGACY;
  const embed = { title, description: lines.join('\n').trim() || '(empty)', color, timestamp: now.toISOString() };
  if (fields.length) embed.fields = fields;
  // Visitors' text never pings anyone, whatever it says.
  return { embeds: [embed], allowed_mentions: { parse: [] } };
}

module.exports = { problem, discordPayload, approveEntry, publishConfig, matchesMessage, discordEscape, MAX_QUESTION_LENGTH };
