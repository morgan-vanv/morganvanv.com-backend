import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The whole Worker in the Workers runtime (workerd, offline). status.js has its own tests in test/unit
// (node --test, with a fake fetch). The service URLs are blanked here, so nothing ever leaves.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { VTT_URL: '', JELLYFIN_HEALTH_URL: '', DESK_HEALTH_URL: '', MINECRAFT_ADDRESS: '' } },
    }),
  ],
  test: { include: ['test/worker/**/*.test.mjs'] },
});
