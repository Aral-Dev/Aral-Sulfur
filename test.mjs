#!/usr/bin/env node
/**
 * ARAL SULFUR v1.0.0 — Comprehensive Live `workerd` + Playwright + TLS-over-VLESS E2E Suite (17/17 Suites)
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const PORT = 18800 + Math.floor(Math.random() * 500);
const MOCK_PORT = 19400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildVlessHeader(uuidStr, host, port, cmd = 1) {
  const uuidBytes = Buffer.from(uuidStr.replace(/-/g, ''), 'hex');
  const hostBytes = Buffer.from(host, 'utf8');
  const hdr = Buffer.alloc(1 + 16 + 1 + 1 + 2 + 1 + 1 + hostBytes.length);
  let o = 0;
  hdr[o++] = 0x00;
  uuidBytes.copy(hdr, o); o += 16;
  hdr[o++] = 0x00;
  hdr[o++] = cmd;
  hdr.writeUInt16BE(port, o); o += 2;
  hdr[o++] = 0x02;
  hdr[o++] = hostBytes.length;
  hostBytes.copy(hdr, o);
  return hdr;
}

async function fetchHttpsViaFragmentedVless({ wsUrl, uuid, targetHost, targetPort = 443, path = '/' }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let vlessRespHeaderStripped = false;

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`VLESS HTTPS test timed out for ${targetHost}`));
    }, 20000);

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.on('open', async () => {
      const vlessHdr = buildVlessHeader(uuid, targetHost, targetPort, 1);
      ws.send(vlessHdr);
      await sleep(35);

      let fragBudget = 6;
      const duplex = new Duplex({
        read() {},
        write(chunk, _enc, cb) {
          (async () => {
            const buf = Buffer.from(chunk);
            if (fragBudget > 0 && buf.length > 20) {
              fragBudget--;
              for (let off = 0; off < buf.length; off += 24) {
                if (ws.readyState !== WebSocket.OPEN) break;
                ws.send(buf.subarray(off, Math.min(off + 24, buf.length)));
                await sleep(8);
              }
            } else if (ws.readyState === WebSocket.OPEN) {
              ws.send(buf);
            }
            cb();
          })().catch(cb);
        },
      });

      ws.on('message', (data) => {
        let buf = Buffer.from(data);
        if (!vlessRespHeaderStripped) {
          vlessRespHeaderStripped = true;
          buf = buf.subarray(2);
        }
        if (buf.length > 0) duplex.push(buf);
      });
      ws.on('close', () => duplex.push(null));

      const tlsSock = tls.connect({
        socket: duplex,
        servername: targetHost,
        ALPNProtocols: ['http/1.1'],
      });

      let rawResp = '';
      tlsSock.setEncoding('utf8');
      tlsSock.on('secureConnect', () => {
        tlsSock.write(
          `GET ${path} HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: curl/8.5.0\r\nConnection: close\r\n\r\n`
        );
      });
      tlsSock.on('data', (chunk) => {
        rawResp += chunk;
      });
      tlsSock.on('end', () => {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(rawResp);
      });
      tlsSock.on('error', (err) => {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(err);
      });
    });
  });
}

async function startMockCloudflareAndGitHubServer(stateRecorder) {
  const realBundleSample = fs.readFileSync(new URL('./worker-single-file.js', import.meta.url), 'utf8');
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, MOCK_BASE);
    let bodyBuf = Buffer.alloc(0);
    for await (const chunk of req) {
      bodyBuf = Buffer.concat([bodyBuf, Buffer.from(chunk)]);
    }
    const auth = req.headers.authorization || '';

    // Snapshot of the public Cloudflare IP API — only the E2E harness overrides the feed URL.
    if (u.pathname === '/official-ips') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(fs.readFileSync(new URL('./fixtures/cloudflare-ips.json', import.meta.url)));
    }

    // Cloudflare REST + GraphQL Mock (strictly enforces Bearer token like real api.cloudflare.com)
    if (u.pathname.startsWith('/cf/')) {
      if (auth !== 'Bearer cf_valid_test_token_1234567890') {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] }));
      }
    }
    if (u.pathname === '/cf/user/tokens/verify') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ success: true, result: { id: 'tok_1', status: 'active' } }));
    }
    if (u.pathname === '/cf/accounts') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        result: [{ id: 'acc_nl_998877', name: 'Aral Sulfur Edge Account' }],
      }));
    }
    if (u.pathname === '/cf/accounts/acc_nl_998877/workers/scripts') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        result: [{ id: 'aral-worker' }],
      }));
    }
    if (u.pathname === '/cf/accounts/acc_nl_998877/workers/scripts/aral-worker/settings') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        result: {
          compatibility_date: '2025-09-01',
          compatibility_flags: ['nodejs_compat'],
          bindings: [
            { type: 'kv_namespace', name: 'KV', namespace_id: 'kv_ns_demo_123' },
            { type: 'secret_text', name: 'CUSTOM_SECRET' },
          ],
        },
      }));
    }
    if (u.pathname === '/cf/accounts/acc_nl_998877/workers/scripts/aral-worker' && req.method === 'PUT') {
      stateRecorder.workerUploads.push({
        contentType: req.headers['content-type'] || '',
        bodyText: bodyBuf.toString('utf8'),
        byteLength: bodyBuf.length,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ success: true, result: { id: 'aral-worker' } }));
    }
    if (u.pathname === '/cf/graphql' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        data: {
          viewer: {
            accounts: [
              {
                workersInvocationsAdaptive: [
                  {
                    dimensions: { scriptName: 'aral-worker' },
                    sum: { requests: 27450, subrequests: 8200, errors: 3 },
                  },
                ],
              },
            ],
          },
        },
      }));
    }

    // Hardcoded GitHub `Aral-Dev/Aral-Sulfur` Mock
    if (u.pathname === '/gh/repos/Aral-Dev/Aral-Sulfur/releases/latest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        tag_name: 'v1.1.0',
        html_url: 'https://github.com/Aral-Dev/Aral-Sulfur/releases/tag/v1.1.0',
        body: '- Official test release from Aral-Dev/Aral-Sulfur',
        published_at: '2026-10-31T12:00:00Z',
        assets: [
          {
            name: 'worker-single-file.js',
            browser_download_url: `${MOCK_BASE}/ghraw/Aral-Dev/Aral-Sulfur/v1.1.0/worker-single-file.js`,
          },
        ],
      }));
    }
    if (u.pathname === '/ghraw/Aral-Dev/Aral-Sulfur/main/package.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ name: 'aral', version: '1.0.0' })); // main branch matches installed
    }
    if (u.pathname.endsWith('/worker-single-file.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end(realBundleSample);
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'mock route not found: ' + u.pathname }));
  });

  await new Promise((resolve) => srv.listen(MOCK_PORT, '127.0.0.1', resolve));
  return srv;
}

async function main() {
  console.log('═══ ARAL SULFUR v1.0.0 Full Live Verification Suite (17/17) ═══');

  const mockRecorder = { workerUploads: [] };
  const mockSrv = await startMockCloudflareAndGitHubServer(mockRecorder);

  const proc = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--local',
      '--port',
      String(PORT),
      '--persist-to',
      `/tmp/nl-v25-kv-${Date.now()}`,
      '--var',
      `NL_CF_API_BASE:${MOCK_BASE}/cf`,
      '--var',
      `NL_CF_IP_RANGES_TEST_URL:${MOCK_BASE}/official-ips`,
      '--var',
      `NL_GH_API_BASE:${MOCK_BASE}/gh`,
      '--var',
      `NL_GH_RAW_BASE:${MOCK_BASE}/ghraw`,
      '--var',
      'NL_DISABLE_POOL_PROVISION:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let serverLogs = '';
  proc.stdout.on('data', (d) => { serverLogs += d.toString(); });
  proc.stderr.on('data', (d) => { serverLogs += d.toString(); });

  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`${BASE}/health`);
        if (r.ok) { ready = true; break; }
      } catch {}
      await sleep(300);
    }
    assert(ready, 'workerd failed to start');

    // ── TEST 1: Health, Client-Info & Speed-Probe Endpoints (v3.0.0) ──
    const health = await (await fetch(`${BASE}/health`)).json();
    assert.equal(health.version, '1.0.0', 'Health version must be 1.0.0');
    assert.notEqual(health.colo, 'EDGE', 'colo must never be EDGE');

    const ciRes = await fetch(`${BASE}/api/client-info`, {
      headers: { 'cf-connecting-ip': '5.160.214.88', 'cf-ipcountry': 'IR' },
    });
    assert.equal(ciRes.status, 200);
    const ciJson = await ciRes.json();
    assert.equal(ciJson.cf.clientIp, '5.160.214.88');
    assert.equal(ciJson.cf.country, 'IR');
    assert.equal(ciJson.cf.countryNameFa, 'ایران');

    const spRes = await fetch(`${BASE}/api/speed-probe?bytes=65536`);
    assert.equal(spRes.status, 200);
    const spBuf = await spRes.arrayBuffer();
    assert.equal(spBuf.byteLength, 65536, 'Speed probe must return exact requested byte count');
    const spUpRes = await fetch(`${BASE}/api/speed-probe`, { method: 'POST', body: new Uint8Array(65536) });
    assert.equal(spUpRes.status, 200);
    assert.equal((await spUpRes.json()).receivedBytes, 65536, 'Upload probe must count exact bytes');
    const spTooLarge = await fetch(`${BASE}/api/speed-probe`, { method: 'POST', body: new Uint8Array(131073) });
    assert.equal(spTooLarge.status, 413, 'Upload probe must reject bodies above 128 KiB');
    console.log(`✓ [1/16] /health + /api/client-info + /api/speed-probe -> version=${health.version}, 64KB down/up + upload limit OK`);

    // ── TEST 2: Setup Panel & Verify No remarkPrefix + Default ProxyIPs + TgProxy ──
    const setupRes = await fetch(`${BASE}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'AdminPassword24!', firstUserName: 'سردبیر اصلی' }),
    });
    assert.equal(setupRes.status, 200);
    let cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];
    const boot = await setupRes.json();

    assert.equal(boot.version, '1.0.0');
    assert.equal(boot.updater.repo, 'Aral-Dev/Aral-Sulfur', 'Hardcoded official GitHub repo must be Aral-Dev/Aral-Sulfur');
    assert.equal(boot.updater.repoUrl, 'https://github.com/Aral-Dev/Aral-Sulfur');
    assert.equal(boot.settings.remarkPrefix, undefined, 'remarkPrefix must be completely removed');
    assert(boot.settings.proxyIPs.length >= 3, 'Default verified ProxyIPs must be populated');
    assert.equal(boot.settings.enableNAT64, true, 'Default NAT64 must be enabled');
    assert.equal(boot.settings.enableTgProxy, true, 'Telegram Web Proxy must be enabled by default');
    assert.match(boot.settings.tgProxySecret, /^[0-9a-f]{32}$/, '32-hex Telegram secret auto-minted');
    assert(boot.tgProxy.tgUrl.startsWith('tg://webproxy?server='), 'tg://webproxy URL ready');
    console.log(`✓ [2/16] Setup & Defaults -> 0 remarkPrefix, ${boot.settings.proxyIPs.length} ProxyIPs, tg://webproxy ready`);

    const rangeGuest = await fetch(`${BASE}/api/cf/ip-ranges`);
    assert.equal(rangeGuest.status, 401, 'Official CIDRs must be served only to authenticated admin');
    const rangeRes = await fetch(`${BASE}/api/cf/ip-ranges`, { headers: { cookie } });
    assert.equal(rangeRes.status, 200);
    const officialRanges = await rangeRes.json();
    assert.equal(officialRanges.ipv4.length, 15, 'Cloudflare fixture should include 15 IPv4 CIDRs');
    assert.equal(officialRanges.ipv6.length, 7, 'Cloudflare fixture should include 7 IPv6 CIDRs');
    assert.equal(officialRanges.ipv4[0], '173.245.48.0/20');
    const user = boot.users[0];

    // ── TEST 3: All 6 TLS Ports + All 7 HTTP Ports + Zero-Emoji Free Notice in Subscriptions ──
    const rawSubRes = await fetch(`${BASE}/sub/${user.subToken}?format=raw`);
    assert.equal(rawSubRes.status, 200);
    const announceHdr = rawSubRes.headers.get('announce') || '';
    assert(announceHdr.startsWith('base64:'), 'Subscription must include announce header');
    const decodedAnnounce = Buffer.from(announceHdr.slice(7), 'base64').toString('utf8');
    assert(decodedAnnounce.includes('رایگان و متن‌باز'), 'Announce header must state free & non-commercial');
    assert(!/\p{Extended_Pictographic}/u.test(decodedAnnounce), 'Announce header must have 0 emojis');

    const rawLines = (await rawSubRes.text()).trim().split('\n');
    const firstDecodedHash = decodeURIComponent(rawLines[0].split('#')[1] || '');
    assert(firstDecodedHash.includes('رایگان و غیرقابل فروش'), 'Top URI line must state free & not for sale');
    assert(!/\p{Extended_Pictographic}/u.test(firstDecodedHash), 'Top URI line must have 0 emojis');

    for (const p of [443, 8443, 2053, 2083, 2087, 2096]) {
      assert(rawLines.some((l) => l.includes(`:${p}?`)), `Expected TLS port ${p} in subscription`);
    }

    const setHttpRes = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ...boot.settings, enableHttpPorts: true }),
    });
    assert.equal(setHttpRes.status, 200);
    const rawWithHttp = (await (await fetch(`${BASE}/sub/${user.subToken}?format=raw`)).text()).trim().split('\n');
    for (const hp of [80, 8080, 8880, 2052, 2082, 2086, 2095]) {
      assert(rawWithHttp.some((l) => l.includes(`:${hp}?`) && l.includes('security=none')), `Expected HTTP port ${hp}`);
    }
    console.log(`✓ [3/16] Ports & Emoji-Free Subscriptions -> All 6 TLS + 7 HTTP ports (${rawWithHttp.length} lines), 0 emojis`);

    // ── TEST 4: Private DoH (`/dns-query/<token>`) Browser HTML + JSON + Binary POST ──
    const dohHtmlRes = await fetch(`${BASE}/dns-query/${user.subToken}`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    assert.equal(dohHtmlRes.status, 200);
    const dohHtml = await dohHtmlRes.text();
    assert(dohHtml.includes('PRIVATE DoH') && dohHtml.includes('ARAL <b>SULFUR</b>'));
    assert(!/\p{Extended_Pictographic}/u.test(dohHtml), 'DoH HTML guide must contain 0 emojis');

    const dohJson = await (await fetch(`${BASE}/dns-query/${user.subToken}?name=example.com&type=A`)).json();
    assert.equal(dohJson.Status, 0);

    const dnsWireQuery = Buffer.from('abcd01000001000000000000076578616d706c6503636f6d0000010001', 'hex');
    const dohPostRes = await fetch(`${BASE}/dns-query/${user.subToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: dnsWireQuery,
    });
    assert.equal(dohPostRes.status, 200);
    console.log('✓ [4/16] Private DoH -> Emoji-free HTML Guide 200 + JSON 200 + RFC 8484 POST 200');

    // ── TEST 5: LIVE `www.speedtest.net` HTTPS over Fragmented VLESS Tunnel ──
    const speedtestHttp = await fetchHttpsViaFragmentedVless({
      wsUrl: `ws://127.0.0.1:${PORT}/?ed=2048`,
      uuid: user.uuid,
      targetHost: 'www.speedtest.net',
      targetPort: 443,
      path: '/cdn-cgi/trace',
    });
    assert(
      /^HTTP\/1\.[01]\s+200\b/.test(speedtestHttp) && speedtestHttp.includes('h=www.speedtest.net'),
      `Expected HTTP 200 from www.speedtest.net over VLESS tunnel, got: ${speedtestHttp.slice(0, 140)}`
    );
    console.log('✓ [5/16] Cloudflare-Hosted Tunnel -> LIVE HTTPS to www.speedtest.net over fragmented VLESS returned 200 OK');

    // ── TEST 6: Official Telegram Web Proxy (`/?bridge=`, `/api/v1/session`, `/api/v1/ws`) ──
    const tgSecret = boot.settings.tgProxySecret;
    const hmacCap = crypto
      .createHmac('sha256', Buffer.from(tgSecret, 'hex'))
      .update('tdesktop-web-proxy-bridge-v1\n127.0.0.1')
      .digest('base64url');
    const bridgeHtml = await (await fetch(`${BASE}/?bridge=${hmacCap}`)).text();
    const bootMatch = /boot="([A-Za-z0-9_-]{43})"/.exec(bridgeHtml);
    assert(bootMatch, 'Bridge HTML must embed 43-char boot token');

    const sessRes = await fetch(`${BASE}/api/v1/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bootMatch[1]}`, 'content-type': 'application/octet-stream' },
      body: new Uint8Array([0x10, 0, 0, 0, 0, 0, 0, 1, 1]),
    });
    assert.equal(sessRes.status, 200);
    const sessToken = sessRes.headers.get('x-session-token') || '';
    await new Promise((resolve, reject) => {
      const subproto = `tproxy-lane-v1.${sessToken}.1`;
      const tgWs = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ws`, subproto);
      tgWs.on('open', () => { assert.equal(tgWs.protocol, subproto); tgWs.close(); resolve(); });
      tgWs.on('error', reject);
    });
    console.log('✓ [6/16] Official Telegram Web Proxy -> HMAC Bridge 200 + Session Lease 200 + Lane WS 101 verified');

    // ── TEST 7–12: Headless Chromium UI E2E Verification ──
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 920 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(`${BASE}/panel`, { waitUntil: 'networkidle' });

    // Free Notice Popup Modal
    assert.equal(await page.locator('#free-notice-modal').isVisible(), true);
    await page.click('#btn-free-close');

    // Sponsor is deliberately absent from the login view; only visible inside admin.
    await page.waitForSelector('#v-login:not([hidden])');
    const sponsor = page.locator('#sponsor-telegram');
    assert.equal(await sponsor.isVisible(), false, 'Sponsor must not appear on login');

    // ── TEST 7: Visitor IP, Country, ISP Strip + BLUR Toggle BEFORE & AFTER Login ──
    await page.waitForFunction(() => {
      const el = document.getElementById('visitor-ip');
      return el && el.textContent && el.textContent.trim() !== '—';
    }, { timeout: 6000 });
    const detectedIp = (await page.locator('#visitor-ip').textContent()).trim();
    assert(detectedIp.length >= 3, `Expected detected IP, got: ${detectedIp}`);
    assert.equal(await page.locator('#visitor-ip').evaluate((el) => el.classList.contains('is-blurred')), false);

    await page.click('#btn-ip-blur');
    const isBlurredAfterClick = await page.locator('#visitor-ip').evaluate((el) => el.classList.contains('is-blurred'));
    const computedFilter = await page.locator('#visitor-ip').evaluate((el) => getComputedStyle(el).filter);
    assert.equal(isBlurredAfterClick, true, 'IP element must get .is-blurred class');
    assert(computedFilter.includes('blur'), `Expected CSS blur filter, got: ${computedFilter}`);
    await page.click('#btn-ip-blur');
    assert.equal(await page.locator('#visitor-ip').evaluate((el) => el.classList.contains('is-blurred')), false);
    console.log(`✓ [7/16] Visitor IP/Country/ISP Strip + BLUR Toggle -> IP="${detectedIp}", filter="${computedFilter}" verified`);

    // Login to Admin Panel
    await page.fill('#login-pass', 'AdminPassword24!');
    await page.click('#f-login button[type="submit"]');
    await page.waitForSelector('#v-admin:not([hidden])');

    // Theme-native floating sponsor: only in admin, usable on both themes/mobile.
    assert.equal(await sponsor.isVisible(), true);
    assert.equal(await sponsor.getAttribute('href'), 'https://t.me/AralDev');
    assert.equal(await sponsor.getAttribute('target'), '_blank');
    assert((await sponsor.getAttribute('rel')).includes('noopener'));
    assert.equal(await sponsor.locator('.sponsor-float-icon use').getAttribute('href'), '#i-telegram');
    const iconAnimation = await sponsor.locator('.sponsor-live').evaluate((el) => getComputedStyle(el).animationName);
    assert(iconAnimation.includes('sulfur-pulse'), 'Floating Telegram live dot must have motion');
    // The panel boots in dark by default; force LIGHT first to guarantee a real theme delta.
    // NOTE: the badge has a .2s background transition, so read the color with the transition
    // temporarily disabled — headless frames can stall and return a stale mid-transition color.
    const cascadeBg = () => sponsor.evaluate((el) => {
      el.style.transition = 'none';
      const bg = getComputedStyle(el).backgroundColor;
      el.style.transition = '';
      return bg;
    });
    await page.click('#v-admin .t-pick[data-th="light"]');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', undefined, { timeout: 8000 });
    const lightBackgroundForced = await cascadeBg();
    await page.click('#v-admin .t-pick[data-th="dark"]');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', undefined, { timeout: 8000 });
    const darkBackground = await cascadeBg();
    assert.notEqual(lightBackgroundForced, darkBackground, 'Floating sponsor must adapt to theme');
    await page.setViewportSize({ width: 390, height: 844 });
    const sponsorBox = await sponsor.boundingBox();
    assert(sponsorBox.x >= 0 && sponsorBox.x + sponsorBox.width <= 390, 'Floating sponsor must fit mobile viewport');
    await page.setViewportSize({ width: 1400, height: 920 });
    await page.click('#v-admin .t-pick[data-th="light"]');
    await context.route('https://t.me/AralDev', (route) => route.fulfill({
      status: 200, contentType: 'text/html', body: '<title>Telegram sponsor link verified</title>',
    }));
    const sponsorPopup = page.waitForEvent('popup');
    await sponsor.click();
    const openedSponsor = await sponsorPopup;
    await openedSponsor.waitForLoadState('domcontentloaded');
    assert.equal(openedSponsor.url(), 'https://t.me/AralDev');
    await openedSponsor.close();
    console.log('✓ [login/admin] Sponsor absent on login, floating only in panel; exact link, animation, themes, mobile & popup');

    // ── TEST 8: Zero-Emoji Live DOM Audit + Custom Monochrome SVG Icons ──
    const emojiCheck = await page.evaluate(() => {
      const txt = document.documentElement.innerText || '';
      const matches = txt.match(/\p{Extended_Pictographic}/gu) || [];
      const svgIcons = document.querySelectorAll('svg.ic').length;
      return { emojiCount: matches.length, matches, svgIcons };
    });
    assert.equal(emojiCheck.emojiCount, 0, `Expected 0 emojis in DOM, found: ${emojiCheck.matches.join(',')}`);
    assert(emojiCheck.svgIcons >= 25, `Expected >=25 custom SVG icons, found: ${emojiCheck.svgIcons}`);
    console.log(`✓ [8/16] Zero-Emoji & Custom SVG Icon Audit -> 0 emojis in DOM, ${emojiCheck.svgIcons} crisp vector icons rendered`);

    // ── TEST 9: Sulfur Glass Design System Audit ──
    // Calm glassmorphism: every card must be frosted (backdrop-filter), the navigation must
    // expose exactly the 4 simple menus, and the active tab must carry the honey gradient.
    const glassAudit = await page.evaluate(() => {
      const card = document.querySelector('#pane-home .card');
      const cs = card ? getComputedStyle(card) : null;
      const navBtns = Array.from(document.querySelectorAll('.tabbar .tab-btn'));
      const activeBtn = document.querySelector('.tabbar .tab-btn.active');
      const activeCs = activeBtn ? getComputedStyle(activeBtn) : null;
      const clock = document.getElementById('digital-clock');
      return {
        backdrop: cs ? cs.backdropFilter || cs.webkitBackdropFilter || '' : '',
        radius: cs ? cs.borderRadius : '',
        navLabels: navBtns.map((b) => b.textContent.trim()),
        activeTab: activeBtn ? activeBtn.getAttribute('data-tab') : '',
        activeBg: activeCs ? activeCs.backgroundImage : '',
        clockText: clock ? clock.textContent : '',
        clockMono: clock ? getComputedStyle(clock).fontFamily : '',
        dir: document.documentElement.getAttribute('dir'),
      };
    });
    assert(String(glassAudit.backdrop).includes('blur'), `Sulfur cards must be frosted glass, got: ${glassAudit.backdrop}`);
    assert(glassAudit.radius !== '0px', 'Cards must keep rounded corners');
    assert.equal(glassAudit.navLabels.length, 4, 'Sulfur menu must expose exactly 4 simple sections');
    assert(glassAudit.navLabels.join(',').includes('خانه'), 'Menu must contain the Home (خانه) entry');
    assert(glassAudit.navLabels.join(',').includes('مشترکین'), 'Menu must contain the Subscribers (مشترکین) entry');
    assert(glassAudit.navLabels.join(',').includes('اتصال و شبکه'), 'Menu must contain the Network (اتصال و شبکه) entry');
    assert(glassAudit.navLabels.join(',').includes('تنظیمات'), 'Menu must contain the Settings (تنظیمات) entry');
    assert.equal(glassAudit.activeTab, 'home', 'Home tab must be active after login');
    assert(glassAudit.activeBg.includes('gradient'), 'Active tab must carry the honey gradient');
    assert(/^\d{2}:\d{2}:\d{2}$/.test(glassAudit.clockText), `Digital clock must render HH:MM:SS, got: ${glassAudit.clockText}`);
    assert(glassAudit.clockMono.includes('JBM'), 'Digital clock must use the calm mono typeface');
    assert.equal(glassAudit.dir, 'rtl', 'Persian panel must stay RTL');
    console.log(`✓ [9/16] Sulfur Glass Design -> frosted cards, 4-menu nav, honey active tab, live clock ${glassAudit.clockText}`);

    // ── TEST 10: Dynamic Theme-Native Monochrome Speed/RTT & Subscriber Usage Chart ──
    await page.click('#btn-speed-burst');
    await sleep(600);
    const kpiSpd = await page.locator('#kpi-speed').textContent();
    assert(kpiSpd.includes('Mbps') && !kpiSpd.startsWith('—'), `Expected live Mbps after burst test, got: ${kpiSpd}`);

    // Switch to Subscriber Usage mode & Dark theme and confirm monochrome canvas renders non-uniform pixels
    await page.click('#chart-mode-usage');
    await page.click('#v-admin .t-pick[data-th="dark"]');
    await sleep(300);
    const canvasOk = await page.evaluate(() => {
      const c = document.getElementById('telemetry-canvas');
      const ctx = c.getContext('2d');
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      const uniqueLuma = new Set();
      for (let i = 0; i < data.length; i += 64) {
        uniqueLuma.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      }
      return { width: c.width, height: c.height, paletteCount: uniqueLuma.size };
    });
    assert(canvasOk.paletteCount >= 2, 'Telemetry canvas must actively draw monochrome bars/waveforms');
    await page.click('#v-admin .t-pick[data-th="light"]');
    await page.click('#chart-mode-live');
    console.log(`✓ [10/16] Monochrome Live Speed & Usage Chart -> Burst=${kpiSpd.trim()}, canvas=${canvasOk.width}x${canvasOk.height} verified`);

    // ── TEST 11: Simple Network Tab — protocol pills, TLS ports & clean-IP list persistence ──
    await page.click('.tab-btn[data-tab="net"]');
    await page.waitForSelector('#pane-net:not([hidden])');
    const netAudit = await page.evaluate(() => ({
      vlessOn: document.getElementById('s-vless').classList.contains('on'),
      trojanOn: document.getElementById('s-trojan').classList.contains('on'),
      ssOn: document.getElementById('s-ss').classList.contains('on'),
      tlsPorts: Array.from(document.querySelectorAll('#tls-ports-box input:checked')).map((c) => c.value),
      fragOn: document.getElementById('s-frag-on').checked,
    }));
    assert.equal(netAudit.vlessOn, true, 'VLESS must be enabled by default');
    assert.equal(netAudit.trojanOn, true, 'Trojan must be enabled by default');
    assert.equal(netAudit.ssOn, false, 'Shadowsocks must be off by default');
    assert(netAudit.tlsPorts.includes('443'), 'TLS port 443 must be checked by default');
    assert.equal(netAudit.fragOn, true, 'Anti-DPI fragment must default to ON');

    // Enable Shadowsocks, keep only 443 + 2053 as TLS ports, then save through the simple form.
    await page.click('#s-ss');
    await page.uncheck('#tls-ports-box input[value="8443"]');
    await page.uncheck('#tls-ports-box input[value="2083"]');
    await page.uncheck('#tls-ports-box input[value="2087"]');
    await page.uncheck('#tls-ports-box input[value="2096"]');
    await page.check('#tls-ports-box input[value="2053"]');
    await page.fill('#s-cleanips', ['www.speedtest.net#Speedtest', '1.1.1.1#CF-One'].join(String.fromCharCode(10)));
    await page.click('#save-net');
    await sleep(400);
    const afterNet = await (await fetch(`${BASE}/api/bootstrap`, { headers: { cookie } })).json();
    assert.equal(afterNet.settings.enableSS, true, 'Shadowsocks toggle must persist to KV');
    assert.deepEqual(afterNet.settings.tlsPorts, [443, 2053], 'TLS port chips must persist to KV');
    assert(afterNet.settings.cleanIPs.includes('1.1.1.1#CF-One'), 'Clean-IP textarea lines must persist to KV');
    const rawAfterNet = await (await fetch(`${BASE}/sub/${user.subToken}?format=raw`)).text();
    assert(rawAfterNet.includes('ss://'), 'Raw subscription must expose Shadowsocks nodes after enabling SS');
    assert(rawAfterNet.includes(':2053'), 'Raw subscription must expose the newly selected TLS port');
    // Revert SS to keep later assertions deterministic.
    await page.click('#s-ss');
    await page.click('#save-net');
    await sleep(300);
    console.log(`✓ [11/16] Simple Network Tab -> protocol pills, TLS ports & clean-IPs persist; raw sub reflects SS + :2053`);

    // ── TEST 12: Per-user STATIC IP assignment (Sulfur flagship) + flag-free Press Pass ──
    // Create a subscriber with two fixed clean IPs through the simple modal.
    await page.click('.tab-btn[data-tab="users"]');
    await page.waitForSelector('#pane-users:not([hidden])');
    await page.click('#btn-add-user-modal');
    await page.fill('#uf-name', 'StaticIP');
    await page.fill('#uf-gb', '0');
    // Auto-rotate is ON by default for new users — switch to the fixed-IP mode.
    assert.equal(await page.locator('#uf-autorot-ips').isChecked(), true, 'New subscribers must default to rotating clean IPs');
    await page.uncheck('#uf-autorot-ips');
    assert.equal(await page.locator('#uf-static-box').isVisible(), true, 'Static IP textarea must appear when rotation is off');
    assert.equal(await page.locator('#uf-rot-box').isVisible(), false, 'Rotation controls must hide in static mode');
    await page.fill('#uf-ips', ['104.17.10.12#StaticOne', 'www.speedtest.net#Speedtest'].join(String.fromCharCode(10)));
    await page.click('#f-user button[type="submit"]');
    await sleep(450);

    const staticUser = await (await fetch(`${BASE}/api/bootstrap`, { headers: { cookie } })).json();
    const su = staticUser.users.find((u) => u.name === 'StaticIP');
    assert(su, 'StaticIP subscriber must exist after modal save');
    assert.equal(su.autoRotateIps, false, 'Static IP mode must persist (autoRotateIps=false)');
    assert.deepEqual(su.ips, ['104.17.10.12#StaticOne', 'www.speedtest.net#Speedtest'], 'Fixed IP list must round-trip');
    const rawStatic = await (await fetch(`${BASE}/sub/${su.subToken}?format=raw`)).text();
    assert(rawStatic.includes('104.17.10.12'), 'Static IP must appear in the generated subscription endpoints');

    // Press Pass page must stay flag-free with the uniform Aral Sulfur | PROTOCOL watermark.
    const subPage = await context.newPage();
    await subPage.goto(`${BASE}/sub/${su.subToken}`, { waitUntil: 'networkidle' });
    await subPage.click('#sub-free-ok');
    const passAudit = await subPage.evaluate(() => {
      const flags = (document.documentElement.innerText || '').match(/\p{Regional_Indicator}{2}/gu) || [];
      const nodeNames = Array.from(document.querySelectorAll('#s-nodes .node-title strong')).map((el) => el.textContent.trim());
      const nonNodeText = (document.documentElement.innerText || '').replace(/\p{Regional_Indicator}{2}/gu, '');
      return { flags: flags.length, nodeNames, otherEmoji: (nonNodeText.match(/\p{Extended_Pictographic}/gu) || []).length };
    });
    assert.equal(passAudit.flags, 0, 'Uniform Aral remarks must keep the Press Pass completely flag-free');
    assert(passAudit.nodeNames.length > 0 && passAudit.nodeNames.every((n) => /^Aral Sulfur \| (VLESS|Trojan|SS)$/.test(n)), 'Press Pass node list must show only the Aral Sulfur | PROTOCOL watermark');
    assert.equal(passAudit.otherEmoji, 0, 'Subscriber Press Pass must remain otherwise emoji-free');
    await subPage.close();
    console.log(`✓ [12/16] Per-user STATIC IPs -> fixed list round-trips, endpoints use 104.17.10.12, Press Pass flag-free with Aral Sulfur watermark`);

    // ── TEST 13: New User Zero-Traffic & Progress Bar Isolation + Duplicate UUID Guard ──
    // Note: `user` (سردبیر اصلی) already accrued real bytes from VLESS + Trojan E2E tunnels in Tests 4–5!
    // Adding a brand-new unlimited user `SinA` MUST have `usedBytes === 0` and `0%` progress bar width!
    const dupRes = await fetch(`${BASE}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'DupCheck', uuid: user.uuid }),
    });
    assert.equal(dupRes.status, 400, 'Duplicate UUID on new user must be rejected with 400');

    await page.click('.tab-btn[data-tab="users"]');
    await page.waitForSelector('#pane-users:not([hidden])');
    await page.click('#btn-add-user-modal');
    await page.fill('#uf-name', 'SinA');
    await page.fill('#uf-gb', '0');
    await page.click('#f-user button[type="submit"]');
    await sleep(400);

    const userBarAudit = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#users-list .ucard'));
      return cards.map((c) => {
        const name = (c.querySelector('.uname')?.innerText || '').trim();
        const bw = (c.querySelector('.umeter .mono')?.innerText || '').trim();
        const barWidth = c.querySelector('.meter i')?.style.width || '';
        return { name, bw, barWidth };
      });
    });
    const sinaCard = userBarAudit.find((c) => c.name.includes('SinA'));
    assert(sinaCard, 'SinA must appear in the Subscribers ledger');
    assert(sinaCard.bw.startsWith('0 B /'), `New user SinA must start at 0 B, got: ${sinaCard.bw}`);
    assert.equal(sinaCard.barWidth, '0%', `New 0-byte user progress bar MUST be 0%, got: ${sinaCard.barWidth}`);

    // Home tab status chips must also stay in sync for the freshly selected user.
    await page.click('.tab-btn[data-tab="home"]');
    await page.waitForSelector('#pane-home:not([hidden])');
    const homeStatusTxt = await page.evaluate(() => document.getElementById('u-status-cell')?.innerText || '');
    assert(homeStatusTxt.length > 0, 'Home tab must render the selected subscriber status chips');
    console.log(`✓ [13/16] New User Isolation & Progress Bar Fix -> SinA (${sinaCard.bw}) bar=${sinaCard.barWidth}, duplicate UUID blocked`);

    // ── TEST 14: Settings Tab — password change, kill switch & JSON backup ──
    await page.click('.tab-btn[data-tab="settings"]');
    await page.waitForSelector('#pane-settings:not([hidden])');
    const setAudit = await page.evaluate(() => ({
      themePicks: document.querySelectorAll('#pane-settings .t-pick').length,
      hasUpdater: !!document.getElementById('btn-gh-check'),
      hasExport: !!document.getElementById('btn-export'),
      hasImport: !!document.getElementById('inp-import'),
      repoText: (document.querySelector('#pane-settings').innerText || '').includes('Aral-Dev/Aral-Sulfur'),
    }));
    assert(setAudit.themePicks >= 2, 'Settings must expose both light & dark theme pickers');
    assert(setAudit.hasUpdater, 'Settings must expose the panel update card');
    assert(setAudit.hasExport && setAudit.hasImport, 'Settings must expose backup export & restore');
    assert(setAudit.repoText, 'Update card must point at the Aral-Dev/Aral-Sulfur repository');

    // Change the admin password through the simple form, then verify the old one is dead.
    await page.fill('#pw-cur', 'AdminPassword24!');
    await page.fill('#pw-new', 'SulfurCalm25!');
    await page.click('#f-pass button[type="submit"]');
    await sleep(450);
    const oldLogin = await fetch(`${BASE}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'AdminPassword24!' }),
    });
    assert.equal(oldLogin.status, 401, 'Old admin password must stop working after change');
    const newLogin = await fetch(`${BASE}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'SulfurCalm25!' }),
    });
    assert.equal(newLogin.status, 200, 'New admin password must be accepted by the API');
    cookie = newLogin.headers.get('set-cookie').split(';')[0];

    // Kill switch must round-trip through the simple danger button.
    await page.click('#btn-kill');
    await sleep(400);
    const ksOn = await (await fetch(`${BASE}/api/bootstrap`, { headers: { cookie } })).json();
    assert.equal(ksOn.settings.killSwitch, true, 'Kill switch must engage from the Settings tab');
    await page.click('#btn-kill');
    await sleep(400);
    const ksOff = await (await fetch(`${BASE}/api/bootstrap`, { headers: { cookie } })).json();
    assert.equal(ksOff.settings.killSwitch, false, 'Kill switch must disengage from the Settings tab');

    // JSON backup must contain every subscriber.
    const backup = await (await fetch(`${BASE}/api/backup`, { headers: { cookie } })).json();
    assert(backup.ok && Array.isArray(backup.users) && backup.users.length >= 3, 'Backup JSON must carry every subscriber');
    assert(backup.settings && typeof backup.settings === 'object', 'Backup JSON must carry settings');
    console.log(`✓ [14/16] Settings Tab -> theme pickers, ${backup.users.length}-user JSON backup, password rotation & kill switch verified`);


    // ── TEST 15: Hardcoded GitHub (`Aral-Dev/Aral-Sulfur`) Updater & In-Panel Self-Deploy ──
    // The Settings tab update card must check the official repo and self-deploy through
    // the Cloudflare API while preserving KV bindings and secrets.
    await page.click('#btn-gh-check');
    await sleep(500);
    const ghUi = await page.evaluate(() => ({
      remVer: document.getElementById('gh-rem-ver')?.textContent || '',
      badgeTxt: document.getElementById('gh-status-badge')?.textContent || '',
      dlHref: document.getElementById('gh-dl-link')?.href || '',
    }));
    assert.equal(ghUi.remVer, 'V1.1.0', `Expected V1.1.0 from mock GitHub release, got: ${ghUi.remVer}`);
    assert(ghUi.badgeTxt.includes('نسخهٔ جدید') || ghUi.badgeTxt.includes('UPDATE'), `Update badge must announce the new release, got: ${ghUi.badgeTxt}`);
    assert.equal(ghUi.dlHref, 'https://github.com/Aral-Dev/Aral-Sulfur/releases/tag/v1.1.0', 'Manual download link must follow the mock release');

    // Fill the Cloudflare token form inside the disclosure and self-apply the update.
    await page.evaluate(() => { document.getElementById('gh-apply-box').open = true; });
    await page.fill('#gh-inp-token', 'cf_valid_test_token_1234567890');
    await page.click('#btn-gh-apply');
    await sleep(700);
    assert.equal(mockRecorder.workerUploads.length, 1, 'Self-updater must PUT multipart Worker bundle to Cloudflare API');
    const upload = mockRecorder.workerUploads[0];
    assert(upload.contentType.includes('multipart/form-data'), 'Worker upload must be multipart/form-data');
    assert(upload.bodyText.includes('"kv_ns_demo_123"'), 'Self-updater MUST preserve existing KV namespace bindings');
    assert(upload.bodyText.includes('"keep_bindings":["secret_text","secret_key"]'), 'Self-updater MUST preserve existing secrets');
    assert(upload.byteLength > 200000, 'Uploaded Worker bundle must contain full compiled script');
    console.log(`✓ [15/16] GitHub Self-Updater (Aral-Dev/Aral-Sulfur) -> V1.1.0 detected, in-panel deploy preserved KV + secrets`);


    // ── TEST 16: Server-Side Family Filter — tunnel gate + private DoH Family upgrade ──
    const boot16 = await (await fetch(`${BASE}/api/bootstrap`, { headers: { cookie } })).json();
    assert.equal(boot16.settings.blockAdult, false, 'Family filter must default to OFF');

    const famOnRes = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ...boot16.settings, blockAdult: true }),
    });
    assert.equal(famOnRes.status, 200);
    assert.equal((await famOnRes.json()).settings.blockAdult, true, 'blockAdult must round-trip');

    // Private DoH must upgrade to Cloudflare Family and sinkhole an adult domain…
    const blkDom = await (await fetch(`${BASE}/dns-query/${user.subToken}?name=pornhub.com&type=A`)).json();
    const blkIps = (blkDom.Answer || []).filter((r) => r.type === 1).map((r) => String(r.data));
    assert(blkIps.length > 0 && blkIps.every((ip) => ip === '0.0.0.0'), `Family DoH must sinkhole adult domains, got: ${blkIps.join(',') || '(none)'}`);
    // …while ordinary domains still resolve through the same endpoint.
    const okDom = await (await fetch(`${BASE}/dns-query/${user.subToken}?name=example.com&type=A`)).json();
    assert.equal(okDom.Status, 0, 'Ordinary domains must keep resolving with the filter ON');

    // Live VLESS tunnel through the ACTIVE gate: ordinary targets must still work (fail-open design).
    const famTunnel = await fetchHttpsViaFragmentedVless({
      wsUrl: `ws://127.0.0.1:${PORT}/?ed=2048`,
      uuid: user.uuid,
      targetHost: 'www.speedtest.net',
      targetPort: 443,
      path: '/cdn-cgi/trace',
    });
    assert(
      /^HTTP\/1\.[01]\s+200\b/.test(famTunnel) && famTunnel.includes('h=www.speedtest.net'),
      `Family gate must NOT break ordinary browsing, got: ${famTunnel.slice(0, 140)}`
    );

    const famOffRes = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ...boot16.settings, blockAdult: false }),
    });
    assert.equal(famOffRes.status, 200);
    console.log('✓ [16/16] Server-Side Family Filter -> DoH sinkhole + ordinary resolve + live tunnel 200 + default OFF');

    // ── TEST 17: ULTRA v4.2 — extended feature set (feed alias, auto-update, restart-core,
    //    pools sampling, per-user ports + pool type + separate request reset, lifetime & deleted
    //    accounting, mid-connection heartbeat enforcement, CF-token password recovery) ──

    // (a) /feed/<token> alias must mirror /sub/<token> byte-for-byte and never be cached
    const feedRes = await fetch(`${BASE}/feed/${user.subToken}`);
    assert.equal(feedRes.status, 200, '/feed alias must serve subscriptions');
    assert.equal(feedRes.headers.get('cache-control'), 'no-store', '/feed must never be cached');
    const subMirror = await fetch(`${BASE}/sub/${user.subToken}`);
    assert.equal(await feedRes.text(), await subMirror.text(), '/feed payload must equal /sub payload');

    // (b) autoUpdate setting round-trip (default OFF -> ON -> OFF)
    const updOn = await (await fetch(`${BASE}/api/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ...boot16.settings, blockAdult: false, autoUpdate: true }),
    })).json();
    assert.equal(updOn.settings.autoUpdate, true, 'autoUpdate must round-trip ON');
    const updOff = await (await fetch(`${BASE}/api/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ...updOn.settings, autoUpdate: false }),
    })).json();
    assert.equal(updOff.settings.autoUpdate, false, 'autoUpdate must round-trip OFF');

    // (c) restart-core: flush caches, keep users
    const restartJson = await (await fetch(`${BASE}/api/restart-core`, { method: 'POST', headers: { cookie } })).json();
    assert.equal(restartJson.restarted, true, 'restart-core must report restarted');
    assert(restartJson.users >= 1, 'restart-core must preserve subscribers');

    // (d) pools: save proxy + ip pools, then sample candidates for the smart provisioner
    const putPool = async (kind, text) => (await fetch(`${BASE}/api/pools`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ kind, text }),
    })).json();
    assert((await putPool('proxy', 'socks5://1.2.3.4:1080\nsocks5://5.6.7.8:1080')).ok, 'proxy pool save');
    assert((await putPool('ips4', '1.2.3.4\n5.6.7.8')).ok, 'ips4 pool save');
    assert((await putPool('ips6', '2606:4700::6810:84e5')).ok, 'ips6 pool save');
    assert((await putPool('dom', 'www.example.com')).ok, 'dom pool save');
    const sampleJson = await (await fetch(`${BASE}/api/pools?sample=proxy&count=2`, { headers: { cookie } })).json();
    assert(sampleJson.ok && sampleJson.candidates.length === 2, 'pool sampling must return requested count');
    assert(sampleJson.candidates.every((c) => /^socks5:\/\/\d/.test(c.p)), 'sampled candidates must be proxy URLs');

    // (e) per-user ports override + rotation pool type + separate request auto-reset
    const mkJson = await (await fetch(`${BASE}/api/users`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'v41-parity', ports: '8443', poolType: 'ipv4', autoResetReqDays: 7,
        autoRotateIps: true, ipCount: 5,
      }),
    })).json();
    const v41 = mkJson.users.find((u) => u.name === 'v41-parity');
    assert(v41, 'v41-parity user must be created');
    assert.equal(v41.ports, '8443', 'per-user ports must persist');
    assert.equal(v41.poolType, 'ipv4', 'poolType must persist');
    assert.equal(v41.autoResetReqDays, 7, 'separate request reset days must persist');
    const nodesJson = await (await fetch(`${BASE}/api/users/${v41.id}/nodes`, { headers: { cookie } })).json();
    assert(nodesJson.nodes.length > 0, 'nodes must be generated for the new user');
    assert(nodesJson.nodes.every((n) => Number(n.port) === 8443), `per-user ports must override panel ports, got: ${[...new Set(nodesJson.nodes.map((n) => n.port))].join(',')}`);
    const rotatedAddrs = nodesJson.nodes.map((n) => n.address).filter((a) => a !== '127.0.0.1');
    assert(rotatedAddrs.length > 0, 'rotation must inject clean addresses');
    assert(
      rotatedAddrs.every((a) => a === '1.2.3.4' || a === '5.6.7.8'),
      `poolType=ipv4 must rotate ONLY from the IPv4 pool, got: ${rotatedAddrs.join(',')}`
    );

    // (f) lifetime usage survives manual reset + deleted-user accounting
    const genUsage = await fetchHttpsViaFragmentedVless({
      wsUrl: `ws://127.0.0.1:${PORT}/?ed=2048`,
      uuid: v41.uuid,
      targetHost: 'www.speedtest.net',
      targetPort: 443,
      path: '/cdn-cgi/trace',
    });
    assert(/^HTTP\/1\.[01]\s+200\b/.test(genUsage), 'usage-generating tunnel must succeed');
    // Poll until the background first-connection flush lands in KV (lifetime bookkeeping)
    let v41used = null;
    for (let i = 0; i < 12 && !v41used; i++) {
      await sleep(1000);
      const bootLife = await (await fetch(`${BASE}/api/bootstrap`, { headers: { cookie } })).json();
      const cand = bootLife.users.find((u) => u.id === v41.id);
      if ((cand.usedBytes || 0) > 0 && (cand.lifetimeUpBytes || 0) + (cand.lifetimeDownBytes || 0) > 0) v41used = cand;
    }
    assert(v41used, 'usage + lifetime must be recorded (flush may lag a few seconds)');
    await fetch(`${BASE}/api/users/${v41.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ action: 'reset_traffic' }),
    });
    const bootAfterReset = await (await fetch(`${BASE}/api/bootstrap`, { headers: { cookie } })).json();
    const v41reset = bootAfterReset.users.find((u) => u.id === v41.id);
    assert.equal(v41reset.usedBytes, 0, 'reset_traffic must zero the period counter');
    assert((v41reset.lifetimeUpBytes || 0) + (v41reset.lifetimeDownBytes || 0) > 0, 'lifetime must survive reset_traffic');
    assert((bootAfterReset.totals.deletedBytes || 0) === 0, 'deleted accounting starts at zero');
    // delete the used subscriber — lifetime traffic must move into server-wide accounting
    await fetch(`${BASE}/api/users/${v41.id}`, { method: 'DELETE', headers: { cookie } });
    const bootAfterDel = await (await fetch(`${BASE}/api/bootstrap`, { headers: { cookie } })).json();
    assert((bootAfterDel.totals.deletedBytes || 0) > 0, 'deleted users must leave their traffic in server accounting');

    // (g) mid-connection heartbeat enforcement: disabling a subscriber must kill their LIVE tunnel
    const hbJson = await (await fetch(`${BASE}/api/users`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'hb-watch' }),
    })).json();
    const hbUser = hbJson.users.find((u) => u.name === 'hb-watch');
    const idleWs = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?ed=2048`);
      const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('idle tunnel open timeout')); }, 15000);
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
      ws.on('open', () => {
        ws.send(buildVlessHeader(hbUser.uuid, 'www.speedtest.net', 443, 1));
        clearTimeout(t);
        resolve(ws);
      });
    });
    await sleep(2500); // let the tunnel establish and the remote dial settle
    assert(idleWs.readyState === WebSocket.OPEN, 'idle tunnel must be open');
    const dis = await fetch(`${BASE}/api/users/${hbUser.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(dis.status, 200, 'disable request must succeed');
    const killed = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 45000);
      idleWs.on('close', () => { clearTimeout(t); resolve(true); });
    });
    assert(killed, 'heartbeat must terminate a disabled subscriber mid-connection');

    // (h) password recovery via Cloudflare API token — users preserved, panel re-set-up
    const badRec = await fetch(`${BASE}/api/recover`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'definitely-wrong-token-1234' }),
    });
    assert.equal(badRec.status, 400, 'recovery with a bad token must be rejected');
    const rec = await fetch(`${BASE}/api/recover`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'cf_valid_test_token_1234567890' }),
    });
    assert.equal(rec.status, 200, 'recovery with a valid CF token must succeed');
    const recJson = await rec.json();
    assert(recJson.ok && recJson.preservedUsers >= 1, 'recovery must preserve subscribers');
    const bootNeedsSetup = await (await fetch(`${BASE}/api/bootstrap`)).json();
    assert.equal(bootNeedsSetup.state, 'needs_setup', 'panel must return to first-run setup after recovery');
    const reSetup = await fetch(`${BASE}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'NewAdminPassword25!' }),
    });
    assert.equal(reSetup.status, 200, 're-setup must succeed after recovery');
    const reJson = await reSetup.json();
    assert(reJson.users.some((u) => u.name === 'hb-watch'), 'subscribers must survive the recovery cycle');
    assert(reJson.settings && typeof reJson.settings.wsPath === 'string', 'settings must survive the recovery cycle');
    console.log('✓ [17/17] ULTRA v4.2 Extended -> feed alias, auto-update toggle, restart-core, pool sampling, per-user ports/poolType/req-reset, lifetime+deleted accounting, live heartbeat kill, CF-token recovery — ALL VERIFIED!');

    assert.equal(pageErrors.length, 0, `Unexpected browser JS errors: ${pageErrors.join('; ')}`);
    await browser.close();
    assert(!serverLogs.includes('Uncaught'), `Unexpected Uncaught in workerd logs:\n${serverLogs}`);
    console.log('\nALL 17/17 ARAL SULFUR v1.0.0 E2E VERIFICATION SUITES PASSED WITH ZERO ERRORS!');
  } catch (err) {
    console.error('\nTEST FAILED:', err);
    if (serverLogs) console.error('SERVER LOGS:\n', serverLogs.slice(-1500));
    proc.kill('SIGTERM');
    mockSrv.close();
    process.exit(1);
  } finally {
    proc.kill('SIGTERM');
    mockSrv.close();
  }
  process.exit(0);
}

main();
