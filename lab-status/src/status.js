// Is each of the homelab's public services up? One plain function per question, no Workers APIs, so it runs
// (and is tested) under node --test with a fake fetch.
//
// A service is "up" when its public address answers within TIMEOUT_MS with a 2xx or 3xx (redirects are not
// followed: Foundry sends visitors to /join), and, when a keyword is given, the body is exactly that word
// (Jellyfin's /health says "Healthy", or "Degraded" or "Unhealthy" otherwise). Anything else, a timeout or a
// network error included, is "down". Only names and up/down leave this Worker: never an address, a status
// code or an error message.

/** How long one check may take before it counts as down. */
const TIMEOUT_MS = 5000;

/** How long a result is reused before anyone checks again (per Worker isolate). */
const FRESH_MS = 2 * 60 * 1000;

/**
 * The services the Lab page shows, by the key the site reads. URLs come from the Worker's vars
 * (wrangler.jsonc), so a change of address is a config change, not a code change.
 * @param {Record<string, string | undefined>} env
 * @returns {{ key: string, url: string, keyword?: string }[]}
 */
function targetsFrom(env) {
  const targets = [];
  if (env.VTT_URL) targets.push({ key: 'vtt', url: env.VTT_URL });
  if (env.JELLYFIN_HEALTH_URL) targets.push({ key: 'jellyfin', url: env.JELLYFIN_HEALTH_URL, keyword: 'Healthy' });
  return targets;
}

/**
 * Checks one target.
 * @param {{ url: string, keyword?: string }} target
 * @param {typeof fetch} fetchFn
 * @returns {Promise<'up' | 'down'>}
 */
async function checkOne(target, fetchFn) {
  try {
    const response = await fetchFn(target.url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'morganvanv.com lab-status' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status < 200 || response.status >= 400) {
      await response.body?.cancel();
      return 'down';
    }
    if (!target.keyword) {
      await response.body?.cancel();
      return 'up';
    }
    const text = await response.text();
    return text.trim() === target.keyword ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

/**
 * Checks every target at once.
 * @returns {Promise<{ checkedAt: string, services: Record<string, 'up' | 'down'> }>}
 */
async function checkAll(targets, fetchFn, now = () => Date.now()) {
  const results = await Promise.all(targets.map(target => checkOne(target, fetchFn)));
  const services = {};
  targets.forEach((target, i) => {
    services[target.key] = results[i];
  });
  return { checkedAt: new Date(now()).toISOString(), services };
}

/**
 * Wraps checkAll so a result is reused for FRESH_MS and concurrent callers share one check: however many
 * visitors open /lab, each isolate knocks on Morgan's services at most once every two minutes.
 */
function memoized(check, now = () => Date.now(), freshMs = FRESH_MS) {
  let last = null;
  let lastAt = 0;
  let inFlight = null;
  return () => {
    if (last && now() - lastAt < freshMs) return Promise.resolve(last);
    if (!inFlight) {
      inFlight = check().then(
        result => {
          last = result;
          lastAt = now();
          inFlight = null;
          return result;
        },
        error => {
          inFlight = null;
          throw error;
        },
      );
    }
    return inFlight;
  };
}

module.exports = { TIMEOUT_MS, FRESH_MS, targetsFrom, checkOne, checkAll, memoized };
