import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // The pure modules, in plain Node.
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'], environment: 'node' },
      },
      {
        // The whole Worker and its Durable Object, in the Workers runtime (workerd, offline).
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: { bindings: { CAMPFIRE_HOST_KEY: 'test-host-key' } },
          }),
        ],
        test: { name: 'worker', include: ['test/worker/**/*.test.ts'] },
      },
    ],
  },
});
