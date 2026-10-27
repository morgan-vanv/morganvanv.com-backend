import { MAX_BODY_BYTES } from './config';
import { corsHeaders } from './cors';

/** A JSON response with the campfire's usual headers, plus CORS for the caller's origin. */
export function json(body: unknown, status: number, origin: string | null, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(origin),
      ...extra,
    },
  });
}

/** `{ "error": "<short human message>" }`. */
export const failure = (status: number, message: string, origin: string | null, extra: Record<string, string> = {}): Response =>
  json({ error: message }, status, origin, extra);

/** An empty response (204 and the like), with CORS. */
export const empty = (status: number, origin: string | null, extra: Record<string, string> = {}): Response =>
  new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...corsHeaders(origin), ...extra } });

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** True for `application/json`, with or without parameters such as charset. */
export function isJson(contentType: string | null): boolean {
  return !!contentType && contentType.split(';')[0]!.trim().toLowerCase() === 'application/json';
}

/** True if the declared Content-Length is already too big. */
export function declaredTooLarge(request: Request, limit = MAX_BODY_BYTES): boolean {
  const length = Number(request.headers.get('Content-Length'));
  return Number.isFinite(length) && length > limit;
}

/**
 * Reads the body as text, stopping (413) as soon as it passes `limit` bytes, whatever Content-Length
 * claimed, so a chunked upload can't make the Worker buffer it all.
 */
export async function readLimitedText(request: Request, limit = MAX_BODY_BYTES): Promise<string> {
  if (declaredTooLarge(request, limit)) throw new HttpError(413, 'That\'s too long for the campfire.');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, 'That\'s too long for the campfire.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Reads a small JSON body: 415 if it isn't JSON, 413 if it's too big, 400 if it doesn't parse. */
export async function readJson(request: Request, limit = MAX_BODY_BYTES): Promise<unknown> {
  if (!isJson(request.headers.get('Content-Type'))) throw new HttpError(415, 'Send JSON (Content-Type: application/json).');
  const text = await readLimitedText(request, limit);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'That isn\'t valid JSON.');
  }
}
