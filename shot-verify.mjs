#!/usr/bin/env node
/* Visual verification for ARAL SULFUR — screenshots of every view & tab. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = 19580;
const BASE = 'file://' + path.join(ROOT, 'panel-preview.html');
const OUT = '/tmp/render/uranium';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });


const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Login view — demo mode boots straight to admin, so switch views explicitly
await page.goto(BASE, { waitUntil: 'load' });
await sleep(2500);
await page.evaluate(() => {
  const pl = document.getElementById('preloader'); if (pl) pl.hidden = true;
  const fm = document.getElementById('free-notice-modal'); if (fm) fm.hidden = true;
  for (const id of ['v-admin', 'v-setup', 'v-stateless']) { const el = document.getElementById(id); if (el) el.hidden = true; }
  document.getElementById('v-login').hidden = false;
});
await sleep(2200);
await page.screenshot({ path: OUT + '/01-login.png', fullPage: true });

// 2. Setup view
await page.evaluate(() => {
  document.getElementById('v-login').hidden = true;
  document.getElementById('v-setup').hidden = false;
});
await sleep(400);
await page.screenshot({ path: OUT + '/02-setup.png', fullPage: true });

// 3. Stateless view
await page.evaluate(() => {
  document.getElementById('v-setup').hidden = true;
  document.getElementById('v-stateless').hidden = false;
});
await sleep(400);
await page.screenshot({ path: OUT + '/03-stateless.png', fullPage: true });

// 4. Admin — enter via demo (call bootstrap api offline → use the demo path)
await page.evaluate(() => {
  document.getElementById('v-stateless').hidden = true;
});
// The demo store path: ingestBootstrap with demo payload when api fails (file preview)
// panel-preview over http: api('/api/bootstrap') fails → offline path. Instead force demo:
await page.evaluate(() => { try { sessionStorage.clear(); localStorage.clear(); } catch (e) {} });
await page.reload({ waitUntil: 'load' });
await sleep(1500);
await page.evaluate(() => { const pl = document.getElementById('preloader'); if (pl) pl.hidden = true; });
const mode = await page.evaluate(() => ({
  login: !document.getElementById('v-login').hidden,
  admin: !document.getElementById('v-admin').hidden,
  stateless: !document.getElementById('v-stateless').hidden,
  demo: !!(window.__aralDemo)
}));
console.log('boot mode:', JSON.stringify(mode));

if (mode.admin) {
  // close the free-notice modal if present
  try { await page.click('#btn-free-close', { timeout: 2500 }); } catch (e) {}
  await sleep(400);
  for (const [i, tab] of ['home', 'users', 'net', 'settings'].entries()) {
    await page.click(`.tab-btn[data-tab="${tab}"]`);
    await sleep(700);
    await page.screenshot({ path: OUT + `/1${i}-admin-${tab}.png`, fullPage: true });
  }
  // user modal
  await page.click('.tab-btn[data-tab="users"]');
  await sleep(400);
  const editBtn = await page.$('.u-act-edit');
  if (editBtn) { await editBtn.click(); await sleep(500); await page.screenshot({ path: OUT + '/20-user-modal.png' }); }
  try { await page.click('#um-close', { timeout: 3000 }); } catch (e) {}
  // light theme
  await page.click('#v-admin .t-pick[data-th="light"]');
  await sleep(600);
  await page.click('.tab-btn[data-tab="home"]');
  await sleep(500);
  await page.screenshot({ path: OUT + '/21-admin-light.png', fullPage: true });
  await page.click('#v-admin .t-pick[data-th="dark"]');
  // english
  await page.click('#lang');
  await sleep(500);
  await page.screenshot({ path: OUT + '/22-admin-english.png' });
  await page.click('#lang');
}

// mobile
const mob = await ctx.newPage();
mob.setViewportSize?.({ width: 390, height: 844 });
await mob.goto(BASE, { waitUntil: 'load' });
await sleep(2200);
await mob.evaluate(() => { const pl = document.getElementById('preloader'); if (pl) pl.hidden = true; });
await mob.screenshot({ path: OUT + '/30-login-mobile.png', fullPage: true });
const mobAdmin = await mob.evaluate(() => !document.getElementById('v-admin').hidden);
if (mobAdmin) {
  try { await mob.click('#btn-free-close', { timeout: 2500 }); } catch (e) {}
  await mob.evaluate(() => { window.scrollTo(0, 0); });
  for (const tab of ['home', 'users', 'net', 'settings']) {
    await mob.click(`.tab-btn[data-tab="${tab}"]`);
    await sleep(600);
    await mob.screenshot({ path: OUT + `/3-${tab}-mobile.png`, fullPage: true });
  }
}

console.log('JS errors captured:', errors.length ? errors.slice(0, 12) : 'none');
await browser.close();
console.log('done →', OUT);
