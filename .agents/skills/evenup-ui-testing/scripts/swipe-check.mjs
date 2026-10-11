// EvenUp swipe check: sends REAL touch swipes (Chrome DevTools touch events) to a swipeable area and reports
// whether its content changed. Mouse drags do NOT trigger React Native's touch responder, so a mouse-based test
// says "swipe broken" even when it works.
//
// Checks, for the area with data-testid=<content>:
//   - swiping left moves to the next tab (content changes), N times
//   - swiping right comes back
//   - a vertical drag does NOT change the tab
//   - the page URL never changes (web must not treat a right swipe as browser "back")
//
// Usage (dev server running with EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:9 on port 8099):
//   node swipe-check.mjs --path group/3 --content group-tab-content [--swipes 3] [--base …] [--chrome …]
//   node swipe-check.mjs --path group/3/member/8 --content member-activity-content
// Exit code 1 if any check fails.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

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
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const base = opt('--base', 'http://localhost:8099').replace(/\/+$/, '');
const path = screenPath(opt('--path', '/group/3'));
const testId = opt('--content', 'group-tab-content');
const swipes = Number(opt('--swipes', '3'));
const chromePath = opt('--chrome', process.env.CHROME || undefined);

const browser = await chromium.launch(chromePath ? { executablePath: chromePath } : {});
const ctx = await browser.newContext({ viewport: { width: 400, height: 1600 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
await page.goto(base, { waitUntil: 'networkidle' });
const start = page.getByText('Get started');
if (await start.isVisible({ timeout: 60000 }).catch(() => false)) {
  await page.locator('input').first().fill('Tester');
  await start.tap();
  await page.getByText('Your groups').waitFor({ timeout: 30000 });
}
await page.goto(base + path, { waitUntil: 'networkidle' });
const content = page.locator(`[data-testid="${testId}"]`);
await content.waitFor({ timeout: 30000 });
await page.waitForTimeout(800);

const cdp = await ctx.newCDPSession(page);
const snapshot = async () => (await content.innerText()).slice(0, 120);
const touch = async (dx, dy = 0) => {
  const b = await content.boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + Math.min(80, b.height / 2);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 12, y: y + (dy * i) / 12 + i * 0.5 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(800);
};

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failed++;
};
const url = page.url();
const seen = [await snapshot()];
for (let i = 1; i <= swipes; i++) {
  await touch(-220);
  const now = await snapshot();
  check(now !== seen[seen.length - 1], `swipe left #${i} changes the tab`);
  seen.push(now);
}
await touch(220);
check((await snapshot()) === seen[seen.length - 2], 'swipe right goes back one tab');
check(page.url() === url, 'URL unchanged (no browser back on swipe)');
const before = await snapshot();
await touch(6, 220);
check((await snapshot()) === before, 'vertical drag keeps the tab');
await browser.close();
process.exit(failed ? 1 : 0);
