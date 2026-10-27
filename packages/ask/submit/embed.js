// Turns a submission from the site's Contact form (or the sky's "name a star") into a Discord embed.
//
// The site always sends `question`: a complete, human-readable message whose first line names
// what it is ("❓ Question", "✨ Subtitle suggestion", ...). It also sends `kind`. Older versions of
// this function only knew `question`, so a submission without a known kind still works and gets
// the old generic title.

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

// The site's own limits (SUBTITLE_MAX_LENGTH, CREDIT_MAX_LENGTH, MAX_NAME); longer means it didn't come from the form.
const MAX_SUBTITLE = 60;
const MAX_CREDIT = 24;
const MAX_STAR_NAME = 24;

/** One line of visitor text: no invisible or control characters, whitespace collapsed (as the site's oneLine). */
function oneLine(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\p{Cf}]/gu, '').replace(/\s+/g, ' ').replace(/\p{Cc}/gu, '').trim();
}

/** A single-quoted TypeScript string literal (as the site's tsString). */
function tsString(text) {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
}

/** A credit: null for anonymous, undefined when it's not something the form could have sent. */
function creditOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const credit = oneLine(value);
  if (credit.length > MAX_CREDIT) return undefined;
  return credit || null;
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
  const credit = creditOf(args.credit);
  if (credit === undefined) return null;

  if (args.kind === 'subtitle') {
    const text = oneLine(args.subtitle);
    if (!text || text.length > MAX_SUBTITLE) return null;
    return `{ text: ${tsString(text)}, by: ${credit === null ? 'null' : tsString(credit)}, added: '${added}' },`;
  }

  if (args.kind === 'star') {
    const name = oneLine(args.name);
    const star = args.star;
    if (!name || name.length > MAX_STAR_NAME || !star || typeof star !== 'object') return null;
    const { ra, dec } = star;
    const okRa = typeof ra === 'number' && Number.isFinite(ra) && ra >= 0 && ra < 360;
    const okDec = typeof dec === 'number' && Number.isFinite(dec) && dec >= -90 && dec <= 90;
    if (!okRa || !okDec) return null;
    return `[${[ra, dec, name, credit, added].map(value => JSON.stringify(value)).join(', ')}]`;
  }

  return null;
}

/** The Discord webhook payload for a valid submission. */
function discordPayload(args, now = new Date()) {
  const kind = Object.prototype.hasOwnProperty.call(KINDS, args.kind) ? KINDS[args.kind] : null;
  // The site ends a suggestion with its own "approve:" line; drop any (it's rebuilt below), so
  // nothing a visitor typed can pose as the line to paste.
  const lines = args.question.trim().split('\n').filter(line => !line.trimStart().startsWith('approve:'));

  // The title already says what it is, so drop the matching label line.
  if (kind && lines[0]?.trim() === kind.title) lines.shift();

  const fields = [];
  const entry = approveEntry(args, now);
  if (entry) {
    // A backtick in a visitor's text could close the code block early, so such entries go in as plain text.
    const value = entry.includes('`') ? entry : '```\n' + entry + '\n```';
    fields.push({ name: 'To approve, paste this', value: value.slice(0, 1024) });
  }

  const { title, color } = kind ?? LEGACY;
  const embed = { title, description: lines.join('\n').trim() || '(empty)', color, timestamp: now.toISOString() };
  if (fields.length) embed.fields = fields;
  // Visitors' text never pings anyone, whatever it says.
  return { embeds: [embed], allowed_mentions: { parse: [] } };
}

module.exports = { problem, discordPayload, approveEntry, MAX_QUESTION_LENGTH };
