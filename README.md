# ⚗️ Aral Sulfur Panel

<div dir="rtl">

## معرفی

**Aral Sulfur** یک پنل مدیریت پروکسی روی **Cloudflare Workers** است — تک‌فایل، بدون نیاز به بیلد یا ابزار اضافه، با دیزاین‌سیستم اختصاصی Aral و پالت رنگی **گوگردی** در دو حالت **تیره و روشن**.

این نسخه از پایه بازطراحی شده تا **هرگز خطای 1101 کلادفلر** نداشته باشد:

- **بدون `EMBEDED_SETTINGS`**: همه تنظیمات در KV ذخیره می‌شوند؛ ورکر با هر تنظیماتی بالا می‌آید
- **بدون `node:crypto` و بدون `nodejs_compat`**: SHA-224 تروjan به‌صورت خالص، X25519 و JWT با WebCrypto استاندارد
- **صفر وابستگی خارجی در زمان اجرا** (حتی `jose` حذف شد)
- تمام مسیرها با `safeRoute` پوشش داده شده‌اند و صفحه خطا Fault-Tolerant است — هیچ استثنایی به رانتایم نشت نمی‌کند
- اگر KV بسته نباشد، به‌جای خطا یک **صفحه راهنمای اتصال KV** نمایش داده می‌شود

## 🚀 نصب (۲ دقیقه)

1. در داشبورد Cloudflare یک **Worker** جدید بسازید (مثلاً با نام دامنه‌تان)
2. محتوای فایل **`worker-single-file.js`** (در ریشه همین ریپو) را در ادیتور ورکر Paste کنید و Deploy بزنید
   - نیازی به تنظیم Compatibility Flags نیست
3. در تنظیمات ورکر: **Settings → Bindings → Add → KV Namespace**
   - یک KV بسازید (ترجیحاً با نام `aral`)
   - **Variable name را دقیقاً `KV`** بگذارید
4. آدرس ورکر را باز کنید → **ویزارد راه‌اندازی Aral Sulfur** بالا می‌آید
5. ایمیل کلادفلر، یک API Token (با دسترسی `Workers Scripts: Edit`)، رمز پنل، UUID و مسیر امن را وارد کنید → **Activate**

تمام! پنل روی `https://<worker>/<securePath>/panel` در دسترس است.

> اگر KV وصل نباشد، صفحه راهنمای گام‌به‌گام اتصال KV نمایش داده می‌شود (نه خطای 1101).

## 🔄 آپدیت خودکار

داخل پنل: **Settings → Check for Updates**

- آخرین نسخه از `package.json` ریپو رسمی خوانده می‌شود
- اگر نسخه جدیدی باشد، دکمه **Update** فعال می‌شود
- با یک کلیک: فایل `worker-single-file.js` از ریشه ریپو دانلود و روی ورکر شما **با حفظ کامل KV bindings و secrets و compatibility flags** مجدداً آپلود می‌شود
- تنظیمات شما در KV هستند، پس بعد از آپدیت همه‌چیز سر جایش است

## 🛡️ چرا دیگر خطای 1101 نمی‌بینید؟

| مشکل رایج BPB | راه‌حل Aral Sulfur |
|---|---|
| `EMBEDED_SETTINGS` تعریف‌نشده → ReferenceError در بوت | حذف کامل؛ تنظیمات lazy از KV خوانده می‌شوند |
| `node:crypto` بدون فلگ `nodejs_compat` → خطای import | صفر import از `node:`؛ WebCrypto خالص |
| KV با نام اشتباه bind شده → خطا در اولین get | `findKV` با نام‌های `aral`/`KV`/`kv` + صفحه راهنما |
| خطای داخل هندلر خطا → 1101 | صفحه خطای دو لایه با fallback استاتیک |
| استثناهای async داخل روتر | همه مسیرها با `safeRoute` await و مهار می‌شوند |

## ✨ امکانات (همه حفظ شده‌اند)

- **VLESS + Trojan** روی Workers با پورت‌های دلخواه، Fragment، ECH، Chain Proxy
- **Warp / Warp Pro** (MahsaNG Knocker، Amnezia، v2ray UDP Noise) با تمدید خودکار
- سابسکریپشن برای v2rayN، MahsaNG، Streisand، sing-box، husi، Clash Meta، Stash، Wireguard، Amnezia
- **ربات تلگرام** با منوی کامل و QR
- قوانین روتینگ کامل (Iran/China/Russia، تحریم‌ها، قوانین سفارشی)
- DoH اختصاصی، صفحه Proxy IP با تست سلامت، My IP با پرچم
- Import/Export تنظیمات، Custom Domain، Fallback Domain
- تم گوگردی دارک/لایت با سوییچ (ذخیره در مرورگر)، افکت‌های Glitch/Scanline/Radar/Glass
- واترمارک‌های Aral در همه صفحات: t.me/AralDev · t.me/AralPanel · youtube.com/@Aral-Dev · github.com/Aral-Dev/Aral-Sulfur

## 📁 ساختار ریپو

```
aral-sulfur/
├── worker-single-file.js   ← فایل استقرار (دقیقاً در ریشه، همین را Paste کنید)
├── dist/worker.js          ← همان فایل (برای سازگاری)
├── scripts/build.js        ← بیلد (esbuild + terser + gzip)
├── src/
│   ├── worker.ts           ← روتر با لایه‌های ضد 1101
│   ├── handlers/setup.ts   ← ویزارد راه‌اندازی + صفحه راهنمای KV
│   ├── settings/           ← معماری KV-based (settings, main, kv, validators)
│   ├── auth/auth.ts        ← JWT دست‌ساز HS256 (WebCrypto)
│   ├── common/sha.ts       ← SHA-224 خالص + X25519
│   ├── cores/              ← تولید کانفیگ xray / sing-box / clash / wireguard
│   ├── api/                ← تماس با Cloudflare API (آپدیت خودکار)
│   └── assets/             ← UI گوگردی (panel, login, setup, proxy-ip, error)
└── package.json
```

## 🛠️ بیلد از سورس

```bash
npm install
npm run check     # tsc --noEmit (0 خطا)
npm run build     # → worker-single-file.js در ریشه
```

## 📞 ارتباط با ما

- 📢 کانال اصلی: [t.me/AralDev](https://t.me/AralDev)
- 🖥️ کانال پنل‌ها: [t.me/AralPanel](https://t.me/AralPanel)
- ▶️ یوتیوب: [youtube.com/@Aral-Dev](https://youtube.com/@Aral-Dev)
- 💻 گیت‌هاب: [github.com/Aral-Dev/Aral-Sulfur](https://github.com/Aral-Dev/Aral-Sulfur)

</div>

---

<div align="center">

**⚗️ ARAL SULFUR — Single-File Cloudflare Worker · No 1101 · Powered by KV**

</div>
