/**
 * Pings Morgan's Discord when a guest shouts (optional: only with a DISCORD_WEBHOOK_URL secret), so he
 * sees what's said without keeping /social open. A ping carries the nick, the text and the shout's id,
 * never anything about who said it.
 */
import { SHOUTBOX_URL } from './config';

/** A Discord webhook URL, or null if `raw` isn't one (unset, blank or anything else means pings are off). */
export function webhookUrl(raw: string | undefined): string | null {
  const url = raw?.trim() ?? '';
  return /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url) ? url : null;
}

/** Discord Markdown escaped (as the Ask Morgan embed does), so text shows exactly as typed and can't make a masked link. */
export function discordEscape(text: string): string {
  return text.replace(/[\\`*_~|<>#\-[\]()]/g, '\\$&');
}

export interface PingShout {
  readonly id: number;
  readonly nick: string;
  readonly text: string;
  readonly at: string;
}

/** The webhook body for one shout. Mentions are off: a shout never pings anyone, whatever it says. */
export function pingPayload(shout: PingShout): unknown {
  return {
    embeds: [{
      title: '🔥 Shout',
      url: SHOUTBOX_URL,
      description: `**${discordEscape(shout.nick)}**: ${discordEscape(shout.text)}`,
      color: 0xc9922a,
      footer: { text: `#${shout.id} · delete it from /social with your host key` },
      timestamp: shout.at,
    }],
    allowed_mentions: { parse: [] },
  };
}

/**
 * Sends the ping. Never throws: a ping that fails is only logged (status only, never the shout), and
 * it runs after the response has gone (waitUntil), so it can't slow down or fail a shout.
 */
export async function sendPing(url: string, shout: PingShout, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pingPayload(shout)),
    });
    if (!response.ok) console.error(`ping: Discord answered ${response.status}`);
    return response.ok;
  } catch (error) {
    console.error('ping: Discord unreachable', error instanceof Error ? error.message : 'unknown error');
    return false;
  }
}
