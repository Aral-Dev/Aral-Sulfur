
/* ============================================================
 * Cloudflare API — ENV secret sync + self-update (bindings preserved)
 * ============================================================ */

async function cfApi(token, url, init = {}) {
    const res = await fetch(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(init.headers || {}),
        },
    });
    const data = await res.json().catch(() => null);
    if (!data) throw new Error(`Cloudflare API returned status ${res.status}`);
    if (!data.success) throw new Error(data?.errors?.[0]?.message || `Cloudflare API error ${res.status}`);
    return data;
}

async function resolveAccountId(token) {
    const data = await cfApi(token, 'https://api.cloudflare.com/client/v4/accounts');
    const accounts = data.result || [];
    if (!accounts.length) throw new Error('No Cloudflare accounts found for this token.');
    return accounts[0].id;
}

function workerNameFromHost(host) {
    const name = String(host || '').split('.')[0];
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error('Could not resolve the worker name from the current host.');
    }
    return name;
}

/** Pushes tunnel settings into the worker's ENV secret (no redeploy, other bindings untouched). */
async function syncTunnelEnv(state, request) {
    if (!state.apiToken) throw new Error('Cloudflare API token is not configured.');
    const host = new URL(request.url).hostname;
    const scriptName = workerNameFromHost(host);
    const accountId = state.accID || await resolveAccountId(state.apiToken);

    await cfApi(state.apiToken,
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
        {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'ENV',
                text: encodeTunnelEnv(stateToTunnelSettings(state)),
                type: 'secret_text',
            }),
        }
    );
}

async function fetchWithTimeout(url, ms, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { headers, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function compareSemver(a, b) {
    const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        const da = pa[i] || 0;
        const db = pb[i] || 0;
        if (da > db) return 1;
        if (da < db) return -1;
    }
    return 0;
}

/** Self-update: read the deployed script's settings (bindings), download the
 *  latest worker from GitHub, redeploy via multipart keeping every binding. */
async function applySelfUpdate(state, request) {
    const host = new URL(request.url).hostname;
    const scriptName = workerNameFromHost(host);
    const accountId = state.accID || await resolveAccountId(state.apiToken);
    const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`;

    // current deployment settings → reuse bindings + compatibility date
    const settingsResp = await cfApi(state.apiToken, `${apiBase}/settings`);
    const current = settingsResp.result || {};
    const compatibilityDate = current.compatibility_date || '2025-01-01';
    let bindings = Array.isArray(current.bindings) ? current.bindings : [];

    // keep KV etc.; replace ENV with the fresh value so the sync tunnel path survives the update
    bindings = bindings.filter((b) => b.name !== 'ENV');
    bindings.push({
        type: 'secret_text',
        name: 'ENV',
        text: encodeTunnelEnv(stateToTunnelSettings(state)),
    });

    // latest published worker
    const pkgResp = await fetchWithTimeout(PACKAGE_RAW_URL, 10000);
    if (!pkgResp.ok) throw new Error('Could not fetch the latest package.json from GitHub.');
    const pkg = await pkgResp.json();
    const latest = String(pkg.version || '');
    if (!latest) throw new Error('Latest version not found in GitHub package.json.');
    if (compareSemver(latest, PANEL_VERSION) <= 0) {
        return { updated: false, version: PANEL_VERSION, latest };
    }

    const workerResp = await fetchWithTimeout(WORKER_RAW_URL, 20000);
    if (!workerResp.ok) throw new Error('Could not fetch the latest worker from GitHub.');
    const code = await workerResp.text();
    if (!code.includes('ARAL SULFUR')) throw new Error('The downloaded file is not an Aral Sulfur worker.');

    const metadata = {
        main_module: 'worker.js',
        compatibility_date: compatibilityDate,
        bindings,
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');

    await cfApi(state.apiToken, apiBase, { method: 'PUT', body: form });
    return { updated: true, version: latest, previous: PANEL_VERSION };
}

/** Version probe for the dashboard badge (no deploy). */
async function checkUpdateInfo() {
    try {
        const resp = await fetchWithTimeout(PACKAGE_RAW_URL, 8000);
        if (!resp.ok) return { updateAvailable: false, latest: PANEL_VERSION };
        const pkg = await resp.json();
        const latest = String(pkg.version || PANEL_VERSION);
        return { updateAvailable: compareSemver(latest, PANEL_VERSION) > 0, latest };
    } catch {
        return { updateAvailable: false, latest: PANEL_VERSION };
    }
}

/* ============================================================
 * Subscription builders — VLESS + Trojan over WS (path /vl and /tr)
 * ============================================================ */

function buildVlessLink(host, uuid, name) {
    const params = new URLSearchParams({
        encryption: 'none',
        security: 'tls',
        sni: host,
        fp: 'chrome',
        type: 'ws',
        host: host,
        path: '/vl',
    });
    return `vless://${uuid}@${host}:443?${params.toString()}#${encodeURIComponent(name)}`;
}

function buildTrojanLink(host, password, name) {
    const params = new URLSearchParams({
        security: 'tls',
        sni: host,
        fp: 'chrome',
        type: 'ws',
        host: host,
        path: '/tr',
    });
    return `trojan://${password}@${host}:443?${params.toString()}#${encodeURIComponent(name)}`;
}

function buildClashConfig(host, uuid, trojanPass) {
    return [
        'proxies:',
        `  - name: "ARAL-VLESS"`,
        '    type: vless',
        `    server: ${host}`,
        '    port: 443',
        `    uuid: ${uuid}`,
        '    tls: true',
        '    servername: ' + host,
        '    client-fingerprint: chrome',
        '    network: ws',
        '    ws-opts:',
        '      path: /vl',
        '      headers:',
        `        Host: ${host}`,
        `  - name: "ARAL-TROJAN"`,
        '    type: trojan',
        `    server: ${host}`,
        '    port: 443',
        `    password: ${trojanPass}`,
        '    sni: ' + host,
        '    client-fingerprint: chrome',
        '    network: ws',
        '    ws-opts:',
        '      path: /tr',
        '      headers:',
        `        Host: ${host}`,
        'proxy-groups:',
        '  - name: "ARAL-SULFUR"',
        '    type: select',
        '    proxies:',
        '      - "ARAL-VLESS"',
        '      - "ARAL-TROJAN"',
        'rules:',
        '  - MATCH,ARAL-SULFUR',
    ].join('\n');
}

function buildXrayOutbounds(host, uuid, trojanPass) {
    return {
        log: { loglevel: 'warning' },
        outbounds: [
            {
                tag: 'proxy-vless',
                protocol: 'vless',
                settings: {
                    vnext: [{
                        address: host,
                        port: 443,
                        users: [{ id: uuid, encryption: 'none', flow: '' }],
                    }],
                },
                streamSettings: {
                    network: 'ws',
                    security: 'tls',
                    tlsSettings: { serverName: host, fingerprint: 'chrome' },
                    wsSettings: { path: '/vl', headers: { Host: host } },
                },
            },
            {
                tag: 'proxy-trojan',
                protocol: 'trojan',
                settings: {
                    servers: [{ address: host, port: 443, password: trojanPass }],
                },
                streamSettings: {
                    network: 'ws',
                    security: 'tls',
                    tlsSettings: { serverName: host, fingerprint: 'chrome' },
                    wsSettings: { path: '/tr', headers: { Host: host } },
                },
            },
            { tag: 'direct', protocol: 'freedom' },
            { tag: 'block', protocol: 'blackhole' },
        ],
    };
}

function buildSingBoxConfig(host, uuid, trojanPass) {
    return {
        log: { level: 'warn' },
        outbounds: [
            {
                tag: 'aral-vless',
                type: 'vless',
                server: host,
                server_port: 443,
                uuid: uuid,
                tls: { enabled: true, server_name: host, utls: { enabled: true, fingerprint: 'chrome' } },
                transport: { type: 'ws', path: '/vl', headers: { Host: host } },
            },
            {
                tag: 'aral-trojan',
                type: 'trojan',
                server: host,
                server_port: 443,
                password: trojanPass,
                tls: { enabled: true, server_name: host, utls: { enabled: true, fingerprint: 'chrome' } },
                transport: { type: 'ws', path: '/tr', headers: { Host: host } },
            },
            { tag: 'direct', type: 'direct' },
        ],
    };
}

/** Subscription endpoint. ?app=links|xray|sing-box|clash (default: base64 links) */
async function handleSubscription(request, state) {
    const host = new URL(request.url).hostname;
    const app = new URL(request.url).searchParams.get('app') || 'links';
    const name = `ARAL-SULFUR`;

    if (app === 'clash') {
        return new Response(buildClashConfig(host, state.vlUUID, state.trPass), {
            headers: {
                'Content-Type': 'text/yaml; charset=utf-8',
                'Profile-Update-Interval': '24',
                'Subscription-Userinfo': 'upload=0; download=0; total=107374182400; expire=0',
            },
        });
    }

    if (app === 'xray') {
        return new Response(JSON.stringify(buildXrayOutbounds(host, state.vlUUID, state.trPass), null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
    }

    if (app === 'sing-box') {
        return new Response(JSON.stringify(buildSingBoxConfig(host, state.vlUUID, state.trPass), null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
    }

    const links = [
        buildVlessLink(host, state.vlUUID, `${name}-VLESS`),
        buildTrojanLink(host, state.trPass, `${name}-TROJAN`),
    ].join('\n');
    return new Response(utf8ToBase64(links), {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Profile-Update-Interval': '24',
            'Subscription-Userinfo': 'upload=0; download=0; total=107374182400; expire=0',
        },
    });
}
