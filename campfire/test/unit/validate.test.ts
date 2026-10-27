import { describe, expect, it } from 'vitest';
import {
  charLength, cleanText, countUrls, isHoneypot, isReservedNick, normaliseNick, parseClientId, parseShoutId, validateShout,
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
});

describe('isReservedNick', () => {
  it('reserves Morgan and the obvious stand-ins in any case or leetspeak', () => {
    expect(isReservedNick('Morgan')).toBe(true);
    expect(isReservedNick('m0rg4n')).toBe(true);
    expect(isReservedNick('m.o.r.g.a.n')).toBe(true);
    expect(isReservedNick('admin')).toBe(true);
    expect(isReservedNick('morgans_friend')).toBe(false);
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
    expect(isHoneypot({ website: 1 })).toBe(true);
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
