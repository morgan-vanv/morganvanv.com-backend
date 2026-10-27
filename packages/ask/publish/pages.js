// The publish function's pages: small, plain and dark, no scripts. Every interpolated value is escaped.

const crypto = require('crypto');

const STYLE = [
  ':root{color-scheme:dark}',
  'body{margin:0;background:#0b0f1a;color:#e4e6eb;font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
  'main{max-width:40rem;margin:0 auto;padding:2.5rem 1rem}',
  'h1{font-size:1.25rem;color:#f0c674;margin:0 0 1rem}',
  'p{margin:0 0 1rem}',
  '.dim{color:#9aa0aa}',
  'code{color:#f0c674;overflow-wrap:anywhere}',
  'pre{background:#141a28;border:1px solid #2a3142;border-radius:6px;padding:1rem;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}',
  'a{color:#8ab4f8}',
  'button{font:inherit;min-height:44px;padding:.6rem 1.2rem;background:#c9922a;color:#0b0f1a;border:0;border-radius:6px;cursor:pointer}',
  'button:hover,button:focus-visible{background:#f0c674;outline:2px solid #f0c674;outline-offset:2px}',
].join('');

const STYLE_HASH = crypto.createHash('sha256').update(STYLE).digest('base64');

// No scripts, no images, nothing framed; the form may only post here (and follow the redirect to the PR).
const CSP = [
  "default-src 'none'",
  `style-src 'sha256-${STYLE_HASH}'`,
  "form-action 'self' https://github.com",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': CSP,
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only ever link to a GitHub page. */
function githubUrl(url) {
  return typeof url === 'string' && url.startsWith('https://github.com/') ? url : null;
}

function page(statusCode, title, inner, extraHeaders = {}) {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · ask/publish</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${inner}
</main>
</body>
</html>
`;
  return { statusCode, headers: { ...HEADERS, ...extraHeaders }, body };
}

const KIND_NAMES = { subtitle: 'a greeting subtitle', star: 'a star name', question: 'a mailbag question' };

function prLink(pr) {
  const url = githubUrl(pr.url);
  const label = `PR #${escapeHtml(pr.number)}`;
  return url ? `<a href="${escapeHtml(url)}">${label}</a>` : label;
}

/** GET: what will be published, where, and the one button that does it. */
function confirmPage(item, path, content, p, s, expires) {
  return page(200, `Publish ${KIND_NAMES[item.kind]}?`, `
<p>This opens a pull request on the site's repo adding one file. Nothing goes live until you merge it.</p>
<p class="dim">File: <code>${escapeHtml(path)}</code></p>
<pre>${escapeHtml(content)}</pre>
<form method="post">
<input type="hidden" name="p" value="${escapeHtml(p)}">
<input type="hidden" name="s" value="${escapeHtml(s)}">
<button type="submit">Open the pull request</button>
</form>
<p class="dim">This link works until ${escapeHtml(expires.toISOString().slice(0, 10))}.</p>`);
}

/** GET for a link that has already been used. */
function usedPage(pr) {
  return page(200, 'Already published', `
<p>This link already opened ${prLink(pr)} (${escapeHtml(pr.state)}).</p>`);
}

/** POST succeeded: straight to the PR. The body is for anything that doesn't follow redirects. */
function openedPage(pr, existed) {
  const url = githubUrl(pr.url);
  const inner = `<p>${existed ? 'It was already open:' : 'Opened'} ${prLink(pr)}.</p>`;
  if (!url) return page(200, existed ? 'Already published' : 'Pull request opened', inner);
  return page(303, existed ? 'Already published' : 'Pull request opened', inner, { Location: url });
}

function errorPage(statusCode, title, message) {
  return page(statusCode, title, `\n<p>${escapeHtml(message)}</p>`, statusCode === 405 ? { Allow: 'GET, POST' } : {});
}

module.exports = { escapeHtml, confirmPage, usedPage, openedPage, errorPage, CSP, HEADERS };
