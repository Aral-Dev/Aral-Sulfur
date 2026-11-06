import { HttpStatus, respond } from '@common';
import { getGlobals, getKV } from '@settings';

export function logout(): Response {
    return respond(true, HttpStatus.OK, 'Successfully logged out!', null, {
        'Set-Cookie': 'jwtToken=; Path=/; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'Content-Type': 'text/plain'
    });
}

export async function generateJWTToken(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    try {
        const kv = getKV();
        const data = await request.json() as any;
        const savedPass = await kv.get('pwd');
        const { accEmail } = getGlobals();
        const username = data.username?.toLowerCase();
        if (username !== accEmail || data.password !== savedPass) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Wrong Credentials.');
        }

        let secretKey = await kv.get('secretKey');
        if (!secretKey) {
            secretKey = generateSecretKey();
            await kv.put('secretKey', secretKey);
        }

        const { accID } = getGlobals();
        const jwtToken = await signJWT({ id: accID }, secretKey, 24 * 60 * 60);

        return respond(true, HttpStatus.OK, 'Successfully generated Auth token', null, {
            'Set-Cookie': `jwtToken=${jwtToken}; Path=/; HttpOnly; Secure; Max-Age=${24 * 60 * 60}; SameSite=Strict`,
            'Content-Type': 'text/plain',
        });
    } catch (error) {
        console.log('Login error:', error);
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, 'Login failed, please try again.');
    }
}

function generateSecretKey(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);

    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/* ---------- Minimal HS256 JWT (WebCrypto only, no external deps) ---------- */

function base64UrlEncode(bytes: Uint8Array | string): string {
    const input = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    let binary = '';
    for (const b of input) binary += String.fromCharCode(b);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecodeToString(str: string): string {
    const b64 = str.replaceAll('-', '+').replaceAll('_', '/')
        .padEnd(Math.ceil(str.length / 4) * 4, '=');
    return atob(b64);
}

async function hmacSign(keyStr: string, data: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(keyStr),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
    return new Uint8Array(sig);
}

async function signJWT(payload: Record<string, any>, secret: string, maxAgeSec: number): Promise<string> {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const body = { ...payload, iat: now, exp: now + maxAgeSec };

    const headPart = base64UrlEncode(JSON.stringify(header));
    const payloadPart = base64UrlEncode(JSON.stringify(body));
    const signingInput = `${headPart}.${payloadPart}`;
    const sig = await hmacSign(secret, signingInput);

    return `${signingInput}.${base64UrlEncode(sig)}`;
}

async function verifyJWT(token: string, secret: string): Promise<Record<string, any> | null> {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const head = JSON.parse(base64UrlDecodeToString(parts[0]));
        if (head?.alg !== 'HS256') return null;

        const expectedSig = await hmacSign(secret, `${parts[0]}.${parts[1]}`);
        const expected = base64UrlEncode(expectedSig);
        if (expected !== parts[2]) return null;

        const payload = JSON.parse(base64UrlDecodeToString(parts[1]));
        if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;

        return payload;
    } catch {
        return null;
    }
}

export async function authenticate(request: Request, env: Env): Promise<boolean> {
    try {
        const kv = getKV();
        const secretKey = await kv.get('secretKey');
        if (secretKey === null) {
            console.log('Secret key not found in KV.');
            return false;
        }

        const cookie = request.headers.get('Cookie')?.match(/(^|;\s*)jwtToken=([^;]*)/);
        const token = cookie ? cookie[2] : null;
        if (!token) {
            console.log('Unauthorized: Token not available!');
            return false;
        }

        const payload = await verifyJWT(token, secretKey);
        if (!payload) {
            console.log('Unauthorized: Invalid or expired token.');
            return false;
        }

        return true;
    } catch (error) {
        console.log(error);
        return false;
    }
}

export async function resetPassword(request: Request, env: Env): Promise<Response> {
    try {
        const kv = getKV();
        const auth = await authenticate(request, env);
        const oldPwd = await kv.get('pwd');
        if (oldPwd && !auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized.');
        }

        const data = await request.json() as any;
        const { accEmail } = getGlobals();

        if (!auth && !data.username) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Missing username.');
        }

        if (data.username && data.username !== accEmail) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Wrong username.');
        }

        if (data.password === oldPwd) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Please enter a new Password.');
        }

        await kv.put('pwd', data.password);

        return respond(true, HttpStatus.OK, 'Successfully logged in!', null, {
            'Set-Cookie': 'jwtToken=; Path=/; Secure; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
            'Content-Type': 'text/plain',
        });
    } catch (error) {
        console.log(error);
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to reset password, please try again.');
    }
}
