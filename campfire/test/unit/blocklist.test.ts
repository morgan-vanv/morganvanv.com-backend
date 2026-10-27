import { describe, expect, it } from 'vitest';
import { fold, isBlocked } from '../../src/blocklist';

describe('fold', () => {
  it('lower-cases, drops accents and undoes leetspeak', () => {
    expect(fold('HÉLLO W0rld!!')).toBe('hello worldii');
    expect(fold('n1gg3r')).toBe('nigger');
  });

  it('joins letters spaced out to dodge a filter', () => {
    expect(fold('f a g g o t')).toBe('faggot');
    expect(fold('f.a.g')).toBe('fag');
  });

  it('leaves ordinary words alone', () => {
    expect(fold('a nice fire')).toBe('a nice fire');
  });
});

describe('isBlocked', () => {
  it.each([
    'you are a faggot', 'FAGGOT', 'f4gg0t', 'faaaggot', 'f a g', 'n1gg@', 'kikes', 'retarded', 'buy viagra now',
    'V I A G R A', 'cialis', 'cheap cialis', 'check my onlyfans', 'b u y f o l l o w e r s', 'cheapviagraonline',
    'ki\u200Dke', 'fa\u200Cg', 'n\u{E0041}igger', 'xniggerx',
  ])('blocks %j', text => expect(isBlocked(text)).toBe(true));

  it.each([
    'Hello from Scunthorpe', 'Niger is a country', 'the fire retardant worked', 'spicy food', 'nice campfire',
    'a classic', 'I like assessments', 'Shoutout to Morgan', 'what a beautiful sky tonight', 'skidding', '', 'xxx',
    'socialism', 'a socialist', 'ask a specialist', 'commercialised', 'social issues', 'crucial is it',
    'the financial is fine', 'snigger', 'sniggering at the back',
  ])('lets %j through', text => expect(isBlocked(text)).toBe(false));

  it('is deliberately blunt about whole words', () => {
    // "faggot" also means a bundle of sticks; on a site about a campfire, that's a loss we'll take.
    expect(isBlocked('faggots of wood')).toBe(true);
  });
});
