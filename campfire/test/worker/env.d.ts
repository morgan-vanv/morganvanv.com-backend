import type { Env as CampfireEnv } from '../../src/campfire';

declare global {
  namespace Cloudflare {
    interface Env extends CampfireEnv {}
  }
}
