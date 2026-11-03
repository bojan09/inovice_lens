import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, fixture, readFixture, VIEWPORTS, runAxe, bgLuminance, hasHorizontalOverflow } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

async function open(opts) {
  const ctx = await app.newPage(opts);
  await ctx.page.goto(app.base);
  await ctx.page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…'); // main.js has run
  return ctx;
}
/** Emulate an OS colour-scheme change and wait until the page has actually restyled. */
async function setOsScheme(page, scheme) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForFunction((s) => matchMedia(`(prefers-color-scheme: ${s})`).matches, scheme);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
const FOUR = ['sample.jpg', 'sample.png', 'sample.webp', 'sample.pdf'].map(fixture);
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
const FOUR_BUF = ['sample.jpg', 'sample.png', 'sample.webp', 'sample.pdf'].map((name) => ({ name, mimeType: MIME[name.split('.')[1]], buffer: readFixture(name) }));

// ---------------------------------------------------------------- navigation
test('navigation: 4 views work, aria-current follows, unavailable views say Coming in Phase N', async () => {
  const { page, problems, context } = await open();
  const expect = {
    convert: { h1: /Turn documents into editable files/, title: /^Convert/ },
    batch: { h1: /Batch Processing/, title: /^Batch Processing/, soon: 'Coming in Phase 5' },
    projects: { h1: /Saved Projects/, title: /^Saved Projects/, soon: 'Coming in Phase 5' },
    settings: { h1: /Settings/, title: /^Settings/, soon: 'Coming in Phase 6' },
  };
  for (const [id, e] of Object.entries(expect)) {
    await page.click(`.sidebar [data-nav="${id}"]`);
    assert.match(await page.locator(`#view-${id} h1:visible`).innerText(), e.h1);
    assert.match(await page.title(), e.title);
    assert.equal(await page.locator('.view:visible').count(), 1, `exactly one view visible for ${id}`);
    assert.equal(await page.getAttribute(`.sidebar [data-nav="${id}"]`, 'aria-current'), 'page');
    assert.equal(await page.locator('.sidebar [aria-current="page"]').count(), 1);
    if (e.soon) assert.ok(await page.locator(`#view-${id} .chip`).innerText().then((t) => t === e.soon));
  }
  await page.goto(`${app.base}#/does-not-exist`);
  assert.equal(await page.locator('#view-convert').isVisible(), true);
  // Back/forward works with hash routes
  await page.click('.sidebar [data-nav="batch"]');
  await page.goBack();
  assert.equal(await page.locator('#view-convert').isVisible(), true);
  // Focus moves to <main> on route change for keyboard / screen-reader users
  await page.click('.sidebar [data-nav="settings"]');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'main');
  assert.deepEqual(problems, []);
  await context.close();
});

test('scope: English only, no language switcher and no fake storage number', async () => {
  const { page, context } = await open();
  const text = await page.locator('body').innerText();
  assert.doesNotMatch(text, /Language|Македонски|\bEN\b/);
  assert.equal(await page.locator('[lang]:not(html)').count(), 0);
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  const storage = await page.locator('#storage-value').innerText();
  assert.doesNotMatch(storage, /312/);
  assert.match(storage, /^(\d+(\.\d+)? (B|KB|MB|GB|TB) of \d+(\.\d+)? (KB|MB|GB|TB)|Not available in this browser)$/);
  await context.close();
});

// ---------------------------------------------------------------- theme
test('theme: light / dark / system, persisted across reload, no mixed surfaces', async () => {
  const { page, context } = await open({ colorScheme: 'light', reducedMotion: 'reduce' }); // no transitions in flight while sampling
  const surfaces = ['body', '.sidebar', '.topbar', '.dropzone', '.search'];
  const lum = async () => (await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))), Object.fromEntries(await Promise.all(surfaces.map(async (s) => [s, await bgLuminance(page, s)]))));

  // system + OS light
  assert.equal(await page.getAttribute('html', 'data-theme'), null);
  for (const v of Object.values(await lum())) assert.ok(v > 0.6, `light surface luminance ${v}`);

  // system follows OS change live
  await setOsScheme(page, 'dark');
  for (const [s, v] of Object.entries(await lum())) assert.ok(v < 0.1, `system->dark ${s} luminance ${v}`);
  await setOsScheme(page, 'light');

  // explicit dark, with OS = light
  await page.click('#theme-btn');
  assert.equal(await page.getAttribute('#theme-btn', 'aria-expanded'), 'true');
  await page.click('[data-theme-pref="dark"]');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  for (const [s, v] of Object.entries(await lum())) assert.ok(v < 0.1, `dark ${s} luminance ${v}`);
  assert.match(await page.getAttribute('#theme-btn', 'aria-label'), /^Theme: Dark/);

  await page.reload();
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark', 'survives refresh');
  for (const v of Object.values(await lum())) assert.ok(v < 0.1);

  // explicit light with OS = dark
  await setOsScheme(page, 'dark');
  await page.click('#theme-btn');
  await page.click('[data-theme-pref="light"]');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  for (const v of Object.values(await lum())) assert.ok(v > 0.6);
  await page.reload();
  assert.equal(await page.evaluate(() => localStorage.getItem('invoicelens.theme')), 'light');

  // back to system clears the stored preference
  await page.click('#theme-btn');
  await page.click('[data-theme-pref="system"]');
  assert.equal(await page.getAttribute('html', 'data-theme'), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('invoicelens.theme')), null);
  for (const v of Object.values(await lum())) assert.ok(v < 0.1, 'system + OS dark');
  await context.close();
});

test('theme: first paint already uses the stored theme (no flash)', async () => {
  const { page, context } = await app.newPage({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('invoicelens.theme', 'dark'));
  await page.goto(app.base, { waitUntil: 'commit' });
  await page.waitForSelector('html[data-theme="dark"]', { state: 'attached' });
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await context.close();
});

test('theme menu: keyboard operable, Escape returns focus to the button', async () => {
  const { page, context } = await open();
  await page.focus('#theme-btn');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#theme-menu').isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.themePref), 'system');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.themePref), 'dark');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#theme-menu').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'theme-btn');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await context.close();
});

// ---------------------------------------------------------------- intake
test('intake: real JPG, PNG, WebP and PDF are accepted, previewed and removable', async () => {
  const { page, problems, context } = await open();
  await page.setInputFiles('#file-input', FOUR);
  await page.waitForSelector('.file-card');
  assert.equal(await page.locator('.file-card').count(), 4);
  assert.equal(await page.locator('.reject-card').count(), 0);
  assert.equal(await page.locator('#files-count').innerText(), '(4)');
  const names = await page.locator('.file-card .file-name').allInnerTexts();
  assert.deepEqual(names, ['sample.jpg', 'sample.png', 'sample.webp', 'sample.pdf']);
  // image previews actually decode; PDF has no <img>
  const decoded = await page.$$eval('.file-card img', (imgs) => imgs.map((i) => i.complete && i.naturalWidth));
  assert.deepEqual(decoded, [480, 480, 480]);
  assert.equal(await page.locator('.file-card:has(.thumb-pdf) img').count(), 0);
  const meta = await page.locator('.file-card').nth(1).locator('.file-meta').innerText();
  assert.match(meta, /PNG.*KB.*480 × 640 px/s);

  // honest state: Convert is disabled and labelled, no success/converted claims
  assert.equal(await page.locator('#convert-btn').isDisabled(), true);
  assert.match(await page.locator('#convert-btn').innerText(), /Export/i);
  assert.doesNotMatch(await page.locator('#files-panel').innerText(), /converted successfully|exported|completed/i);

  // remove one
  await page.click('button[aria-label="Remove sample.png"]');
  assert.equal(await page.locator('.file-card').count(), 3);
  assert.equal(await page.locator('#files-count').innerText(), '(3)');
  // clear all hides the panel
  await page.click('#clear-all');
  assert.equal(await page.locator('#files-panel').isVisible(), false);
  assert.deepEqual(problems, []);
  await context.close();
});

test('intake: invalid inputs each get a specific, visible error', async () => {
  const { page, context } = await open();
  const png = readFixture('sample.png');
  await page.setInputFiles('#file-input', [
    { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'actually-png.jpg', mimeType: 'image/jpeg', buffer: png },
    { name: 'cut-off.png', mimeType: 'image/png', buffer: png.subarray(0, 200) },
    { name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is not a pdf') },
    { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.alloc(26 * 1024 * 1024)]) },
    { name: 'good.png', mimeType: 'image/png', buffer: png },
  ]);
  await page.waitForSelector('.file-card');
  assert.equal(await page.locator('.file-card').count(), 1);
  const rejects = await page.locator('.reject-card').allInnerTexts();
  assert.equal(rejects.length, 6);
  const joined = rejects.join('\n');
  assert.match(joined, /empty\.png[\s\S]*is empty/);
  assert.match(joined, /notes\.txt[\s\S]*Unsupported file type/);
  assert.match(joined, /actually-png\.jpg[\s\S]*extension says JPG but the content is PNG/);
  assert.match(joined, /cut-off\.png[\s\S]*damaged or incomplete/);
  assert.match(joined, /fake\.pdf[\s\S]*Unsupported file type/);
  assert.match(joined, /huge\.png[\s\S]*over the 25\.0? MB per-file limit|huge\.png[\s\S]*over the 25 MB/);
  // dismiss works
  await page.click('button[aria-label="Dismiss empty.png"]');
  assert.equal(await page.locator('.reject-card').count(), 5);
  // toast summarises
  assert.match(await page.locator('#toasts').innerText(), /1 file added, 6 not accepted/);
  await context.close();
});

test('intake: duplicate content is rejected; removing then re-adding works', async () => {
  const { page, context } = await open();
  await page.setInputFiles('#file-input', fixture('sample.png'));
  await page.waitForSelector('.file-card');
  await page.setInputFiles('#file-input', { name: 'renamed-copy.png', mimeType: 'image/png', buffer: readFixture('sample.png') });
  await page.waitForSelector('.reject-card');
  assert.match(await page.locator('.reject-card').innerText(), /Already added \(identical content to sample\.png\)/);
  assert.equal(await page.locator('.file-card').count(), 1);
  await page.click('button[aria-label="Remove sample.png"]');
  await page.setInputFiles('#file-input', fixture('sample.png'));
  await page.waitForFunction(() => document.querySelectorAll('.file-card').length === 1);
  await context.close();
});

test('intake: object URLs are revoked on remove, clear and pagehide', async () => {
  const { page, context } = await app.newPage();
  await page.addInitScript(() => {
    window.__urls = { created: [], revoked: [] };
    const c = URL.createObjectURL.bind(URL);
    const r = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (b) => { const u = c(b); window.__urls.created.push(u); return u; };
    URL.revokeObjectURL = (u) => { window.__urls.revoked.push(u); r(u); };
  });
  await page.goto(app.base);
  await page.setInputFiles('#file-input', FOUR);
  await page.waitForFunction(() => document.querySelectorAll('.file-card').length === 4);
  assert.equal(await page.evaluate(() => window.__urls.created.length), 3, 'one URL per image, none for the PDF');
  await page.click('button[aria-label="Remove sample.jpg"]');
  assert.equal(await page.evaluate(() => window.__urls.revoked.length), 1);
  await page.click('#clear-all');
  assert.deepEqual(await page.evaluate(() => [...window.__urls.revoked].sort()), await page.evaluate(() => [...window.__urls.created].sort()));
  await context.close();
});

test('intake: drag & drop (highlight, drop adds files) and clipboard paste', async () => {
  const { page, context } = await open();
  const dispatch = (type, withFiles) => page.evaluate(async ({ type, withFiles }) => {
    const dt = new DataTransfer();
    if (withFiles) {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    }
    const ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
    document.querySelector('#dropzone').dispatchEvent(ev);
    return ev.defaultPrevented;
  }, { type, withFiles });

  assert.equal(await dispatch('dragenter', true), true);
  assert.equal(await page.locator('#dropzone.is-dragover').count(), 1);
  await dispatch('dragleave', true);
  assert.equal(await page.locator('#dropzone.is-dragover').count(), 0);
  await dispatch('dragenter', true);
  await dispatch('drop', true);
  await page.waitForSelector('.file-card');
  assert.equal(await page.locator('#dropzone.is-dragover').count(), 0);
  assert.equal(await page.locator('.file-card .file-name').innerText(), 'dropped.png');

  // paste an image (e.g. screenshot)
  await page.evaluate(async () => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('.file-card').length === 2);
  assert.match(await page.locator('.file-card .file-name').nth(1).innerText(), /^pasted-\d+-1\.png$/);

  // pasting text into the search field must not be hijacked
  await page.focus('#search');
  await page.keyboard.insertText('abc');
  assert.equal(await page.inputValue('#search'), 'abc');
  await context.close();
});

test('search filters selected files and reports no match', async () => {
  const { page, context } = await open();
  await page.setInputFiles('#file-input', FOUR);
  await page.waitForFunction(() => document.querySelectorAll('.file-card').length === 4);
  await page.fill('#search', 'WEBP');
  assert.equal(await page.locator('.file-card:visible').count(), 1);
  await page.fill('#search', 'zzz');
  assert.equal(await page.locator('.file-card:visible').count(), 0);
  assert.equal(await page.locator('#no-match').isVisible(), true);
  await page.fill('#search', '');
  assert.equal(await page.locator('.file-card:visible').count(), 4);
  await context.close();
});

test('intake keyboard path: Browse Files is a real focusable button and opens the picker', async () => {
  const { page, context } = await open();
  await page.focus('#browse-btn');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles(fixture('sample.pdf'));
  await page.waitForSelector('.file-card');
  await context.close();
});

test('privacy: no network traffic beyond static assets, no console/CSP errors, no POST', async () => {
  const { page, requests, problems, context } = await open();
  await page.setInputFiles('#file-input', FOUR);
  await page.waitForFunction(() => document.querySelectorAll('.file-card').length === 4);
  await page.click('#clear-all');
  const origin = new URL(app.base).origin;
  const foreign = requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith('blob:') && !r.url.startsWith('data:'));
  assert.deepEqual(foreign, []);
  assert.deepEqual(requests.filter((r) => r.method !== 'GET'), []);
  assert.deepEqual(problems, []);
  await context.close();
});

test('CSP: inline script injection is blocked', async () => {
  const { page, context } = await open();
  const ran = await page.evaluate(() => new Promise((resolve) => {
    window.__csp = false;
    const s = document.createElement('script');
    s.textContent = 'window.__csp = true';
    document.head.append(s);
    setTimeout(() => resolve(window.__csp), 100);
  }));
  assert.equal(ran, false);
  await context.close();
});

test('XSS: hostile file names are rendered as text', async () => {
  const { page, context } = await open();
  const name = '"><img src=x onerror=alert(1)>.png';
  await page.setInputFiles('#file-input', { name, mimeType: 'image/png', buffer: readFixture('sample.png') });
  await page.waitForSelector('.file-card');
  assert.equal(await page.locator('.file-card .file-name').innerText(), name);
  assert.equal(await page.locator('.file-card .file-name img').count(), 0);
  await context.close();
});

// ---------------------------------------------------------------- responsive
test('responsive: structure per breakpoint (desktop sidebar, tablet drawer, mobile bottom nav)', async () => {
  // desktop
  let c = await open({ viewport: VIEWPORTS.desktop });
  assert.equal(await c.page.locator('.sidebar').isVisible(), true);
  assert.equal(await c.page.locator('#menu-btn').isVisible(), false);
  assert.equal(await c.page.locator('.bottom-nav').isVisible(), false);
  assert.equal(await c.page.locator('#search').isVisible(), true);
  const sb = await c.page.locator('.sidebar').boundingBox();
  assert.ok(sb.width >= 198 && sb.width <= 202, `sidebar width ${sb.width}`);
  const hb = await c.page.locator('.topbar').boundingBox();
  assert.equal(Math.round(hb.height), 56); // --header-h (border-box)
  await c.context.close();

  // tablet
  c = await open({ viewport: VIEWPORTS.tablet });
  const { page } = c;
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  assert.equal(await page.locator('.bottom-nav').isVisible(), false);
  assert.equal(await page.locator('#menu-btn').isVisible(), true);
  await page.click('#menu-btn');
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  assert.equal(await page.getAttribute('#menu-btn', 'aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.closest('#sidebar') !== null), true, 'focus moves into drawer');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.sidebar').classList.contains('is-open'));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-btn', 'focus returns');
  await page.click('#menu-btn');
  await page.click('.sidebar [data-nav="batch"]');
  await page.locator('#view-batch').waitFor({ state: 'visible' });
  await page.locator('#scrim').waitFor({ state: 'hidden' }); // drawer closes after navigating
  await page.click('#menu-btn');
  await page.mouse.click(740, 500); // scrim
  await page.waitForFunction(() => !document.querySelector('.sidebar').classList.contains('is-open'));
  await c.context.close();

  // mobile
  c = await open({ viewport: VIEWPORTS.mobile });
  assert.equal(await c.page.locator('.sidebar').isVisible(), false);
  assert.equal(await c.page.locator('.bottom-nav').isVisible(), true);
  assert.equal(await c.page.locator('#search').isVisible(), false);
  assert.match(await c.page.locator('h1:visible').innerText(), /Upload a document/);
  await c.page.click('.bottom-nav [data-nav="settings"]');
  await c.page.locator('#view-settings').waitFor({ state: 'visible' });
  assert.equal(await c.page.getAttribute('.bottom-nav [data-nav="settings"]', 'aria-current'), 'page');
  await c.context.close();
});

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  for (const scheme of ['light', 'dark']) {
    test(`responsive: no horizontal overflow at ${vpName} ${vp.width}x${vp.height} ${scheme} (empty, files, errors, every view)`, async () => {
      const { page, context } = await open({ viewport: vp, colorScheme: scheme });
      assert.equal(await hasHorizontalOverflow(page), false, 'empty convert');
      await page.setInputFiles('#file-input', [
        ...FOUR_BUF,
        { name: 'a-really-long-file-name-that-goes-on-and-on-and-on-and-on-and-on-and-on-and-on.png', mimeType: 'image/png', buffer: readFixture('sample.png').subarray(0, 100) },
      ]);
      await page.waitForSelector('.reject-card');
      assert.equal(await hasHorizontalOverflow(page), false, 'files + rejected');
      for (const id of ['batch', 'projects', 'settings']) {
        await page.goto(`${app.base}#/${id}`);
        assert.equal(await hasHorizontalOverflow(page), false, id);
      }
      await context.close();
    });
  }
}

test('touch targets on mobile are at least 44px', async () => {
  const { page, context } = await open({ viewport: VIEWPORTS.mobile });
  await page.setInputFiles('#file-input', [fixture('sample.png')]);
  await page.waitForSelector('.file-card');
  const selectors = ['.mobile-home [data-browse]', '#camera-btn', '#gallery-btn', '.mobile-home .tile >> nth=2',
    '.bn-link >> nth=0', '.bn-link >> nth=3', '#theme-btn', '#add-more', '#clear-all', '.file-card button[aria-label^="Remove"]'];
  for (const sel of selectors) {
    const box = await page.locator(sel).first().boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, `${sel} is ${box.width}x${box.height}`);
  }
  await context.close();
});

test('mobile inputs: camera and gallery controls open real pickers with the right constraints', async () => {
  const { page, context } = await open({ viewport: VIEWPORTS.mobile });
  assert.equal(await page.getAttribute('#camera-input', 'capture'), 'environment');
  assert.match(await page.getAttribute('#camera-input', 'accept'), /image/);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#gallery-btn')]);
  await chooser.setFiles(fixture('sample.webp'));
  await page.waitForSelector('.file-card');
  assert.equal(await page.locator('.file-card .file-name').innerText(), 'sample.webp');
  await context.close();
});

test('reduced motion: transitions are disabled', async () => {
  const { page, context } = await open({ reducedMotion: 'reduce' });
  const d = await page.$eval('.nav-link', (el) => getComputedStyle(el).transitionDuration);
  assert.ok(parseFloat(d) <= 0.001, `transition-duration ${d}`);
  await context.close();
});

// ---------------------------------------------------------------- accessibility
for (const [vpName, vp] of Object.entries({ desktop: VIEWPORTS.desktop, tablet: VIEWPORTS.tablet, mobile: VIEWPORTS.mobile })) {
  for (const scheme of ['light', 'dark']) {
    test(`axe-core: zero violations at ${vpName} ${scheme} (empty, files + errors, other views)`, async () => {
      const { page, context } = await open({ viewport: vp, colorScheme: scheme });
      assert.deepEqual(await runAxe(page), [], 'empty');
      await page.setInputFiles('#file-input', [...FOUR_BUF, { name: 'bad.png', mimeType: 'image/png', buffer: Buffer.alloc(0) }]);
      await page.waitForSelector('.reject-card');
      await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      assert.deepEqual(await runAxe(page), [], 'files + rejected');
      for (const id of ['batch', 'projects', 'settings']) {
        await page.goto(`${app.base}#/${id}`);
        assert.deepEqual(await runAxe(page), [], id);
      }
      await context.close();
    });
  }
}

test('axe-core: theme menu open and tablet drawer open', async () => {
  for (const scheme of ['light', 'dark']) {
    let c = await open({ viewport: VIEWPORTS.desktop, colorScheme: scheme });
    await c.page.click('#theme-btn');
    assert.deepEqual(await runAxe(c.page), [], `menu ${scheme}`);
    await c.context.close();
    c = await open({ viewport: VIEWPORTS.tablet, colorScheme: scheme });
    await c.page.click('#menu-btn');
    assert.deepEqual(await runAxe(c.page), [], `drawer ${scheme}`);
    await c.context.close();
  }
});
