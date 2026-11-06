# ⚗️ Aral Sulfur Panel

<div dir="rtl">

## معرفی

**Aral Sulfur** یک پنل مدیریت پیشرفته پروکسی روی **Cloudflare Workers** است — بازطراحی کامل و حرفه‌ای با دیزاین‌سیستم اختصاصی Aral و پالت رنگی **گوگردی** در دو حالت **تیره (Dark)** و **روشن (Light)**.

این پنل بدون نیاز به سرور خارجی اجرا می‌شود و تمام امکانات آن روی زیرساخت Cloudflare قرار دارد: VLESS، Trojan، Warp، Warp Pro، Fragment، Routing Rules و ده‌ها قابلیت دیگر.

## ✨ ویژگی‌های این نسخه

### 🎨 تم و ظاهر کاملاً جدید (Aral Design System)
- پالت رنگی **گوگردی** (Sulfur Yellow) با رنگ اصلی `#f5d90a` در حالت تیره و `#d9b900` در حالت روشن
- افکت‌های ویژه برگرفته از زبان بصری Aral:
  - پس‌زمینه **Checkerboard** متحرک
  - **Grid** گوگردی با ماسک شعاعی
  - خطوط **Scanline** روی کل صفحه
  - پرتو **Radar Beam** چرخان
  - افکت **Glitch** روی تیترها (لایه‌های زرد/سبز نئونی)
- کارت‌های شیشه‌ای (**Glassmorphism**) با گوشه‌های بریده (`clip-path`) به سبک Aral
- سوییچ **دارک/لایت** در هدر پنل — انتخاب کاربر در `localStorage` ذخیره می‌شود و در همه صفحات (پنل، ورود، Proxy IP) اعمال می‌شود
- فونت‌ها: `Orbitron` (تیترها)، `JetBrains Mono` (کدها و مقادیر)، `Vazirmatn` (متن)
- فاویکون جدید: بلور الماسی گوگردی زرد

### 🔄 آپدیت خودکار از ریپو
- دکمه جدید **Check for Updates** در بخش Settings پنل
- استعلام آخرین نسخه از `https://github.com/Aral-Dev/Aral-Sulfur` (فایل `package.json` ریپو)
- اگر نسخه جدیدی موجود باشد، دکمه **Update** فعال می‌شود و با یک کلیک، پنل به‌صورت خودکار از آخرین ریلیز ریپو بازسازی و مجدداً دیپلوی می‌شود
- همه تنظیمات فعلی شما (UUID، رمزها، مسیر امن و...) بعد از آپدیت حفظ می‌شوند

### 🛡️ مقاوم‌سازی در برابر خطای 1101 کلادفلر
- صفحه خطا به‌صورت **کاملاً Fault-Tolerant** بازنویسی شده: اگر حتی خود رندر صفحه خطا همfail شود، یک صفحه خطای استاتیک جایگزین برمی‌گردد
- تمام مسیرهای روتر با لایه `safeRoute` پوشش داده شده‌اند تا هیچ Promise رد شده‌ای به رانتایم Cloudflare نشت نکند
- پیام خطا قبل از نمایش Escape می‌شود (ضد XSS)
- نتیجه: به جای صفحه سفید **Error 1101: Worker threw exception**، همیشه یک صفحه خطای برنددار و خوانا خواهید دید

### 🏷️ برندینگ Aral
- تمام واترمارک‌های BPB حذف و برند **Aral Sulfur** جایگزین شد:
  - نام کانفیگ‌های سابسکریپشن: `⚗️ Aral Sulfur Normal` و...
  - نام فایل‌های دانلودی: `aral-normal-xray.json`، `aral-Warp-1.conf` و...
  - پیام‌های ربات تلگرام: `⚗️ Aral Sulfur Panel Bot`
  - هدر `Profile-Title` در ساب‌ها
- واترمارک‌های جدید در فوتر همه صفحات:

| کانال | لینک |
|---|---|
| کانال اصلی | t.me/AralDev |
| کانل پنل‌ها | t.me/AralPanel |
| YouTube | youtube.com/@Aral-Dev |
| GitHub | github.com/Aral-Dev/Aral-Sulfur |

## 🚀 نصب

### روش Cloudflare Pages (پیشنهادی)

1. وارد حساب Cloudflare خود شوید
2. به بخش **Workers & Pages → Create → Pages → Upload assets** بروید
3. یک پروژه با نام دامنه اصلی خودتان بسازید (مثلاً برای `mydomain.com` نام `mydomain` )
4. فایل `_worker.js` (از پوشه `dist`) را همراه یک فایل `index.html` خالی آپلود کنید
5. یک **KV Namespace** بسازید و با نام `kv` به پروژه متصل کنید (Settings → Bindings)
6. پس از دیپلوی، پنل روی `https://<project>.pages.dev/panel` در دسترس است — اولین ورود، صفحه تنظیم رمز عبور نمایش داده می‌شود

> نکته: در اولین اجرا باید از طریق ابزار استقرار (Wizard یا اسکریپت) مقادیر `EMBEDED_SETTINGS` شامل `accID`، `accEmail`، `apiToken`، `vlUUID`، `trPass`، `securePath` و `mainDomain` تنظیم شوند. برای این کار می‌توانید از ابزار [Aral CF Deployer](https://t.me/AralPanel) استفاده کنید.

### روش Worker (با Wrangler)

```bash
wrangler deploy dist/worker.js --name mydomain \
  --compatibility-date 2025-01-01 \
  --compatibility-flag nodejs_compat \
  --kv-binding=kv:YOUR_KV_NAMESPACE_ID
```

## 🔄 آپدیت پنل

داخل پنل: **Settings → Check for Updates → Update**

پنل به‌صورت خودکار:
1. آخرین نسخه را از ریپو رسمی استعلام می‌کند
2. سورس جدید را دریافت می‌کند
3. تنظیمات فعلی شما را داخل آن جای‌گذاری می‌کند
4. نسخه جدید را روی حساب Cloudflare شما مجدداً دیپلوی می‌کند

## 📁 ساختار پروژه

```
aral-sulfur/
├── dist/
│   └── worker.js        ← فایل نهایی برای دیپلوی (خروجی بیلد)
├── scripts/
│   └── build.js         ← اسکریپت بیلد (esbuild + terser + gzip)
├── src/
│   ├── worker.ts        ← نقطه ورود (با لایه‌های ضد 1101)
│   ├── assets/
│   │   ├── panel/       ← پنل اصلی (HTML/CSS/JS تم گوگردی)
│   │   ├── login/       ← صفحه ورود
│   │   ├── proxy-ip/    ← صفحه تست Proxy IP
│   │   ├── error/       ← صفحه خطا (Fault-Tolerant)
│   │   └── favicon.ico  ← فاویکون بلور گوگرد
│   ├── cores/           ← هسته تولید کانفیگ (xray / sing-box / clash / wireguard)
│   ├── handlers/        ← روتر و هندلرها
│   ├── api/             ← تماس با API کلادفلر
│   ├── settings/        ← مدیریت تنظیمات
│   ├── protocols/       ← پیاده‌سازی VLESS و Trojan
│   └── auth/            ← احراز هویت JWT
└── package.json
```

## 🛠️ بیلد از سورس

```bash
npm install
npm run build     # خروجی: dist/worker.js
npm run check     # بررسی تایپ‌اسکریپت
```

## 📊 امکانات پنل (همه حفظ شده‌اند)

- **VLESS & Trojan** روی Workers با پورت‌های TLS و non-TLS دلخواه
- **Warp** و **Warp Pro** (شامل MahsaNG Knocker، Amnezia و v2ray UDP Noise)
- **Xray Fragment** با پروفایل‌های Low/Medium/High/Severe
- **قوانین روتینگ** کامل: Bypass/Block داخلی، قوانین تحریم (ChatGPT، Google AI، Microsooft و...)، قوانین سفارشی
- **DNS**: Local، Remote، Anti-Sanction، Fake DNS و DoH اختصاصی
- سابسکریپشن برای **v2rayN، MahsaNG، Streisand، sing-box، husi، Clash Meta، Stash، Wireguard، Amnezia** و...
- **ربات تلگرام** با منوی کامل دریافت کانفیگ و QR
- **Import/Export** تنظیمات (فایل و ریموت) + اشتراک‌گذاری
- نمایش **My IP** (هم Cloudflare هم Other targets) با پرچم کشورها
- جدول **Proxy IP** با تست سلامت و پینگ
- بازسازی حساب‌های Warp و تمدید خودکار
- Custom Domain و Fallback Domain

## ⚠️ نکات مهم

- تمام پروتکل‌ها بدون تغییر منطقی حفظ شده‌اند — فقط ظاهر و برند تغییر کرده است
- پس از آپدیت، سابسکریپشن‌های کلاینت‌ها باید یک بار Refresh شوند
- اگر از نسخه‌های قدیمی BPB مهاجرت می‌کنید، تنظیمات از طریق فایل `.dat` قابل Import هستند

## 📞 ارتباط با ما

- 📢 کانال اصلی: [t.me/AralDev](https://t.me/AralDev)
- 🖥️ کانال پنل‌ها: [t.me/AralPanel](https://t.me/AralPanel)
- ▶️ یوتیوب: [youtube.com/@Aral-Dev](https://youtube.com/@Aral-Dev)
- 💻 گیت‌هاب: [github.com/Aral-Dev/Aral-Sulfur](https://github.com/Aral-Dev/Aral-Sulfur)

</div>

---

<div align="center">

**⚗️ ARAL SULFUR — Powered by Cloudflare Workers**

</div>
