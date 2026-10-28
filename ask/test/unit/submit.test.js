// Run with: npm run test:unit (node --test)
const test = require('node:test');
const assert = require('node:assert/strict');
const { handleSubmit } = require('../../src/submit');

const env = { DISCORD_WEBHOOK_URL: 'https://discord.example/webhook' };

function discord(status = 204) {
  const sent = [];
  const fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: status < 300, status }; };
  return { sent, fetch };
}

test('only a POST is a submission; OPTIONS is the CORS preflight', async () => {
  const { sent, fetch } = discord();
  const main = args => handleSubmit(args, { fetch, env });
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
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, env.DISCORD_WEBHOOK_URL);
});

test('an odd honeypot value doesn\'t crash it, and a filled one sends nothing', async () => {
  const { sent, fetch } = discord();
  const main = args => handleSubmit(args, { fetch, env });
  assert.equal((await main({ http: { method: 'POST' }, question: 'hi', username_honey: 42 })).statusCode, 200);
  assert.deepEqual((await main({ http: { method: 'POST' }, question: 'hi', username_honey: 'bot' })).body.message, 'Submission received.');
  assert.equal(sent.length, 1);
});

test('a bad submission is a 400, and nothing reaches Discord', async () => {
  const { sent, fetch } = discord();
  const response = await handleSubmit({ http: { method: 'POST' }, question: '' }, { fetch, env });
  assert.equal(response.statusCode, 400);
  assert.equal(typeof response.body.error, 'string');
  assert.equal(sent.length, 0);
});

test('no webhook is a 503; Discord failing or hanging is a 500', async () => {
  const { fetch } = discord();
  const post = { http: { method: 'POST' }, question: 'hi' };
  assert.equal((await handleSubmit(post, { fetch, env: {} })).statusCode, 503);
  assert.equal((await handleSubmit(post, { fetch, env: { DISCORD_WEBHOOK_URL: 'http://insecure.example' } })).statusCode, 503);
  assert.equal((await handleSubmit(post, { fetch: discord(500).fetch, env })).statusCode, 500);
  const hangs = async () => { throw new DOMException('timed out', 'TimeoutError'); };
  assert.equal((await handleSubmit(post, { fetch: hangs, env })).statusCode, 500);
});
