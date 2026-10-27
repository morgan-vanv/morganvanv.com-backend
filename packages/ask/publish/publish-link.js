// A "Publish as PR" link: one visitor suggestion, signed so the stateless publish function can trust it.
//
// ask/submit makes the links (into Morgan's private Discord) and ask/publish checks them. DigitalOcean
// deploys each function folder on its own, so this file lives in both folders; a test fails if the
// two copies ever differ (edit one, copy it over the other).
//
// A link carries the item itself: `p` is base64url JSON, `s` an HMAC-SHA256 of `p` keyed by
// PUBLISH_SECRET. The item is built from the submission's structured fields, cleaned and held to
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

const ID_PATTERN = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)-[0-9a-f]{4}$/;

/** One line of visitor text: no invisible or control characters, whitespace collapsed (as the site's oneLine). */
function oneLine(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\p{Cf}]/gu, '').replace(/\s+/g, ' ').replace(/\p{Cc}/gu, '').trim();
}

/** Several lines of visitor text: as oneLine, but line breaks kept (at most one blank line in a row). */
function block(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cf}]/gu, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[^\P{Cc}\n]/gu, '')
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
    if (!text || text.length > MAX_QUESTION) return null;
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

/** `YYYY-MM-DD-<slug>-<4 hex>`, dated (UTC) when the item was issued. */
function makeId(kind, fields, iat, hex4) {
  return `${isoDay(iat)}-${slugify(kind === 'star' ? fields.name : fields.text, kind)}-${hex4}`;
}

/**
 * The publishable item for a submission, or null: always null for the anonymous dropbox
 * (`message`) and for anything whose fields don't fit the form.
 */
function makeItem(args, now = new Date(), randomHex = () => crypto.randomBytes(2).toString('hex')) {
  const kind = args && args.kind;
  if (!PUBLISHABLE_KINDS.includes(kind)) return null;
  const fields = cleanFields(kind, args);
  if (!fields) return null;
  const iat = Math.floor(now.getTime() / 1000);
  return { kind, id: makeId(kind, fields, iat, randomHex()), iat, fields };
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
  return base64url(crypto.createHmac('sha256', secret).update(p).digest());
}

function signatureMatches(p, s, secret) {
  const expected = Buffer.from(sign(p, secret), 'utf8');
  const given = Buffer.from(s, 'utf8');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** A secret long enough to sign with (`openssl rand -hex 32` makes 64 characters), or null. */
function usableSecret(secret) {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH && !secret.startsWith('${') ? secret : null;
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
  encodeItem,
  sign,
  usableSecret,
  publishLink,
  readLink,
  expiresAt,
};
