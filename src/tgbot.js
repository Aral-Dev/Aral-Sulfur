/**
 * ARAL SULFUR — Telegram Management Bot.
 *
 * Webhook-based, admin-only bot wired straight into the panel KV state:
 *   · Admin pastes a BotFather token + their numeric Telegram ID in the panel
 *   · The worker validates the token (getMe) and automatically calls setWebhook on
 *     its own URL (`/api/tgbot/hook/<secret>`), verified via Telegram's
 *     X-Telegram-Bot-Api-Secret-Token header on every update
 *   · /start greets the admin and shows the menu: [مشترکین] [پنل]
 *   · "مشترکین" lists every subscriber as inline glass buttons (paginated)
 *   · Tapping a subscriber delivers the panel QR code as a real photo plus all
 *     subscription links, primary VLESS/Trojan URIs and the status page
 *
 * QR images are rendered in-process by ./qrpng.js — no third-party QR service ever
 * sees a subscription token.
 */

import { enrichUserView, PANEL_VERSION } from './storage.js';
import { computeQuickUserNodeMeta, formatBytes } from './sub.js';
import { qrPngBytes } from './qrpng.js';

const TG_API_DEFAULT = 'https://api.telegram.org';
let tgApiBase = TG_API_DEFAULT;
const USERS_PER_PAGE = 12;
const TG_TIMEOUT_MS = 15000;

/** Test/dev hook: point the Telegram API at a mock server (env.NL_TG_API_BASE). */
export function setTgApiBase(base) {
  const clean = String(base || '').trim().replace(/\/+$/, '');
  tgApiBase = clean || TG_API_DEFAULT;
}

function apiBase() {
  return tgApiBase || TG_API_DEFAULT;
}

/* ─────────────────────────── Telegram API helpers ─────────────────────────── */

async function tgCall(token, method, payload, timeoutMs = TG_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => { try { ctrl.abort('timeout'); } catch {} }, timeoutMs);
  try {
    const res = await fetch(`${apiBase()}/bot${token}/${method}`, {
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

async function tgSendPhotoFile(token, chatId, pngBytes, caption, replyMarkup) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => { try { ctrl.abort('timeout'); } catch {} }, 25000);
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
    form.append('photo', new Blob([pngBytes], { type: 'image/png' }), `aral-qr-${Date.now()}.png`);
    const res = await fetch(`${apiBase()}/bot${token}/sendPhoto`, {
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
export function tgBotPublicInfo(settings) {
  const s = settings || {};
  const tok = String(s.tgBotToken || '');
  const info = s.tgBotInfo && typeof s.tgBotInfo === 'object' ? s.tgBotInfo : null;
  return {
    configured: Boolean(tok),
    maskedToken: tok ? tok.slice(0, 8) + '••••••••' + tok.slice(-4) : '',
    adminIds: parseAdminIds(s.tgBotAdminIds),
    botId: info?.botId || '',
    username: info?.username || '',
    firstName: info?.firstName || '',
    webhookSetAt: info?.webhookSetAt || 0,
    lastOkAt: info?.lastOkAt || 0,
    lastError: info?.lastError || '',
    hookPath: tok && s.tgBotHookSecret ? `/api/tgbot/hook/${s.tgBotHookSecret}` : '',
  };
}

/* ─────────────────────────── Panel-side management APIs ─────────────────────────── */

/** Validate a BotFather token + wire the webhook. Returns an error string on failure. */
export async function tgBotConnect(env, state, { token, adminIds, host, persistState }) {
  const cleanToken = String(token || '').trim();
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,60}$/.test(cleanToken)) {
    return { ok: false, error: 'قالب توکن بات معتبر نیست. توکن را از @BotFather دقیقاً کپی کنید.' };
  }
  const ids = parseAdminIds(adminIds);
  if (!ids.length) {
    return { ok: false, error: 'حداقل یک آیدی عددی ادمین لازم است (مثلاً ۱۲۳۴۵۶۷۸۹ از @userinfobot).' };
  }

  const me = await tgCall(cleanToken, 'getMe', {});
  if (!me.ok || !me.okResult || !me.okResult.id) {
    return {
      ok: false,
      error: `توکن بات نامعتبر است یا تلگرام در دسترس نیست (${me.description || 'خطای نامشخص'}).`,
    };
  }

  const hookSecret = state.settings.tgBotHookSecret;
  const webhookUrl = `https://${host}/api/tgbot/hook/${hookSecret}`;
  const wh = await tgCall(cleanToken, 'setWebhook', {
    url: webhookUrl,
    secret_token: hookSecret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
    max_connections: 4,
  });
  if (!wh.ok) {
    return { ok: false, error: `ست‌کردن وبهوک ناموفق بود: ${wh.description || 'خطای نامشخص'}` };
  }

  state.settings.tgBotToken = cleanToken;
  state.settings.tgBotAdminIds = ids.join(',');
  state.settings.tgBotInfo = {
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
export async function tgBotDisconnect(env, state, { persistState } = {}) {
  const token = state.settings.tgBotToken;
  if (token) {
    await tgCall(token, 'deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  }
  state.settings.tgBotToken = '';
  state.settings.tgBotInfo = null;
  if (persistState) {
    try { await persistState(env, state); } catch {}
  }
  return { ok: true };
}

/** Live status probe for the panel UI (getWebhookInfo + getMe). */
export async function tgBotStatus(state) {
  const token = state.settings.tgBotToken;
  if (!token) {
    return { ok: true, configured: false };
  }
  const me = await tgCall(token, 'getMe', {});
  const wh = await tgCall(token, 'getWebhookInfo', {});
  return {
    ok: true,
    configured: true,
    connected: me.ok,
    bot: me.okResult
      ? { botId: me.okResult.id, username: me.okResult.username || '', firstName: me.okResult.first_name || '' }
      : null,
    webhook: wh.okResult || null,
    error: me.ok ? '' : (me.description || 'getMe failed'),
    lastError: state.settings.tgBotInfo?.lastError || '',
  };
}

function recordBotError(state, message, persistState, env) {
  const info = state.settings.tgBotInfo && typeof state.settings.tgBotInfo === 'object'
    ? { ...state.settings.tgBotInfo }
    : {};
  info.lastError = String(message || '').slice(0, 160);
  state.settings.tgBotInfo = info;
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

function buildSubLinks(host, subToken) {
  const base = `https://${host}/sub/${encodeURIComponent(subToken)}`;
  return {
    pressPass: base,
    normalSub: `${base}?format=b64`,
    rawSub: `${base}?format=raw`,
    xraySub: `${base}?format=xray`,
    singboxSub: `${base}?format=singbox`,
    clashSub: `${base}?format=clash`,
    statusUrl: `https://${host}/status/${encodeURIComponent(subToken)}`,
  };
}

function mainMenuKeyboard(host) {
  return {
    inline_keyboard: [
      [
        { text: '👥 مشترکین', callback_data: 'subs:0' },
        { text: '🖥 پنل', url: `https://${host}/panel` },
      ],
    ],
  };
}

function welcomeMessage(state, host, adminName) {
  const users = Array.isArray(state.users) ? state.users : [];
  const active = users.filter((u) => enrichUserView(u).status === 'active').length;
  const botName = state.settings.tgBotInfo?.firstName || 'ARAL';
  return [
    `⚛️ <b>ARAL SULFUR</b> — بات مدیریت پنل`,
    ``,
    `سلام ${escHtml(adminName || 'مدیر')} عزیز! 👑`,
    `به بات رسمی پنل <b>${escHtml(botName)}</b> خوش آمدید.`,
    ``,
    `📍 آدرس پنل: <code>https://${escHtml(host)}/panel</code>`,
    `👥 مشترکین: <b>${users.length}</b> نفر (<b>${active}</b> فعال)`,
    `🔢 نسخهٔ هسته: <b>${escHtml(PANEL_VERSION)}</b>`,
    ``,
    `از منوی زیر گزینهٔ دلخواه را انتخاب کنید 👇`,
  ].join('\n');
}

function subsListPage(state, page, host) {
  const users = (Array.isArray(state.users) ? state.users : []).map((u) => enrichUserView(u));
  users.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const totalPages = Math.max(1, Math.ceil(users.length / USERS_PER_PAGE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = users.slice(safePage * USERS_PER_PAGE, (safePage + 1) * USERS_PER_PAGE);

  const keyboard = [];
  for (const u of slice) {
    keyboard.push([
      {
        text: `${statusIcon(u.status)} ${String(u.name || '').slice(0, 28)}`,
        callback_data: `u:${u.id}:${safePage}`,
      },
    ]);
  }
  const nav = [];
  if (safePage > 0) nav.push({ text: '◀️ قبلی', callback_data: `subs:${safePage - 1}` });
  nav.push({ text: `صفحهٔ ${safePage + 1} از ${totalPages}`, callback_data: 'noop:0' });
  if (safePage < totalPages - 1) nav.push({ text: 'بعدی ▶️', callback_data: `subs:${safePage + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: '⬅️ منوی اصلی', callback_data: 'menu:0' }]);

  const header = [
    `👥 <b>فهرست مشترکین</b> (${users.length} نفر)`,
    users.length ? 'برای دیدن QR و همهٔ لینک‌ها، روی هر مشترک بزنید:' : 'هنوز مشترکی ثبت نشده است؛ از پنل یکی بسازید.',
  ].join('\n');
  return { text: header, keyboard };
}

function userCardCaption(user, host) {
  const links = buildSubLinks(host, user.subToken);
  const limit = user.limitBytes > 0
    ? `${formatBytes(user.usedBytes)} از ${formatBytes(user.limitBytes)} (${Math.min(100, Math.round((user.usedBytes / user.limitBytes) * 100))}%)`
    : `${formatBytes(user.usedBytes)} از ∞`;
  let expiry = 'نامحدود';
  if (user.effectiveExpiresAt > 0) {
    const days = Math.max(0, Math.ceil((user.effectiveExpiresAt - Date.now()) / 86_400_000));
    expiry = `${days} روز باقی‌مانده`;
  } else if (user.startOnFirstUse && user.expiryDays > 0) {
    expiry = `${user.expiryDays} روز از اولین اتصال`;
  }
  const lines = [
    `👤 <b>${escHtml(user.name)}</b> — ${statusTextFa(user.status)}`,
    ``,
    `📊 مصرف: ${escHtml(limit)}`,
    `⏳ اعتبار: ${expiry}`,
    `🧷 توکن اشتراک: <code>${escHtml(user.subToken)}</code>`,
    ``,
    `━━━ 🔗 <b>لینک‌های اشتراک</b> ━━━`,
    ``,
    `📌 اشتراک عادی (Base64):`,
    `<code>${escHtml(links.normalSub)}</code>`,
    ``,
    `🧩 اشتراک Fragment (Xray JSON):`,
    `<code>${escHtml(links.xraySub)}</code>`,
    ``,
    `📦 Sing-box / Hiddify:`,
    `<code>${escHtml(links.singboxSub)}</code>`,
    ``,
    `🪢 Clash / Mihomo:`,
    `<code>${escHtml(links.clashSub)}</code>`,
    ``,
    `🪪 صفحهٔ وضعیت (کارت مشترک):`,
    `<code>${escHtml(links.statusUrl)}</code>`,
  ];
  return lines.join('\n').slice(0, 1024);
}

function userNodesMessage(user, host, settings) {
  const links = buildSubLinks(host, user.subToken);
  const meta = computeQuickUserNodeMeta(user, settings, host);
  const out = [`⚡ <b>نودهای مستقیمِ ${escHtml(user.name)}</b>`, ``];
  if (meta.primaryVless) {
    out.push(`🛰 VLESS:`, `<code>${escHtml(meta.primaryVless)}</code>`, ``);
  }
  if (meta.primaryTrojan) {
    out.push(`🔐 Trojan:`, `<code>${escHtml(meta.primaryTrojan)}</code>`, ``);
  }
  out.push(`🛡 DoH خصوصی:`, `<code>https://${escHtml(host)}/dns-query/${escHtml(user.subToken)}</code>`);
  out.push(``, `💡 برای افزودن، لینک اشتراک را در اپ (V2rayNG / Hiddify / Clash) Import کنید یا QR را اسکن کنید.`);
  const text = out.join('\n');
  return text.length > 4000 ? text.slice(0, 4000) + '\n…' : text;
}

/* ─────────────────────────── Webhook entrypoint ─────────────────────────── */

/**
 * Handle an incoming Telegram webhook call. The caller (worker.js) must ensure
 * the URL path secret matches settings.tgBotHookSecret; Telegram's own secret
 * header is verified here.
 */
export async function handleTgBotUpdate(request, url, env, runtime, { persistState } = {}) {
  const state = runtime;
  const settings = state.settings;
  const host = url.host;
  const pathSecret = url.pathname.split('/').pop() || '';
  const headerSecret = String(request.headers.get('x-telegram-bot-api-secret-token') || '');

  if (!settings.tgBotToken || pathSecret !== settings.tgBotHookSecret || headerSecret !== settings.tgBotHookSecret) {
    return new Response('forbidden', { status: 403 });
  }

  let update = null;
  try {
    update = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  try {
    const admins = parseAdminIds(settings.tgBotAdminIds);
    const token = settings.tgBotToken;

    const cq = update.callback_query;
    if (cq) {
      const chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
      const fromId = cq.from ? String(cq.from.id) : '';
      if (!chatId) return new Response('ok');
      if (!admins.includes(fromId)) {
        await tgCall(token, 'answerCallbackQuery', {
          callback_query_id: cq.id,
          text: '⛔ این بات فقط برای مدیر پنل است.',
          show_alert: true,
        });
        return new Response('ok');
      }

      const data = String(cq.data || '');
      if (data.startsWith('noop:')) {
        await tgCall(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: '✨ ARAL SULFUR' });
        return new Response('ok');
      }
      if (data.startsWith('menu:')) {
        await tgCall(token, 'answerCallbackQuery', { callback_query_id: cq.id });
        await tgCall(token, 'editMessageText', {
          chat_id: chatId,
          message_id: cq.message.message_id,
          text: welcomeMessage(state, host, cq.from.first_name),
          parse_mode: 'HTML',
          reply_markup: mainMenuKeyboard(host),
          disable_web_page_preview: true,
        });
        return new Response('ok');
      }
      if (data.startsWith('subs:')) {
        const page = Math.max(0, Number(data.split(':')[1]) || 0);
        await tgCall(token, 'answerCallbackQuery', { callback_query_id: cq.id });
        const list = subsListPage(state, page, host);
        await tgCall(token, 'editMessageText', {
          chat_id: chatId,
          message_id: cq.message.message_id,
          text: list.text,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: list.keyboard },
          disable_web_page_preview: true,
        });
        return new Response('ok');
      }
      if (data.startsWith('u:')) {
        const [, userId, pageStr] = data.split(':');
        const user = (state.users || []).find((u) => u && u.id === userId);
        if (!user) {
          await tgCall(token, 'answerCallbackQuery', {
            callback_query_id: cq.id,
            text: '⚠️ این مشترک حذف شده است؛ فهرست را رفرش کنید.',
            show_alert: true,
          });
          return new Response('ok');
        }
        await tgCall(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'در حال آماده‌سازی…' });
        const view = enrichUserView(user);
        const page = Math.max(0, Number(pageStr) || 0);
        const backKb = {
          inline_keyboard: [
            [
              { text: '⬅️ بازگشت به مشترکین', callback_data: `subs:${page}` },
              { text: '🪪 صفحهٔ وضعیت', url: `https://${host}/status/${encodeURIComponent(view.subToken)}` },
            ],
          ],
        };

        // 1) The panel QR (normal subscription) as a real photo
        const qrCaption = `📱 <b>QR اشتراک عادی</b> — ${escHtml(view.name)}\n(همان QR پیشخوان پنل؛ با اپ اسکن کنید)`.slice(0, 1024);
        let png = null;
        try {
          png = qrPngBytes(`https://${host}/sub/${encodeURIComponent(view.subToken)}`, { scale: 8, margin: 3 });
        } catch {}
        if (png) {
          const sent = await tgSendPhotoFile(token, chatId, png, qrCaption, backKb);
          if (!sent.ok) {
            await tgCall(token, 'sendMessage', {
              chat_id: chatId,
              text: `⚠️ ارسال QR ناموفق بود (${escHtml(sent.description)}). لینک‌ها را در پیام بعدی ببینید.`,
              parse_mode: 'HTML',
              reply_markup: backKb,
            });
          }
        } else {
          await tgCall(token, 'sendMessage', {
            chat_id: chatId,
            text: `⚠️ ساخت QR برای این مشترک ممکن نشد؛ از لینک‌های زیر استفاده کنید.`,
            parse_mode: 'HTML',
            reply_markup: backKb,
          });
        }

        // 2) All subscription links
        await tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: userCardCaption(view, host),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });

        // 3) Primary VLESS / Trojan URIs + private DoH
        const nodesMsg = userNodesMessage(view, host, settings);
        if (nodesMsg) {
          await tgCall(token, 'sendMessage', {
            chat_id: chatId,
            text: nodesMsg,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          });
        }
        return new Response('ok');
      }
      await tgCall(token, 'answerCallbackQuery', { callback_query_id: cq.id });
      return new Response('ok');
    }

    const msg = update.message;
    if (!msg || !msg.chat) return new Response('ok');
    const chatId = msg.chat.id;
    const fromId = msg.from ? String(msg.from.id) : '';

    if (!admins.includes(fromId)) {
      await tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: [
          '⛔ <b>دسترسی محدود</b>',
          '',
          'این بات مخصوص مدیریتِ پنل ARAL SULFUR است و فقط پاسخ‌گوی ادمینِ ثبت‌شده در پنل است.',
          'اگر شما مدیر این پنل هستید، آیدی عددی خودتان را در پنل (تب شبکه → کارت بات تلگرام) ثبت کنید.',
        ].join('\n'),
        parse_mode: 'HTML',
      });
      return new Response('ok');
    }

    const text = String(msg.text || '').trim();
    if (text.startsWith('/start') || text.startsWith('/menu') || text === 'سلام') {
      await tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: welcomeMessage(state, host, msg.from && msg.from.first_name),
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(host),
        disable_web_page_preview: true,
      });
      return new Response('ok');
    }
    if (text.startsWith('/subs')) {
      const list = subsListPage(state, 0, host);
      await tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: list.text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: list.keyboard },
        disable_web_page_preview: true,
      });
      return new Response('ok');
    }
    if (text.startsWith('/status')) {
      const users = (state.users || []).map((u) => enrichUserView(u));
      const active = users.filter((u) => u.status === 'active').length;
      await tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: [
          `📊 <b>وضعیت سریع پنل</b>`,
          ``,
          `👥 مشترکین: ${users.length} نفر`,
          `✅ فعال: ${active}`,
          `⛔ غیرفعال/محدود: ${users.length - active}`,
          `🏠 هاست: <code>${escHtml(host)}</code>`,
        ].join('\n'),
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(host),
      });
      return new Response('ok');
    }
    // Unknown text → gentle hint
    await tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: 'برای شروع دستور /start را بزنید یا از دکمه‌های منو استفاده کنید.',
      reply_markup: mainMenuKeyboard(host),
    });
    return new Response('ok');
  } catch (err) {
    recordBotError(state, err && err.message ? err.message : 'update handling error', persistState, env);
    return new Response('ok'); // never 500 — Telegram would retry storm
  }
}
