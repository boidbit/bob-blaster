// Builds the Google Play listing graphics into ./store:
//   icon-512.png (512x512), feature-graphic.png (1024x500), phone-1..4.png (1080x1920 screenshots from the real game)
// Run: CHROME_PATH=/path/to/chrome node tools/store-assets.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'store'); fs.mkdirSync(out, { recursive: true });

// ---- 1. gameplay screenshots (360x640 CSS px at 3x = 1080x1920)
const { page, close } = await launch({ width: 360, height: 640, dpr: 3 });
const frames = (n) => page.evaluate((n) => { for (let i = 0; i < n; i++) window.__bb.frame(1 / 60); }, n);
const shot = async (n) => { await page.waitForTimeout(500); await page.screenshot({ path: path.join(out, n + '.png') }); };
const play = (level, theme, seconds) => page.evaluate(({ level, theme, seconds }) => {
  const bb = window.__bb; bb.setThemeById(theme); bb.startLevel(level); bb.setFiring(true);
  const r = window.__bot.makeRunner(); while (r.t < seconds && bb.state === 'play') r.step(true);
}, { level, theme, seconds });
const themes = await page.evaluate(() => window.__bb.THEMES.map((t) => t.id));

await page.evaluate((id) => window.__bb.setThemeById(id), themes[0]); await frames(40);
await shot('phone-1');                                   // menu
await play(6, themes[1 % themes.length], 11); await shot('phone-2');   // mid-level action
await play(12, themes[2 % themes.length], 9); await shot('phone-3');   // bigger level, other background
// cannon power-up card
await page.evaluate((id) => { window.__bb.setThemeById(id); }, themes[3 % themes.length]);
await page.evaluate(() => { const bb = window.__bb; bb.startLevel(4); bb.setFiring(true); const r = window.__bot.makeRunner(); while (bb.state !== 'clear' && bb.state !== 'over' && r.t < 400) r.step(true); });
await frames(5); await shot('phone-4');
await close();

// ---- 2. icon + feature graphic
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
const fonts = pathToFileURL(path.join(root, 'www/fonts')).href;
const icon = fs.readFileSync(path.join(root, 'assets/icon-only.png')).toString('base64');
let p = await b.newPage({ viewport: { width: 512, height: 512 } });
await p.setContent(`<body style="margin:0"><img src="data:image/png;base64,${icon}" width="512" height="512" style="display:block"></body>`);
await p.screenshot({ path: path.join(out, 'icon-512.png') }); await p.close();

const woff = (f) => fs.readFileSync(path.join(root, 'www/fonts', f)).toString('base64');
const fontFile = fs.readdirSync(path.join(root, 'www/fonts')).find((f) => /lilita/i.test(f) && f.endsWith('.woff2'));
p = await b.newPage({ viewport: { width: 1024, height: 500 } });
await p.setContent(`<style>
@font-face{font-family:L;src:url(data:font/woff2;base64,${woff(fontFile)})}
body{margin:0;width:1024px;height:500px;overflow:hidden;position:relative;background:radial-gradient(90% 120% at 25% 30%,#43286f,#15101F 70%);font-family:L}
.t{position:absolute;left:70px;top:120px;color:#FFF3E2;font-size:118px;line-height:.95;letter-spacing:2px;text-shadow:0 6px 0 #1A0A2A,0 0 30px #FF5E9C80}
.t b{color:#FFD23F;font-weight:400;display:block}
.s{position:absolute;left:74px;top:384px;color:#3FB7F0;font-size:34px;letter-spacing:3px}
img{position:absolute;right:50px;top:35px;width:430px;height:430px;object-fit:cover;border-radius:50%}
</style><div class="t">BLOB<b>BLASTER</b></div><div class="s">TAP. SHOOT. POP!</div>
<img src="data:image/png;base64,${fs.readFileSync(path.join(root, 'assets/icon-foreground.png')).toString('base64')}">`);
await p.waitForTimeout(300);
await p.screenshot({ path: path.join(out, 'feature-graphic.png') });
await b.close();
console.log(fs.readdirSync(out).join('\n'));
