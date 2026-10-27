import { isBlocked, fold } from './blocklist';
import { HOST_NICK, MAX_URLS, NICK_MAX, RESERVED_NICKS, TEXT_MAX } from './config';

/** A shout that passed every check, ready to store. */
export interface CleanShout {
  readonly nick: string;
  readonly text: string;
  readonly host: boolean;
}

export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Characters that only ever cause trouble in a one-line log: bidi overrides, zero-width spaces, BOMs. */
const INVISIBLES = /[\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/** Length in characters as a person counts them (code points, so an emoji is one). */
export const charLength = (text: string): number => [...text].length;

/**
 * Tidies shout text into one plain line: control and invisible characters gone, any run of
 * whitespace (newlines included) one space, piles of combining marks (Zalgo) cut down, trimmed.
 */
export function cleanText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[\t\n\v\f\r]/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .replace(INVISIBLES, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Normalises a nick: trimmed, compatibility forms folded (fullwidth letters become plain ones) and
 * inner spaces turned into underscores. Returns null if anything but letters, digits, _ - . is left,
 * or it's empty or too long.
 */
export function normaliseNick(raw: string): string | null {
  const nick = raw.normalize('NFKC').trim().replace(/\s+/gu, '_');
  if (nick.length < 1 || nick.length > NICK_MAX) return null;
  return /^[A-Za-z0-9_.-]+$/.test(nick) ? nick : null;
}

/** Nicks a guest can't take: Morgan's and the obvious stand-ins, in any case or leetspeak. */
export function isReservedNick(nick: string): boolean {
  const bare = fold(nick).replace(/ /g, '');
  return RESERVED_NICKS.includes(bare);
}

/** URLs and bare domains in the text. */
export function countUrls(text: string): number {
  const pattern = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|app|co|uk|us|ru|cn|xyz|info|biz|me|gg|ly|tk|top|site|online|shop|link|click|live|store)\b\S*/gi;
  return text.match(pattern)?.length ?? 0;
}

/** True if the hidden "website" field was filled in, which only bots do. */
export function isHoneypot(body: unknown): boolean {
  const website = (body as { website?: unknown } | null)?.website;
  if (website === undefined || website === null) return false;
  return typeof website !== 'string' || website.trim() !== '';
}

/**
 * Checks a POST /shouts body. The host (Morgan, with the key) always posts as "morgan" and skips the
 * blocklist and URL limit; everyone else needs a valid nick and clean text.
 */
export function validateShout(body: unknown, host: boolean): Checked<CleanShout> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Send a JSON object with a nick and some text.');
  const { nick: rawNick, text: rawText } = body as { nick?: unknown; text?: unknown };

  if (typeof rawText !== 'string') return fail('Say something first.');
  const text = cleanText(rawText);
  if (!text) return fail('Say something first.');
  if (charLength(text) > TEXT_MAX) return fail(`Keep it under ${TEXT_MAX} characters.`);

  if (host) return { ok: true, value: { nick: HOST_NICK, text, host: true } };

  if (typeof rawNick !== 'string' || !rawNick.trim()) return fail('Pick a nick first.');
  const nick = normaliseNick(rawNick);
  if (!nick) return fail(`Nicks are 1–${NICK_MAX} letters, digits, _ - or .`);
  if (isReservedNick(nick)) return fail('That nick is taken.');
  if (isBlocked(nick)) return fail('Pick a different nick.');

  if (isBlocked(text)) return fail('Let\'s keep it friendly.');
  if (countUrls(text) > MAX_URLS) return fail('One link per message, please.');

  return { ok: true, value: { nick, text, host: false } };
}

/** The id in DELETE /shouts/<id>, or null if it isn't a positive whole number. */
export function parseShoutId(raw: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/** A per-tab client id the site made up (a UUID, in practice), or null if it doesn't look like one. */
export function parseClientId(raw: string | null): string | null {
  return raw && /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : null;
}
