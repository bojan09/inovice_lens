// Shared Playwright helpers. Playwright and Chromium are provided by the environment (not an
// npm dependency of this project); resolution falls back to the global install.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../../scripts/serve.js';

const localRequire = createRequire(import.meta.url);

function loadPlaywright() {
  try {
    return localRequire('playwright');
  } catch {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return createRequire(`${globalRoot}/`)('playwright');
  }
}

export const { chromium } = loadPlaywright();

export const fixture = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
export const readFixture = (name) => readFileSync(fixture(name));
export const axeSource = readFileSync(fileURLToPath(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url)), 'utf8');

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
  small: { width: 320, height: 700 },
};

export async function startApp() {
  const server = createStaticServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  return {
    base,
    browser,
    async newPage({ viewport = VIEWPORTS.desktop, colorScheme = 'light', ...opts } = {}) {
      const context = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1, ...opts });
      const page = await context.newPage();
      const problems = [];
      const requests = [];
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`); });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
      return { page, context, problems, requests };
    },
    async close() {
      await browser.close();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Run axe-core inside the page. Injected through CDP evaluate, so the page CSP stays enforced. */
export async function runAxe(page) {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  });
}

/** Relative luminance 0..1 of the computed background of a selector. */
export async function bgLuminance(page, selector) {
  return page.$eval(selector, (el) => {
    const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g).map(Number);
    const [r, g, b] = m.slice(0, 3).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  });
}

export async function hasHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

export async function dismissToasts(page) {
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
}
