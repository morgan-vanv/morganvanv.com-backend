import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The whole Worker in the Workers runtime (workerd, offline). The handlers' own tests are test/unit
// (node --test). Discord is never called: these tests only reach paths that stop first.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          DISCORD_WEBHOOK_URL: 'off',
          PUBLISH_SECRET: 'test-publish-secret-0123456789abcdef-0123',
        },
      },
    }),
  ],
  test: { include: ['test/worker/**/*.test.mjs'] },
});
