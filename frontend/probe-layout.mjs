// TEMPORARY (deleted afterwards): why the staff layout collapses in the captures.
import { chromium } from '@playwright/test';
import { mockAnswer, PERSONAS } from './e2e/screenshots/mockApi.mjs';

const role = process.env.ROLE || 'staff';
const target = process.env.TARGET || '/escalations/';
const persona = PERSONAS[role];
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${b64({ alg: 'none' })}.${b64({ token_type: 'access', user_id: persona.user_id, username: persona.username, first_name: persona.first_name, last_name: persona.last_name, is_staff: persona.is_staff, is_superuser: persona.is_superuser, exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: Number(process.env.VH || 900) }, locale: 'de-DE' });
await context.addInitScript((value) => {
  localStorage.setItem('authToken', value);
  localStorage.setItem('refreshToken', value);
  localStorage.setItem('progeo_consent', JSON.stringify({ version: 3, decidedAt: new Date().toISOString(), categories: { necessary: true, externalMaps: false, statistics: false } }));
}, token);
await context.route('http://127.0.0.1:59999/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockAnswer(route.request().method(), route.request().url(), role) ?? {}) }));
const page = await context.newPage();
page.on('pageerror', (error) => console.log('PAGEERROR', error.message.slice(0, 200)));
page.on('console', (message) => message.type() === 'error' && console.log('CONSOLE', message.text().slice(0, 200)));
await page.goto(`http://127.0.0.1:3399${target}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const info = await page.evaluate(() => {
  const describe = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return `${selector}: -`;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return `${selector}: w=${Math.round(rect.width)} h=${Math.round(rect.height)} display=${style.display} flex=${style.flex} width=${style.width}`;
  };
  return [
    describe('[data-testid="app-layout"]'), describe('.progeo-sidebar'), describe('[data-testid="sidebar-nav"]'),
    describe('.app-layout-content'), describe('[data-testid^="page-"]'),
    `page roots: ${[...document.querySelectorAll('[data-testid^="page-"]')].map((e) => e.getAttribute('data-testid')).join(',')}`,
    `body text start: ${document.body.innerText.slice(0, 120).replace(/\n/g, ' | ')}`,
  ];
});
console.log(info.join('\n'));
await browser.close();
