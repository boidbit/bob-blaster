// Runs inside the page, next to tools/bot.js (shorts/record.mjs injects it; shorts/sim.mjs runs it in Node).
// Plays one take of a short: steps the game at 30 frames a second (two 1/60 s game steps a frame, as the game and
// the bot are used to), lets the bot in tools/bot.js drive the cannon, and writes down what happens, with frame
// numbers, for the editor. Needs the shorts tap (shorts/tap.mjs) and the harness hook (window.__bb).
window.__dir = (() => {
  const B = () => window.__bb, TAP = () => window.__tap;
  const FPS = 30, DT = 1 / 60;
  const W = 1080, H = 1920;

  function rngOf(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // the canvas must already be the size of the video: a picture of another shape would come out stretched
  function size() {
    const cv = document.getElementById('cv');
    return { w: cv.width, h: cv.height };
  }

  let T = null;

  // one take: { level, theme, seed, bot: { lapse, dur: [a, b], after }, max_time, tail_win, tail_over }
  function begin(spec) {
    Math.random = rngOf(spec.seed);   // the game's own dice, so a seed gives the same take again
    const bb = B();
    TAP().fresh();
    bb.setThemeById(spec.theme);
    bb.startLevel(spec.level);
    bb.setFiring(true);
    TAP().ev.length = 0;
    T = {
      spec, f: 0, ev: [], runner: window.__bot.makeRunner(), brng: rngOf(spec.seed * 31 + 7), lapse: 0, t: 0,
      end: -1, outcome: '', near: new Map(), lastHurt: -999, bot: Object.assign({ lapse: 0, dur: [0.3, 0.6], after: 0 }, spec.bot || {}),
    };
    note('start', { level: spec.level, theme: bb.themeId, lives: bb.lives, blobs: bb.queue.length, hp: Math.round(bb.total) });
    return { level: spec.level, theme: bb.themeId };
  }

  function note(k, o) {
    T.ev.push(Object.assign({ e: k, f: T.f }, o || {}));
  }

  // the bot now and then looks away for a moment (the tense and the fail takes): the cannon stays where it was going
  function gameStep() {
    const bb = B(), b = T.bot;
    if (T.lapse > 0) {
      T.lapse -= DT;
      bb.step(DT);
    } else {
      if (b.lapse > 0 && T.t >= b.after && T.brng() < b.lapse * DT) T.lapse = b.dur[0] + (b.dur[1] - b.dur[0]) * T.brng();
      T.runner.step(false);
    }
    T.t += DT;
  }

  // what the tap saw during the last frame, as events
  function collect() {
    const bb = B(), raw = TAP().ev.splice(0);
    let shots = 0;
    for (const x of raw) {
      if (x.k === 'shot') { shots++; continue; }
      if (x.k === 'pop') {
        note(x.last ? 'win' : 'pop', { s: x.s, hp: x.hp, x: Math.round(x.x), y: Math.round(x.y), c: x.c });
        if (x.last && T.end < 0) { T.end = T.f + Math.round(T.spec.tail_win * FPS); T.outcome = 'win'; }
      } else if (x.k === 'hurt') {
        T.lastHurt = T.f;
        note('hurt', { lives: x.lives, s: x.s, x: Math.round(x.x) });
      } else if (x.k === 'die') {
        note('over', { x: Math.round(x.x) });
        if (T.end < 0) { T.end = T.f + Math.round(T.spec.tail_over * FPS); T.outcome = 'over'; }
      } else if (x.k === 'clear') {
        note('clear', { lives: x.lives });
      }
    }
    if (shots) note('shot', { n: shots });
    closeCalls(bb);
    if (T.f % 6 === 0) note('tick', { lives: bb.lives, n: bb.blobs.length, left: bb.queue.length, p: +(bb.dealt / bb.total).toFixed(3) });
  }

  // a blob that comes within a whisker of the cannon and does not hit it (the same test the game uses for a hit)
  function closeCalls(bb) {
    const c = bb.cannon, G = bb.GROUND;
    const live = c.alive && bb.state === 'play' && bb.inv <= 0;
    for (const b of T.near.keys()) if (!bb.blobs.includes(b)) T.near.delete(b);
    for (const b of bb.blobs) {
      const nx = Math.max(c.x - 16, Math.min(b.x, c.x + 16)), ny = Math.max(G - 32, Math.min(b.y, G));
      const dx = b.x - nx, dy = b.y - ny, q = (dx * dx + dy * dy) / (b.r * b.r * 0.6);
      const m = T.near.get(b);
      if (q < 4) {
        if (!m) T.near.set(b, { q, f: T.f, ok: live });
        else {
          m.ok = m.ok && live;
          if (q < m.q) { m.q = q; m.f = T.f; }
        }
      } else if (m) {
        T.near.delete(b);
        if (m.ok && m.q > 1 && m.q < 2.4 && m.f - T.lastHurt > 15) {
          T.ev.push({ e: 'close', f: m.f, v: +((2.4 - m.q) / 1.4).toFixed(2), s: b.s, lives: bb.lives });
        }
      }
    }
  }

  // one video frame: two game steps, the events, and (if wanted) the picture. Returns whether the take is over.
  function frame(render = true) {
    for (let i = 0; i < 2; i++) gameStep();
    if (render) TAP().draw(1 / FPS);
    collect();
    T.f++;
    const done = (T.end >= 0 && T.f >= T.end) || T.f >= Math.round(T.spec.max_time * FPS);
    if (done && !T.outcome) T.outcome = 'time';
    return done;
  }

  function finish() {
    const ev = T.ev.slice().sort((a, b) => a.f - b.f);
    ev.push({ e: 'end', f: T.f, outcome: T.outcome, lives: B().lives });
    return { events: ev, frames: T.f, outcome: T.outcome };
  }

  // a whole take without pictures (for sim.mjs and for choosing levels)
  function play(spec) {
    begin(spec);
    while (!frame(false));
    return finish();
  }

  // how often the bot clears a level: n plays of it, no pictures
  function trials(level, n, seed, bot) {
    let wins = 0, secs = 0;
    for (let i = 0; i < n; i++) {
      const r = play({ level, theme: 'night', seed: seed + i * 7919, bot, max_time: 240, tail_win: 0, tail_over: 0 });
      if (r.outcome === 'win') { wins++; secs += r.frames / FPS; }
    }
    return { level, n, wins, secs: wins ? +(secs / wins).toFixed(1) : 0 };
  }

  return { W, H, FPS, size, begin, frame, finish, play, trials };
})();
