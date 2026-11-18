// Full-page screenshots of every route (routes.mjs) - pc and mobile, as a
// normal user and as staff - against the frontend dev server, every API
// request answered by mockApi.mjs. Started by `python manage.py e2e_screenshots`
// (progeo/management/commands/e2e_screenshots.py), which sets:
//
//   SCREENS_OUT          the run's folder (media/uploads/e2e/<run>/, with pc/ and mobile/)
//   SCREENS_RUN          its name
//   SCREENS_BASE         the frontend, e.g. http://127.0.0.1:3299
//   SCREENS_MOCK_ORIGIN  the API origin the frontend was started with (VITE_BACKEND_URL)
//   SCREENS_DEVICES      pc,mobile     SCREENS_ROLES  user,staff     SCREENS_ONLY  actions (optional)
//
// Writes {device}/{device}-{role}-{action}.png and manifest.json (after every
// screenshot - a run cut short keeps what it has).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { mockAnswer, PERSONAS } from './mockApi.mjs';
import { ROUTES } from './routes.mjs';

const OUT = process.env.SCREENS_OUT;
const BASE = (process.env.SCREENS_BASE || 'http://127.0.0.1:3299').replace(
  /\/$/,
  '',
);
const MOCK_ORIGIN = process.env.SCREENS_MOCK_ORIGIN || 'http://127.0.0.1:59999';
const list = (raw, fallback) =>
  (raw || fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const DEVICES = list(process.env.SCREENS_DEVICES, 'pc,mobile');
const ROLES = list(process.env.SCREENS_ROLES, 'user,staff');
const LANGUAGES = list(process.env.SCREENS_LANGUAGES, 'de,en');
// The browser's locale per language (dates, numbers) - the app's language
// itself comes from i18next's stored choice and the profile (mockApi.mjs).
const LOCALES = { de: 'de-DE', en: 'en-GB' };
const ONLY = new Set(list(process.env.SCREENS_ONLY, ''));

const VIEWPORTS = {
  pc: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  // CSS pixels = image pixels (scale 1) - the review's coordinates are the page's.
  mobile: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  },
};

if (!OUT) {
  console.error(
    'SCREENS_OUT missing - run it via `python manage.py e2e_screenshots`',
  );
  process.exit(2);
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const tokenOf = (persona) =>
  `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    token_type: 'access',
    user_id: persona.user_id,
    username: persona.username,
    first_name: persona.first_name,
    last_name: persona.last_name,
    is_staff: persona.is_staff,
    is_superuser: persona.is_superuser,
    exp: Math.floor(Date.now() / 1000) + 86400,
    is_pending: false,
    two_factor_setup_required: false,
  })}.mock`;

const manifest = {
  run: process.env.SCREENS_RUN || path.basename(OUT),
  created: new Date().toISOString(),
  base: BASE,
  images: [],
};
const saveManifest = () =>
  fs.writeFileSync(
    path.join(OUT, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

const settle = async (page) => {
  // The page's root (data-testid="page-…"), then quiet network and a moment
  // for charts and transitions.
  await page
    .waitForSelector('[data-testid^="page-"]', { timeout: 15000 })
    .catch(() => undefined);
  await page
    .waitForLoadState('networkidle', { timeout: 15000 })
    .catch(() => undefined);
  await page.waitForTimeout(1200);
};

/** The page's full height, capped (a runaway page must not make a 100 MB image). */
const MAX_HEIGHT = 20000;
const pageHeight = (page) =>
  page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
  );

/**
 * The window as tall as the page, settled - then the screenshot is just the
 * window. Playwright's fullPage capture resizes the window while it shoots:
 * the app reacts to that resize mid-capture (the sidebar spread over the page
 * where it is the tallest column). Grown first, the layout is final.
 *
 * Measured once, at the device's own window: grown again and again, every
 * element sized by the window (min-height: 100vh) grew with it - a mobile
 * page ended up six windows tall, the rest empty.
 */
const growToPage = async (page, width) => {
  const height = Math.min(await pageHeight(page), MAX_HEIGHT);
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(500);
  return { fullPage: false };
};

const browser = await chromium.launch();
let failures = 0;
try {
  for (const device of DEVICES) {
    fs.mkdirSync(path.join(OUT, device), { recursive: true });
    for (const language of LANGUAGES) {
      for (const role of ROLES) {
        const persona = PERSONAS[role];
        for (const route of ROUTES) {
          if (
            !route.roles.includes(role) ||
            (ONLY.size && !ONLY.has(route.action))
          ) {
            continue;
          }
          const file = `${device}-${role}-${language}-${route.action}.png`;
          const context = await browser.newContext({
            ...VIEWPORTS[device],
            locale: LOCALES[language] ?? 'de-DE',
            timezoneId: 'Europe/Berlin',
          });
          await context.addInitScript(
            ({ token, language: lng }) => {
              if (token) {
                localStorage.setItem('authToken', token);
                localStorage.setItem('refreshToken', token);
              }
              // i18next-browser-languagedetector's stored choice.
              localStorage.setItem('i18nextLng', lng);
              localStorage.setItem(
                'progeo_consent',
                JSON.stringify({
                  version: 3,
                  decidedAt: new Date().toISOString(),
                  categories: {
                    necessary: true,
                    externalMaps: false,
                    statistics: false,
                  },
                }),
              );
            },
            { token: route.public ? null : tokenOf(persona), language },
          );
          const unmocked = new Set();
          await context.route(`${MOCK_ORIGIN}/**`, (request) => {
            const { method, url } = {
              method: request.request().method(),
              url: request.request().url(),
            };
            const body = mockAnswer(method, url, role, language);
            if (body === undefined) {
              unmocked.add(`${method} ${new URL(url).pathname}`);
            }
            return request.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(body ?? {}),
            });
          });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) =>
            errors.push(error.message.slice(0, 300)),
          );
          try {
            await page.goto(`${BASE}${route.path}`, {
              waitUntil: 'domcontentloaded',
              timeout: 30000,
            });
            await settle(page);
            await page.screenshot({
              path: path.join(OUT, device, file),
              ...(await growToPage(page, VIEWPORTS[device].viewport.width)),
            });
            const size = await page.evaluate(() => [
              document.documentElement.scrollWidth,
              document.documentElement.scrollHeight,
            ]);
            manifest.images.push({
              file,
              device,
              role,
              language,
              action: route.action,
              path: route.path,
              viewport: [
                VIEWPORTS[device].viewport.width,
                VIEWPORTS[device].viewport.height,
              ],
              width: size[0],
              height: size[1],
              errors: errors.slice(0, 5),
              unmocked: [...unmocked].sort(),
            });
            console.log(
              `ok    ${file}${errors.length ? `  (${errors.length} page error(s))` : ''}`,
            );
          } catch (error) {
            failures += 1;
            console.log(`FAIL  ${file}: ${String(error).slice(0, 200)}`);
          } finally {
            saveManifest();
            await context.close();
          }
        }
      }
    }
  }
} finally {
  await browser.close();
}
console.log(`${manifest.images.length} screenshot(s), ${failures} failed`);
process.exit(failures && !manifest.images.length ? 1 : 0);
