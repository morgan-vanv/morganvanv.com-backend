// Opens the PR for an item with GitHub's REST API: a branch from master, one new file on it, a PR
// labelled `visitor`. Safe to run again for the same item (a double click, a retry after an error):
// whatever already exists is reused, and an existing PR is returned rather than a second one opened.
//
// The token only ever goes in the Authorization header. Nothing here logs it or the visitor's text.

const { branchName, filePath, fileContent, prTitle, prBody, idLine, commitMessage } = require('./entry');

const API = 'https://api.github.com';
const BASE_BRANCH = 'master';
const LABEL = { name: 'visitor', color: 'c9922a', description: 'Suggested by a visitor to the site' };

// Each call gets 8 s, and the whole run 25 s, so a hung GitHub shows our page, not DigitalOcean's
// timeout (the function's limit is 30 s).
const CALL_TIMEOUT_MS = 8000;
const RUN_BUDGET_MS = 25000;

class GitHubError extends Error {
  constructor(step, status, detail, { rateLimited = false, timedOut = false } = {}) {
    super(`GitHub ${step} failed (${status})`);
    this.step = step;
    this.status = status;
    // GitHub's own one-line message, if any (never the token, never the visitor's text).
    this.detail = typeof detail === 'string' ? detail.slice(0, 200) : '';
    this.rateLimited = rateLimited;
    this.timedOut = timedOut;
  }
}

function header(response, name) {
  return response.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : null;
}

/** Primary (x-ratelimit-remaining: 0) and secondary (retry-after, or GitHub saying so) rate limits. */
function isRateLimited(response, data) {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  const message = data && typeof data.message === 'string' ? data.message : '';
  return header(response, 'x-ratelimit-remaining') === '0'
    || header(response, 'retry-after') !== null
    || /rate limit/i.test(message);
}

function client({ fetch, token, repo, callTimeoutMs = CALL_TIMEOUT_MS, budgetMs = RUN_BUDGET_MS }) {
  const deadline = Date.now() + budgetMs;

  async function call(step, method, path, body) {
    const timeLeft = Math.min(callTimeoutMs, deadline - Date.now());
    if (timeLeft <= 0) throw new GitHubError(step, 0, 'GitHub took too long.', { timedOut: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeLeft);
    let response;
    let data = null;
    try {
      response = await fetch(path.startsWith('/search/') ? `${API}${path}` : `${API}/repos/${repo}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'morganvanv-ask-publish',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      try {
        data = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        // Some responses have no body.
      }
    } catch {
      if (controller.signal.aborted) throw new GitHubError(step, 0, 'GitHub took too long.', { timedOut: true });
      throw new GitHubError(step, 0, 'GitHub could not be reached.');
    } finally {
      clearTimeout(timer);
    }
    return { status: response.status, data, rateLimited: isRateLimited(response, data) };
  }

  function fail(step, result) {
    return new GitHubError(step, result.status, result.data && result.data.message, { rateLimited: result.rateLimited });
  }

  /** `call`, throwing a GitHubError unless the status is one of `ok`. */
  async function expect(step, ok, method, path, body) {
    const result = await call(step, method, path, body);
    if (!ok.includes(result.status)) throw fail(step, result);
    return result;
  }

  return { call, expect, fail };
}

function owner(repo) {
  return repo.split('/')[0];
}

function prSummary(pr) {
  const merged = pr.merged_at || (pr.pull_request && pr.pull_request.merged_at);
  return { number: pr.number, url: pr.html_url, state: merged ? 'merged' : pr.state };
}

/**
 * The PR already opened for this item (open, closed or merged), or null. First by its branch,
 * which GitHub knows at once (a double click); then by the id line in its body, which still finds
 * a PR that was closed and had its branch deleted, so a rejected item never comes back.
 */
async function findPr(gh, repo, item) {
  const head = encodeURIComponent(`${owner(repo)}:${branchName(item)}`);
  const byBranch = await gh.expect('looking for an existing PR', [200], 'GET', `/pulls?head=${head}&state=all&per_page=1`);
  if (Array.isArray(byBranch.data) && byBranch.data[0]) return prSummary(byBranch.data[0]);

  const query = encodeURIComponent(`repo:${repo} is:pr in:body "${item.id}"`);
  const search = await gh.expect('searching for an existing PR', [200], 'GET', `/search/issues?q=${query}&per_page=10`);
  const items = search.data && Array.isArray(search.data.items) ? search.data.items : [];
  // Search matches loosely; only a PR whose body has this exact id line counts.
  const found = items.find(pr => pr.pull_request && typeof pr.body === 'string' && pr.body.includes(idLine(item)));
  return found ? prSummary(found) : null;
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
  throw gh.fail('adding the file', put);
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
async function publish(options, item) {
  const gh = client(options);
  const { repo } = options;
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
  throw gh.fail('opening the PR', opened);
}

/** Looks for an existing PR only (for the confirm page). */
async function existingPr(options, item) {
  return findPr(client(options), options.repo, item);
}

module.exports = { publish, existingPr, GitHubError, BASE_BRANCH, LABEL, CALL_TIMEOUT_MS };
