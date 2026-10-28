import { describe, expect, it } from 'vitest';
import {
  charLength, cleanText, countUrls, decoyShout, isHoneypot, isReservedNick, normaliseNick, parseClientId, parseShoutId, validateShout,
} from '../../src/validate';

describe('cleanText', () => {
  it('trims and collapses whitespace, newlines included', () => {
    expect(cleanText('  hello \n\n  there\t\tfriend  ')).toBe('hello there friend');
  });

  it('strips control and invisible characters', () => {
    expect(cleanText('hi\u0000\u0007 the\u200Bre\u202E!')).toBe('hi there!');
  });

  it('cuts piles of combining marks down to two', () => {
    // q has no precomposed accented forms, so NFC leaves every mark in place.
    expect(cleanText('q\u0301\u0302\u0303\u0304\u0305')).toBe('q\u0301\u0302');
  });

  it('strips every invisible character: joiners, tags, U+180E, U+034F, variation selectors but FE0F', () => {
    expect(cleanText('a\u200Db\u200Cc')).toBe('abc');
    expect(cleanText('flag\u{E0067}\u{E0062}\u{E007F}')).toBe('flag');
    expect(cleanText('a\u180Eb\u034Fc\uFE00d')).toBe('abcd');
    expect(cleanText('\u2764\uFE0F')).toBe('\u2764\uFE0F');
  });

  it('drops blank-looking fillers', () => {
    expect(cleanText('\u3164')).toBe('');
    expect(cleanText('hi\u115F\u1160\uFFA0\u2800there')).toBe('hithere');
  });

  it('repairs lone surrogates', () => {
    expect(cleanText('a\uD800b')).toBe('a\uFFFDb');
    expect(cleanText('a\uDC00')).toBe('a\uFFFD');
  });

  it('keeps emoji and accents', () => {
    expect(cleanText('café 🔥')).toBe('café 🔥');
  });
});

describe('charLength', () => {
  it('counts code points, so an emoji is one', () => {
    expect(charLength('🔥🔥')).toBe(2);
  });
});

describe('normaliseNick', () => {
  it('accepts letters, digits and _ - .', () => {
    expect(normaliseNick('guest_4821')).toBe('guest_4821');
    expect(normaliseNick('a.b-c')).toBe('a.b-c');
  });

  it('trims, folds fullwidth letters and turns inner spaces into underscores', () => {
    expect(normaliseNick('  ｍｏｒｇａｎ  ')).toBe('morgan');
    expect(normaliseNick('night  owl')).toBe('night_owl');
  });

  it('rejects anything else, empty or too long', () => {
    expect(normaliseNick('')).toBeNull();
    expect(normaliseNick('   ')).toBeNull();
    expect(normaliseNick('<script>')).toBeNull();
    expect(normaliseNick('café')).toBeNull();
    expect(normaliseNick('a'.repeat(17))).toBeNull();
    expect(normaliseNick('a'.repeat(16))).toBe('a'.repeat(16));
  });

  it('drops invisible characters and refuses nicks that are only fillers', () => {
    expect(normaliseNick('o\u200Dwl')).toBe('owl');
    expect(normaliseNick('\u3164')).toBeNull();
    expect(normaliseNick('\u2800\u2800')).toBeNull();
    expect(normaliseNick('\u200B')).toBeNull();
  });
});

describe('isReservedNick', () => {
  it('reserves anything containing Morgan, and the other stand-ins exactly, in any case or leetspeak', () => {
    expect(isReservedNick('Morgan')).toBe(true);
    expect(isReservedNick('m0rg4n')).toBe(true);
    expect(isReservedNick('m.o.r.g.a.n')).toBe(true);
    expect(isReservedNick('admin')).toBe(true);
    expect(isReservedNick('morgans_friend')).toBe(true);
    expect(isReservedNick('real.m0rgan')).toBe(true);
    expect(isReservedNick('administrator')).toBe(false);
    expect(isReservedNick('night_owl')).toBe(false);
  });
});

describe('countUrls', () => {
  it('counts links and bare domains', () => {
    expect(countUrls('no links here. Really.')).toBe(0);
    expect(countUrls('see https://example.com/a?b=c')).toBe(1);
    expect(countUrls('www.example.org and spam.xyz')).toBe(2);
    expect(countUrls('http://a.example http://b.example')).toBe(2);
  });
});

describe('isHoneypot', () => {
  it('is only tripped by a filled-in website field', () => {
    expect(isHoneypot({ website: '' })).toBe(false);
    expect(isHoneypot({ website: '   ' })).toBe(false);
    expect(isHoneypot({})).toBe(false);
    expect(isHoneypot({ website: 'http://spam.example' })).toBe(true);
    expect(isHoneypot({ website: false })).toBe(false);
    expect(isHoneypot({ website: 0 })).toBe(false);
    expect(isHoneypot({ website: 1 })).toBe(false);
    expect(isHoneypot(null)).toBe(false);
  });
});

describe('decoyShout', () => {
  it('echoes the bot\'s own words, cleaned up like a stored shout', () => {
    expect(decoyShout({ nick: ' spam_bot ', text: ' buy\n\nnow ' })).toEqual({ nick: 'spam_bot', text: 'buy now' });
    expect(decoyShout({ nick: '<b>', text: 'x'.repeat(300) })).toEqual({ nick: 'guest', text: 'x'.repeat(200) });
    expect(decoyShout(null)).toEqual({ nick: 'guest', text: '' });
  });
});

describe('validateShout', () => {
  const ok = (body: unknown, host = false) => {
    const result = validateShout(body, host);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const error = (body: unknown, host = false) => {
    const result = validateShout(body, host);
    if (result.ok) throw new Error('expected a rejection');
    return result.error;
  };

  it('accepts a normal shout, cleaned up', () => {
    expect(ok({ nick: ' guest_4821 ', text: '  hello   fire ' })).toEqual({ nick: 'guest_4821', text: 'hello fire', host: false });
  });

  it('needs an object with text and a nick', () => {
    expect(error(null)).toMatch(/JSON object/);
    expect(error([1])).toMatch(/JSON object/);
    expect(error({ nick: 'a' })).toMatch(/Say something/);
    expect(error({ nick: 'a', text: ' \n ' })).toMatch(/Say something/);
    expect(error({ nick: 'a', text: '\u3164' })).toMatch(/Say something/);
    expect(error({ nick: 'a', text: '\u200B\u2800\uFE0F' })).toMatch(/Say something/);
    expect(error({ nick: '\u3164', text: 'hi' })).toMatch(/Nicks are/);
    expect(error({ text: 'hi' })).toMatch(/nick/);
    expect(error({ nick: 'bad nick!', text: 'hi' })).toMatch(/Nicks are/);
  });

  it('allows exactly 200 characters of text', () => {
    expect(ok({ nick: 'a', text: 'x'.repeat(200) }).text).toHaveLength(200);
    expect(error({ nick: 'a', text: 'x'.repeat(201) })).toMatch(/200/);
    expect(ok({ nick: 'a', text: '🔥'.repeat(200) }).text).toBe('🔥'.repeat(200));
  });

  it('keeps guests from being Morgan', () => {
    expect(error({ nick: 'MORGAN', text: 'hi' })).toMatch(/taken/);
  });

  it('turns away blocked words and too many links', () => {
    expect(error({ nick: 'a', text: 'f4gg0t' })).toMatch(/friendly/);
    expect(error({ nick: 'a', text: 'ki\u200Dke' })).toMatch(/friendly/);
    expect(ok({ nick: 'socialist', text: 'socialism, specialist' }).nick).toBe('socialist');
    expect(error({ nick: 'f4g', text: 'hi' })).toMatch(/different nick/);
    expect(ok({ nick: 'a', text: 'my site: https://example.com' }).text).toContain('example.com');
    expect(error({ nick: 'a', text: 'https://a.example https://b.example' })).toMatch(/One link/);
  });

  it('signs the host as morgan, whatever nick was sent', () => {
    expect(ok({ nick: 'whoever', text: 'welcome https://a.example https://b.example' }, true))
      .toEqual({ nick: 'morgan', text: 'welcome https://a.example https://b.example', host: true });
    expect(ok({ text: 'no nick needed' }, true).nick).toBe('morgan');
  });
});

describe('parseShoutId', () => {
  it('takes positive whole numbers only', () => {
    expect(parseShoutId('12')).toBe(12);
    expect(parseShoutId('0')).toBeNull();
    expect(parseShoutId('-1')).toBeNull();
    expect(parseShoutId('1.5')).toBeNull();
    expect(parseShoutId('012')).toBeNull();
    expect(parseShoutId('abc')).toBeNull();
    expect(parseShoutId('99999999999999999')).toBeNull();
  });
});

describe('parseClientId', () => {
  it('takes UUID-like ids and ignores anything else', () => {
    expect(parseClientId('3f1c2a9e-7d4b-4c1e-9a55-0b6c8e2f1d3a')).toBe('3f1c2a9e-7d4b-4c1e-9a55-0b6c8e2f1d3a');
    expect(parseClientId(null)).toBeNull();
    expect(parseClientId('')).toBeNull();
    expect(parseClientId('short')).toBeNull();
    expect(parseClientId('has spaces in it')).toBeNull();
    expect(parseClientId('x'.repeat(65))).toBeNull();
  });
});
