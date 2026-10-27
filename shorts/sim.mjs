#!/usr/bin/env node
// Plays Blob Blaster's real game code in plain Node, no browser: the page's script runs in a sandbox with a
// do-nothing stand-in for the page and the canvas (nothing is drawn). With the shorts tap, the harness hook,
// tools/bot.js and shorts/director.js on top, exactly as in the recording. Quick checks, and bot win rates.
//
//   node shorts/sim.mjs --check                          the tap, the bot and the director work on the current game
//   node shorts/sim.mjs --rates 5,10,20,30 --trials 10   how often the bot clears these levels
//   node shorts/sim.mjs --take '{"level":14,"seed":3}'   the events of one take
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ROOT, NEEDLE, patchGame } from './tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// anything at all: every property is another one of these, calling or constructing one gives another one,
// and as a number it is 0. Enough for the game's drawing and page calls to do nothing.
function anything() {
  const store = {};
  const p = new Proxy(function () {}, {
    get(t, k) {
      if (k in store) return store[k];
      if (k === Symbol.toPrimitive) return (hint) => (hint === 'number' ? 0 : '');
      if (k === 'then') return undefined;
      return (store[k] = anything());
    },
    set(t, k, v) {
      store[k] = v;
      return true;
    },
    apply: () => anything(),
    construct: () => anything(),
  });
  return p;
}

function element(extra = {}) {
  const e = anything();
  Object.assign(e, extra);
  return e;
}

// the harness's hook, read from tools/harness.mjs so there is one copy of it (that file needs playwright-core to import)
function harnessHook() {
  const src = fs.readFileSync(path.join(ROOT, 'tools/harness.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const m = src.match(/const HOOK = `([\s\S]*?)`;/);
  if (!m) throw new Error('sim: could not read the hook in tools/harness.mjs');
  return m[1];
}

export function makeGame() {
  const html = patchGame(fs.readFileSync(path.join(ROOT, 'www/index.html'), 'utf8'));
  let script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  if (!script.includes(NEEDLE)) throw new Error('sim: the game script has no end to hook');
  script = script.replace(NEEDLE, harnessHook());

  // the play field as the recorder sets it up: 432x768 CSS px at 2.5x, so the canvas is 1080x1920
  const els = {
    wrap: element({ clientWidth: 432, clientHeight: 768 }),
    cv: element({ width: 0, height: 0 }),
    stage: element(),
    ov: element({ hidden: true }),
  };
  const store = new Map();
  const ctx = {
    console, performance, Math, JSON, setTimeout, clearTimeout,
    devicePixelRatio: 2.5,
    __noLoop: true,
    document: Object.assign(anything(), {
      getElementById: (id) => els[id] || (els[id] = element()),
      querySelector: (q) => (q === '.hud' ? element({ offsetHeight: 58 }) : element()),
      createElement: () => element({ width: 0, height: 0 }),
      addEventListener() {},
      hidden: false,
    }),
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), clear: () => store.clear() },
    navigator: { vibrate() {} },
    addEventListener() {},
    requestAnimationFrame() {},
    getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0' }),
    ResizeObserver: class { observe() {} },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx, { filename: 'www/index.html' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'tools/bot.js'), 'utf8'), ctx, { filename: 'tools/bot.js' });
  vm.runInContext(fs.readFileSync(path.join(HERE, 'director.js'), 'utf8'), ctx, { filename: 'shorts/director.js' });
  return { ctx, dir: ctx.__dir, bb: ctx.__bb, els };
}

const TAKE = { level: 10, theme: 'night', seed: 1, bot: {}, max_time: 150, tail_win: 2.4, tail_over: 1.6 };

function summary(r) {
  const n = (k) => r.events.filter((e) => e.e === k).length;
  const pops = r.events.filter((e) => e.e === 'pop' || e.e === 'win');
  return { outcome: r.outcome, seconds: +(r.frames / 30).toFixed(1), pops: pops.length, giant: pops.filter((e) => e.s === 3).length,
    hurts: n('hurt'), close: n('close'), bestCombo: Math.max(0, ...pops.map((e) => e.c)), lowest: Math.min(3, ...r.events.filter((e) => e.e === 'hurt').map((e) => e.lives)) };
}

function check() {
  const { dir, els } = makeGame();
  const sz = dir.size();
  if (sz.w !== 1080 || sz.h !== 1920) throw new Error(`canvas came out ${sz.w}x${sz.h}, not 1080x1920`);
  let fails = 0;
  const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) fails++; };
  // an easy level: the pro bot clears it, and every kind of event shows up with sensible frame numbers
  const easy = dir.play(Object.assign({}, TAKE, { level: 3, seed: 11 }));
  const s1 = summary(easy);
  console.log('level 3:', JSON.stringify(s1));
  ok(easy.outcome === 'win', 'the bot clears level 3');
  ok(easy.events[0].e === 'start' && easy.events.at(-1).e === 'end', 'a take starts with start and ends with end');
  ok(easy.events.some((e) => e.e === 'clear'), 'the level-clear screen is reached in the tail');
  ok(easy.events.every((e, i, a) => i === 0 || a[i - 1].f <= e.f), 'events are in frame order');
  ok(s1.pops >= 3, 'pops are seen');
  // the same seed gives the same take
  const again = dir.play(Object.assign({}, TAKE, { level: 3, seed: 11 }));
  ok(JSON.stringify(again.events) === JSON.stringify(easy.events), 'the same seed plays the same take');
  // a bot that keeps looking away loses hearts, and in the end the cannon
  const bad = dir.play(Object.assign({}, TAKE, { level: 16, seed: 5, bot: { lapse: 1.5, dur: [0.6, 1.2], after: 3 } }));
  const s2 = summary(bad);
  console.log('level 16, careless bot:', JSON.stringify(s2));
  ok(s2.hurts >= 1, 'a careless bot gets hit');
  ok(bad.outcome === 'over' ? bad.events.some((e) => e.e === 'over') : true, 'a lost take has its game over');
  ok(els.cv.width === 1080, 'the canvas stays 1080 wide');
  if (fails) process.exit(1);
  console.log('sim check passed');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = process.argv.slice(2);
  const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  if (a.includes('--check')) check();
  else if (a.includes('--rates')) {
    const { dir } = makeGame();
    const n = Number(opt('--trials', 10));
    for (const L of opt('--rates').split(',').map(Number)) {
      const t0 = Date.now();
      const r = dir.trials(L, n, 1000 + L, {});
      console.log(`level ${String(L).padStart(2)}: ${r.wins}/${r.n} won (${Math.round((100 * r.wins) / r.n)}%), ${r.secs} s a win  [${((Date.now() - t0) / 1000).toFixed(1)} s]`);
    }
  } else if (a.includes('--take')) {
    const { dir } = makeGame();
    const r = dir.play(Object.assign({}, TAKE, JSON.parse(opt('--take', '{}'))));
    console.log(JSON.stringify(summary(r)));
    for (const e of r.events) if (e.e !== 'tick' && e.e !== 'shot') console.log(JSON.stringify(e));
  } else {
    console.log('use --check, --rates <levels> or --take <json>');
  }
}
