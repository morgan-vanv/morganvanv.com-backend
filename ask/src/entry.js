// What a published item becomes in the site's repo: one new file (the path and contents are built in
// publish-link.js, shared with ask/submit), on its own branch, with a PR that says how to merge or reject it.

const { ANSWER_MARKER, filePath, fileContent } = require('./publish-link');

// Visitor PRs say where they came from; no @-mentions, so nobody is pinged.
const PR_FOOTER = '<sub>Opened by `ask/publish` (morganvanv.com-backend) from a signed link in Morgan\'s Discord.</sub>';


function day(iat) {
  return new Date(iat * 1000).toISOString().slice(0, 10);
}

function branchName(item) {
  return `visitor/${item.kind}/${item.id}`;
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

/** `branchRepo` is where the branch lives: the bot's fork when publishing from one, else `repo`. */
function prBody(item, repo, branchRepo = repo) {
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
    const edit = `https://github.com/${branchRepo}/edit/${branchName(item)}/${path}`;
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
