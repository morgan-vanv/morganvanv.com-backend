// /publish's pages: small, plain and dark, no scripts. Every interpolated value is escaped.

const crypto = require('node:crypto');

const STYLE = [
  ':root{color-scheme:dark}',
  'body{margin:0;background:#0b0f1a;color:#e4e6eb;font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
  'main{max-width:40rem;margin:0 auto;padding:2.5rem 1rem}',
  'h1{font-size:1.25rem;color:#f0c674;margin:0 0 1rem}',
  'p{margin:0 0 1rem}',
  '.dim{color:#9aa0aa}',
  '.warn{color:#f0c674;margin-top:1rem}',
  'code{color:#f0c674;overflow-wrap:anywhere}',
  'pre{background:#141a28;border:1px solid #2a3142;border-radius:6px;padding:1rem;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}',
  'a{color:#8ab4f8}',
    ].join('');

const STYLE_HASH = crypto.createHash('sha256').update(STYLE).digest('base64');

// No scripts, no images, no forms, nothing framed.
const CSP = [
  "default-src 'none'",
  `style-src 'sha256-${STYLE_HASH}'`,
  "form-action 'none'",
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
  // frame-ancestors covers current browsers; this covers older ones.
  'X-Frame-Options': 'DENY',
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

/**
 * A good link: straight on to GitHub's new-file editor (303), with a link in the body for anything that
 * doesn't follow redirects. Opening it changes nothing; the file is only made when Morgan commits it there.
 */
function editorPage(item, editorUrl) {
  const inner = `
<p>Opening GitHub's editor with ${escapeHtml(KIND_NAMES[item.kind] || 'the file')} filled in.</p>
<p><a href="${escapeHtml(editorUrl)}">Continue to GitHub</a></p>`;
  return page(303, 'Publish on GitHub', inner, { Location: editorUrl });
}

function errorPage(statusCode, title, message) {
  return page(statusCode, title, `\n<p>${escapeHtml(message)}</p>`, statusCode === 405 ? { Allow: 'GET, HEAD' } : {});
}

module.exports = { escapeHtml, editorPage, errorPage, CSP, HEADERS };
