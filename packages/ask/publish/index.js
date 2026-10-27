// DigitalOcean entry point for ask/publish (see publish.js). The runtime is pinned to nodejs:24 in
// project.yml, so fetch and AbortController are built in and this function has no dependencies.
const { handle } = require('./publish');

async function main(args) {
  return handle(args, { fetch, env: process.env, now: new Date() });
}

exports.main = main;
