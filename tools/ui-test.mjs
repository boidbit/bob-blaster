// End-to-end checks of the game UI in headless Chromium. Screenshots go to test-output/.
//   CHROME_PATH=/path/to/chrome node tools/ui-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './harness.mjs';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-output');
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : '  -> ' + extra}`); if (!ok) failed++; };

const { page, problems, close } = await launch({ width: 360, height: 640, dpr: 2 });
const text = (sel) => page.locator(sel).first().innerText().catch(() => '');
const shot = async (n) => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(out, n + '.png') }); };  // wait for the card's pop-in animation
const frames = (n, dt = 1 / 60) => page.evaluate(({ n, dt }) => { for (let i = 0; i < n; i++) window.__bb.frame(dt); }, { n, dt });
const botPlay = (level, seconds = 400) => page.evaluate(({ level, seconds }) => {
  const bb = window.__bb; bb.startLevel(level); bb.setFiring(true);
  const r = window.__bot.makeRunner(); while (bb.state !== 'clear' && bb.state !== 'over' && r.t < seconds) r.step(true);
  return { state: bb.state, lives: bb.lives };
}, { level, seconds });

// ---- boot + menu
check('fonts load from the app (offline)', await page.evaluate(() => document.fonts.check('20px "Lilita One"') && document.fonts.check('700 14px Figtree')));
check('menu shows PLAY LEVEL 1', (await text('#go')).includes('PLAY LEVEL 1'));
check('menu shows cannon stats 9 /sec and 1 /shot', (await text('.power')).replace(/\s+/g, ' ').includes('9 /sec') && (await text('.power')).replace(/\s+/g, ' ').includes('1 /shot'));
check('no upgrade shop anywhere', (await page.locator('.shop, .up, #up-rate, #up-dmg, .price').count()) === 0 && !(await page.content()).includes('UPGRADES'));
await frames(30); await shot('01-menu');

// ---- level 1 start
await page.click('#go');
check('PLAY starts level 1', await page.evaluate(() => window.__bb.state === 'play' && document.getElementById('ov').hidden));
await frames(120);
await page.evaluate(() => { window.__bb.setFiring(true); }); await frames(1);

// ---- clear screen shows what the cannon gains (level 3 -> 4 raises fire rate, level 4 -> 5 doubles damage)
let r = await botPlay(3); await frames(5);
check('level 3 cleared by the bot', r.state === 'clear', JSON.stringify(r));
let t = (await text('.card')).replace(/\s+/g, ' ');
check('clear card says CANNON POWER UP! with 9 -> 10 fire rate', t.includes('CANNON POWER UP!') && t.includes('9') && t.includes('10 /sec'), t);
check('clear card has Level 3 ribbon, stars, coins, NEXT', t.includes('LEVEL 3') && t.includes('NEXT') && (await page.locator('.stars svg').count()) === 3);
await shot('02-clear-powerup');
r = await botPlay(4); await frames(5);
t = (await text('.card')).replace(/\s+/g, ' ');
check('level 4 -> 5 shows damage 2 -> 4', r.state === 'clear' && (await page.locator('.pw.up').count()) >= 1 && t.includes('4 /shot'), t);
await page.click('#go');
check('NEXT starts the following level', await page.evaluate(() => window.__bb.state === 'play' && window.__bb.levelPlayed() === 5));

// ---- back button flow
await frames(60);
await page.evaluate(() => window.__bb.goBack());
check('back while playing pauses', await page.evaluate(() => window.__bb.state === 'paused') && (await text('.ribbon')).includes('PAUSED'));
await shot('03-paused');
await page.evaluate(() => window.__bb.goBack());
check('back again resumes', await page.evaluate(() => window.__bb.state === 'play' && document.getElementById('ov').hidden));

// ---- game over (drive the cannon under the lowest blob and never shoot)
await page.evaluate(() => { const bb = window.__bb; bb.setFiring(false); bb.startLevel(2); });
await page.evaluate(() => {
  const bb = window.__bb; let n = 0;
  while (bb.state !== 'over' && n++ < 60 * 120) {
    const low = bb.blobs.slice().sort((a, b) => b.y - a.y)[0];
    if (low) bb.setTx(low.x);
    bb.frame(1 / 60);
  }
});
check('walking into blobs costs all 3 hearts and ends the level', await page.evaluate(() => window.__bb.state === 'over' && window.__bb.lives === 0), await page.evaluate(() => window.__bb.state + ' lives ' + window.__bb.lives));
t = (await text('.card')).replace(/\s+/g, ' ');
check('game over card: OUT OF HEARTS, tip, RETRY, no shop', t.includes('OUT OF HEARTS') && t.includes('RETRY') && (await page.locator('.tip').count()) === 1 && (await page.locator('.shop').count()) === 0, t);
await shot('04-over');
await page.evaluate(() => window.__bb.goBack());
check('back from game over goes to the menu', await page.evaluate(() => window.__bb.state === 'menu' && window.__bb.ovKind === 'menu'));
let exited = 0; await page.evaluate(() => window.__bb.setExit(() => { window.__exited = (window.__exited || 0) + 1; }));
await page.evaluate(() => window.__bb.goBack());
check('back on the menu exits the app', (await page.evaluate(() => window.__exited || 0)) === 1);

// ---- settings
await page.click('#gear'); await frames(5);
check('gear opens settings', (await text('.ribbon')).includes('SETTINGS'));
await shot('05-settings');
await page.click('#t-sfx');
check('sound switch turns off and is saved', await page.evaluate(() => window.__bb.S.set.sfx === false && JSON.parse(localStorage.getItem('blobblaster.v2')).set.sfx === false));
await page.click('#t-sfx');
await page.click('#bg-lava');
check('picking Lava Land changes the background', await page.evaluate(() => window.__bb.themeId === 'lava'));
await page.click('#bg-random');
check('Random background is selectable', await page.evaluate(() => window.__bb.S.set.bg === 'random'));
await page.click('#go');
check('DONE returns to the menu', await page.evaluate(() => window.__bb.ovKind === 'menu'));

// ---- progress is saved, old saves still load, reset works
await page.evaluate(() => { window.__bb.S.level = 12; window.__bb.S.best = 12; window.__bb.S.coins = 321; localStorage.setItem('blobblaster.v2', JSON.stringify(window.__bb.S)); });
await page.reload(); await page.addScriptTag({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'bot.js') });
check('reload keeps level 12 and coins', await page.evaluate(() => window.__bb.S.level === 12 && window.__bb.S.coins === 321), await page.evaluate(() => JSON.stringify(window.__bb.S) + ' | ls=' + localStorage.getItem('blobblaster.v2')));
await page.evaluate(() => localStorage.setItem('blobblaster.v2', JSON.stringify({ level: 7, coins: 50, rate: 5, dmg: 4, best: 7, set: {} })));
await page.reload();
check('an old save with manual upgrades loads, and the extra fields are dropped', await page.evaluate(() => window.__bb.S.level === 7 && !('rate' in window.__bb.S) && !('dmg' in window.__bb.S) && window.__bb.fireRate(7) === 11 && window.__bb.damage(7) === 5));
await page.click('#gear'); await page.click('#rs');
check('reset asks first', (await text('.danger')).includes('Delete your coins'));
await page.click('#rs-no'); await page.click('#rs'); await page.click('#rs-yes');
check('reset puts the game back to level 1 with 0 coins', await page.evaluate(() => window.__bb.S.level === 1 && window.__bb.S.coins === 0 && window.__bb.ovKind === 'menu'));

// ---- layout on other screens: nothing may overflow
for (const [w, h, name] of [[320, 568, 'small-phone'], [412, 915, 'tall-phone'], [768, 1024, 'tablet'], [915, 412, 'landscape']]) {
  await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(150); await frames(3);
  const m = await page.evaluate(() => {
    const st = document.getElementById('stage').getBoundingClientRect(), cd = document.querySelector('.card').getBoundingClientRect();
    return { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, iw: innerWidth, ih: innerHeight,
      stage: [st.left, st.top, st.right, st.bottom], card: [cd.left, cd.top, cd.right, cd.bottom] };
  });
  const insideScreen = m.stage[0] >= 0 && m.stage[1] >= 0 && m.stage[2] <= m.iw + 0.5 && m.stage[3] <= m.ih + 0.5;
  const cardInside = m.card[0] >= m.stage[0] && m.card[2] <= m.stage[2] && m.card[1] >= m.stage[1] && m.card[3] <= m.stage[3];
  check(`${name} ${w}x${h}: game fits the screen, no scrolling`, insideScreen && m.sw <= m.iw && m.sh <= m.ih, JSON.stringify(m));
  check(`${name}: menu card fits inside the play field`, cardInside, JSON.stringify(m));
  await shot('06-layout-' + name);
  // settings is the tallest panel: its DONE button must stay on screen and the list must scroll when it has to
  await page.click('#gear'); await page.waitForTimeout(350);
  const s = await page.evaluate(() => {
    const st = document.getElementById('stage').getBoundingClientRect(), g = document.getElementById('go').getBoundingClientRect(), c = document.querySelector('.card').getBoundingClientRect();
    return { stage: [st.left, st.top, st.right, st.bottom], go: [g.left, g.top, g.right, g.bottom], card: [c.left, c.top, c.right, c.bottom] };
  });
  check(`${name}: settings card and its DONE button stay inside the play field`, s.go[1] >= s.stage[1] && s.go[3] <= s.stage[3] && s.card[1] >= s.stage[1] - 0.5 && s.card[3] <= s.stage[3] + 0.5 && s.card[0] >= s.stage[0] && s.card[2] <= s.stage[2], JSON.stringify(s));
  await shot('07-settings-' + name);
  await page.click('#go');
}

check('no console errors, warnings or failed requests', problems.length === 0, problems.join(' | '));
await close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
