// What a published item becomes in the site's repo: one new file (so pending PRs never conflict),
// on its own branch, with a PR that says how to merge or reject it.
//
// The site reads these exact paths and shapes:
//   content/subtitles/<id>.json  { "text", "by", "added": "YYYY-MM" }
//   content/stars/<id>.json      { "ra", "dec", "name", "by", "added": "YYYY-MM", "near"? }
//   content/mailbag/<id>.md      front matter (asked: YYYY-MM-DD), the question quoted, then Morgan's answer

const DIRECTORIES = { subtitle: 'content/subtitles', star: 'content/stars', question: 'content/mailbag' };

const ANSWER_MARKER = '<!-- Write your answer below this line, then merge. Leave it empty and the site\'s checks will fail. -->';

// Visitor PRs say where they came from; no @-mentions, so nobody is pinged.
const PR_FOOTER = '<sub>Opened by `ask/publish` (morganvanv.com-backend) from a signed link in Morgan\'s Discord.</sub>';


function month(iat) {
  return new Date(iat * 1000).toISOString().slice(0, 7);
}

function day(iat) {
  return new Date(iat * 1000).toISOString().slice(0, 10);
}

function branchName(item) {
  return `visitor/${item.kind}/${item.id}`;
}

function filePath(item) {
  return `${DIRECTORIES[item.kind]}/${item.id}${item.kind === 'question' ? '.md' : '.json'}`;
}

/** The new file's text. */
function fileContent(item) {
  const { kind, fields, iat } = item;
  if (kind === 'subtitle') {
    return JSON.stringify({ text: fields.text, by: fields.by, added: month(iat) }, null, 2) + '\n';
  }
  if (kind === 'star') {
    const star = { ra: fields.ra, dec: fields.dec, name: fields.name, by: fields.by, added: month(iat) };
    if (fields.near) star.near = fields.near;
    return JSON.stringify(star, null, 2) + '\n';
  }
  // Every line of the question is quoted, so nothing in it can end the front matter or pass for the marker.
  const quoted = fields.text.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');
  return `---\nasked: ${day(iat)}\n---\n${quoted}\n\n${ANSWER_MARKER}\n`;
}

/**
 * The PR title: kind and id only. The site squash-merges with the PR title as the commit title, so
 * visitor text here would land on master, where "fixes #12" closes an issue and "owner/repo#3"
 * cross-references from Morgan's account. The id's slug is only [a-z0-9-].
 */
function prTitle(item) {
  return `visitor: ${item.kind} ${item.id}`;
}

/** A Markdown code span or fenced block that visitor text can't close early (and where @-mentions do nothing). */
function fenceFor(text, min) {
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length));
  return '`'.repeat(Math.max(min, longest + 1));
}

function codeSpan(text) {
  const ticks = fenceFor(text, 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function codeBlock(text, language) {
  const fence = fenceFor(text, 3);
  return `${fence}${language}\n${text.replace(/\n$/, '')}\n${fence}`;
}

function signed(degrees) {
  return `${degrees < 0 ? '−' : '+'}${Math.abs(degrees)}°`;
}

function prBody(item, repo) {
  const path = filePath(item);
  const credit = item.fields.by ? codeSpan(item.fields.by) : 'anonymous';
  const lines = [];

  if (item.kind === 'subtitle') {
    lines.push(`A visitor suggested a greeting subtitle (credit: ${credit}).`, '');
  } else if (item.kind === 'star') {
    const near = item.fields.near ? `, near ${codeSpan(item.fields.near)}` : '';
    lines.push(
      `A visitor named a star ${codeSpan(item.fields.name)} (credit: ${credit}).`,
      '',
      `It's at RA ${item.fields.ra}°, Dec ${signed(item.fields.dec)}${near}.`,
      '',
    );
  } else {
    const edit = `https://github.com/${repo}/edit/${branchName(item)}/${path}`;
    lines.push(
      `A visitor asked a question for the mailbag on ${day(item.iat)}.`,
      '',
      `**Answer it before merging:** [edit the file on this branch](${edit}) and write your answer under the comment line. ` +
        'An empty answer fails the site\'s checks.',
      '',
    );
  }

  lines.push(
    '**Merge to publish it. Close to reject it.** Nothing goes live until this is merged. '
      + 'This PR and its text stay public on GitHub either way.',
    '',
    `New file: \`${path}\``,
    '',
    codeBlock(fileContent(item), item.kind === 'question' ? 'markdown' : 'json'),
    '',
    // ask/publish searches for this line to find the PR again, even closed with its branch deleted.
    idLine(item),
    '',
    '---',
    PR_FOOTER,
  );
  return lines.join('\n') + '\n';
}

/** The line in every visitor PR body that names its item (ids are [a-z0-9-], so it's safe to search for). */
function idLine(item) {
  return `Visitor item: \`${item.id}\``;
}

/** Kind and id only, like the title. */
function commitMessage(item) {
  return `visitor: add ${item.kind} ${item.id}`;
}

module.exports = { ANSWER_MARKER, branchName, filePath, fileContent, prTitle, prBody, idLine, commitMessage, codeSpan, codeBlock };
