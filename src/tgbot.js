/**
 * ARAL SULFUR v1.2 — Dual-Platform Delivery Bot (Telegram + Bale).
 *
 * Webhook-based, admin-only bot wired straight into the panel KV state:
 *   · Admin pastes a BotFather token + their numeric ID in the panel → Settings → ست کردن بات
 *   · The worker validates the token (getMe) and automatically calls setWebhook on its own
 *     URL (`/api/tgbot/hook/<secret>` or `/api/blbot/hook/<secret>`); Telegram's
 *     X-Telegram-Bot-Api-Secret-Token header is verified on every update (path secret
 *     is always verified for both platforms)
 *   · /start greets the admin with TWO colored glass options:
 *        [📥 دریافت کانفیگ]  (green / success)   [🔗 دریافت پروکسی]  (blue / primary)
 *   · دریافت کانفیگ → every panel subscriber as glass buttons (paginated) → tapping one
 *     streams its config URIs RANDOMLY, 5 per copyable message, with a
 *     [⏭ 5 تای بعدی] glass button carrying the same random order until the list ends
 *   · دریافت پروکسی → every Telegram-proxy port as glass URL buttons — one tap opens
 *     Telegram straight into the connect screen
 *   · Every screen carries a back button; colored button styles use Bot API 9.4+
 *     (`style`: danger/success/primary) and degrade gracefully on Bale (automatic
 *     style-free retry if the platform rejects the field)
 *
 * QR images are rendered in-process by ./qrpng.js — no third-party QR service ever
 * sees a subscription token.
 */

import { enrichUserView, PANEL_VERSION } from './storage.js';
import { buildUriLines, computeQuickUserNodeMeta, formatBytes } from './sub.js';
import { buildTgProxyFullLinks } from './tgproxy.js';
import { qrPngBytes } from './qrpng.js';

const TG_API_DEFAULT = 'https://api.telegram.org';
const BALE_API_DEFAULT = 'https://tapi.bale.ai';
let tgApiBase = TG_API_DEFAULT;
let baleApiBase = BALE_API_DEFAULT;
const USERS_PER_PAGE = 10;
const CONFIGS_PER_MESSAGE = 5;
const TG_TIMEOUT_MS = 15000;

/** Test/dev hook: point the Telegram API at a mock server (env.NL_TG_API_BASE). */
export function setTgApiBase(base) {
  const clean = String(base || '').trim().replace(/\/+$/, '');
  tgApiBase = clean || TG_API_DEFAULT;
}

/** Test/dev hook: point the Bale API at a mock server (env.NL_BALE_API_BASE). */
export function setBaleApiBase(base) {
  const clean = String(base || '').trim().replace(/\/+$/, '');
  baleApiBase = clean || BALE_API_DEFAULT;
}

function apiBase(platform) {
  if (platform === 'bale') return baleApiBase || BALE_API_DEFAULT;
  return tgApiBase || TG_API_DEFAULT;
}

/* ─────────────────────────── platform helpers ─────────────────────────── */

function settingsKeys(platform) {
  return platform === 'bale'
    ? { token: 'blBotToken', adminIds: 'blBotAdminIds', hookSecret: 'blBotHookSecret', info: 'blBotInfo' }
    : { token: 'tgBotToken', adminIds: 'tgBotAdminIds', hookSecret: 'tgBotHookSecret', info: 'tgBotInfo' };
}

function hookPathFor(platform) {
  return platform === 'bale' ? '/api/blbot/hook/' : '/api/tgbot/hook/';
}

/** Strip Bot-API-9.4 style fields for platforms that reject them (Bale fallback). */
function stripButtonStyles(markup) {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return null;
  return {
    inline_keyboard: markup.inline_keyboard.map((row) =>
      row.map((btn) => {
        const { style, icon_custom_emoji_id, ...rest } = btn;
        return rest;
      })
    ),
  };
}

async function rawBotCall(platform, token, method, payload, timeoutMs = TG_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => { try { ctrl.abort('timeout'); } catch {} }, timeoutMs);
  try {
    const res = await fetch(`${apiBase(platform)}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    return {
      ok: Boolean(res.ok && data && data.ok),
      okResult: data && data.ok ? data.result : null,
      description: data && data.description ? String(data.description) : '',
      status: res.status,
    };
  } catch (err) {
    return { ok: false, okResult: null, description: err && err.message ? String(err.message) : 'network error', status: 0 };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Style-aware bot call: sends colored-glass buttons as-is; when the platform rejects
 * the modern `style`/`icon_custom_emoji_id` fields (HTTP 400), retries once without
 * them so both Telegram and Bale always work.
 */
async function botCall(platform, token, method, payload, timeoutMs = TG_TIMEOUT_MS) {
  const first = await rawBotCall(platform, token, method, payload, timeoutMs);
  if (first.ok || first.status !== 400 || !payload || !payload.reply_markup) return first;
  const stripped = stripButtonStyles(payload.reply_markup);
  if (!stripped) return first;
  const retry = await rawBotCall(platform, token, method, { ...payload, reply_markup: stripped }, timeoutMs);
  return retry.ok ? retry : first;
}

async function tgSendPhotoFile(platform, token, chatId, pngBytes, caption, replyMarkup) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => { try { ctrl.abort('timeout'); } catch {} }, 25000);
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
    form.append('photo', new Blob([pngBytes], { type: 'image/png' }), `aral-qr-${Date.now()}.png`);
    const res = await fetch(`${apiBase(platform)}/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    return {
      ok: Boolean(res.ok && data && data.ok),
      description: data && data.description ? String(data.description) : '',
    };
  } catch (err) {
    return { ok: false, description: err && err.message ? String(err.message) : 'network error' };
  } finally {
    clearTimeout(tid);
  }
}

/* ─────────────────────────── Settings helpers ─────────────────────────── */

function parseAdminIds(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^-?\d{3,20}$/.test(s));
}

export function tgBotConfigured(settings) {
  return Boolean(settings && settings.tgBotToken && settings.tgBotHookSecret);
}

/** Public (masked) view for the panel UI — never exposes the raw token. */
export function botPublicInfo(settings, platform) {
  const s = settings || {};
  const k = settingsKeys(platform);
  const tok = String(s[k.token] || '');
  const info = s[k.info] && typeof s[k.info] === 'object' ? s[k.info] : null;
  return {
    platform,
    configured: Boolean(tok),
    maskedToken: tok ? tok.slice(0, 8) + '••••••••' + tok.slice(-4) : '',
    adminIds: parseAdminIds(s[k.adminIds]),
    botId: info?.botId || '',
    username: info?.username || '',
    firstName: info?.firstName || '',
    webhookSetAt: info?.webhookSetAt || 0,
    lastOkAt: info?.lastOkAt || 0,
    lastError: info?.lastError || '',
    hookPath: tok && s[k.hookSecret] ? `${hookPathFor(platform)}${s[k.hookSecret]}` : '',
  };
}

export function tgBotPublicInfo(settings) {
  return botPublicInfo(settings, 'telegram');
}

export function blBotPublicInfo(settings) {
  return botPublicInfo(settings, 'bale');
}

/* ─────────────────────────── Panel-side management APIs ─────────────────────────── */

/** Validate a BotFather token + wire the webhook (fully automatic). Returns an error string on failure. */
export async function botConnect(env, state, { platform, token, adminIds, host, persistState }) {
  const isBale = platform === 'bale';
  const k = settingsKeys(platform);
  const cleanToken = String(token || '').trim();
  if (!/^\d{6,12}:[A-Za-z0-9_-]{20,60}$/.test(cleanToken)) {
    return { ok: false, error: isBale
      ? 'قالب توکن بات بله معتبر نیست. توکن را از @BotFather بله دقیقاً کپی کنید.'
      : 'قالب توکن بات معتبر نیست. توکن را از @BotFather دقیقاً کپی کنید.' };
  }
  const ids = parseAdminIds(adminIds);
  if (!ids.length) {
    return { ok: false, error: 'حداقل یک آیدی عددی ادمین لازم است (مثلاً ۱۲۳۴۵۶۷۸۹ از @userinfobot).' };
  }

  const me = await rawBotCall(platform, cleanToken, 'getMe', {});
  if (!me.ok || !me.okResult || !me.okResult.id) {
    return {
      ok: false,
      error: `توکن بات نامعتبر است یا سرویس در دسترس نیست (${me.description || 'خطای نامشخص'}).`,
    };
  }

  const hookSecret = state.settings[k.hookSecret];
  const webhookUrl = `https://${host}${hookPathFor(platform)}${hookSecret}`;
  const whPayload = {
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
    max_connections: 4,
  };
  /* Telegram verifies every update with a shared secret header; Bale's API has no
     secret_token support, so the unguessable path secret alone protects its hook. */
  if (!isBale) whPayload.secret_token = hookSecret;
  const wh = await rawBotCall(platform, cleanToken, 'setWebhook', whPayload);
  if (!wh.ok) {
    return { ok: false, error: `ست‌کردن وبهوک ناموفق بود: ${wh.description || 'خطای نامشخص'}` };
  }

  state.settings[k.token] = cleanToken;
  state.settings[k.adminIds] = ids.join(',');
  state.settings[k.info] = {
    botId: String(me.okResult.id),
    username: String(me.okResult.username || ''),
    firstName: String(me.okResult.first_name || ''),
    canJoinGroups: Boolean(me.okResult.can_join_groups),
    webhookSetAt: Date.now(),
    lastOkAt: Date.now(),
    lastError: '',
  };

  if (persistState) {
    try { await persistState(env, state); } catch {}
  }
  return {
    ok: true,
    bot: { botId: me.okResult.id, username: me.okResult.username || '', firstName: me.okResult.first_name || '' },
    webhookUrl,
  };
}

/** Remove the webhook and clear stored bot credentials. */
export async function botDisconnect(env, state, { platform, persistState } = {}) {
  const k = settingsKeys(platform);
  const token = state.settings[k.token];
  if (token) {
    await rawBotCall(platform, token, 'deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  }
  state.settings[k.token] = '';
  state.settings[k.info] = null;
  if (persistState) {
    try { await persistState(env, state); } catch {}
  }
  return { ok: true };
}

export async function tgBotConnect(env, state, opts) {
  return botConnect(env, state, { ...opts, platform: 'telegram' });
}
export async function blBotConnect(env, state, opts) {
  return botConnect(env, state, { ...opts, platform: 'bale' });
}
export async function tgBotDisconnect(env, state, opts) {
  return botDisconnect(env, state, { ...opts, platform: 'telegram' });
}
export async function blBotDisconnect(env, state, opts) {
  return botDisconnect(env, state, { ...opts, platform: 'bale' });
}

/** Live status probe for the panel UI (getWebhookInfo + getMe). */
export async function botStatus(state, platform) {
  const k = settingsKeys(platform);
  const token = state.settings[k.token];
  if (!token) {
    return { ok: true, configured: false };
  }
  const me = await rawBotCall(platform, token, 'getMe', {});
  const wh = await rawBotCall(platform, token, 'getWebhookInfo', {});
  return {
    ok: true,
    configured: true,
    connected: me.ok,
    bot: me.okResult
      ? { botId: me.okResult.id, username: me.okResult.username || '', firstName: me.okResult.first_name || '' }
      : null,
    webhook: wh.okResult || null,
    error: me.ok ? '' : (me.description || 'getMe failed'),
    lastError: state.settings[k.info]?.lastError || '',
  };
}

export async function tgBotStatus(state) {
  return botStatus(state, 'telegram');
}
export async function blBotStatus(state) {
  return botStatus(state, 'bale');
}

function recordBotError(state, platform, message, persistState, env) {
  const k = settingsKeys(platform);
  const info = state.settings[k.info] && typeof state.settings[k.info] === 'object'
    ? { ...state.settings[k.info] }
    : {};
  info.lastError = String(message || '').slice(0, 160);
  state.settings[k.info] = info;
  if (persistState && env) {
    try { void persistState(env, state); } catch {}
  }
}

/* ─────────────────────────── Bot conversation ─────────────────────────── */

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function statusIcon(status) {
  switch (status) {
    case 'active': return '✅';
    case 'paused': return '⛔';
    case 'expired': return '⌛';
    case 'quota': return '🧯';
    case 'reqquota': return '🔢';
    default: return '❔';
  }
}

function statusTextFa(status) {
  switch (status) {
    case 'active': return '✅ فعال';
    case 'paused': return '⛔ موقتاً متوقف';
    case 'expired': return '⌛ منقضی‌شده';
    case 'quota': return '🧯 حجم تمام‌شده';
    case 'reqquota': return '🔢 سهمیهٔ اتصال تمام‌شده';
    default: return '❔ نامشخص';
  }
}

/* Seeded shuffle so "5 تای بعدی" continues the SAME random order */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seedNum) {
  const out = [...arr];
  const rnd = mulberry32(seedNum);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function seedHex() {
  try {
    return [...crypto.getRandomValues(new Uint8Array(2))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return String(Math.floor(Math.random() * 0xffff)).padStart(4, '0');
  }
}

function seedNum(hex) {
  return parseInt(String(hex || '0'), 16) || 1;
}

/* Real config URIs only — drop the panel watermark/info pseudo-nodes (null UUID). */
function userConfigUris(user, settings, host) {
  const lines = buildUriLines(user, settings, host);
  return lines.filter((l) => !/^vless:\/\/0{8}-0{4}-0{4}-0{4}-0{12}@127\.0\.0\.1/.test(l));
}

/* ── colored glass keyboards (Bot API 9.4+ styles with safe fallback) ── */

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📥 دریافت کانفیگ', callback_data: 'cfg:0', style: 'success' },
        { text: '🔗 دریافت پروکسی', callback_data: 'prx:0', style: 'primary' },
      ],
    ],
  };
}

function backRow(target) {
  return [{ text: '⬅️ بازگشت', callback_data: target, style: 'danger' }];
}

function welcomeMessage(state, platform, adminName) {
  const users = Array.isArray(state.users) ? state.users : [];
  const active = users.filter((u) => enrichUserView(u).status === 'active').length;
  const isBale = platform === 'bale';
  const brand = isBale ? '🟢 <b>ARAL SULFUR</b> — بات بله' : '🔵 <b>ARAL SULFUR</b> — بات تلگرام';
  return [
    brand,
    ``,
    `سلام ${escHtml(adminName || 'مدیر')} عزیز! 👑`,
    `به بات تحویل کانفیگ پنل خوش آمدید.`,
    ``,
    `👥 مشترکین: <b>${users.length}</b> نفر (<b>${active}</b> فعال)`,
    `🔢 نسخهٔ هسته: <b>${escHtml(PANEL_VERSION)}</b>`,
    ``,
    `از منوی شیشه‌ای زیر گزینهٔ دلخواه را انتخاب کنید 👇`,
  ].join('\n');
}

function subscribersPage(state, page) {
  const users = (Array.isArray(state.users) ? state.users : []).map((u) => enrichUserView(u));
  users.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const totalPages = Math.max(1, Math.ceil(users.length / USERS_PER_PAGE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = users.slice(safePage * USERS_PER_PAGE, (safePage + 1) * USERS_PER_PAGE);

  const keyboard = [];
  for (const u of slice) {
    keyboard.push([
      {
        text: `${statusIcon(u.status)} ${String(u.name || '').slice(0, 28)} · ${u.nodeCount || 0} کانفیگ`,
        callback_data: `cfu:${u.id}:${safePage}`,
        style: u.status === 'active' ? 'success' : 'danger',
      },
    ]);
  }
  const nav = [];
  if (safePage > 0) nav.push({ text: '◀️ قبلی', callback_data: `cfg:${safePage - 1}`, style: 'primary' });
  nav.push({ text: `📄 ${safePage + 1} / ${totalPages}`, callback_data: 'noop:0' });
  if (safePage < totalPages - 1) nav.push({ text: 'بعدی ▶️', callback_data: `cfg:${safePage + 1}`, style: 'primary' });
  if (nav.length) keyboard.push(nav);
  keyboard.push(backRow('menu:0'));

  const header = [
    `📥 <b>دریافت کانفیگ</b> — کدام مشترک؟`,
    `روی مشترک بزن تا کانفیگ‌هایش <b>به‌صورت رندوم</b> و ۵تا۵تا برایت ارسال شود:`,
  ].join('\n');
  return { text: header, keyboard };
}

function configsChunkMessage(user, chunk, cursor, total, seed) {
  const shown = chunk
    .map((uri, i) => `<code>${escHtml(uri)}</code>`)
    .join('\n\n');
  const header = `⚡ <b>کانفیگ‌های ${escHtml(user.name)}</b> — ${cursor + 1} تا ${cursor + chunk.length} از ${total}`;
  return `${header}\n\n${shown}\n\n💡 برای کپی، روی هر کانفیگ بزن.`;
}

function configsChunkKeyboard(user, cursor, chunkLen, total, page) {
  const nextCursor = cursor + chunkLen;
  const row = [];
  if (nextCursor < total) {
    row.push({ text: `⏭ ۵ تای بعدی (${total - nextCursor} باقی‌مانده)`, callback_data: `cfn:${user.id}:${nextCursor}:${seedLast()}`, style: 'success' });
  } else {
    row.push({ text: '✅ پایان لیست', callback_data: 'noop:0' });
  }
  return {
    inline_keyboard: [
      row,
      [
        { text: '🔁 رندوم دوباره', callback_data: `cfu:${user.id}:${page}`, style: 'primary' },
        ...backRow('cfg:' + page),
      ],
    ],
  };
}

/* tiny per-update seed holder (set right before building a keyboard) */
var _lastSeed = '';
function seedLast() { return _lastSeed || seedHex(); }
function setSeed(s) { _lastSeed = s; }

async function proxiesPage(state, host) {
  const settings = state.settings || {};
  if (!settings.tgProxySecret || settings.enableTgProxy === false) {
    return {
      text: '⚠️ پروکسی تلگرام در پنل فعال نیست. از تب «پروکسی تلگرام» آن را روشن کنید.',
      keyboard: { inline_keyboard: [backRow('menu:0')] },
    };
  }
  const info = await buildTgProxyFullLinks(host, settings.tgProxySecret, settings.tgProxyDomain);
  const ports = info.ports || [];
  const lines = [
    '🔗 <b>دریافت پروکسی</b> — همهٔ پورت‌ها',
    ``,
    `روی هر دکمه بزن تا <b>مستقیم به تلگرام</b> برای اتصال بروی:`,
    ``,
  ];
  const keyboard = [];
  for (const p of ports) {
    keyboard.push([
      {
        text: `🚀 اتصال روی پورت :${p.port}`,
        url: p.tgUrl,
        style: p.port === 443 ? 'success' : 'primary',
      },
      {
        text: `📋 :${p.port}`,
        callback_data: `pcs:${p.port}`,
        style: 'primary',
      },
    ]);
    lines.push(`پورت <code>:${p.port}</code> — سکرت: <code>${escHtml(String(p.secret).slice(0, 18))}…</code>`);
  }
  lines.push('');
  lines.push('🧷 لینک‌های آمادهٔ اشتراک‌گذاری (کپی با لمس):');
  for (const p of ports.slice(0, 3)) {
    lines.push(`<code>${escHtml(p.tmeUrl)}</code>`);
  }
  keyboard.push(backRow('menu:0'));
  let text = lines.join('\n');
  if (text.length > 4000) text = text.slice(0, 4000) + '\n…';
  return { text, keyboard };
}

function proxySecretMessage(portInfo) {
  return [
    `📋 <b>پروکسی پورت :${portInfo.port}</b>`,
    '',
    `سکرت کامل:`,
    `<code>${escHtml(portInfo.secret)}</code>`,
    '',
    `لینک t.me (کپی‌پذیر):`,
    `<code>${escHtml(portInfo.tmeUrl)}</code>`,
    '',
    `لینک مستقیم تلگرام:`,
    `<code>${escHtml(portInfo.tgUrl)}</code>`,
  ].join('\n');
}

/* ─────────────────────────── Webhook entrypoints ─────────────────────────── */

async function handleBotUpdate(request, url, env, runtime, { persistState, platform }) {
  const state = runtime;
  const settings = state.settings;
  const host = url.host;
  const isBale = platform === 'bale';
  const k = settingsKeys(platform);
  const pathSecret = url.pathname.split('/').pop() || '';
  const headerSecret = String(request.headers.get('x-telegram-bot-api-secret-token') || '');

  if (!settings[k.token] || pathSecret !== settings[k.hookSecret]) {
    return new Response('forbidden', { status: 403 });
  }
  /* Telegram always sends the shared secret header; Bale has no such feature. */
  if (!isBale && headerSecret !== settings[k.hookSecret]) {
    return new Response('forbidden', { status: 403 });
  }

  let update = null;
  try {
    update = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  try {
    const admins = parseAdminIds(settings[k.adminIds]);
    const token = settings[k.token];
    const send = (payload) => botCall(platform, token, 'sendMessage', { parse_mode: 'HTML', disable_web_page_preview: true, ...payload });
    const edit = (payload) => botCall(platform, token, 'editMessageText', { parse_mode: 'HTML', disable_web_page_preview: true, ...payload });
    const answer = (payload) => botCall(platform, token, 'answerCallbackQuery', payload);

    const cq = update.callback_query;
    if (cq) {
      const chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
      const fromId = cq.from ? String(cq.from.id) : '';
      if (!chatId) return new Response('ok');
      if (!admins.includes(fromId)) {
        await answer({ callback_query_id: cq.id, text: '⛔ این بات فقط برای مدیر پنل است.', show_alert: true });
        return new Response('ok');
      }

      const data = String(cq.data || '');
      const msgId = cq.message.message_id;

      if (data.startsWith('noop:')) {
        await answer({ callback_query_id: cq.id, text: '✨ ARAL SULFUR' });
        return new Response('ok');
      }
      if (data.startsWith('menu:')) {
        await answer({ callback_query_id: cq.id });
        await edit({ chat_id: chatId, message_id: msgId, text: welcomeMessage(state, platform, cq.from.first_name), reply_markup: mainMenuKeyboard() });
        return new Response('ok');
      }

      /* ── دریافت کانفیگ: subscriber picker ── */
      if (data.startsWith('cfg:')) {
        const page = Math.max(0, Number(data.split(':')[1]) || 0);
        await answer({ callback_query_id: cq.id });
        const list = subscribersPage(state, page);
        await edit({ chat_id: chatId, message_id: msgId, text: list.text, reply_markup: { inline_keyboard: list.keyboard } });
        return new Response('ok');
      }

      /* ── tap a subscriber → first random 5 configs ── */
      if (data.startsWith('cfu:')) {
        const [, userId, pageStr] = data.split(':');
        const user = (state.users || []).find((u) => u && u.id === userId);
        if (!user) {
          await answer({ callback_query_id: cq.id, text: '⚠️ این مشترک حذف شده است؛ فهرست را رفرش کنید.', show_alert: true });
          return new Response('ok');
        }
        await answer({ callback_query_id: cq.id, text: 'در حال آماده‌سازی…' });
        const view = enrichUserView(user);
        const page = Math.max(0, Number(pageStr) || 0);
        const seed = seedHex();
        setSeed(seed);
        const uris = seededShuffle(userConfigUris(view, settings, host), seedNum(seed));
        if (!uris.length) {
          await send({ chat_id: chatId, text: '⚠️ کانفیگی برای این مشترک ساخته نشد؛ پروتکل‌ها را در پنل بررسی کنید.', reply_markup: { inline_keyboard: [backRow('cfg:' + page)] } });
          return new Response('ok');
        }
        const chunk = uris.slice(0, CONFIGS_PER_MESSAGE);
        await send({
          chat_id: chatId,
          text: configsChunkMessage(view, chunk, 0, uris.length),
          reply_markup: configsChunkKeyboard(view, 0, chunk.length, uris.length, page),
        });
        return new Response('ok');
      }

      /* ── ۵ تای بعدی: continue the same seeded order ── */
      if (data.startsWith('cfn:')) {
        const [, userId, cursorStr, seedStr] = data.split(':');
        const user = (state.users || []).find((u) => u && u.id === userId);
        if (!user) {
          await answer({ callback_query_id: cq.id, text: '⚠️ این مشترک حذف شده است.', show_alert: true });
          return new Response('ok');
        }
        await answer({ callback_query_id: cq.id, text: '۵ تای بعدی…' });
        const view = enrichUserView(user);
        const cursor = Math.max(0, Number(cursorStr) || 0);
        setSeed(seedStr || seedHex());
        const uris = seededShuffle(userConfigUris(view, settings, host), seedNum(seedStr));
        if (cursor >= uris.length) {
          await send({ chat_id: chatId, text: '✅ همهٔ کانفیگ‌ها ارسال شد.', reply_markup: { inline_keyboard: [backRow('cfg:0')] } });
          return new Response('ok');
        }
        const chunk = uris.slice(cursor, cursor + CONFIGS_PER_MESSAGE);
        await send({
          chat_id: chatId,
          text: configsChunkMessage(view, chunk, cursor, uris.length),
          reply_markup: configsChunkKeyboard(view, cursor, chunk.length, uris.length, 0),
        });
        return new Response('ok');
      }

      /* ── دریافت پروکسی: menu of glass connect buttons ── */
      if (data.startsWith('prx:')) {
        await answer({ callback_query_id: cq.id });
        const page = await proxiesPage(state, host);
        await edit({ chat_id: chatId, message_id: msgId, text: page.text, reply_markup: { inline_keyboard: page.keyboard } });
        return new Response('ok');
      }

      /* ── copy a proxy's secret/links ── */
      if (data.startsWith('pcs:')) {
        const port = Number(data.split(':')[1]) || 443;
        await answer({ callback_query_id: cq.id });
        const settings2 = state.settings || {};
        if (settings2.tgProxySecret) {
          const info = await buildTgProxyFullLinks(host, settings2.tgProxySecret, settings2.tgProxyDomain);
          const portInfo = (info.ports || []).find((p) => p.port === port);
          if (portInfo) {
            await send({
              chat_id: chatId,
              text: proxySecretMessage(portInfo),
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🚀 اتصال همین پورت', url: portInfo.tgUrl, style: 'success' }],
                  backRow('prx:0'),
                ],
              },
            });
            return new Response('ok');
          }
        }
        await send({ chat_id: chatId, text: '⚠️ اطلاعات این پورت پیدا نشد.', reply_markup: { inline_keyboard: [backRow('prx:0')] } });
        return new Response('ok');
      }

      /* legacy subscriber card (QR + links) kept for power users via /subs */
      if (data.startsWith('u:')) {
        const [, userId, pageStr] = data.split(':');
        const user = (state.users || []).find((u) => u && u.id === userId);
        if (!user) {
          await answer({ callback_query_id: cq.id, text: '⚠️ این مشترک حذف شده است.', show_alert: true });
          return new Response('ok');
        }
        await answer({ callback_query_id: cq.id, text: 'در حال آماده‌سازی…' });
        const view = enrichUserView(user);
        const backKb = { inline_keyboard: [[{ text: '⬅️ بازگشت به مشترکین', callback_data: `cfg:${Math.max(0, Number(pageStr) || 0)}`, style: 'danger' }]] };
        const qrCaption = `📱 <b>QR اشتراک عادی</b> — ${escHtml(view.name)}`.slice(0, 1024);
        let png = null;
        try {
          png = qrPngBytes(`https://${host}/sub/${encodeURIComponent(view.subToken)}`, { scale: 8, margin: 3 });
        } catch {}
        if (png) {
          await tgSendPhotoFile(platform, token, chatId, png, qrCaption, backKb);
        } else {
          await send({ chat_id: chatId, text: '⚠️ ساخت QR ممکن نشد؛ لینک‌ها را در پیام بعدی ببینید.', reply_markup: backKb });
        }
        const meta = computeQuickUserNodeMeta(view, settings, host);
        const body = [
          `👤 <b>${escHtml(view.name)}</b> — ${statusTextFa(view.status)}`,
          `📊 مصرف: ${formatBytes(view.usedBytes)} / ${view.limitBytes > 0 ? formatBytes(view.limitBytes) : '∞'}`,
          '',
          `🧷 ساب عادی:`,
          `<code>https://${escHtml(host)}/sub/${escHtml(view.subToken)}?format=b64</code>`,
          '',
          `🧩 ساب Fragment:`,
          `<code>https://${escHtml(host)}/sub/${escHtml(view.subToken)}?format=xray</code>`,
        ];
        if (meta.primaryVless) body.push('', `🛰 VLESS مستقیم:`, `<code>${escHtml(meta.primaryVless)}</code>`);
        await send({ chat_id: chatId, text: body.join('\n').slice(0, 4000), reply_markup: backKb });
        return new Response('ok');
      }

      await answer({ callback_query_id: cq.id });
      return new Response('ok');
    }

    const msg = update.message;
    if (!msg || !msg.chat) return new Response('ok');
    const chatId = msg.chat.id;
    const fromId = msg.from ? String(msg.from.id) : '';

    if (!admins.includes(fromId)) {
      await send({
        chat_id: chatId,
        text: [
          '⛔ <b>دسترسی محدود</b>',
          '',
          'این بات مخصوص مدیریتِ پنل ARAL SULFUR است و فقط پاسخ‌گوی ادمینِ ثبت‌شده در پنل است.',
          'اگر شما مدیر این پنل هستید، آیدی عددی خودتان را در پنل (تنظیمات → ست کردن بات) ثبت کنید.',
        ].join('\n'),
      });
      return new Response('ok');
    }

    const text = String(msg.text || '').trim();
    if (text.startsWith('/start') || text.startsWith('/menu') || text === 'سلام') {
      await send({
        chat_id: chatId,
        text: welcomeMessage(state, platform, msg.from && msg.from.first_name),
        reply_markup: mainMenuKeyboard(),
      });
      return new Response('ok');
    }
    if (text.startsWith('/configs') || text.startsWith('/cfg')) {
      const list = subscribersPage(state, 0);
      await send({ chat_id: chatId, text: list.text, reply_markup: { inline_keyboard: list.keyboard } });
      return new Response('ok');
    }
    if (text.startsWith('/proxies') || text.startsWith('/prx')) {
      const page = await proxiesPage(state, host);
      await send({ chat_id: chatId, text: page.text, reply_markup: { inline_keyboard: page.keyboard } });
      return new Response('ok');
    }
    if (text.startsWith('/subs')) {
      const list = subscribersPage(state, 0);
      await send({ chat_id: chatId, text: list.text, reply_markup: { inline_keyboard: list.keyboard } });
      return new Response('ok');
    }
    if (text.startsWith('/status')) {
      const users = (state.users || []).map((u) => enrichUserView(u));
      const active = users.filter((u) => u.status === 'active').length;
      await send({
        chat_id: chatId,
        text: [
          `📊 <b>وضعیت سریع پنل</b>`,
          ``,
          `👥 مشترکین: ${users.length} نفر`,
          `✅ فعال: ${active}`,
          `⛔ غیرفعال/محدود: ${users.length - active}`,
          `🏠 هاست: <code>${escHtml(host)}</code>`,
        ].join('\n'),
        reply_markup: mainMenuKeyboard(),
      });
      return new Response('ok');
    }
    // Unknown text → gentle hint with the glass menu
    await send({
      chat_id: chatId,
      text: 'برای شروع دستور /start را بزنید یا از دکمه‌های شیشه‌ای زیر استفاده کنید 👇',
      reply_markup: mainMenuKeyboard(),
    });
    return new Response('ok');
  } catch (err) {
    recordBotError(state, platform, err && err.message ? err.message : 'update handling error', persistState, env);
    return new Response('ok'); // never 500 — Telegram would retry storm
  }
}

export async function handleTgBotUpdate(request, url, env, runtime, opts = {}) {
  return handleBotUpdate(request, url, env, runtime, { ...opts, platform: 'telegram' });
}

export async function handleBaleBotUpdate(request, url, env, runtime, opts = {}) {
  return handleBotUpdate(request, url, env, runtime, { ...opts, platform: 'bale' });
}
