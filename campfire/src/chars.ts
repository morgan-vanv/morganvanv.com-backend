/**
 * Characters that render as nothing (or as a blank) and only ever cause trouble in a one-line log:
 * every format character (\p{Cf}: zero-width spaces and joiners, bidi controls, soft hyphens, tag
 * characters, U+180E), the combining grapheme joiner U+034F, variation selectors U+FE00–FE0E (FE0F,
 * which asks for emoji presentation, stays) and tag characters U+E0000–E007F that aren't Cf.
 */
const INVISIBLE = /[\p{Cf}͏᠎︀-︎\u{E0000}-\u{E007F}]/gu;

/** Letters and symbols that look like a blank: Hangul fillers and the empty braille pattern. */
const FILLERS = /[ᅟᅠㅤﾠ⠀]/gu;

/** Removes invisible characters and blank-looking fillers; replaces lone surrogates with U+FFFD. */
export function stripInvisible(text: string): string {
  return text.toWellFormed().replace(INVISIBLE, '').replace(FILLERS, '');
}

/** True if there's at least one letter, number, symbol or punctuation mark someone would actually see. */
export function hasVisible(text: string): boolean {
  return /[\p{L}\p{N}\p{S}\p{P}]/u.test(text.replace(FILLERS, ''));
}
