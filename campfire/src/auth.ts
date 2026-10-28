/** Morgan's host key: `Authorization: Bearer <CAMPFIRE_HOST_KEY>`. */

export type HostCheck = 'host' | 'guest' | 'wrong-key' | 'host-off';

/** The bearer token in an Authorization header, or null if there isn't one. */
export function bearerToken(header: string | null): string | null {
  const match = header ? /^Bearer[ ]+(\S+)\s*$/i.exec(header) : null;
  return match?.[1] ?? null;
}

/**
 * Compares two strings in time that doesn't depend on where they differ, or on their lengths:
 * both are hashed to 32 bytes first and every byte is compared.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(async s => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x!.length; i++) diff |= x![i]! ^ y![i]!;
  return diff === 0;
}

/**
 * The shortest host key the campfire accepts. A shorter CAMPFIRE_HOST_KEY turns host features off, as
 * if none were set: GET /host answers any guess, so the key has to be too long to guess
 * (`openssl rand -hex 32` makes 64 characters).
 */
export const MIN_HOST_KEY_LENGTH = 32;

/**
 * Who's asking: the host (right key), a guest (no key), someone with the wrong key, or someone with a
 * key while host features are off (no secret configured, or one too short to trust).
 */
export async function checkHost(header: string | null, secret: string | undefined): Promise<HostCheck> {
  const token = bearerToken(header);
  if (token === null) return 'guest';
  if (!secret || secret.length < MIN_HOST_KEY_LENGTH) return 'host-off';
  return (await constantTimeEqual(token, secret)) ? 'host' : 'wrong-key';
}
