# ⚗️ Aral Sulfur — نسخه کاملاً بازسازی‌شده (از صفر)

<div dir="rtl">

## چرا این نسخه فرق دارد

پنل‌های قبلی (و کد قبلی من روی سورس قدیمی‌ات) هنوز روی الگوی «global state + KV در مسیر تونل» بودند. BPB در پروژه جدیدش (`BPB-VPN`، نوامبر ۲۰۲۶) کل ورکر را از نو نوشت و ریشه 1101 را برداشت. این نسخه **از صفر و فقط با دو منبع** نوشته شد: ورکر جدید BPB و سه پنل قبلی خودت (aral-ultra / Aral-panel / Aral-Uranium).

## معماری جدید (چرا دیگر 1101 غیرممکن است)

| قانون | از کجا |
|---|---|
| مسیر تونل تنظیمات را **sync از ENV binding** می‌خواند (base64 JSON) — نه KV، نه global، نه async | BPB-VPN worker |
| تنظیمات در کل زنجیره تونل **parameter** است — ۳۰ تونل همزمان روی ۳۰ مقصد، صفر تداخل | BPB-VPN worker |
| تونل **فقط TCP** (command ≠ 1 رد می‌شود) — DNS به‌صورت DoH از داخل خود تونل | BPB-VPN worker |
| هر promise بدون await یک `.catch` دارد: `pipeTo`، `socket.closed`، `retry` | BPB-VPN worker |
| echo هدر `Sec-WebSocket-Protocol` در پاسخ 101 (بدون آن Xray قطع می‌کند) | BPB-VPN worker |
| یک `try/catch` بیرونی کل fetch — خطا = 500 تمیز، هرگز کرش runtime | aral-ultra |
| KV تک‌blob (`aralState`) + JWT (HS256، WebCrypto) + SHA-224 خالص JS برای Trojan | سه پنل قبلی |
| self-update: bindings فعلی خوانده و حفظ می‌شوند + ENV تازه تزریق می‌شود | BPB deploy الگو + Aral |

پنل بعد از setup و بعد از هر تغییر تنظیمات، تنظیمات تونل را در **secret به نام `ENV`** ورکر می‌گذارد (Workers Secrets API — بدون re-deploy). اگر حتی موفق نشود، KV همچنان مسیر fallback تونل است.

## امکانات

- ویزارد نصب فارسی (validation توکن کلادفلر قبل از ذخیره)
- لاگین JWT + secure path مخفی + لاگ‌اوت
- داشبورد: وضعیت، آپدیت‌چک، لینک اشتراک با تب‌های **links / Clash / Xray / sing-box**
- تنظیمات تونل: UUID، رمز Trojan، حالت proxyip / NAT64 prefix، fallback، DoH
- self-update از گیت‌هاب با حفظ KV و compatibility date
- تم سولفور زرد RTL + چهار لینک Aral (Dev / Channel / YouTube / GitHub)

## نصب

1. Worker جدید → کل `worker-single-file.js` را Paste و Deploy (بدون هیچ Flag)
2. KV بسازید (نام `aral`) → در Bindings ورکر با **Variable name: `KV`** متصل کنید
3. آدرس ورکر را باز کنید → ویزارد → Activate

## تست‌ها (سه سوئیت، همه سبز)

- **e2e کامل: 42/42** — حالت ENV-only بدون KV، ENV خراب، UUID غلط، رد UDP، setup→login→settings→ENV re-sync→ساب در ۴ فرمت→self-update با حفظ bindings، مسیرهای خرابکارانه، قطعی KV وسط کار، تونل حین قطعی KV
- **حمله به مسیر retry: 6/6** — DoH همیشه خراب + اتصال همیشه رد → صفر unhandledRejection (در پنل‌های قبلی همین سناریو مستقیم 1101 می‌شد)
- **تست race: 30/30 + 30/30** — ۳۰ تونل همزمان روی ۳۰ مقصد مختلف، هرکدام فقط pong خودش را گرفت (صفر نشتی بین تونل‌ها) + طوفان retry با DNS قطع
- شمارنده `unhandledRejection`/`uncaughtException` در هر سه سوئیت: **صفر** (این دقیقاً همان چیزی است که کلادفلر به‌عنوان 1101 گزارش می‌کند)

## فایل‌ها

- `worker-single-file.js` — کل پنل در یک فایل، آماده Paste

## پشتیبانی

t.me/AralDev · t.me/AralPanel · youtube.com/@Aral-Dev · github.com/Aral-Dev/Aral-Sulfur

</div>
