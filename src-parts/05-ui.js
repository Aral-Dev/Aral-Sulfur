
/* ============================================================
 * UI — Sulfur yellow design system (Aral visual language)
 * ============================================================ */

const SULFUR_CSS = `
:root{
  --bg:#0a0a08; --gold:#f5c518; --gold-soft:rgba(245,197,24,.14);
  --neon:#7cff5e; --neon-soft:rgba(124,255,94,.07);
  --err:#ff5545; --ok:#43d17c;
  --txt:#ece8dd; --body-txt:#cfc9ba; --mut:#948d7c; --dim:#5c564a;
  --panel:#141209; --field:#0e0d07; --glass:rgba(20,18,9,.66);
  --line:rgba(245,197,24,.16); --line-soft:rgba(245,197,24,.08);
  --mono:'JetBrains Mono',monospace; --sans:'Vazirmatn',system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--body-txt);font-family:var(--sans);min-height:100vh}
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
  background:radial-gradient(600px 400px at 85% -5%,var(--gold-soft),transparent 65%),
             radial-gradient(500px 350px at 10% 105%,var(--neon-soft),transparent 60%)}
.wrap{position:relative;z-index:1;max-width:520px;margin:0 auto;padding:28px 20px 48px}
.logo{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:6px}
.logo .gem{width:34px;height:34px;flex:none}
.logo h1{font-family:var(--mono);font-size:1.35rem;font-weight:800;letter-spacing:.14em;color:var(--txt)}
.logo h1 b{color:var(--gold)}
.tag{text-align:center;font-size:.78rem;color:var(--mut);margin-bottom:26px}
.card{background:var(--glass);border:1px solid var(--line);border-radius:14px;padding:22px 20px;backdrop-filter:blur(14px)}
.card + .card{margin-top:16px}
.card h2{font-size:.95rem;color:var(--txt);margin-bottom:14px;display:flex;align-items:center;gap:8px}
.card h2::before{content:'';width:8px;height:8px;background:var(--gold);transform:rotate(45deg);flex:none}
label{display:block;font-size:.78rem;color:var(--mut);margin:12px 0 6px}
input,select{width:100%;background:var(--field);border:1px solid var(--line-soft);border-radius:9px;
  color:var(--txt);font-family:var(--sans);font-size:.92rem;padding:11px 13px;outline:none;transition:.2s}
input:focus,select:focus{border-color:var(--gold);box-shadow:0 0 0 3px var(--gold-soft)}
input::placeholder{color:var(--dim)}
.row{display:flex;gap:10px}
.row > *{flex:1}
.btn{width:100%;margin-top:18px;background:var(--gold);color:#1a1605;border:none;border-radius:10px;
  font-family:var(--sans);font-weight:800;font-size:.95rem;padding:13px;cursor:pointer;transition:.2s}
.btn:hover{filter:brightness(1.1);box-shadow:0 6px 24px var(--gold-soft)}
.btn.ghost{background:transparent;color:var(--gold);border:1px solid var(--line)}
.btn.small{width:auto;margin-top:0;padding:11px 16px;font-size:.82rem}
.msg{border-radius:9px;padding:11px 13px;font-size:.82rem;margin-top:14px;display:none}
.msg.show{display:block}
.msg.ok{background:rgba(67,209,124,.1);color:var(--ok);border:1px solid rgba(67,209,124,.25)}
.msg.err{background:rgba(255,85,69,.1);color:var(--err);border:1px solid rgba(255,85,69,.25)}
.links{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:22px}
.links a{display:flex;flex-direction:column;align-items:center;gap:6px;padding:11px 4px;border-radius:10px;
  background:var(--field);border:1px solid var(--line-soft);color:var(--mut);font-size:.66rem;text-decoration:none;transition:.2s}
.links a:hover{color:var(--gold);border-color:var(--line)}
.links svg{width:20px;height:20px}
.foot{text-align:center;font-size:.7rem;color:var(--dim);margin-top:26px;font-family:var(--mono)}
.badge{display:inline-block;font-family:var(--mono);font-size:.68rem;color:var(--gold);
  border:1px solid var(--line);border-radius:6px;padding:3px 8px;margin-right:auto}
.subbox{background:var(--field);border:1px solid var(--line-soft);border-radius:9px;padding:12px;
  font-family:var(--mono);font-size:.72rem;color:var(--body-txt);word-break:break-all;direction:ltr;text-align:left}
.kv{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px dashed var(--line-soft);font-size:.82rem}
.kv:last-child{border-bottom:none}
.kv .k{color:var(--mut)} .kv .v{font-family:var(--mono);color:var(--txt);font-size:.76rem}
.copy{cursor:pointer;color:var(--gold)}
.tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.tabs button{flex:1;background:var(--field);border:1px solid var(--line-soft);color:var(--mut);
  border-radius:8px;padding:8px 6px;font-size:.72rem;font-family:var(--sans);cursor:pointer}
.tabs button.on{color:var(--gold);border-color:var(--line);background:var(--gold-soft)}
`;

const ARAL_ICON_SVG = `<svg viewBox="0 0 32 32" fill="none"><rect x="9" y="9" width="14" height="14" transform="rotate(45 16 16)" fill="#f5c518"/><rect x="13.5" y="13.5" width="5" height="5" transform="rotate(45 16 16)" fill="#0a0a08"/></svg>`;

const LINKS_HTML = `
<div class="links">
  <a href="https://t.me/AralDev" target="_blank" rel="noopener">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.9 4.6 19 19.3c-.2 1-.8 1.2-1.6.8l-4.5-3.3-2.2 2.1c-.24.24-.44.44-.9.44l.33-4.6L18.7 7.4c.37-.33-.08-.51-.57-.19L7.24 13.3l-4.4-1.4c-.96-.3-.98-.96.2-1.42L20.4 3.2c.8-.29 1.5.19 1.24 1.4Z"/></svg>
    <span>Developer</span></a>
  <a href="https://t.me/AralPanel" target="_blank" rel="noopener">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.9 6.9-1.7 8.1c-.13.57-.47.71-.95.44l-2.6-1.9-1.3 1.2c-.14.14-.26.26-.53.26l.2-2.7 4.9-4.4c.2-.2-.05-.3-.33-.1l-6 3.8-2.6-.8c-.6-.2-.6-.6.12-.9l10-3.9c.5-.2.94.1.78.9Z"/></svg>
    <span>Channel</span></a>
  <a href="https://youtube.com/@Aral-Dev" target="_blank" rel="noopener">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.5 12 4.5 12 4.5s-7 0-8.9.6A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12 31 31 0 0 0 1 16.8a3 3 0 0 0 2.1 2.1c1.9.6 8.9.6 8.9.6s7 0 8.9-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 23.5 12 31 31 0 0 0 23 7.2ZM9.8 15.3V8.7l5.8 3.3-5.8 3.3Z"/></svg>
    <span>YouTube</span></a>
  <a href="https://github.com/Aral-Dev/Aral-Sulfur" target="_blank" rel="noopener">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.2-.4-1.2.1-2.6 0 0 .8-.3 2.8 1a9.4 9.4 0 0 1 5 0c2-1.3 2.7-1 2.7-1 .6 1.4.2 2.4.1 2.6.7.7 1 1.6 1 2.7 0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2Z"/></svg>
    <span>GitHub</span></a>
</div>`;

function pageShell(title, bodyHtml) {
    return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Aral Sulfur</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='9' y='9' width='14' height='14' transform='rotate(45 16 16)' fill='%23f5c518'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Vazirmatn:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>${SULFUR_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="logo">${ARAL_ICON_SVG}<h1>ARAL <b>SULFUR</b></h1></div>
  <div class="tag">⚗️ پنل شخصی‌سازی‌شده VLESS + Trojan روی Cloudflare Workers</div>
  ${bodyHtml}
  ${LINKS_HTML}
  <div class="foot">ARAL SULFUR · v${'${PANEL_VERSION}'} · Aral-Dev</div>
</div>
</body>
</html>`;
}

function renderKVGuide() {
    return new Response(pageShell('راهنمای نصب', `
<div class="card">
  <h2>ذخیره‌سازی متصل نیست</h2>
  <p style="font-size:.84rem;line-height:2">
    برای کار پنل باید یک فضای KV به این ورکر متصل شود:<br>
    ۱) در داشبورد Cloudflare وارد بخش <b>KV → Create namespace</b> شوید و یک namespace با نام
    <b>aral</b> بسازید.<br>
    ۲) در تنظیمات همین ورکر (Settings → Bindings → Add) آن را با
    <b>Variable name کوتاه: <span style="color:var(--gold);font-family:var(--mono)">KV</span></b> متصل کنید.<br>
    ۳) صفحه را دوباره باز کنید — ویزارد نصب خودکار ظاهر می‌شود.
  </p>
</div>
<div class="card">
  <h2>چرا این پنل 1101 نمی‌گیرد؟</h2>
  <p style="font-size:.84rem;line-height:2">
    مسیر تونل تنظیمات را به‌صورت <b>همزمان (sync)</b> از ENV می‌خواند، تونل فقط TCP است،
    و تک‌تک promiseهای بدون await یک catch دارند. حتی اگر KV لحظه‌ای قطع شود، تونل‌ها از ENV
    ادامه می‌دهند.
  </p>
</div>`).replaceAll('${PANEL_VERSION}', PANEL_VERSION), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

function renderSetupPage() {
    return new Response(pageShell('نصب', `
<div class="card">
  <h2>فعال‌سازی پنل</h2>
  <label>ایمیل حساب Cloudflare</label>
  <input id="accEmail" type="email" placeholder="you@example.com" dir="ltr">
  <label>API Token (دسترسی Workers / Zone)</label>
  <input id="apiToken" type="text" placeholder="v1.0 - ..." dir="ltr">
  <label>رمز ورود پنل (حداقل ۶ کاراکتر)</label>
  <input id="panelPass" type="password" placeholder="••••••" dir="ltr">
  <div class="row">
    <div>
      <label>VLESS UUID</label>
      <input id="vlUUID" type="text" dir="ltr" placeholder="click generate">
    </div>
    <div style="flex:0 0 auto;display:flex;align-items:flex-end">
      <button class="btn small ghost" type="button" onclick="gen()">🎲</button>
    </div>
  </div>
  <div class="row">
    <div>
      <label>رمز Trojan</label>
      <input id="trPass" type="text" dir="ltr">
    </div>
    <div style="flex:0 0 auto;display:flex;align-items:flex-end">
      <button class="btn small ghost" type="button" onclick="genTr()">🎲</button>
    </div>
  </div>
  <label>Secure Path (مسیر مخفی پنل)</label>
  <input id="securePath" type="text" dir="ltr" placeholder="mySecretPath">
  <button class="btn" onclick="apply()">⚗️ فعال‌سازی پنل</button>
  <div id="msg" class="msg"></div>
</div>
<script>
function gen(){document.getElementById('vlUUID').value=crypto.randomUUID()}
function genTr(){const c='abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';const a=new Uint8Array(14);crypto.getRandomValues(a);document.getElementById('trPass').value=Array.from(a,n=>c[n%c.length]).join('')}
function genSp(){document.getElementById('securePath').value=Array.from(crypto.getRandomValues(new Uint8Array(10)),n=>'abcdefghijklmnopqrstuvwxyz0123456789'[n%36]).join('')}
gen();genTr();genSp();
async function apply(){
  const msg=document.getElementById('msg');
  const body={
    accEmail:v('accEmail'),apiToken:v('apiToken'),panelPass:v('panelPass'),
    vlUUID:v('vlUUID'),trPass:v('trPass'),securePath:v('securePath')
  };
  if(!body.accEmail||!body.apiToken||!body.panelPass||!body.vlUUID||!body.trPass||!body.securePath){show('err','همه فیلدها لازم هستند.');return}
  msg.className='msg';msg.textContent='در حال فعال‌سازی…';msg.classList.add('show');
  try{
    const r=await fetch('/setup/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();
    if(d.success){show('ok','پنل فعال شد! در حال انتقال به صفحه ورود…');setTimeout(()=>location.href='/'+d.body.securePath+'/login',1200)}
    else show('err',d.message||'خطا در فعال‌سازی');
  }catch(e){show('err','ارتباط با سرور برقرار نشد.')}
}
function v(id){return document.getElementById(id).value.trim()}
function show(t,m){const msg=document.getElementById('msg');msg.className='msg show '+t;msg.textContent=m}
</script>`).replaceAll('${PANEL_VERSION}', PANEL_VERSION), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

function renderLoginPage() {
    return new Response(pageShell('ورود', `
<div class="card">
  <h2>ورود به پنل</h2>
  <label>نام کاربری (ایمیل Cloudflare)</label>
  <input id="username" type="text" dir="ltr" autocomplete="username">
  <label>رمز عبور</label>
  <input id="password" type="password" dir="ltr" autocomplete="current-password">
  <button class="btn" onclick="login()">🔓 ورود</button>
  <div id="msg" class="msg"></div>
</div>
<script>
async function login(){
  const msg=document.getElementById('msg');
  msg.className='msg';msg.textContent='در حال بررسی…';msg.classList.add('show');
  try{
    const r=await fetch(location.pathname+'/authenticate',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:v('username'),password:v('password')})});
    const d=await r.json();
    if(d.success)location.href=location.pathname.replace(/\\/login$/,'/panel');
    else{msg.className='msg show err';msg.textContent=d.message||'خطا'}
  }catch(e){msg.className='msg show err';msg.textContent='ارتباط با سرور برقرار نشد.'}
}
function v(id){return document.getElementById(id).value}
document.addEventListener('keydown',e=>{if(e.key==='Enter')login()});
</script>`).replaceAll('${PANEL_VERSION}', PANEL_VERSION), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

function renderPanelPage(state) {
    return new Response(pageShell('داشبورد', `
<div class="card">
  <h2>وضعیت پنل <span class="badge">v${'${PV}'}</span></h2>
  <div class="kv"><span class="k">حالت تونل</span><span class="v">VLESS + Trojan · TCP-only · sync ENV</span></div>
  <div class="kv"><span class="k">Proxy IP Mode</span><span class="v" id="modeView"></span></div>
  <div class="kv"><span class="k">نسخه جدید</span><span class="v" id="updView">در حال بررسی…</span></div>
  <button class="btn ghost" style="margin-top:14px" onclick="doUpdate(this)">⬆️ بررسی و نصب آپدیت</button>
  <div id="umsg" class="msg"></div>
</div>
<div class="card">
  <h2>لینک اشتراک</h2>
  <div class="tabs">
    <button class="on" onclick="setTab(this,'subbox','links')">لینک‌ها</button>
    <button onclick="setTab(this,'subbox','clash')">Clash</button>
    <button onclick="setTab(this,'subbox','xray')">Xray</button>
    <button onclick="setTab(this,'subbox','sing-box')">sing-box</button>
  </div>
  <div class="subbox" id="subbox"></div>
  <button class="btn ghost" style="margin-top:14px" onclick="copySub(this)">📋 کپی</button>
</div>
<div class="card">
  <h2>تنظیمات تونل</h2>
  <label>VLESS UUID</label><input id="vlUUID" dir="ltr">
  <label>رمز Trojan</label><input id="trPass" dir="ltr">
  <label>حالت اتصال مجدد</label>
  <select id="proxyIpMode">
    <option value="proxyip">Proxy IP (دامنه/آی‌پی واسط)</option>
    <option value="prefix">NAT64 Prefix (DNS روی IPv6)</option>
  </select>
  <label>لیست Proxy IP / NAT64 Prefix (هر خط یکی)</label>
  <textarea id="proxyList" rows="3" dir="ltr" style="width:100%;background:var(--field);border:1px solid var(--line-soft);border-radius:9px;color:var(--txt);font-family:var(--mono);font-size:.78rem;padding:11px 13px;outline:none"></textarea>
  <label>دامنه Fallback (اختیاری)</label>
  <input id="fallback" dir="ltr" placeholder="example.com">
  <label>DoH Server</label>
  <input id="dohUrl" dir="ltr">
  <button class="btn" onclick="saveSettings(this)">💾 ذخیره تنظیمات</button>
  <div id="smsg" class="msg"></div>
</div>
<div class="card">
  <h2>خروج</h2>
  <button class="btn ghost" onclick="location.href=location.pathname.replace(/\\/panel$/,'/logout')">🚪 خروج از حساب</button>
</div>
<script>
const SUB_BASE=location.pathname.replace(/\\/panel$/,'/sub');
let currentApp='links';
async function loadSettings(){
  const r=await fetch(location.pathname+'/settings');const d=await r.json();
  const s=d.body.proxySettings;
  document.getElementById('vlUUID').value=s.vlUUID;
  document.getElementById('trPass').value=s.trPass;
  document.getElementById('proxyIpMode').value=s.proxyIpMode;
  document.getElementById('proxyList').value=(s.proxyIpMode==='prefix'?s.prefixes:s.proxyIPs).join('\\n');
  document.getElementById('fallback').value=s.fallback||'';
  document.getElementById('dohUrl').value=s.dohUrl||'';
  document.getElementById('modeView').textContent=s.proxyIpMode;
  const u=document.getElementById('updView');
  if(d.body.updateInfo&&d.body.updateInfo.updateAvailable){u.textContent='آپدیت موجود: v'+d.body.updateInfo.latest;u.style.color='var(--gold)'}
  else{u.textContent='شما در آخرین نسخه هستید';u.style.color='var(--ok)'}
}
async function loadSub(){
  const r=await fetch(SUB_BASE+'?app='+currentApp);
  let t=await r.text();
  if(currentApp==='links'){try{t=atob(t)}catch(e){}}
  document.getElementById('subbox').textContent=t;
}
function setTab(btn,_,app){document.querySelectorAll('.tabs button').forEach(b=>b.classList.remove('on'));btn.classList.add('on');currentApp=app;loadSub()}
function copySub(btn){
  const t=document.getElementById('subbox').textContent;
  navigator.clipboard.writeText(t).then(()=>{btn.textContent='✅ کپی شد';setTimeout(()=>btn.textContent='📋 کپی',1200)});
}
async function saveSettings(btn){
  const msg=document.getElementById('smsg');
  const list=document.getElementById('proxyList').value.split('\\n').map(s=>s.trim()).filter(Boolean);
  const body={
    vlUUID:val('vlUUID'),trPass:val('trPass'),proxyIpMode:val('proxyIpMode'),
    proxyIPs:val('proxyIpMode')==='proxyip'?list:[],
    prefixes:val('proxyIpMode')==='prefix'?list:[],
    fallback:val('fallback'),dohUrl:val('dohUrl')
  };
  msg.className='msg';msg.textContent='در حال ذخیره…';msg.classList.add('show');
  const r=await fetch(location.pathname+'/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json();
  msg.className='msg show '+(d.success?'ok':'err');msg.textContent=d.message;
  if(d.success)loadSub();
}
async function doUpdate(btn){
  const msg=document.getElementById('umsg');
  msg.className='msg';msg.textContent='در حال بررسی…';msg.classList.add('show');
  try{
    const r=await fetch(location.pathname+'/update-panel',{method:'POST'});
    const d=await r.json();
    msg.className='msg show '+(d.success?'ok':'err');msg.textContent=d.message;
    if(d.success&&d.body&&d.body.updated)setTimeout(()=>location.reload(),1500);
  }catch(e){msg.className='msg show err';msg.textContent='ارتباط با سرور برقرار نشد.'}
}
function val(id){return document.getElementById(id).value.trim()}
loadSettings();loadSub();
</script>`).replaceAll('${PV}', PANEL_VERSION).replaceAll('${PANEL_VERSION}', PANEL_VERSION), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}
