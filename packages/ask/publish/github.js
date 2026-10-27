// Opens the PR for an item with GitHub's REST API: a branch from master, one new file on it, a PR
// labelled `visitor`. Safe to run again for the same item (a double click, a retry after an error):
// whatever already exists is reused, and an existing PR is returned rather than a second one opened.
//
// The token only ever goes in the Authorization header. Nothing here logs it or the visitor's text.

const { branchName, filePath, fileContent, prTitle, prBody, commitMessage } = require('./entry');

const API = 'https://api.github.com';
const BASE_BRANCH = 'master';
const LABEL = { name: 'visitor', color: 'c9922a', description: 'Suggested by a visitor to the site' };

class GitHubError extends Error {
  constructor(step, status, detail) {
    super(`GitHub ${step} failed (${status})`);
    this.step = step;
    this.status = status;
    // GitHub's own one-line message, if any (never the token, never the visitor's text).
    this.detail = typeof detail === 'string' ? detail.slice(0, 200) : '';
  }
}

function client({ fetch, token, repo }) {
  async function call(step, method, path, body) {
    let response;
    try {
      response = await fetch(`${API}/repos/${repo}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'morganvanv-ask-publish',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError(step, 0, 'GitHub could not be reached.');
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      // Some responses have no body.
    }
    const rateLimited = response.status === 429
      || (response.status === 403 && response.headers && typeof response.headers.get === 'function'
        && response.headers.get('x-ratelimit-remaining') === '0');
    return { status: response.status, data, rateLimited };
  }

  /** `call`, throwing a GitHubError unless the status is one of `ok`. */
  async function expect(step, ok, method, path, body) {
    const result = await call(step, method, path, body);
    if (!ok.includes(result.status)) {
      const error = new GitHubError(step, result.status, result.data && result.data.message);
      error.rateLimited = result.rateLimited;
      throw error;
    }
    return result;
  }

  return { call, expect };
}

function owner(repo) {
  return repo.split('/')[0];
}

function prSummary(pr) {
  return { number: pr.number, url: pr.html_url, state: pr.merged_at ? 'merged' : pr.state };
}

/** The PR already opened for this item (open, closed or merged), or null. */
async function findPr(gh, repo, item) {
  const head = encodeURIComponent(`${owner(repo)}:${branchName(item)}`);
  const { data } = await gh.expect('looking for an existing PR', [200], 'GET', `/pulls?head=${head}&state=all&per_page=1`);
  return Array.isArray(data) && data[0] ? prSummary(data[0]) : null;
}

async function ensureBranch(gh, item) {
  const branch = branchName(item);
  const existing = await gh.expect('checking the branch', [200, 404], 'GET', `/git/ref/heads/${branch}`);
  if (existing.status === 200) return;
  const base = await gh.expect(`reading ${BASE_BRANCH}`, [200], 'GET', `/git/ref/heads/${BASE_BRANCH}`);
  const sha = base.data && base.data.object && base.data.object.sha;
  if (typeof sha !== 'string') throw new GitHubError(`reading ${BASE_BRANCH}`, base.status, 'No commit on the base branch.');
  // 422: it was created a moment ago (a double click); that's fine.
  await gh.expect('creating the branch', [201, 422], 'POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
}

async function ensureFile(gh, item) {
  const branch = branchName(item);
  const path = filePath(item);
  const ref = encodeURIComponent(branch);
  const existing = await gh.expect('checking the file', [200, 404], 'GET', `/contents/${path}?ref=${ref}`);
  if (existing.status === 200) return;
  const content = Buffer.from(fileContent(item), 'utf8').toString('base64');
  const put = await gh.call('adding the file', 'PUT', `/contents/${path}`, { message: commitMessage(item), content, branch });
  if (put.status === 200 || put.status === 201) return;
  // 409/422: it was added a moment ago (a double click). Anything else, or still no file, is an error.
  if (put.status === 409 || put.status === 422) {
    const again = await gh.call('checking the file', 'GET', `/contents/${path}?ref=${ref}`);
    if (again.status === 200) return;
  }
  const error = new GitHubError('adding the file', put.status, put.data && put.data.message);
  error.rateLimited = put.rateLimited;
  throw error;
}

/** Labels the PR `visitor`, creating the label the first time. Never fails the publish. */
async function labelPr(gh, number) {
  try {
    const label = await gh.call('reading the label', 'GET', `/labels/${LABEL.name}`);
    if (label.status === 404) await gh.call('creating the label', 'POST', '/labels', LABEL);
    const added = await gh.call('labelling the PR', 'POST', `/issues/${number}/labels`, { labels: [LABEL.name] });
    if (added.status !== 200) console.error(`ask/publish: labelling the PR failed (${added.status})`);
  } catch {
    console.error('ask/publish: labelling the PR failed');
  }
}

/**
 * Opens (or finds) the PR for `item`. Returns { pr: { number, url, state }, existed }.
 * Throws a GitHubError when GitHub refuses a step.
 */
async function publish({ fetch, token, repo }, item) {
  const gh = client({ fetch, token, repo });
  const found = await findPr(gh, repo, item);
  if (found) return { pr: found, existed: true };

  await ensureBranch(gh, item);
  await ensureFile(gh, item);

  const opened = await gh.call('opening the PR', 'POST', '/pulls', {
    title: prTitle(item),
    head: branchName(item),
    base: BASE_BRANCH,
    body: prBody(item, repo),
  });
  if (opened.status === 201 && opened.data) {
    const pr = prSummary(opened.data);
    await labelPr(gh, pr.number);
    return { pr, existed: false };
  }
  // 422: one was opened a moment ago (a double click); return that one.
  if (opened.status === 422) {
    const raced = await findPr(gh, repo, item);
    if (raced) return { pr: raced, existed: true };
  }
  const error = new GitHubError('opening the PR', opened.status, opened.data && opened.data.message);
  error.rateLimited = opened.rateLimited;
  throw error;
}

/** Looks for an existing PR only (for the confirm page). */
async function existingPr({ fetch, token, repo }, item) {
  return findPr(client({ fetch, token, repo }), repo, item);
}

module.exports = { publish, existingPr, GitHubError, BASE_BRANCH, LABEL };
