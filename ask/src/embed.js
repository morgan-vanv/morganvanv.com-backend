// Turns a submission from the site's Contact form (or the sky's "name a star") into a Discord embed.
//
// The site always sends `question`: a complete, human-readable message whose first line names
// what it is ("❓ Question", "✨ Subtitle suggestion", ...). It also sends `kind`. Older versions of
// this function only knew `question`, so a submission without a known kind still works and gets
// the old generic title.

const { PUBLISHABLE_KINDS, makeItem, publishLink, usableSecret, filePath, fileContent } = require('./publish-link');

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

/**
 * Where "Publish as PR" links point and what signs them, or null when publishing isn't set up
 * (then the embed shows the file to add by hand instead). Both come from the environment (README).
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
  // Older versions of the site add an "approve:" line; current ones (site #109) don't.
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

const MAX_FIELD = 1024;

const NOTHING = {
  mismatch: 'Nothing to publish: the message above doesn\'t match the fields that would be published.',
  comment: 'Nothing to publish: the question contains `<!--`. Write the file by hand if you want it.',
  invalid: 'Nothing to publish: this doesn\'t fit the form\'s limits.',
};
const LINK_TOO_LONG = 'No publish link: too long to fit in one. Create the file above by hand.';
const HAND_FIELD = 'To add by hand, create this file';

/**
 * The file publishing would commit, to create by hand: its path, then its exact contents (in a code
 * block, or escaped when a backtick could break one). Says so when it won't fit in a field.
 */
function handFileField(item) {
  const path = `\`${filePath(item)}\``;
  const content = fileContent(item);
  const shown = content.includes('`')
    ? discordEscape(content)
    : '```' + (item.kind === 'question' ? 'md' : 'json') + '\n' + content + '```';
  const value = `${path}\n${shown}`;
  if (value.length <= MAX_FIELD) return { name: HAND_FIELD, value };
  return {
    name: HAND_FIELD,
    value: `${path}\nToo long to show here (${content.length} characters). Write it by hand from the message above, `
      + 'in the format in the site\'s content/README.md.',
  };
}

/**
 * The fields for a question, subtitle or star name (never the anonymous dropbox):
 *   publishing on:  "Will publish" (the exact text) and "Publish" (the link); if no link fits, the file to
 *                   create by hand and why there's no link;
 *   publishing off: the file to create by hand, exactly as publishing would write it;
 *   either way, one field saying why when there's nothing to publish (the message doesn't match its
 *   fields, a question with `<!--`, or fields outside the form's limits).
 */
function entryFields(args, now, publish, randomHex) {
  if (!PUBLISHABLE_KINDS.includes(args.kind)) return [];
  const why = reason => [{ name: publish ? 'Publish' : HAND_FIELD, value: NOTHING[reason] }];
  if (!matchesMessage(args)) return why('mismatch');
  if (args.kind === 'question' && typeof args.text === 'string' && args.text.includes('<!--')) return why('comment');
  const item = makeItem(args, now, randomHex);
  if (!item) return why('invalid');
  if (!publish) return [handFileField(item)];

  const url = publishLink(item, publish.url, publish.secret);
  const preview = publishPreview(item);
  if (url && preview.length <= MAX_FIELD) {
    return [{ name: 'Will publish', value: preview }, { name: 'Publish', value: `[Publish as PR](${url})` }];
  }
  return [handFileField(item), { name: 'Publish', value: LINK_TOO_LONG }];
}

/**
 * The Discord webhook payload for a valid submission. A question, subtitle or star name also gets a
 * "Publish as PR" link (with `publish`, see publishConfig) or the file to create by hand.
 */
function discordPayload(args, now = new Date(), publish = null, randomHex = undefined) {
  const kind = Object.prototype.hasOwnProperty.call(KINDS, args.kind) ? KINDS[args.kind] : null;
  // Older versions of the site end a suggestion with an "approve:" line for a format the site no longer
  // reads; drop any, so nothing a visitor typed can pose as something to paste.
  const lines = args.question.trim().split('\n').filter(line => !line.trimStart().startsWith('approve:'));

  // The title already says what it is, so drop the matching label line.
  if (kind && lines[0]?.trim() === kind.title) lines.shift();

  const fields = entryFields(args, now, publish, randomHex);

  const { title, color } = kind ?? LEGACY;
  // Square brackets escaped, so a visitor can't write a masked link ([Publish as PR](https://…)) that
  // passes for the real one in the fields below. Backslashes too, or "\[" would undo the escape.
  // The text reads the same.
  const description = lines.join('\n').trim().replace(/[\\[\]]/g, '\\$&') || '(empty)';
  const embed = { title, description, color, timestamp: now.toISOString() };
  if (fields.length) embed.fields = fields;
  // Visitors' text never pings anyone, whatever it says.
  return { embeds: [embed], allowed_mentions: { parse: [] } };
}

module.exports = { problem, discordPayload, publishConfig, matchesMessage, discordEscape, MAX_QUESTION_LENGTH };
