/**
 * A short blocklist: slurs and obvious spam. It isn't meant to catch everything (Morgan can delete
 * anything with his host key); it just stops the worst from ever landing.
 *
 * Text is folded before matching: lower case, accents dropped, common leetspeak undone (n1gg3r),
 * letters spaced out to dodge filters joined back up (f a g), and a run of one letter matches the
 * letter as written (faaaggot). Short words only match whole words, so Scunthorpe, Niger and fire
 * retardant are fine.
 */

/** Matched as whole words, with an optional plural or -ed. */
const WORDS: readonly string[] = [
  'nigger', 'nigga', 'faggot', 'fag', 'kike', 'spic', 'tranny', 'retard', 'wetback', 'beaner',
  'porn', 'viagra', 'cialis', 'casino', 'onlyfans',
];

/** Matched anywhere once spaces and punctuation are gone: long enough not to turn up by accident. */
const ANYWHERE: readonly string[] = [
  'nigger', 'faggot', 'viagra', 'cialis', 'onlyfans', 'buyfollowers', 'seoservices', 'cryptogiveaway',
];

const LEET: Readonly<Record<string, string>> = {
  '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '8': 'b', '9': 'g',
};

/** Lower case, no accents, leetspeak undone, everything but letters turned into spaces. */
export function fold(text: string): string {
  const letters = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[0-9!|@$]/g, c => LEET[c] ?? c)
    .replace(/[^a-z]+/g, ' ')
    .trim();
  // "f a g g o t" -> "faggot": three or more single letters in a row are one word spaced out.
  return letters.replace(/\b[a-z](?: [a-z]\b){2,}/g, run => run.replace(/ /g, ''));
}

/** "fag" -> /f+a+g+/: each letter may repeat, so stretched spellings still match. */
const stretch = (term: string): string => [...term].map(c => `${c}+`).join('');

const WORD_PATTERNS = WORDS.map(term => new RegExp(`^${stretch(term)}(?:s|z|e?d)?$`));
const ANYWHERE_PATTERNS = ANYWHERE.map(term => new RegExp(stretch(term)));

/** True if the text (or nick) has something on the list in it. */
export function isBlocked(text: string): boolean {
  const folded = fold(text);
  if (!folded) return false;
  if (folded.split(' ').some(word => WORD_PATTERNS.some(pattern => pattern.test(word)))) return true;
  const squashed = folded.replace(/ /g, '');
  return ANYWHERE_PATTERNS.some(pattern => pattern.test(squashed));
}
