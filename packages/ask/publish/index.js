// DigitalOcean entry point for ask/publish (see publish.js).
const { handle } = require('./publish');

// The runtime's own fetch when it has one (Node 18+), node-fetch otherwise.
const fetchImpl = typeof fetch === 'function' ? fetch : require('node-fetch');

async function main(args) {
  return handle(args, { fetch: fetchImpl, env: process.env, now: new Date() });
}

exports.main = main;
