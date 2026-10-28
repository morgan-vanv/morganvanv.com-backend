import { describe, expect, it } from 'vitest';
import { allowedOrigin, corsHeaders, preflightHeaders } from '../../src/cors';

describe('allowedOrigin', () => {
  it.each(['https://morganvanv.com', 'https://www.morganvanv.com', 'http://localhost:4200', 'http://localhost:4000'])(
    'allows %s', origin => expect(allowedOrigin(origin)).toBe(origin));

  it.each([null, '', 'null', 'http://morganvanv.com', 'https://morganvanv.com.evil.example', 'https://evil.example',
    'http://localhost:8787', 'https://localhost:4200', 'https://MORGANVANV.com'])(
    'refuses %j', origin => expect(allowedOrigin(origin)).toBeNull());
});

describe('corsHeaders', () => {
  it('echoes an allowed origin and exposes Retry-After', () => {
    expect(corsHeaders('https://morganvanv.com')).toEqual({
      'Access-Control-Allow-Origin': 'https://morganvanv.com',
      'Access-Control-Expose-Headers': 'Retry-After',
      Vary: 'Origin',
    });
  });

  it('gives unknown origins no CORS headers at all', () => {
    expect(corsHeaders('https://evil.example')).toEqual({ Vary: 'Origin' });
  });
});

describe('preflightHeaders', () => {
  it('allows the methods and headers the site uses', () => {
    const headers = preflightHeaders('http://localhost:4200');
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:4200');
    expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, PUT, DELETE, OPTIONS');
    expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
  });

  it('gives unknown origins nothing', () => {
    expect(preflightHeaders(null)).toEqual({ Vary: 'Origin' });
  });
});
