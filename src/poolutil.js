/**
 * ARAL SULFUR — Pool constants & tiny safe-parse helpers (split out so both the
 * storage layer and the pools layer can import without circular deps).
 */

/** Official repository hosting the `data/` pools (clean IPs, domains, exit proxies). */
export const DEFAULT_DATA_REPO = 'Aral-Dev/Aral-Sulfur';

export const POOL_KEYS = {
  proxy: 'nl:pool:proxy:v1',
  ips4: 'nl:pool:ips4:v1',
  ips6: 'nl:pool:ips6:v1',
  dom: 'nl:pool:dom:v1',
};

/** KV marker so one-time auto-provisioning of pools from the data repo runs only once. */
export const POOL_PROVISION_KEY = 'nl:pool:provisioned:v1';

export const POOL_LIMITS = { proxy: 6000, ips4: 60000, ips6: 8000, dom: 4000 };

export function safeJsonParseGuard(raw, fallback = null) {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
