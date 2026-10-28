// POST /submit: the site's Contact form and "name a star" panel. Checks a submission and forwards it to
// Morgan's private Discord channel, with a "Publish as PR" link when publishing is set up (embed.js).
const { problem, discordPayload, publishConfig } = require('./embed');
const { methodOf } = require('./publish-link');

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Handles one submission. `args` is the JSON body plus `http: { method }` (index.mjs builds it);
 * `deps` = { fetch, env, now } so tests can stand in for Discord and the clock.
 */
async function handleSubmit(args, { fetch, env, now = new Date() }) {
  const method = methodOf(args);
  // The CORS preflight (index.mjs answers it before it gets here, with the headers).
  if (method === 'options') return { statusCode: 204 };

  // Only the site's POST is a submission: without this a plain link or <img src="…?question=…"> on any
  // page could post to Discord from its visitors. A request whose method wasn't given is refused too.
  if (method !== 'post') {
    return { statusCode: 405, headers: { Allow: 'POST, OPTIONS', ...JSON_HEADERS }, body: { error: 'Method not allowed.' } };
  }

  // The honeypot: a filled-in hidden field is a bot. Tell it it worked.
  if (typeof args.username_honey === 'string' && args.username_honey.trim() !== '') {
    return { statusCode: 200, headers: JSON_HEADERS, body: { success: true, message: 'Submission received.' } };
  }

  const error = problem(args);
  if (error) return { statusCode: 400, headers: JSON_HEADERS, body: { error } };

  const webhook = typeof env.DISCORD_WEBHOOK_URL === 'string' ? env.DISCORD_WEBHOOK_URL.trim() : '';
  if (!webhook.startsWith('https://')) {
    console.error('ask/submit: DISCORD_WEBHOOK_URL isn\'t set');
    return { statusCode: 503, headers: JSON_HEADERS, body: { error: 'The mailbox is closed right now. Try again later.' } };
  }

  const payload = discordPayload(args, now, publishConfig(env));
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Discord responded with status ${response.status}`);
    return { statusCode: 200, headers: JSON_HEADERS, body: { success: true, message: 'Sent successfully!' } };
  } catch (failure) {
    // Never the webhook URL or the visitor's text: just what went wrong.
    console.error('ask/submit: Discord failed', failure && failure.message);
    return { statusCode: 500, headers: JSON_HEADERS, body: { error: 'Internal server error failing to dispatch message.' } };
  }
}

module.exports = { handleSubmit };
