// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('../packages/ask/submit/index');

async function withFetch(fake, fn) {
  const original = globalThis.fetch;
  const originalUrl = process.env.DISCORD_WEBHOOK_URL;
  globalThis.fetch = fake;
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.example/webhook';
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    if (originalUrl === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = originalUrl;
  }
}

test('only a POST is a submission; OPTIONS is the CORS preflight', async () => {
  const sent = [];
  const fake = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 204 }; };
  await withFetch(fake, async () => {
    assert.equal((await main({ http: { method: 'OPTIONS' } })).statusCode, 204);
    assert.equal((await main({ __ow_method: 'options' })).statusCode, 204);
    for (const args of [{ http: { method: 'GET' } }, { __ow_method: 'get' }, {}, { http: 'POST' }]) {
      const response = await main({ ...args, question: 'hi' });
      assert.equal(response.statusCode, 405, JSON.stringify(args));
      assert.equal(response.headers.Allow, 'POST, OPTIONS');
    }
    assert.equal(sent.length, 0);
    assert.equal((await main({ http: { method: 'POST' }, question: 'hi' })).statusCode, 200);
    assert.equal((await main({ __ow_method: 'post', question: 'hi' })).statusCode, 200);
  });
  assert.equal(sent.length, 2);
});

test('an odd honeypot value doesn\'t crash it', async () => {
  await withFetch(async () => ({ ok: true, status: 204 }), async () => {
    assert.equal((await main({ http: { method: 'POST' }, question: 'hi', username_honey: 42 })).statusCode, 200);
    assert.deepEqual((await main({ http: { method: 'POST' }, question: 'hi', username_honey: 'bot' })).body.message, 'Submission received.');
  });
});
