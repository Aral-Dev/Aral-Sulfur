import { decompressGzipBase64, safeError } from '@common';

export async function renderError(error: any): Promise<Response> {
    const html = await buildErrorPage(error);

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

/**
 * Builds the branded error page in a fully fault-tolerant way.
 * Every step has a static fallback so an exception inside error
 * rendering can never bubble up to the runtime (Cloudflare error 1101).
 */
async function buildErrorPage(error: any): Promise<string> {
    const message = safeError(error);

    let html: string;
    try {
        html = await decompressGzipBase64(ERROR_HTML_CONTENT);
    } catch {
        html = STATIC_ERROR_PAGE;
    }

    try {
        html = html
            .replace('__ERROR_MESSAGE__', escapeHtml(message))
            .replaceAll('__ICON__', typeof ICON_CONTENT === 'string' ? ICON_CONTENT : '');
    } catch {
        html = STATIC_ERROR_PAGE.replace('__ERROR_MESSAGE__', escapeHtml(message));
    }

    return html;
}

function escapeHtml(str: string): string {
    return String(str)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

const STATIC_ERROR_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Aral Sulfur — Error</title>
<style>
body,html{height:100%;margin:0;display:flex;justify-content:center;align-items:center;background:#0a0906;color:#d6d1c4;font-family:system-ui,sans-serif;text-align:center;padding:1.5rem;box-sizing:border-box}
.card{max-width:560px;padding:2rem;border:1px solid rgba(245,217,10,.2);background:rgba(22,19,7,.6)}
h1{color:#f0ede4;font-size:1.4rem;margin:0 0 .8rem;letter-spacing:.08em;text-transform:uppercase}
h1 span{color:#f5d90a}
p{margin:0;font-size:.9rem;line-height:1.9;word-break:break-word}
.links{margin-top:1.4rem;display:flex;justify-content:center;gap:8px;flex-wrap:wrap}
a{color:#9a9484;font-size:.75rem;text-decoration:none;font-family:monospace;border:1px solid rgba(245,217,10,.15);padding:4px 12px}
a:hover{color:#f5d90a}
</style>
</head>
<body>
<div class="card">
<h1>Aral <span>Sulfur</span></h1>
<p><b>❌ Something went wrong!</b></p>
<p>__ERROR_MESSAGE__</p>
<div class="links">
<a href="https://t.me/AralDev">t.me/AralDev</a>
<a href="https://t.me/AralPanel">t.me/AralPanel</a>
<a href="https://github.com/Aral-Dev/Aral-Sulfur">Aral-Dev</a>
</div>
</div>
</body>
</html>`;
