import { decompressGzipBase64, respond, safeError, HttpStatus, isValidUUID } from '@common';
import { getGlobals, getKV, isKVBound, saveMainSettings } from '@settings';
import { MainSettings } from '#types/settings';
import { fallback } from './utils';

export async function handleSetup(request: Request, env: Env): Promise<Response> {
    // setup lives at the ROOT (no securePath prefix): /setup and /setup/apply
    const { pathname } = new URL(request.url);
    const trimmed = pathname.replace(/\/+$/, '');

    switch (trimmed) {
        case '/setup':
            return renderSetup(request, env);

        case '/setup/apply':
            return applySetup(request, env);

        default:
            // any other path while uninitialized: redirect to /setup for convenience
            if (isKVBound()) {
                const url = new URL('/setup', request.url);
                return Response.redirect(url, 302);
            }
            return kvGuidePage();
    }
}

async function renderSetup(request: Request, env: Env): Promise<Response> {
    // KV must be bound before setup can store anything
    if (!isKVBound()) {
        return kvGuidePage();
    }

    // already initialized? send to login/panel
    const kv = getKV();
    if (await kv.get('aralMainSettings')) {
        const { securePath } = getGlobals();
        const url = new URL(`/${securePath}/login`, request.url);
        return Response.redirect(url, 302);
    }

    const str = await decompressGzipBase64(SETUP_HTML_CONTENT);
    const html = str.replaceAll('__ICON__', ICON_CONTENT);

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

interface SetupPayload {
    accEmail: string;
    apiToken: string;
    panelPass: string;
    vlUUID: string;
    trPass: string;
    securePath: string;
}

async function applySetup(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    if (!isKVBound()) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR,
            'KV storage is not bound. Please bind a KV namespace named "aral" (or KV) to this worker first.');
    }

    try {
        const kv = getKV();

        // one-shot setup: refuse if already activated
        if (await kv.get('aralMainSettings')) {
            return respond(false, HttpStatus.FORBIDDEN, 'Panel is already set up. Please log in instead.');
        }

        const data = await request.json() as SetupPayload;
        const accEmail = String(data.accEmail || '').trim().toLowerCase();
        const apiToken = String(data.apiToken || '').trim();
        const panelPass = String(data.panelPass || '').trim();
        const vlUUID = String(data.vlUUID || '').trim();
        const trPass = String(data.trPass || '').trim();
        const securePath = String(data.securePath || '').trim().replace(/^\/+|\/+$/g, '');

        if (!accEmail || !accEmail.includes('@')) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Please enter a valid Cloudflare email.');
        }
        if (!apiToken || apiToken.length < 20) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Please enter a valid Cloudflare API token.');
        }
        if (!panelPass || panelPass.length < 6) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Panel password must be at least 6 characters.');
        }
        if (!isValidUUID(vlUUID)) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Please enter a valid VLESS UUID (use the random button).');
        }
        if (!trPass) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Trojan password is required.');
        }
        if (!securePath || !/^[a-zA-Z0-9_-]+$/.test(securePath)) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Secure path must contain only letters, numbers, - and _.');
        }

        // validate the token against the Cloudflare API before storing anything
        const accID = await validateTokenAndResolveAccount(apiToken);

        const mainSettings: MainSettings & { accID: string; accEmail: string; apiToken: string } = {
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
            dohUrl: 'https://cloudflare-dns.com/dns-query'
        };

        await kv.put('aralMainSettings', JSON.stringify(mainSettings));
        await kv.put('pwd', panelPass);

        return respond(true, HttpStatus.OK, 'Panel activated successfully!', { securePath });
    } catch (error) {
        console.log('Setup error:', error);
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

async function validateTokenAndResolveAccount(apiToken: string): Promise<string> {
    const res = await fetch('https://api.cloudflare.com/client/v4/accounts', {
        headers: { Authorization: `Bearer ${apiToken}` }
    });

    const data: any = await res.json().catch(() => null);
    if (!data || !data.success) {
        const cfMsg = data?.errors?.[0]?.message || `status ${res.status}`;
        throw new Error(`Cloudflare API token validation failed: ${cfMsg}. Make sure the token has "Workers Scripts: Edit" permission.`);
    }

    const accounts = data.result || [];
    if (accounts.length === 0) {
        throw new Error('No Cloudflare account found for this token.');
    }

    return accounts[0].id;
}

/* Friendly guide shown when the KV binding is missing — this is what keeps
   the panel from ever showing a raw 1101 on a fresh deploy. */
function kvGuidePage(): Response {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Aral Sulfur — KV Required</title>
<style>
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.2rem;padding:2rem 1rem;font-family:'Vazirmatn',system-ui;color:#f0ede4;background:radial-gradient(ellipse 70% 60% at 50% 25%,rgba(245,217,10,.06),transparent 75%),#0a0906;text-align:center}
h1{font-family:monospace;font-weight:700;font-size:1.4rem;letter-spacing:.08em;margin:0;text-transform:uppercase}
h1 b{color:#f5d90a}
.card{position:relative;width:min(94vw,600px);padding:1.6rem;background:rgba(22,19,7,.6);border:1px solid rgba(245,217,10,.09);clip-path:polygon(16px 0,100% 0,100% calc(100% - 16px),calc(100% - 16px) 100%,0 100%,0 16px)}
.card::before{content:"";position:absolute;top:0;right:0;width:84px;height:2px;background:linear-gradient(90deg,#f5d90a,transparent)}
h2{font-size:1.05rem;margin:0 0 1rem}
ol{text-align:left;line-height:2.1;color:#d6d1c4;font-size:.9rem;margin:0;padding-inline-start:1.4rem}
ol b{color:#f5d90a}
code{font-family:monospace;color:#f5d90a;background:rgba(245,217,10,.1);padding:2px 8px;border-radius:4px}
.footer{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.footer a{font-family:monospace;font-size:.68rem;color:#9a9484;text-decoration:none;direction:ltr;padding:4px 12px;border:1px solid rgba(245,217,10,.15);background:#0e0c05}
.footer a:hover{color:#f5d90a}
</style>
</head>
<body>
<h1>Aral <b>Sulfur</b></h1>
<div class="card">
<h2>⚠️ KV Storage Not Connected</h2>
<ol>
<li>Open your worker in the <b>Cloudflare Dashboard</b> → <b>Settings</b> → <b>Bindings</b></li>
<li>Click <b>Add</b> → <b>KV Namespace</b></li>
<li>Create (or choose) a namespace named <code>aral</code></li>
<li>Set the <b>Variable name</b> exactly to <code>KV</code></li>
<li>Save, then <b>redeploy / retry</b> — this page will turn into the setup wizard</li>
</ol>
</div>
<div class="footer">
<a href="https://t.me/AralDev">t.me/AralDev</a>
<a href="https://t.me/AralPanel">t.me/AralPanel</a>
<a href="https://youtube.com/@Aral-Dev">@Aral-Dev</a>
<a href="https://github.com/Aral-Dev/Aral-Sulfur">Aral-Dev</a>
</div>
</body>
</html>`;

    return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}
