<div align="center">

# ARAL SULFUR · V1.0 — CALM GLASS EDITION

**نسل ساده و آرامِ پنل آزاد و رایگانِ مدیریت اشتراک VLESS، Trojan و Shadowsocks و پروکسی رسمی تلگرام روی شبکهٔ ابری کلادفلر — با همان هستهٔ اثبات‌شده، در بدنه‌ای شیشه‌ای و دوستانه**
*The simple & calm generation of the free serverless VLESS, Trojan & Shadowsocks panel on Cloudflare Workers & Pages — same battle-tested core, wrapped in soft honey glass*

![Version](https://img.shields.io/badge/Version-1.0.0_SULFUR-d9a03a?style=flat-square) ![Runtime](https://img.shields.io/badge/Cloudflare-Workers%20%26%20Pages-1D2117?style=flat-square) ![Theme](https://img.shields.io/badge/Theme-Sulfur%20Calm%20Glass-E5EB70?style=flat-square)

[کانال رسمی / Official Channel — Telegram](https://t.me/AralDev)

</div>

---

> ### اطلاعیه (رایگان و غیرقابل فروش)
> **ARAL SULFUR** نرم‌افزار آزاد و رایگان است؛ خرید و فروش سورس، پنل یا لینک اشتراکِ ساخته‌شده با آن مجاز نیست.
> **ARAL SULFUR is free software — strictly not for sale.**

---

## سولفور چیست؟ / What is Sulfur?

**ARAL SULFUR** همان موتور قدرتمند و پایدار نسل‌های قبلی ARAL است — بدون هیچ تغییری در سیستم کانفیگ، KV، پروتکل‌ها و پیش‌نیازهای کلادفلر — اما با یک رابط کاربری کاملاً جدید که برای **کاربران مبتدی** طراحی شده: هرگز بیش از ۴ منو، برچسب‌های سادهٔ فارسی و حس آرامش.

*Same engine, same KV keys, same Cloudflare prerequisites — a brand-new beginner-friendly face. If a 12-year-old can read Persian, they can run this panel.*

### چیدمان منو / Menu Layout

| منو | چه چیزی داخلش است |
| --- | --- |
| **خانه** | نمودار زندهٔ سرعت و پینگ + نمودار مصرف مشترکین، ساعت دیجیتالی، وضعیت لحظه‌ای و لینک‌های اشتراک کاربر مدیر و پیش‌فرض (کپی + QR + صفحهٔ وضعیت) |
| **مشترکین** | ساخت/ویرایش/توقف/ریست/حذف مشترک با فرم ساده: نام، حجم، اعتبار، پروتکل‌ها و **آی‌پی ثابت یا چرخشی** به انتخاب شما + عملیات گروهی |
| **اتصال و شبکه** | انتخاب پروتکل (VLESS / Trojan / Shadowsocks)، پورت‌های TLS و غیر TLS، آی‌پی تمیز، دامنه‌ها، پروکسی خروجی و تنظیمات پیشرفتهٔ اتصال |
| **تنظیمات** | تم روشن/تیره، زبان، تغییر رمز، قطع اضطراری، پشتیبان‌گیری JSON و **بروزرسانی پنل از همین ریپو** |

## رنگ و حس / Palette & Feel

| نقش | رنگ |
| --- | --- |
| عسلی / Honey | `#99660F` |
| لیمویی / Lime | `#E5EB70` |
| مرجانی / Coral | `#F79082` |
| مرکبی / Ink | `#1D2117` |
| عاجی / Ivory | `#EFEBE6` |
| جنگلی / Forest | `#395738` |

کارت‌های شیشه‌ای مات (Glassmorphism)، گوشه‌های نرم، انیمیشن‌های آرام و بدون هیچ جلوهٔ آزاردهنده — پنلی که حس آرامش می‌دهد.

## هستهٔ ثابت / Untouched Core

- **VLESS + Trojan + Shadowsocks روی WebSocket** — سه پروتکل همزمان
- **Fragment + Pattern JSON + Cipher Suites + TLS Mask + ECH** ضد DPI
- **ProxyIP · NAT64 · زنجیرهٔ SOCKS5/HTTP/SOCKS4**
- **لوکیشن‌های خروجی چندگانه (تا ۱۵)** و تعویض خودکار پروکسی خراب
- **چرخش خودکار IP تمیز** برای هر مشترک + **IP ثابت دلخواه**
- سهمیهٔ اتصال، حد دستگاه همزمان، ریست خودکار حجم و شروع اعتبار از اولین اتصال
- مسدودسازی بزرگسال/تبلیغات، بات تلگرام، پروکسی رسمی تلگرام، DoH خصوصی
- اشتراک چندقالبی (Base64، Xray، Sing-box، Clash) + صفحهٔ کارت مشترک با صحنهٔ قلهٔ آرال
- **PWA**، تایپوگرافی Vazirmatn + JetBrains Mono، دوزبانه (فارسی/انگلیسی)
- امنیت PBKDF2-HMAC + بازیابی رمز با توکن کلادفلر

## استقرار سریع — Workers / Quick Deploy

1. در کلادفلر یک **KV namespace** با نام `aral` بساز (همان پیش‌نیاز قبلی).
2. یک Worker جدید بساز (Hello World) و کل محتوای `worker-single-file.js` را در **Edit code** جای‌گذاری و **Deploy** کن.
3. از **Settings → Bindings → KV namespace** متغیر `KV` را به فضای `aral` وصل کن.
4. صفحهٔ پنل را باز کن — فرم انتخاب رمز مدیر ظاهر می‌شود.

> بروزرسانی از داخل پنل: تنظیمات → بروزرسانی پنل → بررسی نسخهٔ جدید. آپدیت‌ها از ریپوی رسمی `Aral-Dev/Aral-Sulfur` (فایل `worker-single-file.js` در Release یا شاخهٔ main) دریافت و با حفظ کامل مشترکین و تنظیمات KV نصب می‌شوند.

## استقرار — Pages / Deploy (Pages)

پوشهٔ `dist/` (شامل `index.html` و `_worker.js`) یا بستهٔ آمادهٔ `aral-sulfur-pages.zip` را در **Workers & Pages → Create → Pages → Upload assets** آپلود کن.

## توسعهٔ محلی / Local Development

```bash
npm install          # نصب وابستگی‌ها / install dependencies
npm run build        # ساخت worker-single-file.js + panel-preview.html + dist/
npm run dev          # اجرای محلی با wrangler
npm test             # تست E2E (17/17)
node shot-verify.mjs # اسکرین‌شات بصری همهٔ نماها / visual screenshots
```

## مخازن داده / Data Pools

پوشهٔ `data/` همان قبل است — فهرست‌های عمومی IP تمیز و پروکسی‌های خروجی. بارگذاری خودکار از ریپوی رسمی روی اولین اجرا انجام می‌شود.

## اسکریپت‌های جانبی / Side Scripts

- `aral-relay.sh` — نصب‌کنندهٔ ریلی SOCKS5 برای سرور شخصی
- `aral-scanner.txt` — اسکنر چندگانه برای یافتن IP تمیز

## بروزرسانی هسته / Core Self-Updater

پنل به‌صورت پیش‌فرض نسخهٔ جدید را از مخزن رسمی `Aral-Dev/Aral-Sulfur` بررسی و نصب می‌کند. تمام ثابت‌ها در `src/storage.js` (`GITHUB_REPO`) و `src/ui/app.js` (`OFFICIAL_GITHUB_REPO`) قرار دارند.

## ساختار مخزن / Repository Layout

```
├─ build.mjs               # پایپ‌لاین ساخت (فونت‌سابی، فشرده‌سازی، استلث، ممیزی امضا)
├─ worker-single-file.js   # خروجی نهایی برای Workers
├─ aral-sulfur-pages.zip   # بستهٔ آمادهٔ Pages
├─ wrangler.toml / config.json
├─ aral-relay.sh           # نصب‌کنندهٔ ریلی SOCKS5
├─ aral-scanner.txt        # اسکنر چندگانهٔ SNI
├─ data/                   # مخازن داده (IP تمیز، دامنه، پروکسی‌های عمومی، ECH)
├─ src/
│  ├─ worker.js            # ورودی Worker (API + مسیریابی + PWA)
│  ├─ sub.js               # مولد اشتراک و کارت مشترک
│  ├─ protocols.js         # موتور تونل VLESS/Trojan/ss + سهمیه‌ها + DoH
│  ├─ sslib.js             # موتور Shadowsocks AEAD + اسنیفر و مسدودساز
│  ├─ pools.js / poolutil.js # لایهٔ مخازن داده
│  ├─ tgproxy.js           # پروکسی رسمی تلگرام
│  ├─ tgbot.js             # بات مدیریتی تلگرام
│  ├─ storage.js           # لایهٔ KV و ثابت‌های برند
│  ├─ crypto.js            # توابع رمزنگاری
│  └─ ui/                  # رابط کاربری سولفور (HTML/CSS/JS + فونت‌ها + صحنهٔ قله)
└─ assets/                 # فونت‌های ساب‌ست‌شده (کش ساخت)
```

---

<div align="center">

**ARAL SULFUR** — شیشهٔ آرامِ اشتراک روی کلادفلر · `t.me/AralDev`

*Made with calm & coffee — 100% free, forever.*

</div>
