// TEMPORARY (deleted afterwards): the /review/screens/ page against a real run
// folder, the review API answered from the files.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const RUN_DIR = process.env.RUN_DIR;
const OUT = process.env.SHOT_OUT;
const run = path.basename(RUN_DIR);
const manifest = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'manifest.json'), 'utf-8'));
const images = manifest.images.map((image) => ({
  file: image.file, device: image.device, role: image.role, action: image.action, path: image.path,
  viewport: image.viewport, width: image.width, height: image.height, errors: image.errors,
}));
const notes = [];
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${b64({ alg: 'none' })}.${b64({ token_type: 'access', user_id: 1, username: 'staff', is_staff: true, is_superuser: true, exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-DE' });
await context.addInitScript((value) => {
  localStorage.setItem('authToken', value);
  localStorage.setItem('refreshToken', value);
  localStorage.setItem('progeo_consent', JSON.stringify({ version: 3, decidedAt: new Date().toISOString(), categories: { necessary: true, externalMaps: false, statistics: false } }));
}, token);
await context.route('http://127.0.0.1:59999/**', async (route) => {
  const request = route.request();
  const { pathname } = new URL(request.url());
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (pathname.endsWith('/screen-review/')) return json({ runs: [{ run, created: manifest.created, images: images.length, notes: notes.length }] });
  if (pathname.endsWith(`/screen-review/${run}/`)) return json({ run, images, notes });
  const image = pathname.match(/\/image\/([^/]+)\/$/);
  if (image) {
    const entry = images.find((candidate) => candidate.file === image[1]);
    return route.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(path.join(RUN_DIR, entry.device, entry.file)) });
  }
  if (pathname.endsWith('/notes/') && request.method() === 'POST') {
    const data = request.postDataJSON();
    const note = { id: notes.length + 1, run, ...data, author: 1, author_name: 'Jonas Weber', created: new Date().toISOString(), updated: new Date().toISOString() };
    notes.push(note);
    return json({ note });
  }
  if (pathname.includes('/module-permissions/')) return json({ permissions: {}, enabled: [] });
  if (pathname.endsWith('/qa/notifications/')) return json({ awards: [] });
  return json({});
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto('http://127.0.0.1:3399/review/screens/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/gallery.png` });
// The device filter, then the status screen in the editor.
await page.getByTestId('screens-device').getByText('PC').click();
await page.waitForTimeout(800);
await page.locator('[data-testid="screen-card"][data-test-key="pc-staff-location-status.png"] [data-testid="screen-card-open"]').click();
await page.waitForTimeout(2500);
await page.getByTestId('screen-tool-arrow').click();
const parts = page.locator('[data-testid="screen-editor-parts"] [data-slice-index]');
const first = await parts.nth(0).boundingBox();
const second = await parts.nth(1).boundingBox();
await page.mouse.move(first.x + first.width * 0.3, first.y + first.height * 0.4);
await page.mouse.down();
await page.mouse.move(second.x + second.width * 0.6, second.y + second.height * 0.2, { steps: 12 });
await page.mouse.up();
await page.getByTestId('screen-note-comment').fill('Die KPI-Kacheln gehören neben den Lageplan.');
await page.getByTestId('screen-note-save').click();
await page.waitForTimeout(500);
await page.getByTestId('screen-tool-area').click();
await page.mouse.move(first.x + first.width * 0.55, first.y + first.height * 0.6);
await page.mouse.down();
await page.mouse.move(first.x + first.width * 0.9, first.y + first.height * 0.8, { steps: 8 });
await page.mouse.up();
await page.locator('[data-testid="screen-note-action"][data-test-key="bigger"]').click();
await page.getByTestId('screen-note-comment').fill('Tabelle zu klein');
await page.getByTestId('screen-note-save').click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/editor.png` });
console.log('notes', JSON.stringify(notes.map((note) => [note.kind, note.action, note.geometry])), 'errors', errors);
await browser.close();
