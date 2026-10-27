#!/usr/bin/env node
// Records the takes of one short: Blob Blaster plays itself (tools/bot.js) in headless Chrome, stepped frame by frame
// at a steady 30 frames a second however slowly the frames are drawn. Each frame is the game's canvas, 1080x1920,
// piped to ffmpeg; what happens (pops, hearts, close calls, the end) is written beside it with frame numbers.
//
//   CHROME_PATH=/usr/bin/google-chrome node shorts/record.mjs --recipe recipe.json --out takes/
//   node shorts/record.mjs --recipe recipe.json --out takes/ --dry     the same takes in shorts/sim.mjs: events, no pictures
//
// The game is never changed: tools/harness.mjs loads a temporary copy with the shorts tap (shorts/tap.mjs) and its own
// debug hook patched in.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePatchedGame } from './tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = 1080, H = 1920, FPS = 30;
const MIN_PLAY = 75;   // seconds of play to cut a 30-50 s short from
const BATCH = 6;       // frames fetched from the page at a time

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
  return o;
}

function videoSize(file) {
  const p = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const [w, h] = (p.stdout || '').trim().split(',').map(Number);
  return { w: w || 0, h: h || 0 };
}

function writeEvents(file, events) {
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// ---------- players: the takes in Chrome (pictures and events), or in shorts/sim.mjs (events only) ----------
async function chromePlayer(out) {
  process.env.GAME_FILE = writePatchedGame();
  const { launch } = await import('../tools/harness.mjs');
  // 432x768 CSS px at 2.5x: the game caps its canvas at 2.5x, and at this size the canvas is exactly 1080x1920
  const { page, problems, close } = await launch({ width: 432, height: 768, dpr: 2.5 });
  await page.addScriptTag({ path: path.join(HERE, 'director.js') });
  return {
    problems, close,
    size: () => page.evaluate(() => window.__dir.size()),
    trials: (L, n, seed) => page.evaluate(({ L, n, seed }) => window.__dir.trials(L, n, seed, {}), { L, n, seed }),
    async take(t) {
      const avi = path.join(out, t.name + '.avi');
      fs.rmSync(avi, { force: true });
      const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'copy', '-an', avi],
        { stdio: ['pipe', 'inherit', 'inherit'] });
      const closed = new Promise((res) => ff.on('close', res));
      await page.evaluate((spec) => window.__dir.begin(spec), t);
      let done = false, frames = 0;
      while (!done) {
        const got = await page.evaluate((n) => {
          const cv = document.getElementById('cv'), imgs = [];
          let done = false;
          for (let i = 0; i < n && !done; i++) {
            done = window.__dir.frame(true);
            imgs.push(cv.toDataURL('image/jpeg', 0.92).slice(23));   // after "data:image/jpeg;base64,"
          }
          return { imgs, done };
        }, BATCH);
        for (const b64 of got.imgs) {
          if (!ff.stdin.write(Buffer.from(b64, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
        }
        frames += got.imgs.length;
        done = got.done;
        if (frames % 300 < BATCH) console.log(`  ${t.name}: frame ${frames}`);
      }
      ff.stdin.end();
      const code = await closed;
      const r = await page.evaluate(() => window.__dir.finish());
      if (code !== 0) throw new Error(`ffmpeg could not write ${avi}`);
      // a picture of another shape would come out stretched: stop here and say so, rather than make a bad short
      const sz = videoSize(avi);
      if (sz.w !== W || sz.h !== H) throw new Error(`take ${t.name} came out ${sz.w}x${sz.h}, not ${W}x${H}`);
      return r;
    },
  };
}

async function simPlayer() {
  const { makeGame } = await import('./sim.mjs');
  const { dir } = makeGame();
  return {
    problems: [], close: async () => {},
    size: async () => dir.size(),
    trials: async (L, n, seed) => dir.trials(L, n, seed, {}),
    take: async (t) => dir.play(t),
  };
}

// ---------- the takes of one short ----------
function want(t, r) {
  if (t.want === 'lives1') return r.events.some((e) => e.e === 'hurt' && e.lives === 1);
  if (t.want === 'giant') return r.events.some((e) => (e.e === 'pop' || e.e === 'win') && e.s === 3);
  if (t.want === 'over') return r.outcome === 'over';
  if (t.want === 'win') return r.outcome === 'win';
  return true;
}

// the level for the styles about the odds: the bot plays candidate levels a few times each, without pictures
async function pickLevel(player, stats, seed) {
  const rows = [];
  for (let L = stats.levels[0]; L <= stats.levels[1]; L++) {
    const r = await player.trials(L, stats.trials, seed + L * 101);
    r.pct = Math.round((100 * r.wins) / r.n);
    rows.push(r);
    console.log(`  level ${L}: the bot won ${r.wins} of ${r.n} (${r.pct}%)`);
  }
  const inRange = rows.filter((r) => r.pct >= stats.range[0] && r.pct <= stats.range[1]);
  const pool = inRange.length ? inRange : rows;
  pool.sort((a, b) => Math.abs(a.pct - stats.aim) - Math.abs(b.pct - stats.aim));
  return { rows, pick: pool[0] };
}

export async function recordShort(rec, player, out) {
  const sz = await player.size();
  if (sz.w !== W || sz.h !== H) throw new Error(`the game's canvas is ${sz.w}x${sz.h}, not ${W}x${H}: the short would be stretched`);
  console.log(`canvas ${sz.w}x${sz.h}`);

  if (rec.stats) {
    console.log('measuring the bot:');
    const { rows, pick } = await pickLevel(player, rec.stats, rec.seed % 100000);
    Object.assign(rec.stats, { results: rows, level: pick.level, wins: pick.wins, tries: pick.n, pct: pick.pct });
    for (const t of rec.takes) if (t.level === 'pick') t.level = pick.level;
    console.log(`level ${pick.level}: the bot wins ${pick.wins} of ${pick.n}`);
  }

  const takes = [];
  let play = 0, n = rec.takes.length;
  const once = async (t) => {
    const t0 = Date.now();
    const r = await player.take(t);
    writeEvents(path.join(out, t.name + '.jsonl'), r.events);
    console.log(`take ${t.name}: level ${t.level}, ${t.theme}, ${r.outcome}, ${(r.frames / FPS).toFixed(1)} s of play, in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return r;
  };
  const record = async (t) => {
    let r = await once(t);
    for (let k = 0; k < (t.tries || 0) && !want(t, r); k++) {
      t.seed += 7919;
      console.log(`  no "${t.want}" in this one: again, seed ${t.seed}`);
      r = await once(t);
    }
    Object.assign(t, { frames: r.frames, outcome: r.outcome, got: want(t, r) });
    if (t.want === 'win' && !t.got) {
      // a speedrun level the bot could not clear is left out (its files too), not shown as cleared
      console.log(`  level ${t.level} not cleared: left out`);
      for (const ext of ['.avi', '.jsonl']) fs.rmSync(path.join(out, t.name + ext), { force: true });
      return;
    }
    takes.push(t);
    play += r.frames / FPS;
  };
  for (const t of rec.takes) await record(t);

  // a bot that loses early leaves too little to cut from: more takes, then the recipe is written back with them
  for (let extra = 0; play < MIN_PLAY && extra < 4; extra++) {
    const m = rec.more;
    if (!m) break;   // (a speedrun: its levels in order, nothing in between)
    const lastAttempt = takes.filter((t) => t.final).at(-1);
    if (m.attempt && lastAttempt && lastAttempt.outcome === 'win') break;   // it beat the level: that is the answer
    const r = Math.abs(Math.sin(rec.seed * 12.9898 + extra * 78.233)) % 1;
    let t;
    if (m.attempt && lastAttempt) {
      // one more attempt at the same level; it becomes the last word
      t = Object.assign({}, lastAttempt, { name: 't' + ++n, seed: lastAttempt.seed + 104729 * (extra + 1) });
      lastAttempt.final = false;
    } else {
      const [lo, hi] = m.levels || [2, 6];
      const base = takes[0] || rec.takes[0];
      const themes = m.themes || [base.theme];
      t = Object.assign({}, base, {
        name: 't' + ++n, level: lo + Math.floor(r * (hi - lo + 1)), seed: base.seed + 7919 * (extra + 3), theme: themes[extra % themes.length],
        bot: m.bot === 'shaky' ? { lapse: 0.35, dur: [0.35, 0.8], after: 4 } : { lapse: 0, dur: [0.3, 0.6], after: 0 },
        want: '', tries: 0, final: false,
      });
    }
    console.log(`only ${play.toFixed(0)} s of play so far: one more take`);
    const before = takes.length;
    await record(t);
    // a new take that is not an attempt goes before the last word, so the short still ends on it
    const fin = takes.findIndex((x) => x.final);
    if (takes.length > before && !t.final && fin >= 0 && fin < takes.length - 1) takes.splice(fin, 0, takes.pop());
  }
  if (!takes.length) throw new Error('no take was recorded');
  rec.takes = takes;
  console.log(`${takes.length} takes, ${play.toFixed(0)} s of play`);
  return rec;
}

async function main() {
  const o = args();
  if (!o.recipe || !o.out) throw new Error('use --recipe recipe.json --out takes/ [--dry]');
  const rec = JSON.parse(fs.readFileSync(o.recipe, 'utf8'));
  fs.mkdirSync(o.out, { recursive: true });
  const player = o.dry ? await simPlayer() : await chromePlayer(o.out);
  try {
    await recordShort(rec, player, o.out);
    fs.writeFileSync(o.recipe, JSON.stringify(rec, null, 1));
    if (player.problems.length) console.log('page said:\n  ' + player.problems.slice(0, 10).join('\n  '));
  } finally {
    await player.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e.stack || String(e));
    process.exit(1);
  });
}
