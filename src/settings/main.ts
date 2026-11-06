import { EmbededSettings, MainSettings, PanelSettings } from '#types/settings';
import { getGlobals, getMainSettings, getSettings, saveMainSettings, getKV, isKVBound } from '@settings';
import { createCNAME, listZones } from '@api/dns';
import { safeError } from '@common';

const ARAL_REPO = 'Aral-Dev/Aral-Sulfur';
const ARAL_WORKER_URL = `https://raw.githubusercontent.com/${ARAL_REPO}/main/worker-single-file.js`;

/**
 * Saves the "main" (formerly embedded) settings into KV.
 * No worker re-deploy is needed anymore — changes apply on the next request.
 */
export async function updateMainSettings(newSettings: PanelSettings | null): Promise<Partial<EmbededSettings>> {
    const { vlUUID, trPass, securePath, accID, accEmail, apiToken } = getGlobals();
    const settings: MainSettings = {
        // credentials are preserved across settings updates (they come from setup)
        accID,
        accEmail,
        apiToken,
        vlUUID: newSettings ? newSettings.vlUUID : vlUUID,
        trPass: newSettings ? newSettings.trPass : trPass,
        securePath: newSettings ? newSettings.securePath : securePath,
        proxyIpMode: newSettings ? newSettings.proxyIpMode : 'proxyip',
        proxyIPs: newSettings ? newSettings.proxyIPs : [],
        prefixes: newSettings ? newSettings.prefixes : [],
        fallback: newSettings ? newSettings.fallback : '',
        dohUrl: newSettings ? newSettings.dohUrl : ''
    };

    if (newSettings) {
        const same = compareMainSettings(settings);
        if (same) return {};
    }

    try {
        await saveMainSettings(settings);
        return settings;
    } catch (error) {
        throw new Error(`An error occurred while updating settings: ${safeError(error)}`);
    }
}

function compareMainSettings(settings: MainSettings): boolean {
    const mainSettings = getMainSettings();
    const keys = Object.keys(mainSettings) as Array<keyof MainSettings>;

    return keys.every(key => {
        const envValue = mainSettings[key];
        const settingValue = settings[key];
        if (Array.isArray(envValue) && Array.isArray(settingValue)) {
            return envValue.join(',') === settingValue.join(',');
        }

        return envValue === settingValue;
    });
}

export async function setCustomDomain(customDomain: string) {
    if (!customDomain) return;
    const { deployType } = getGlobals();

    try {
        const tld = customDomain.split('.').slice(-2).join('.');
        const dnsZones = await listZones();
        const zone = dnsZones?.find((z: any) => z.name === tld);
        if (!zone) throw new Error(`Specified domain ${tld} is not registered on your Cloudflare account.`);
        const zoneID = zone.id;
        const { getWorkerDomains, setWorkerDomain } = await import('@api/workers');
        const { getPagesDomains, setPagesDomain } = await import('@api/pages');
        const customDomains = deployType === 'workers'
            ? await getWorkerDomains()
            : await getPagesDomains();

        if (customDomains.includes(customDomain)) {
            throw new Error(`Custom domain '${customDomain}' is already added to ${deployType}.`);
        }

        if (deployType === 'pages') {
            await setPagesDomain(customDomain);
            await createCNAME(zoneID, customDomain);
        } else {
            await setWorkerDomain(customDomain);
        }

        return customDomain;
    } catch (error) {
        throw new Error(`Failed to set Custom Domain: ${safeError(error)}`);
    }
}

/* ---------- Cloudflare Workers self-update (Aral pattern: preserve all bindings) ---------- */

interface UpdateContext {
    apiToken: string;
    accountId: string;
    scriptName: string;
}

async function cfFetch(url: string, apiToken: string, init?: RequestInit): Promise<any> {
    const res = await fetch(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${apiToken}`,
            ...(init?.headers || {})
        }
    });

    const data: any = await res.json().catch(() => null);
    if (!data) throw new Error(`Cloudflare API returned status ${res.status}`);
    if (!data.success) throw new Error(data?.errors?.[0]?.message || `Cloudflare API error ${res.status}`);
    return data;
}

/** Resolves the caller's account ID from the API token when not configured. */
async function resolveAccountId(apiToken: string, preferred: string): Promise<string> {
    if (preferred) return preferred;

    const data = await cfFetch('https://api.cloudflare.com/client/v4/accounts', apiToken);
    const accounts = data.result || [];
    if (accounts.length === 1) return accounts[0].id;
    if (accounts.length > 1) {
        throw new Error('Multiple Cloudflare accounts found. Please run setup and select your account.');
    }
    throw new Error('No Cloudflare account found for this API token.');
}

/** Downloads the latest worker from the Aral Sulfur repo (root-level worker-single-file.js). */
async function fetchLatestWorkerCode(): Promise<string> {
    const res = await fetch(ARAL_WORKER_URL, { cache: 'no-store' });
    if (!res.ok) {
        throw new Error(`Failed to download the latest worker from ${ARAL_WORKER_URL} (status ${res.status}).`);
    }

    const code = await res.text();
    if (code.length < 10000 || !code.includes('export')) {
        throw new Error('The downloaded worker file does not look valid. Please try again later.');
    }

    return code;
}

/**
 * Applies a self-update: re-uploads the worker from the repo while keeping
 * existing bindings (KV, secrets, vars) and compatibility flags intact.
 */
export async function applySelfUpdate(ctx: UpdateContext): Promise<{ previousVersion: string }> {
    const { apiToken } = ctx;
    const accountId = await resolveAccountId(apiToken, ctx.accountId);

    // figure out the script name from the current host when not provided
    let scriptName = ctx.scriptName;
    if (!scriptName) {
        const { hostname } = getGlobals();
        const sub = hostname.split('.')[0];
        scriptName = sub && sub !== hostname ? sub : hostname.split('-')[0];
    }
    if (!scriptName) throw new Error('Worker name is required for the update.');

    const workerCode = await fetchLatestWorkerCode();

    // read current settings so KV bindings / vars / compat flags survive the update
    const cfBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`;
    let metadata: Record<string, any> = {
        main_module: 'worker.js',
        compatibility_date: new Date().toISOString().split('T')[0],
        compatibility_flags: [],
        keep_bindings: ['kv_namespace', 'secret_text', 'secret_key', 'web_service', 'r2_bucket', 'd1', 'service']
    };

    try {
        const current = await cfFetch(`${cfBase}/${encodeURIComponent(scriptName)}/settings`, apiToken);
        const existing = current.result || {};
        metadata = {
            main_module: 'worker.js',
            compatibility_date: existing.compatibility_date || metadata.compatibility_date,
            compatibility_flags: Array.isArray(existing.compatibility_flags) && existing.compatibility_flags.length
                ? existing.compatibility_flags
                : [],
            bindings: Array.isArray(existing.bindings)
                ? existing.bindings.filter((b: any) => b && b.name).map((b: any) =>
                    (b.type === 'secret_text' || b.type === 'secret_key') ? { type: 'inherit', name: b.name } : b)
                : [],
            keep_bindings: ['secret_text', 'secret_key'],
            ...(existing.usage_model ? { usage_model: existing.usage_model } : {})
        };
    } catch (error) {
        console.log('Could not read current worker settings, uploading with defaults:', safeError(error));
    }

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('worker.js', new Blob([workerCode], { type: 'application/javascript+module' }), 'worker.js');

    await cfFetch(`${cfBase}/${encodeURIComponent(scriptName)}`, apiToken, { method: 'PUT', body: form });

    return { previousVersion: VERSION };
}

/** Latest published version of the panel on the Aral Sulfur repo. */
export async function fetchLatestVersion(): Promise<string | null> {
    try {
        const res = await fetch(`https://raw.githubusercontent.com/${ARAL_REPO}/main/package.json`, {
            cache: 'no-store'
        });
        if (!res.ok) return null;
        const pkg: any = await res.json();
        return pkg?.version ?? null;
    } catch {
        return null;
    }
}
