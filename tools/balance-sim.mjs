// Plays many levels with the bot in tools/bot.js and prints win rates. Used to tune the level difficulty curve (hpTarget in the game).
//   CHROME_PATH=/path/to/chrome node tools/balance-sim.mjs            (levels 1..50 sample, 20 runs each)
//   LEVELS=1,5,10 TRIALS=40 node tools/balance-sim.mjs
import { launch } from './harness.mjs';

const LEVELS = (process.env.LEVELS || '1,2,3,4,5,6,8,10,12,15,20,30,40,50').split(',').map(Number);
const TRIALS = Number(process.env.TRIALS || 20);
const { page, close } = await launch();
const rows = await page.evaluate(({ LEVELS, TRIALS }) => {
  const out = [];
  for (const L of LEVELS) {
    let wins = 0, secs = 0, hearts = 0, lostProg = 0, lost = 0;
    for (let i = 0; i < TRIALS; i++) {
      const r = window.__bot.playLevel(L);
      if (r.won) { wins++; secs += r.seconds; hearts += r.heartsLost; } else { lost++; lostProg += r.progress; }
    }
    out.push({ L, rate: window.__bb.fireRate(L), dmg: window.__bb.damage(L), win: wins / TRIALS, secs: wins ? secs / wins : 0, hearts: wins ? hearts / wins : 0, lostProg: lost ? lostProg / lost : 0 });
  }
  return out;
}, { LEVELS, TRIALS });
console.log('level  fire/s  dmg   win   clear time   hearts lost (wins)   progress when lost');
for (const r of rows) console.log(String(r.L).padStart(5), String(r.rate).padStart(7), String(r.dmg).padStart(5), `${(r.win * 100).toFixed(0)}%`.padStart(5), `${r.secs.toFixed(1)}s`.padStart(11), r.hearts.toFixed(2).padStart(14), `${(r.lostProg * 100).toFixed(0)}%`.padStart(22));
await close();
