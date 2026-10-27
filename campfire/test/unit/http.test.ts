import { describe, expect, it } from 'vitest';
import { HttpError, isJson, readJson, readLimitedText } from '../../src/http';
import { NAME, VERSION } from '../../src/config';
import pkg from '../../package.json';

const post = (body: BodyInit | null, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
  new Request('http://campfire.test/shouts', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof HttpError ? error.status : error;
  }
};

describe('isJson', () => {
  it('accepts application/json with or without a charset', () => {
    expect(isJson('application/json')).toBe(true);
    expect(isJson('Application/JSON; charset=utf-8')).toBe(true);
    expect(isJson('text/plain')).toBe(false);
    expect(isJson(null)).toBe(false);
  });
});

describe('readJson', () => {
  it('parses a small JSON body', async () => {
    expect(await readJson(post('{"nick":"a","text":"b"}'))).toEqual({ nick: 'a', text: 'b' });
  });

  it('refuses anything that is not JSON (415), too big (413) or malformed (400)', async () => {
    expect(await status(readJson(post('{}', { 'Content-Type': 'text/plain' })))).toBe(415);
    expect(await status(readJson(post(JSON.stringify({ text: 'x'.repeat(3000) }))))).toBe(413);
    expect(await status(readJson(post('{nope')))).toBe(400);
  });

  it('stops reading a stream that runs past the limit, whatever it claimed', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1000));
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    expect(await status(readLimitedText(post(stream)))).toBe(413);
  });
});

describe('version', () => {
  it('matches package.json', () => {
    expect(NAME).toBe(pkg.name);
    expect(VERSION).toBe(pkg.version);
  });
});
