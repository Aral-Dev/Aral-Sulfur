import { handleDoH } from '@handlers/doh';
import { renderError } from '@handlers/error';
import { handleLogin } from '@handlers/login';
import { handlePanel } from '@handlers/panel';
import { handleProxyIPs } from '@handlers/proxy-ip';
import { generateQRCode } from '@handlers/qrcode';
import { handleSetup } from '@handlers/setup';
import { handleSubscriptions } from '@handlers/subscription';
import { handleTelegram } from '@handlers/telegram';
import { fallback } from '@handlers/utils';
import { handleWebsocket } from '@handlers/websocket';
import { init, getGlobals, loadMainSettings, isKVBound } from '@settings';

export default {
	async fetch(request: Request, env: Env) {
		try {
			init(request, env);

			if (request.headers.get('Upgrade') === 'websocket') return handleWebsocket(request);

			// Setup flow runs before anything else: it works without a securePath
			// and is the only thing reachable until the panel is activated.
			if (!await ensureInitialized()) {
				return await safeRoute(handleSetup(request, env));
			}

			const { securePath, pathname } = getGlobals();
			const path = pathname.split('/').splice(0, 3).join('/');

			// /setup stays reachable after activation → sends to login
			if (pathname === '/setup' || pathname === '/setup/apply') {
				const url = new URL(`/${securePath}/login`, request.url);
				return Response.redirect(url, 302);
			}

			switch (path) {
				case `/${securePath}/panel`:
					return await safeRoute(handlePanel(request, env));

				case `/${securePath}/login`:
					return await safeRoute(handleLogin(request, env));

				case `/${securePath}/sub`:
					return await safeRoute(handleSubscriptions(request, env));

				case `/${securePath}/telegram`:
					return await safeRoute(handleTelegram(request, env));

				case `/${securePath}/dns-query`:
					return handleDoH(request);

				case `/${securePath}/proxy-ip`:
					return await safeRoute(handleProxyIPs(request, env));

				case `/${securePath}/qrcode`:
					return generateQRCode(request);

				default:
					return await safeRoute(fallback(request));
			}
		} catch (error) {
			// Never let an exception escape to the runtime (Cloudflare error 1101):
			// renderError itself is fault-tolerant and always resolves to a Response.
			return await safeErrorPage(error);
		}
	}
};

/**
 * Loads the main settings from KV on the first request of an isolate.
 * Returns false while the panel has not been activated yet — in that case
 * every route falls through to the setup wizard.
 */
async function ensureInitialized(): Promise<boolean> {
	try {
		if (!isKVBound()) return false;

		const settings = await loadMainSettings();
		return settings !== null;
	} catch (error) {
		console.log('Init load error (falling back to setup route):', error);
		return false;
	}
}

/**
 * Wraps a routed handler result so a rejected promise or a thrown
 * non-Error value still becomes a valid Response instead of a 1101.
 */
async function safeRoute(handler: Promise<Response> | Response): Promise<Response> {
	try {
		return await handler;
	} catch (error) {
		return await safeErrorPage(error);
	}
}

async function safeErrorPage(error: any): Promise<Response> {
	try {
		return await renderError(error);
	} catch {
		return new Response(
			'Aral Sulfur encountered an unexpected error. Please try again or reach us on t.me/AralDev',
			{ status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
		);
	}
}
