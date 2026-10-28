import { describe, expect, it } from 'vitest';
import { discordEscape, pingPayload, sendPing, webhookUrl } from '../../src/discord';

const SHOUT = { id: 42, nick: 'night_owl', text: 'hello [click](https://evil.example) @everyone', at: '2026-10-27T22:00:00.000Z' };

describe('the Discord ping', () => {
  it('only takes a real Discord webhook URL', () => {
    const url = 'https://discord.com/api/webhooks/123456/abc_DEF-ghi';
    expect(webhookUrl(url)).toBe(url);
    expect(webhookUrl(` ${url} `)).toBe(url);
    expect(webhookUrl('https://discordapp.com/api/webhooks/1/x')).toBe('https://discordapp.com/api/webhooks/1/x');
    expect(webhookUrl('https://ptb.discord.com/api/webhooks/1/x')).toBe('https://ptb.discord.com/api/webhooks/1/x');
    for (const bad of [undefined, '', 'off', 'http://discord.com/api/webhooks/1/x', 'https://discord.com.evil.example/api/webhooks/1/x',
      'https://evil.example/?https://discord.com/api/webhooks/1/x', 'https://discord.com/api/webhooks/1/x/../../y']) {
      expect(webhookUrl(bad), String(bad)).toBeNull();
    }
  });

  it('shows the shout exactly as typed: no masked links, no mentions', () => {
    const payload = pingPayload(SHOUT) as { embeds: { title: string; url: string; description: string; footer: { text: string } }[]; allowed_mentions: unknown };
    const [embed] = payload.embeds;
    expect(embed!.description).toBe('**night\\_owl**: hello \\[click\\]\\(https://evil.example\\) @everyone');
    expect(embed!.url).toBe('https://morganvanv.com/social/');
    expect(embed!.footer.text).toContain('#42');
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(discordEscape('a*b_c`d')).toBe('a\\*b\\_c\\`d');
  });

  it('never throws, whatever Discord does', async () => {
    const sent: RequestInit[] = [];
    const ok = (async (_url: string, init: RequestInit) => {
      sent.push(init);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    expect(await sendPing('https://discord.com/api/webhooks/1/x', SHOUT, ok)).toBe(true);
    expect(JSON.parse(String(sent[0]!.body))).toEqual(pingPayload(SHOUT));

    const limited = (async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch;
    expect(await sendPing('https://discord.com/api/webhooks/1/x', SHOUT, limited)).toBe(false);
    const down = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    expect(await sendPing('https://discord.com/api/webhooks/1/x', SHOUT, down)).toBe(false);
  });
});
