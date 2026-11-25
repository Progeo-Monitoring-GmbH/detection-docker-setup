// Full-page screenshots of every route (routes.mjs) - pc and mobile, as a
// normal user and as staff - against the frontend dev server, every API
// request answered by mockApi.mjs. Started by `python manage.py e2e_screenshots`
// (progeo/management/commands/e2e_screenshots.py), which sets:
//
//   SCREENS_OUT          the run's folder (media/uploads/e2e/<run>/, with pc/ and mobile/)
//   SCREENS_RUN          its name
//   SCREENS_BASE         the frontend, e.g. http://127.0.0.1:3299
//   SCREENS_MOCK_ORIGIN  the API origin the frontend was started with (VITE_BACKEND_URL)
//   SCREENS_DEVICES      pc,mobile     SCREENS_ROLES  user,staff     SCREENS_LANGUAGES  de,en
//   SCREENS_ONLY         actions (optional): "action" = the page and its dialogs,
//                        "action--dialog" = only that dialog
//   SCREENS_MODALS       0: pages only, no dialogs
//
// Every page is shot with its FoldPanels unfolded (unfoldAll - a route's or
// dialog's `unfold: false` keeps them folded), with the consent decided:
// external maps declined unless the route's `consent` says otherwise (their
// tiles are answered locally, TILE_SERVERS).
//
// Writes {device}/{device}-{role}-{language}-{action}.png per page,
// {device}-{role}-{language}-{action}--{dialog}.png per dialog (routes.mjs
// `modals`) and manifest.json (after every screenshot - a run cut short keeps
// what it has; each entry names the persona it was taken as). Next to every
// screenshot `<file>.elements.json`: its visible elements and where they are,
// so the review's PROMPT.md names the element under a comment. A dialog that does not open is no screenshot but an entry in
// the manifest's `failures` - the run goes on.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from '@playwright/test';
import { mockAnswer, PERSONAS } from './mockApi.mjs';
import { ROUTES, modalName, normalizeSteps } from './routes.mjs';

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
const WITH_MODALS = process.env.SCREENS_MODALS !== '0';

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

/**
 * The app's CONSENT_VERSION (src/components/privacy/consent.ts), read from
 * the source: a stored decision of another version is discarded and the
 * consent banner covers the page - every dialog step then timed out on a
 * covered button (the version went 3 -> 4 and this file still wrote 3).
 */
const CONSENT_VERSION = (() => {
  const source = fs.readFileSync(
    new URL('../../src/components/privacy/consent.ts', import.meta.url),
    'utf8',
  );
  const match = source.match(/export const CONSENT_VERSION\s*=\s*(\d+)/);
  if (!match) {
    console.error('CONSENT_VERSION not found in src/components/privacy/consent.ts');
    process.exit(2);
  }
  return Number(match[1]);
})();

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

// -- images the mocked API serves (plans, screenshots) ----------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
/**
 * A light grey PNG with a darker grid (every `grid` px) - a stand-in for a
 * site plan, a screenshot or a map tile.
 */
const placeholderPng = (width, height, grid = 50) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bit, RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const line = x % grid === 0 || y % grid === 0;
      rows.fill(line ? 200 : 236, row + 1 + x * 3, row + 4 + x * 3);
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};
const PLACEHOLDER_PNG = placeholderPng(1200, 800);
// A 256 px map tile, its grid seamless across tiles.
const TILE_PNG = placeholderPng(256, 256, 64);
/**
 * The external tile servers of the Leaflet maps (src/components/ui/mapLayers.ts) -
 * loaded only with the externalMaps consent (a route's `consent`). Answered with
 * TILE_PNG: the screenshot neither depends on the internet nor sends anything out.
 */
const TILE_SERVERS = [
  'https://server.arcgisonline.com/**',
  'https://tile.openstreetmap.org/**',
];
const isImageRequest = (pathname) =>
  /\.(png|jpe?g|webp)$/i.test(pathname) ||
  /\/screen-review\/[^/]+\/image\//.test(pathname);

// -- the manifest -------------------------------------------------------------------

const manifest = {
  run: process.env.SCREENS_RUN || path.basename(OUT),
  created: new Date().toISOString(),
  base: BASE,
  images: [],
  // Screenshots that could not be taken: {file, device, role, language,
  // action, modal, url, steps, reason} - a dialog that did not open, a page
  // that did not load.
  failures: [],
};
const saveManifest = () =>
  fs.writeFileSync(
    path.join(OUT, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

/**
 * Unfolds every folded FoldPanel (src/components/ui/kit/FoldPanel.tsx) - the
 * screenshot shows the panels' content, a dialog's steps find the elements in
 * them. In rounds: an unfolded panel can hold folded ones.
 */
const FOLDED = '[data-testid="fold-toggle"][aria-expanded="false"]';
const unfoldAll = async (page) => {
  for (let round = 0; round < 5; round += 1) {
    const clicked = await page.evaluate((selector) => {
      const toggles = [...document.querySelectorAll(selector)];
      toggles.forEach((toggle) => toggle.click());
      return toggles.length;
    }, FOLDED);
    if (!clicked) {
      return;
    }
    // Bootstrap's Collapse transition (350 ms), content laid out after it.
    await page.waitForTimeout(500);
  }
};

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
 * Pins every element whose height follows the window's (vh, a flex column of
 * the window's height) to its height in the device's window: the window
 * grown by a probe, what grew with it gets its old height as an inline
 * height / min-height / max-height. Then a taller window changes nothing.
 */
const FREEZE_PROBE = 240;
const freezeWindowHeights = async (page, width) => {
  const { height } = page.viewportSize();
  await page.evaluate(() => {
    const elements = [...document.body.querySelectorAll('*')];
    window.__captureFreeze = elements.map((element) => [
      element,
      element.getBoundingClientRect().height,
    ]);
  });
  await page.setViewportSize({ width, height: height + FREEZE_PROBE });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const grown = (window.__captureFreeze ?? []).filter(
      ([element, before]) =>
        element.isConnected &&
        element.getBoundingClientRect().height - before > 1,
    );
    for (const [element, before] of grown) {
      element.style.setProperty('box-sizing', 'border-box', 'important');
      for (const property of ['height', 'min-height', 'max-height']) {
        element.style.setProperty(property, `${before}px`, 'important');
      }
    }
    delete window.__captureFreeze;
  });
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(300);
};

/**
 * The window as tall as the page, settled - then the screenshot is just the
 * window. Playwright's fullPage capture resizes the window while it shoots:
 * the app reacts to that resize mid-capture (the sidebar spread over the page
 * where it is the tallest column). Grown first, the layout is final.
 *
 * Measured once, at the device's own window: grown again and again, every
 * element sized by the window (min-height: 100vh) grew with it - a mobile
 * page ended up six windows tall, the rest empty.
 *
 * Grown once, they still grew - and what came after them was cut off (the
 * map, calc(100vh - 220px), pushed the location list out of the shot). So
 * first freezeWindowHeights: the page keeps the layout of the device's window.
 */
const growToPage = async (page, width) => {
  await freezeWindowHeights(page, width);
  const height = Math.min(await pageHeight(page), MAX_HEIGHT);
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(500);
  return { fullPage: false };
};

/** The page's address without the origin: path, query and hash. */
const urlOf = (page) => {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}${url.hash}`;
};

// -- the elements of a screenshot ---------------------------------------------------------

// What the review's PROMPT.md names under a comment (backend
// helper/screen_review_elements.py): the visible elements with a test id,
// plus unnamed buttons, links and inputs - in the screenshot's pixels.
const ELEMENT_LIMIT = 3000;
const ELEMENTS_SELECTOR =
  '[data-testid], button, a[href], input, select, textarea, [role="button"]';

/**
 * `<file>.elements.json` next to the screenshot. `rootSelector`: a dialog -
 * only its elements (the page behind the backdrop is not what a comment on
 * a dialog means). Never fails the screenshot.
 */
const saveElements = async (page, device, file, rootSelector = null) => {
  try {
    const elements = await page.evaluate(
      ({ selector, root: rootSel, limit }) => {
        const root = (rootSel && document.querySelector(rootSel)) || document;
        const rows = [];
        for (const node of root.querySelectorAll(selector)) {
          const box = node.getBoundingClientRect();
          if (box.width < 1 || box.height < 1) {
            continue;
          }
          const style = getComputedStyle(node);
          if (style.visibility === 'hidden' || style.display === 'none') {
            continue;
          }
          const testId = node.getAttribute('data-testid');
          const text = (
            node.getAttribute('aria-label') ||
            node.innerText ||
            node.value ||
            node.getAttribute('title') ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);
          if (!testId && !text) {
            continue;
          }
          rows.push({
            t: testId || undefined,
            k: node.getAttribute('data-test-key') || undefined,
            g: node.tagName.toLowerCase(),
            s: text || undefined,
            r: [
              Math.round(box.x + window.scrollX),
              Math.round(box.y + window.scrollY),
              Math.round(box.width),
              Math.round(box.height),
            ],
          });
          if (rows.length >= limit) {
            break;
          }
        }
        return rows;
      },
      { selector: ELEMENTS_SELECTOR, root: rootSelector, limit: ELEMENT_LIMIT },
    );
    fs.writeFileSync(
      path.join(OUT, device, file.replace(/\.png$/, '.elements.json')),
      JSON.stringify({ elements }),
    );
  } catch {
    // The screenshot stays usable - its comments then name coordinates only.
  }
};

// -- dialogs ---------------------------------------------------------------------------

const STEP_TIMEOUT = 8000;
const byTestId = (testId, key) =>
  `[data-testid="${testId}"]${key != null ? `[data-test-key="${key}"]` : ''}`;
const stepSelector = (step) => step.css ?? byTestId(step.testId, step.key);
const describeStep = (step) =>
  `${step.do} ${step.css ?? byTestId(step.testId, step.key)}`;

/** One step of a dialog's way to open (routes.mjs normalizeSteps). */
const runStep = async (page, step) => {
  if (step.do === 'wait') {
    await page.waitForTimeout(step.ms);
    return;
  }
  if (step.do === 'press') {
    await page.keyboard.press(step.value);
    return;
  }
  const target = page.locator(stepSelector(step)).first();
  await target.waitFor({ state: 'attached', timeout: STEP_TIMEOUT });
  if (step.do === 'upload') {
    await target.setInputFiles({
      name: step.file.name,
      mimeType: step.file.mimeType ?? 'application/json',
      buffer: Buffer.from(step.file.content),
    });
    return;
  }
  await target.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
  await target.scrollIntoViewIfNeeded().catch(() => undefined);
  switch (step.do) {
    case 'click':
      await target.click({
        timeout: STEP_TIMEOUT,
        ...(step.position ? { position: step.position } : {}),
      });
      break;
    case 'check':
      await target.check({ timeout: STEP_TIMEOUT });
      break;
    case 'uncheck':
      await target.uncheck({ timeout: STEP_TIMEOUT });
      break;
    case 'fill':
      await target.fill(step.value, { timeout: STEP_TIMEOUT });
      break;
    case 'select':
      await target.selectOption(step.value, { timeout: STEP_TIMEOUT });
      break;
    case 'hover':
      await target.hover({ timeout: STEP_TIMEOUT });
      break;
    default:
      throw new Error(`unknown step ${step.do}`);
  }
  // React re-renders, requests the click started.
  await page.waitForTimeout(250);
};

/**
 * The window grown to the open dialog when it is taller than the window (a
 * long form) - else the window as it is. The dialog is fixed to the window:
 * a full-page screenshot would only add the page under the backdrop.
 */
const growToDialog = async (page, selector, width, height) => {
  // The content's own height: a centered Bootstrap dialog is at least as
  // tall as the window (min-height), its .modal-content is not.
  const needed = await page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const content = element.querySelector('.modal-content') ?? element;
      return Math.ceil(content.scrollHeight);
    })
    .catch(() => 0);
  if (needed + 48 > height) {
    await page.setViewportSize({
      width,
      height: Math.min(needed + 64, MAX_HEIGHT),
    });
    await page.waitForTimeout(400);
    // The grown dialog from its top (a scrolled .modal keeps its offset).
    await page
      .locator(selector)
      .first()
      .evaluate((element) => {
        const scroller = element.closest('.modal');
        if (scroller) {
          scroller.scrollTop = 0;
        }
      })
      .catch(() => undefined);
  }
};

// -- the run ---------------------------------------------------------------------------

const browser = await chromium.launch();
let failures = 0;
try {
  for (const device of DEVICES) {
    fs.mkdirSync(path.join(OUT, device), { recursive: true });
    const { width, height } = VIEWPORTS[device].viewport;
    for (const language of LANGUAGES) {
      for (const role of ROLES) {
        const persona = PERSONAS[role];
        for (const route of ROUTES) {
          if (!route.roles.includes(role)) {
            continue;
          }
          const wantPage = !ONLY.size || ONLY.has(route.action);
          const modals = WITH_MODALS
            ? (route.modals ?? []).filter(
                (modal) =>
                  (modal.roles ?? route.roles).includes(role) &&
                  (modal.devices ?? DEVICES).includes(device) &&
                  (wantPage ||
                    ONLY.has(`${route.action}--${modalName(modal)}`)),
              )
            : [];
          if (!wantPage && !modals.length) {
            continue;
          }
          const prefix = `${device}-${role}-${language}-${route.action}`;
          const context = await browser.newContext({
            ...VIEWPORTS[device],
            locale: LOCALES[language] ?? 'de-DE',
            timezoneId: 'Europe/Berlin',
          });
          await context.addInitScript(
            ({ token, language: lng, consent, consentVersion }) => {
              if (token) {
                localStorage.setItem('authToken', token);
                localStorage.setItem('refreshToken', token);
              }
              // i18next-browser-languagedetector's stored choice.
              localStorage.setItem('i18nextLng', lng);
              localStorage.setItem(
                'progeo_consent',
                JSON.stringify({
                  version: consentVersion,
                  decidedAt: new Date().toISOString(),
                  categories: {
                    necessary: true,
                    externalMaps: false,
                    statistics: false,
                    // routes.mjs `consent`: e.g. the map with its tiles.
                    ...consent,
                  },
                }),
              );
            },
            {
              token: route.public ? null : tokenOf(persona),
              language,
              consent: route.consent ?? {},
              consentVersion: CONSENT_VERSION,
            },
          );
          for (const server of TILE_SERVERS) {
            await context.route(server, (request) =>
              request.fulfill({
                status: 200,
                contentType: 'image/png',
                body: TILE_PNG,
              }),
            );
          }
          // Per screenshot: its mock variant, the requests without a mock.
          const shot = { scenario: null, unmocked: new Set(), errors: [] };
          await context.route(`${MOCK_ORIGIN}/**`, (request) => {
            const method = request.request().method();
            const url = request.request().url();
            if (isImageRequest(new URL(url).pathname)) {
              return request.fulfill({
                status: 200,
                contentType: 'image/png',
                body: PLACEHOLDER_PNG,
              });
            }
            const body = mockAnswer(method, url, role, language, shot.scenario);
            if (body === undefined) {
              shot.unmocked.add(`${method} ${new URL(url).pathname}`);
            }
            return request.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(body ?? {}),
            });
          });
          const page = await context.newPage();
          page.on('pageerror', (error) =>
            shot.errors.push(error.message.slice(0, 300)),
          );
          const open = async (target, scenario = null, unfold = true) => {
            shot.scenario = scenario;
            shot.unmocked = new Set();
            shot.errors = [];
            await page.setViewportSize({ width, height });
            await page.goto(`${BASE}${target}`, {
              waitUntil: 'domcontentloaded',
              timeout: 30000,
            });
            await settle(page);
            if (unfold) {
              await unfoldAll(page);
            }
          };
          const entryOf = (file) => ({
            file,
            device,
            role,
            language,
            action: route.action,
            path: route.path,
            viewport: [width, height],
            errors: shot.errors.slice(0, 5),
            unmocked: [...shot.unmocked].sort(),
            // Who it was taken as - PROMPT.md: a missing element may be a permission.
            persona: {
              username: persona.username,
              is_staff: persona.is_staff,
              is_superuser: persona.is_superuser,
              permissions: persona.permissions,
            },
          });
          try {
            if (wantPage) {
              const file = `${prefix}.png`;
              try {
                await open(route.path, null, route.unfold !== false);
                const url = urlOf(page);
                await page.screenshot({
                  path: path.join(OUT, device, file),
                  ...(await growToPage(page, width)),
                });
                await saveElements(page, device, file);
                const size = await page.evaluate(() => [
                  document.documentElement.scrollWidth,
                  document.documentElement.scrollHeight,
                ]);
                manifest.images.push({
                  ...entryOf(file),
                  url,
                  modal: null,
                  width: size[0],
                  height: size[1],
                });
                console.log(
                  `ok    ${file}${shot.errors.length ? `  (${shot.errors.length} page error(s))` : ''}`,
                );
              } catch (error) {
                failures += 1;
                manifest.failures.push({
                  ...entryOf(file),
                  url: route.path,
                  modal: null,
                  reason: String(error).slice(0, 300),
                });
                console.log(`FAIL  ${file}: ${String(error).slice(0, 200)}`);
              } finally {
                saveManifest();
              }
            }
            // Every dialog from a freshly loaded page - the one before is
            // gone with the reload, none leaks its state into the next.
            for (const modal of modals) {
              const name = modalName(modal);
              const file = `${prefix}--${name}.png`;
              const steps = normalizeSteps(modal.open).filter(
                (step) =>
                  (!step.device || step.device === device) &&
                  (!step.role || step.role === role),
              );
              const target = modal.path ?? route.path;
              const info = {
                name,
                testId: modal.testId,
                path: target,
                scenario: modal.scenario ?? null,
                steps,
              };
              let done = 0;
              try {
                await open(
                  target,
                  modal.scenario ?? null,
                  (modal.unfold ?? route.unfold) !== false,
                );
                const url = urlOf(page);
                for (const step of steps) {
                  await runStep(page, step);
                  done += 1;
                }
                const selector = byTestId(modal.testId);
                await page
                  .locator(selector)
                  .first()
                  .waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
                // Fade-in, data the dialog loads on opening.
                await page
                  .waitForLoadState('networkidle', { timeout: 5000 })
                  .catch(() => undefined);
                await page.waitForTimeout(450);
                await growToDialog(page, selector, width, height);
                await page.screenshot({ path: path.join(OUT, device, file) });
                await saveElements(page, device, file, selector);
                const size = page.viewportSize();
                manifest.images.push({
                  ...entryOf(file),
                  url,
                  modal: info,
                  width: size.width,
                  height: size.height,
                });
                console.log(
                  `ok    ${file}${shot.errors.length ? `  (${shot.errors.length} page error(s))` : ''}`,
                );
              } catch (error) {
                const reason =
                  done < steps.length
                    ? `step ${done + 1} (${describeStep(steps[done])}): ${String(error).split('\n')[0]}`
                    : `dialog ${byTestId(modal.testId)} did not open: ${String(error).split('\n')[0]}`;
                manifest.failures.push({
                  ...entryOf(file),
                  url: target,
                  modal: info,
                  reason: reason.slice(0, 400),
                });
                console.log(`MISS  ${file}: ${reason.slice(0, 200)}`);
              } finally {
                saveManifest();
              }
            }
          } finally {
            await context.close();
          }
        }
      }
    }
  }
} finally {
  await browser.close();
}
const missing = manifest.failures.filter((entry) => entry.modal).length;
console.log(
  `${manifest.images.length} screenshot(s), ${failures} page(s) failed, ${missing} dialog(s) not opened`,
);
process.exit(failures && !manifest.images.length ? 1 : 0);
