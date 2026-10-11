// EvenUp UI audit: renders screens of the web build at several phone sizes and reports layout problems.
//
//   - overlap:   two pieces of text drawn on top of each other
//   - offscreen: content sticking out past the left/right edge (causes sideways scrolling or cut-off buttons)
//   - target:    a tappable element smaller than 40×40 px
//   - hidden:    after scrolling to the end, content still covered by a bottom bar (the last item can't be reached)
//   - pageerror: a JavaScript error while rendering
// Text passing under a pinned bar mid-scroll and rows that scroll sideways on purpose are not reported.
// Screenshots go to <out>/<viewport>/<screen>.png for a human look.
//
// Every request outside the local dev server is blocked, so nothing reaches the production sync server.
// A fresh browser profile onboards as "Tester" and gets the three sample groups (group ids 1–3).
//
// Usage (dev server must be running: EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:9 npx expo start --web --port 8099):
//   node ui-audit.mjs --out <dir> [--base http://localhost:8099] [--chrome <path to chrome>] [screen ...]
// Screens are paths like group/3 or group/3/member/8 (leading slash optional; omit it in Git Bash) (default: a standard set). Exit code 1 if problems found.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright'); // install: npm i playwright (in a temp folder) and set NODE_PATH

// Git Bash on Windows rewrites arguments starting with "/" into Windows paths ("/group/3" -> "C:/Program Files/Git/group/3").
// Accept "group/3" (no leading slash) and refuse rewritten paths with a clear message.
const screenPath = (p) => {
  if (/^[A-Za-z]:[\/]/.test(p)) {
    console.error(`"${p}" looks like a path rewritten by Git Bash. Pass it without the leading slash (group/3) or set MSYS_NO_PATHCONV=1.`);
    process.exit(2);
  }
  return p.startsWith('/') ? p : '/' + p;
};

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const out = opt('--out', 'ui-audit-out');
const base = opt('--base', 'http://localhost:8099').replace(/\/+$/, '');
const chromePath = opt('--chrome', process.env.CHROME || undefined);
const screens = args.length
  ? args.map(screenPath)
  : ['/', '/group/3', '/group/3/expense', '/group/3/payment', '/group/3/members', '/group/3/member/8', '/group/3/settings', '/insights', '/settings', '/import', '/group/new'];

const VIEWPORTS = [
  { name: 'small-320x640', width: 320, height: 640 },
  { name: 'phone-360x780', width: 360, height: 780 },
  { name: 'large-412x915', width: 412, height: 915 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
];

// Runs in the page. mode 'layout': overlapping text, off-screen content, small tap targets.
// mode 'hidden' (after scrolling every list to its end): content still covered by a bottom bar, i.e. unreachable.
function inspect(mode) {
  const vw = document.documentElement.clientWidth;
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && r.width > 0 && r.height > 0;
  };
  const label = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('data-testid') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
  const ancestors = (el) => {
    const out = [];
    for (let a = el; a && a !== document.body; a = a.parentElement) out.push(a);
    return out;
  };
  // A bar pinned over the content (e.g. the bottom "+ Add expense" bar): content scrolling under it is normal.
  const overlayOf = (el) =>
    ancestors(el).find((a) => {
      const s = getComputedStyle(a);
      return s.position === 'fixed' || s.position === 'sticky' || (s.position === 'absolute' && s.bottom === '0px' && a.getBoundingClientRect().width > vw * 0.6);
    }) || null;
  // Inside a row that scrolls sideways on purpose (horizontal ScrollView of chips).
  const inSideScroller = (el) =>
    ancestors(el.parentElement || el).some((a) => {
      const s = getComputedStyle(a);
      return (s.overflowX === 'auto' || s.overflowX === 'scroll') && a.scrollWidth > a.clientWidth + 1;
    });
  // leaf text: elements with their own text and no element child that also has text
  const texts = [...document.querySelectorAll('body *')].filter(
    (el) => visible(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && !el.closest('svg')
  );
  const problems = [];
  const rects = texts.map((el) => ({ el, r: el.getBoundingClientRect(), overlay: overlayOf(el) }));
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i];
    if (mode === 'layout' && (a.r.right > vw + 1 || a.r.left < -1) && !inSideScroller(a.el)) {
      problems.push({ kind: 'offscreen', what: label(a.el), detail: `x ${Math.round(a.r.left)}–${Math.round(a.r.right)} of ${vw}` });
    }
    for (let j = i + 1; j < rects.length; j++) {
      const b = rects[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const crossesOverlay = a.overlay !== b.overlay;
      if (mode === 'layout' && crossesOverlay) continue; // content passing under a pinned bar mid-scroll
      if (mode === 'hidden' && !crossesOverlay) continue; // only overlay-vs-content matters at the end of the list
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      // small overlaps happen with line-height and emoji glyphs; report real collisions only
      if (w > 4 && h > 4 && w * h > 0.25 * Math.min(a.r.width * a.r.height, b.r.width * b.r.height)) {
        problems.push(
          mode === 'hidden'
            ? { kind: 'hidden', what: `"${label(a.overlay ? b.el : a.el)}" stays under "${label(a.overlay ? a.el : b.el)}" at the end of the list`, detail: 'add bottom padding so it can scroll clear' }
            : { kind: 'overlap', what: `"${label(a.el)}" ✕ "${label(b.el)}"`, detail: `${Math.round(w)}×${Math.round(h)}px` }
        );
      }
    }
  }
  if (mode === 'hidden') return problems;
  const targets = [...document.querySelectorAll('[role="button"], button, a[href], input, [tabindex="0"]')].filter(visible);
  for (const el of targets) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) {
      // padding/hitSlop may enlarge the real target; report as a warning to check by eye
      if (r.width * r.height < 40 * 24) problems.push({ kind: 'target', what: label(el), detail: `${Math.round(r.width)}×${Math.round(r.height)}px` });
    }
  }
  if (document.documentElement.scrollWidth > vw + 1) problems.push({ kind: 'offscreen', what: 'page', detail: `page scrolls sideways (${document.documentElement.scrollWidth}px > ${vw}px)` });
  return problems;
}

const browser = await chromium.launch(chromePath ? { executablePath: chromePath } : {});
let total = 0;
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true, isMobile: vp.width < 600 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await page.goto(base, { waitUntil: 'networkidle' });
  const start = page.getByText('Get started');
  if (await start.isVisible({ timeout: 60000 }).catch(() => false)) {
    await page.locator('input').first().fill('Tester');
    await start.click();
    await page.getByText('Your groups').waitFor({ timeout: 30000 });
  }
  mkdirSync(join(out, vp.name), { recursive: true });
  for (const path of screens) {
    errors.length = 0;
    await page.goto(base + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const problems = await page.evaluate(inspect, 'layout');
    // Scroll every vertical list to its end, then check nothing is stuck under a bottom bar.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        const s = getComputedStyle(el);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight;
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await page.waitForTimeout(400);
    problems.push(...(await page.evaluate(inspect, 'hidden')));
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    for (const e of errors) problems.push({ kind: 'pageerror', what: e.slice(0, 80), detail: '' });
    const file = join(out, vp.name, (path === '/' ? 'home' : path.replace(/^\//, '').replace(/[/[\]]/g, '_')) + '.png');
    await page.screenshot({ path: file, fullPage: true });
    const seen = new Set();
    const unique = problems.filter((p) => !seen.has(p.kind + p.what) && seen.add(p.kind + p.what));
    total += unique.filter((p) => p.kind !== 'target').length;
    console.log(`${vp.name} ${path}: ${unique.length ? '' : 'OK'}`);
    for (const p of unique) console.log(`   ${p.kind.padEnd(9)} ${p.what}  ${p.detail}`);
  }
  await ctx.close();
}
await browser.close();
console.log(total ? `\n${total} layout problem(s) (overlap/offscreen/hidden/pageerror). Screenshots in ${out}` : `\nNo overlap/offscreen/hidden problems. Screenshots in ${out}`);
process.exit(total ? 1 : 0);
