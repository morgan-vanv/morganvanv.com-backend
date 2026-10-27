// A "Publish as PR" link: one visitor suggestion, signed so the stateless publish function can trust it,
// and the file it becomes in the site's repo (content/, read by the site; see its content/README.md).
//
// ask/submit makes the links (into Morgan's private Discord) and ask/publish checks them. DigitalOcean
// deploys each function folder on its own, so this file lives in both folders; a test fails if the
// two copies ever differ (edit one, copy it over the other).
//
// A link carries the item itself: `p` is base64url JSON, `s` an HMAC-SHA256 of `publish-link/v1\n` + `p`
// keyed by PUBLISH_SECRET. The item is built from the submission's structured fields, cleaned and held to
// the form's own limits, never from the free-text message: it becomes a file in the site's repo.

const crypto = require('crypto');
const zlib = require('zlib');

const PUBLISHABLE_KINDS = ['question', 'subtitle', 'star'];

// The site's own limits (QUESTION_MAX_LENGTH, SUBTITLE_MAX_LENGTH, CREDIT_MAX_LENGTH, MAX_NAME);
// anything longer didn't come from the form.
const MAX_QUESTION = 500;
const MAX_SUBTITLE = 60;
const MAX_CREDIT = 24;
const MAX_STAR_NAME = 24;
const MAX_NEAR = 40;
const MAX_SLUG = 40;

const LINK_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;
// Discord allows 1024 characters in a field value; the link sits in one as [Publish as PR](…).
const MAX_LINK_LENGTH = 1000;
const MAX_TOKEN_LENGTH = 4096;
const MAX_INFLATED_BYTES = 16 * 1024;
const MIN_SECRET_LENGTH = 32;

const ID_PATTERN = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)-[0-9a-f]{8}$/;
const SIGNATURE_CONTEXT = 'publish-link/v1\n';

/**
 * The request's HTTP method, lowercased, or '' when the platform didn't say. DigitalOcean puts it
 * in `http.method`; older OpenWhisk-style runtimes in `__ow_method`.
 */
function methodOf(args) {
  if (!args || typeof args !== 'object') return '';
  // When the platform sends `http`, it alone says the method: a request whose own parameters include
  // something called `http` (not an object) mustn't fall through to an `__ow_method` it also sent.
  if ('http' in args) {
    const http = args.http;
    const ok = typeof http === 'object' && http !== null && !Array.isArray(http);
    return ok && typeof http.method === 'string' ? http.method.toLowerCase() : '';
  }
  return typeof args.__ow_method === 'string' ? args.__ow_method.toLowerCase() : '';
}

/**
 * One line of visitor text: no invisible or control characters, whitespace collapsed. Control
 * characters go before whitespace is collapsed, so cleaning twice changes nothing (a link must
 * still match its item when publish cleans it again).
 */
function oneLine(value) {
  if (typeof value !== 'string') return '';
  // A lone surrogate would show in Discord but turn into U+FFFD in the file, so it goes first.
  return value.toWellFormed().replace(/[\p{Cf}]/gu, '').replace(/[^\P{Cc}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

/** Several lines of visitor text: as oneLine, but line breaks kept (at most one blank line in a row). */
function block(value) {
  if (typeof value !== 'string') return '';
  return value
    .toWellFormed()
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cf}]/gu, '')
    .replace(/[^\P{Cc}\s]/gu, '')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
 * The cleaned, structured fields of a submission, or null when they don't fit the form's limits.
 *   question: { text }                     (the site sends the bare question as `text`)
 *   subtitle: { text, by }                 (`subtitle`, `credit`)
 *   star:     { ra, dec, name, by, near? } (`name`, `credit`, `star: { ra, dec, near }`)
 */
function cleanFields(kind, args) {
  if (!args || typeof args !== 'object') return null;

  if (kind === 'question') {
    const text = block(args.text);
    // `<!--` could pose as the answer marker or hide text on the site, so such questions are added by hand.
    if (!text || text.length > MAX_QUESTION || text.includes('<!--')) return null;
    return { text };
  }

  const by = creditOf(args.credit);
  if (by === undefined) return null;

  if (kind === 'subtitle') {
    const text = oneLine(args.subtitle);
    if (!text || text.length > MAX_SUBTITLE) return null;
    return { text, by };
  }

  if (kind === 'star') {
    const name = oneLine(args.name);
    const star = args.star;
    if (!name || name.length > MAX_STAR_NAME || !star || typeof star !== 'object') return null;
    const { ra, dec } = star;
    const okRa = typeof ra === 'number' && Number.isFinite(ra) && ra >= 0 && ra < 360;
    const okDec = typeof dec === 'number' && Number.isFinite(dec) && dec >= -90 && dec <= 90;
    if (!okRa || !okDec) return null;
    const fields = { ra, dec, name, by };
    // The bright star it's near is a nicety: one that doesn't fit is left out, not refused.
    const near = oneLine(star.near);
    if (near && near.length <= MAX_NEAR) fields.near = near;
    return fields;
  }

  return null;
}

/** ASCII, lowercase, hyphenated, at most 40 characters (cut at a hyphen when it can be); `fallback` if empty. */
function slugify(text, fallback) {
  const words = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let slug = words;
  if (slug.length > MAX_SLUG) {
    const cut = slug.slice(0, MAX_SLUG + 1);
    const hyphen = cut.lastIndexOf('-');
    slug = hyphen > 0 ? cut.slice(0, hyphen) : cut.slice(0, MAX_SLUG);
  }
  slug = slug.replace(/-+$/, '');
  return slug || fallback;
}

function isoDay(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD-<slug>-<8 hex>`, dated (UTC) when the item was issued. */
function makeId(kind, fields, iat, hex8) {
  return `${isoDay(iat)}-${slugify(kind === 'star' ? fields.name : fields.text, kind)}-${hex8}`;
}

/**
 * The publishable item for a submission, or null: always null for the anonymous dropbox
 * (`message`) and for anything whose fields don't fit the form.
 */
function makeItem(args, now = new Date(), randomHex = () => crypto.randomBytes(4).toString('hex')) {
  const kind = args && args.kind;
  if (!PUBLISHABLE_KINDS.includes(kind)) return null;
  const fields = cleanFields(kind, args);
  if (!fields) return null;
  const iat = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(iat) || iat <= 0) return null;
  const item = { kind, id: makeId(kind, fields, iat, randomHex()), iat, fields };
  // Never hand out a link that publish would refuse.
  return isValidItem(item) ? item : null;
}

// The file an item becomes. ask/publish commits it; ask/submit shows it in Discord to add by hand
// when publishing is off. The site reads these exact paths and shapes:
//   content/subtitles/<id>.json  { "text", "by", "added": "YYYY-MM" }
//   content/stars/<id>.json      { "ra", "dec", "name", "by", "added": "YYYY-MM", "near"? }
//   content/mailbag/<id>.md      front matter (asked: YYYY-MM-DD), the question quoted, then Morgan's answer

const DIRECTORIES = { subtitle: 'content/subtitles', star: 'content/stars', question: 'content/mailbag' };

const ANSWER_MARKER = '<!-- Write your answer below this line, then merge. Leave it empty and the site\'s checks will fail. -->';

function filePath(item) {
  return `${DIRECTORIES[item.kind]}/${item.id}${item.kind === 'question' ? '.md' : '.json'}`;
}

/** The new file's text. */
function fileContent(item) {
  const { kind, fields, iat } = item;
  const added = isoDay(iat).slice(0, 7);
  if (kind === 'subtitle') {
    return JSON.stringify({ text: fields.text, by: fields.by, added }, null, 2) + '\n';
  }
  if (kind === 'star') {
    const star = { ra: fields.ra, dec: fields.dec, name: fields.name, by: fields.by, added };
    if (fields.near) star.near = fields.near;
    return JSON.stringify(star, null, 2) + '\n';
  }
  // Every line of the question is quoted, so nothing in it can end the front matter or pass for the marker.
  const quoted = fields.text.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');
  return `---\nasked: ${isoDay(iat)}\n---\n${quoted}\n\n${ANSWER_MARKER}\n`;
}

/** The submission-shaped args that `fields` came from, so they can be cleaned again and compared. */
function argsOf(kind, fields) {
  if (kind === 'question') return { text: fields.text };
  if (kind === 'subtitle') return { subtitle: fields.text, credit: fields.by };
  return { name: fields.name, credit: fields.by, star: { ra: fields.ra, dec: fields.dec, near: fields.near } };
}

/** True when `item` is exactly what makeItem could have made (checked again before anything is published). */
function isValidItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const { kind, id, iat, fields } = item;
  if (!PUBLISHABLE_KINDS.includes(kind)) return false;
  if (!Number.isSafeInteger(iat) || iat <= 0) return false;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  const clean = cleanFields(kind, argsOf(kind, fields));
  if (!clean || JSON.stringify(clean) !== JSON.stringify(fields)) return false;
  const match = typeof id === 'string' && ID_PATTERN.exec(id);
  return Boolean(match) && match[1] === isoDay(iat) && match[2].length <= MAX_SLUG;
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** The `p` for an item: base64url JSON, or `z.` + base64url deflate-raw JSON when `compress`. */
function encodeItem(item, compress = false) {
  const json = Buffer.from(JSON.stringify({ k: item.kind, id: item.id, t: item.iat, f: item.fields }), 'utf8');
  return compress ? `z.${base64url(zlib.deflateRawSync(json, { level: 9 }))}` : base64url(json);
}

function sign(p, secret) {
  return base64url(crypto.createHmac('sha256', secret).update(SIGNATURE_CONTEXT + p).digest());
}

function signatureMatches(p, s, secret) {
  const expected = Buffer.from(sign(p, secret), 'utf8');
  const given = Buffer.from(s, 'utf8');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** A secret long enough to sign with (`openssl rand -hex 32` makes 64 characters), or null. */
function usableSecret(secret) {
  // Trimmed here, so both functions sign with the same key even if .env has a stray space or CR.
  const trimmed = typeof secret === 'string' ? secret.trim() : '';
  return trimmed.length >= MIN_SECRET_LENGTH && !trimmed.startsWith('${') ? trimmed : null;
}

/**
 * The "Publish as PR" URL for an item: `<publishUrl>?p=…&s=…`. Compressed if plain would be too
 * long for Discord, and null if even that is (a long question in a non-Latin script can be).
 */
function publishLink(item, publishUrl, secret) {
  for (const compress of [false, true]) {
    const p = encodeItem(item, compress);
    const url = `${publishUrl}${publishUrl.includes('?') ? '&' : '?'}p=${p}&s=${sign(p, secret)}`;
    if (url.length <= MAX_LINK_LENGTH) return url;
  }
  return null;
}

/**
 * Checks a link's `p` and `s`: the signature (in constant time) before anything is decoded, then
 * that the item is one makeItem could have made, then its age.
 * Returns { ok: true, item } or { ok: false, reason } with reason 'missing', 'signature', 'malformed' or 'expired'.
 */
function readLink(p, s, secret, now = new Date()) {
  if (typeof p !== 'string' || typeof s !== 'string' || !p || !s) return { ok: false, reason: 'missing' };
  if (p.length > MAX_TOKEN_LENGTH || !/^(z\.)?[A-Za-z0-9_-]+$/.test(p) || !/^[A-Za-z0-9_-]{43}$/.test(s)) {
    return { ok: false, reason: 'signature' };
  }
  if (!signatureMatches(p, s, secret)) return { ok: false, reason: 'signature' };

  let raw;
  try {
    const bytes = p.startsWith('z.')
      ? zlib.inflateRawSync(fromBase64url(p.slice(2)), { maxOutputLength: MAX_INFLATED_BYTES })
      : fromBase64url(p);
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const item = raw && typeof raw === 'object' ? { kind: raw.k, id: raw.id, iat: raw.t, fields: raw.f } : null;
  if (!isValidItem(item)) return { ok: false, reason: 'malformed' };

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (item.iat > nowSeconds + CLOCK_SKEW_SECONDS || nowSeconds - item.iat > LINK_TTL_SECONDS) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, item };
}

/** When a link made at `iat` stops working. */
function expiresAt(iat) {
  return new Date((iat + LINK_TTL_SECONDS) * 1000);
}

module.exports = {
  PUBLISHABLE_KINDS,
  methodOf,
  MAX_QUESTION,
  MAX_LINK_LENGTH,
  LINK_TTL_SECONDS,
  oneLine,
  block,
  creditOf,
  cleanFields,
  slugify,
  makeItem,
  isValidItem,
  ANSWER_MARKER,
  filePath,
  fileContent,
  encodeItem,
  sign,
  usableSecret,
  publishLink,
  readLink,
  expiresAt,
};
