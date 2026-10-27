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

/** The Discord webhook payload for a valid submission. */
function discordPayload(args, now = new Date()) {
  const kind = Object.prototype.hasOwnProperty.call(KINDS, args.kind) ? KINDS[args.kind] : null;
  const lines = args.question.trim().split('\n');

  // The title already says what it is, so drop the matching label line.
  if (kind && lines[0].trim() === kind.title) lines.shift();

  // Pull the "approve:" line out into its own copyable field.
  const fields = [];
  const approveAt = lines.findIndex(line => line.startsWith('approve: '));
  if (approveAt !== -1) {
    const [approve] = lines.splice(approveAt, 1);
    fields.push({ name: 'To approve, paste this', value: '```\n' + approve.slice('approve: '.length) + '\n```' });
  }

  const { title, color } = kind ?? LEGACY;
  const embed = { title, description: lines.join('\n').trim() || '(empty)', color, timestamp: now.toISOString() };
  if (fields.length) embed.fields = fields;
  return { embeds: [embed] };
}

module.exports = { problem, discordPayload, MAX_QUESTION_LENGTH };
