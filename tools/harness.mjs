// Test harness: opens www/index.html in headless Chromium with a small debug hook patched in.
// The hook only exists in the temporary copy this file writes. The shipped game has no test code in it.
//
//   Needs a Chromium/Chrome binary: set CHROME_PATH=/path/to/chrome   (or run `npx playwright-core install chromium`)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEEDLE = "showOverlay('menu');hud();requestAnimationFrame(loop);\n})();";
const HOOK = `showOverlay('menu');hud();if(!window.__noLoop)requestAnimationFrame(loop);
window.__bb={
  step(dt){update(dt)}, frame(dt){update(dt);draw(dt)},
  get state(){return state}, get lives(){return lives}, get S(){return S}, get cannon(){return cannon},
  get blobs(){return blobs}, get dealt(){return dealt}, get total(){return total}, get queue(){return queue},
  get combo(){return combo}, get earned(){return earned}, get inv(){return inv}, get themeId(){return theme.id},
  get ovKind(){return ovKind}, get paused(){return state==='paused'},
  startLevel(n){ if(n) S.level=n; startLevel(); }, setFiring(v){firing=v;fired=true}, setTx(x){cannon.tx=x},
  setThemeById(id){S.set.bg=id;pickTheme();}, openSettings, closeSettings, goBack, toMenu,
  setExit(fn){exitApp=fn},
  fireRate, damage, levelHP, THEMES, GROUND, LW, LH, G, RAD, BOUNCE, levelPlayed(){return levelPlayed}
};
})();`;

export async function launch({ width = 360, height = 640, dpr = 1, manualLoop = true } = {}) {
  const src = fs.readFileSync(path.join(root, 'www/index.html'), 'utf8');
  if (!src.includes(NEEDLE)) throw new Error('harness: could not find the end of the game script to patch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'));
  fs.writeFileSync(path.join(dir, 'index.html'), src.replace(NEEDLE, HOOK));
  fs.cpSync(path.join(root, 'www/fonts'), path.join(dir, 'fonts'), { recursive: true });

  // Serve over http://127.0.0.1 like a real origin (the Android app serves from https://localhost), not file://
  const types = { '.html': 'text/html', '.woff2': 'font/woff2', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/$/, '/index.html'));
    if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox', '--disable-background-networking', '--disable-sync', '--no-first-run'] });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url()));
  if (manualLoop) await page.addInitScript(() => { window.__noLoop = true; });
  // start from a clean save once per tab (window.name survives a reload, so persistence can be tested)
  await page.addInitScript(() => { try { if (window.name !== '__bbinit') { localStorage.clear(); window.name = '__bbinit'; } } catch (e) {} });
  await page.goto(url);
  await page.addScriptTag({ path: path.join(root, 'tools/bot.js') });
  await page.evaluate(() => document.fonts.ready);
  return { browser, page, problems, close: async () => { await browser.close(); server.close(); } };
}
