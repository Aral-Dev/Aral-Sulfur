
/* ============================================================
 * Auth
 * ============================================================ */

async function getKVSecretKey(env) {
    let secretKey = await env.KV.get('secretKey');
    if (!secretKey) {
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        secretKey = Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
        await env.KV.put('secretKey', secretKey);
    }
    return secretKey;
}

async function isAuthed(request, env) {
    try {
        const cookie = request.headers.get('Cookie') || '';
        const match = cookie.match(/jwtToken=([^;]+)/);
        if (!match) return false;
        const secretKey = await getKVSecretKey(env);
        const payload = await verifyJWT(match[1], secretKey);
        return !!payload;
    } catch {
        return false;
    }
}

/* ============================================================
 * Setup wizard (first activation)
 * ============================================================ */

async function handleSetupApply(request, env) {
    if (request.method !== 'POST') {
        return respond(false, 405, 'Method not allowed.');
    }
    if (!(env && env.KV)) {
        return respond(false, 500, 'KV storage is not bound. Bind a KV namespace (variable name KV) to this worker first.');
    }
    if (await readState(env)) {
        return respond(false, 403, 'Panel is already set up. Please log in instead.');
    }

    try {
        const data = await request.json();
        const accEmail = String(data.accEmail || '').trim().toLowerCase();
        const apiToken = String(data.apiToken || '').trim();
        const panelPass = String(data.panelPass || '').trim();
        const vlUUID = String(data.vlUUID || '').trim().toLowerCase();
        const trPass = String(data.trPass || '').trim();
        const securePath = String(data.securePath || '').trim().replace(/^\/+|\/+$/g, '');

        if (!accEmail || !accEmail.includes('@')) return respond(false, 400, 'Please enter a valid Cloudflare email.');
        if (!apiToken || apiToken.length < 20) return respond(false, 400, 'Please enter a valid Cloudflare API token.');
        if (!panelPass || panelPass.length < 6) return respond(false, 400, 'Panel password must be at least 6 characters.');
        if (!isValidUUID(vlUUID)) return respond(false, 400, 'Please enter a valid VLESS UUID (use the random button).');
        if (!trPass) return respond(false, 400, 'Trojan password is required.');
        if (!securePath || !/^[a-zA-Z0-9_-]+$/.test(securePath)) {
            return respond(false, 400, 'Secure path must contain only letters, numbers, - and _.');
        }

        // validate the token against the Cloudflare API before storing anything
        const accID = await resolveAccountId(apiToken);

        const state = {
            accID,
            accEmail,
            apiToken,
            vlUUID,
            trPass,
            securePath,
            proxyIpMode: 'proxyip',
            proxyIPs: [],
            prefixes: [],
            fallback: '',
            dohUrl: 'https://cloudflare-dns.com/dns-query',
            createdAt: new Date().toISOString(),
        };
        await saveState(env, state);
        await env.KV.put('pwd', panelPass);

        // BPB-VPN pattern: push tunnel settings into the ENV secret so the
        // websocket path becomes fully synchronous. Best-effort — KV stays
        // the source of truth and still serves tunnels if this fails.
        let envSynced = false;
        try {
            await syncTunnelEnv(state, request);
            envSynced = true;
        } catch (error) {
            console.log('ENV sync during setup failed (KV stays authoritative):', safeError(error));
        }

        return respond(true, 200, 'Panel activated successfully!', { securePath, envSynced });
    } catch (error) {
        return respond(false, 400, safeError(error) || 'Setup failed.');
    }
}

/* ============================================================
 * Login / logout
 * ============================================================ */

async function handleLoginAuth(request, env, state) {
    if (request.method !== 'POST') return respond(false, 405, 'Method not allowed.');

    try {
        const data = await request.json();
        const savedPass = await env.KV.get('pwd');
        const username = String(data.username || '').toLowerCase();
        if (username !== state.accEmail || data.password !== savedPass) {
            return respond(false, 401, 'Wrong credentials.');
        }

        const secretKey = await getKVSecretKey(env);
        const jwtToken = await signJWT({ id: state.accID }, secretKey, 24 * 60 * 60);
        return respond(true, 200, 'Successfully generated Auth token.', null, {
            'Set-Cookie': `jwtToken=${jwtToken}; Path=/; HttpOnly; Secure; Max-Age=86400; SameSite=Strict`,
        });
    } catch (error) {
        return respond(false, 500, 'Login failed, please try again.');
    }
}

/* ============================================================
 * Settings (GET/PUT) — re-syncs the ENV secret after every change
 * ============================================================ */

async function handleSettings(request, env, state) {
    if (request.method === 'GET') {
        const updateInfo = await checkUpdateInfo();
        return respond(true, 200, null, {
            proxySettings: {
                vlUUID: state.vlUUID,
                trPass: state.trPass,
                proxyIpMode: state.proxyIpMode,
                proxyIPs: state.proxyIPs,
                prefixes: state.prefixes,
                fallback: state.fallback,
                dohUrl: state.dohUrl,
            },
            securePath: state.securePath,
            panelVersion: PANEL_VERSION,
            updateInfo,
        });
    }

    if (request.method !== 'PUT') return respond(false, 405, 'Method not allowed.');

    try {
        const data = await request.json();
        const cleanList = (arr) =>
            (Array.isArray(arr) ? arr : [arr]).flatMap((s) => String(s || '').split(/[\n,]+/))
                .map((s) => s.trim()).filter(Boolean);

        const nextUUID = String(data.vlUUID || state.vlUUID).trim().toLowerCase();
        if (!isValidUUID(nextUUID)) return respond(false, 400, 'Invalid VLESS UUID.');
        const nextTrPass = String(data.trPass || state.trPass).trim();
        if (!nextTrPass) return respond(false, 400, 'Trojan password cannot be empty.');
        const nextMode = String(data.proxyIpMode || 'proxyip');
        if (!['proxyip', 'prefix'].includes(nextMode)) return respond(false, 400, 'Invalid proxy IP mode.');

        const nextState = {
            ...state,
            vlUUID: nextUUID,
            trPass: nextTrPass,
            proxyIpMode: nextMode,
            proxyIPs: cleanList(data.proxyIPs),
            prefixes: cleanList(data.prefixes),
            fallback: String(data.fallback || '').trim(),
            dohUrl: String(data.dohUrl || 'https://cloudflare-dns.com/dns-query').trim(),
        };

        await saveState(env, nextState);

        let envSynced = true;
        try {
            await syncTunnelEnv(nextState, request);
        } catch (error) {
            envSynced = false;
            console.log('ENV sync after settings update failed (KV stays authoritative):', safeError(error));
        }

        return respond(true, 200, 'Settings updated successfully.', { envSynced });
    } catch (error) {
        return respond(false, 500, `An error occurred while updating settings: ${safeError(error)}`);
    }
}

/* ============================================================
 * Entry point — ONE outer try/catch; nothing escapes to the runtime.
 * ============================================================ */

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="9" y="9" width="14" height="14" transform="rotate(45 16 16)" fill="#f5c518"/></svg>`;

export default {
    async fetch(request, env) {
        try {
            const url = new URL(request.url);
            const path = decodeURIComponent(url.pathname || '/').replace(/\/+$/, '') || '/';
            const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();

            // ---------- tunnel: sync settings from ENV, KV only as fallback ----------
            if (upgrade === 'websocket') {
                let settings = readTunnelSettings(env);
                if (!settings) {
                    const state = await readState(env);
                    settings = stateToTunnelSettings(state);
                }
                if (!settings) return new Response('Not Found', { status: 404 });
                return handleWebsocket(request, settings);
            }

            // ---------- zero-KV static ----------
            if (path === '/favicon.ico') {
                return new Response(FAVICON_SVG, {
                    headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' },
                });
            }

            // ---------- setup wizard ----------
            if (path === '/setup' || path === '/setup/') {
                if (await readState(env)) {
                    return Response.redirect(new URL('/', request.url), 302);
                }
                return renderSetupPage();
            }
            if (path === '/setup/apply') return handleSetupApply(request, env);

            // ---------- KV required for everything below ----------
            if (!(env && env.KV)) return renderKVGuide();

            const state = await readState(env);
            if (!state) {
                if (path === '/' || path === '') {
                    return Response.redirect(new URL('/setup', request.url), 302);
                }
                return Response.redirect(new URL('/setup', request.url), 302);
            }

            const { securePath } = state;
            const route = path.split('/').slice(0, 3).join('/');
            const method = request.method;

            if (path === '/' || path === '') {
                return Response.redirect(new URL(`/${securePath}/panel`, request.url), 302);
            }

            switch (route) {
                case `/${securePath}/login`:
                    if (method === 'POST') return handleLoginAuth(request, env, state);
                    if (await isAuthed(request, env)) {
                        return Response.redirect(new URL(`/${securePath}/panel`, request.url), 302);
                    }
                    return renderLoginPage();

                case `/${securePath}/logout`:
                    return new Response(null, {
                        status: 302,
                        headers: {
                            'Set-Cookie': 'jwtToken=; Path=/; HttpOnly; Secure; Max-Age=0; SameSite=Strict',
                            Location: new URL(`/${securePath}/login`, request.url).toString(),
                        },
                    });

                case `/${securePath}/panel`:
                    if (!(await isAuthed(request, env))) {
                        return Response.redirect(new URL(`/${securePath}/login`, request.url), 302);
                    }
                    if (path === `/${securePath}/panel/settings`) return handleSettings(request, env, state);
                    if (path === `/${securePath}/panel/update-panel`) {
                        if (method !== 'POST') return respond(false, 405, 'Method not allowed.');
                        const result = await applySelfUpdate(state, request);
                        return respond(true, 200, result.updated
                            ? `Panel updated successfully from v${result.previous} to v${result.version}.`
                            : `You are already on the latest version (v${result.version}).`, result);
                    }
                    return renderPanelPage(state);

                case `/${securePath}/sub`:
                    if (path === `/${securePath}/sub`) return handleSubscription(request, state);
                    return new Response('Not Found', { status: 404 });

                default:
                    return bpFallback(request, state);
            }
        } catch (error) {
            console.log('fetch handler error:', safeError(error));
            // last line of defense — an exception here is a 500, never a 1101
            return new Response('Internal error', { status: 500 });
        }
    },
};

/** BPB-VPN style fallback: proxy unknown paths to the configured origin. */
async function bpFallback(request, state) {
    if (state && state.fallback) {
        try {
            const raw = String(state.fallback).trim();
            const target = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
            const url = new URL(request.url);
            url.protocol = 'https:';
            url.hostname = target.hostname;
            url.port = target.port;
            return fetch(new Request(url, request));
        } catch { /* fall through */ }
    }
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}
