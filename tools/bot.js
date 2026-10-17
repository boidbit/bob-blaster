// Runs inside the page (injected by harness.mjs). A simple "decent player" used for balance checks and screenshots:
// it holds fire, looks 1.1s ahead at every bouncing blob, avoids spots where one would land, and likes to sit under big blobs.
// It reacts to what the world looked like 0.15s ago and can only move the cannon at 650 px/s, so it is not superhuman.
window.__bot = (() => {
  const B = () => window.__bb;
  function risk(b, x, H) {
    const { GROUND, LW, G, BOUNCE } = B();
    let bx = b.x, by = b.y, vx = b.vx, vy = b.vy; const r = b.r;
    for (let t = 0; t < H; t += 1 / 30) {
      vy += G / 30; bx += vx / 30; by += vy / 30;
      if (bx - r < 0 && vx < 0) { bx = r; vx = -vx; } if (bx + r > LW && vx > 0) { bx = LW - r; vx = -vx; }
      if (by + r > GROUND) { by = GROUND - r; vy = -BOUNCE[b.s]; }
      if (by - r < 0 && vy < 0) vy = -vy;
      const nx = Math.max(x - 16, Math.min(bx, x + 16)), ny = Math.max(GROUND - 32, Math.min(by, GROUND));
      const dx = bx - nx, dy = by - ny; if (dx * dx + dy * dy < r * r * 0.6) return t;
    }
    return Infinity;
  }
  function choose(snap, curX) {
    const { LW } = B(); let best = curX, bestScore = -1e9;
    for (let x = 24; x <= LW - 24; x += 12) {
      let sc = -Math.abs(x - curX) * 0.25;
      for (const b of snap) {
        const t = risk(b, x, 1.1); if (t < Infinity) sc -= 1000 / (1 + t * 4);
        if (Math.abs(x - b.x) < b.r + 6) sc += 10 + b.hp / 25;
      }
      if (sc > bestScore) { bestScore = sc; best = x; }
    }
    return best;
  }
  // One bot-controlled session. step() advances 1/60s. Use `until` to stop early (e.g. a screenshot moment).
  function makeRunner() {
    const hist = []; let t = 0, lastDec = -1, target = B().cannon.x; const dt = 1 / 60;
    return {
      get t() { return t; },
      step(render) {
        const bb = B();
        hist.push(bb.blobs.map(b => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: b.r, s: b.s, hp: b.hp })));
        if (hist.length > 9) hist.shift();
        if (t - lastDec >= 0.12) { lastDec = t; target = choose(hist[0], bb.cannon.x); }
        const d = target - bb.cannon.tx, m = 650 * dt; bb.setTx(bb.cannon.tx + Math.max(-m, Math.min(m, d)));
        render ? bb.frame(dt) : bb.step(dt); t += dt;
      }
    };
  }
  function playLevel(level, maxSeconds = 150) {
    const bb = B(); bb.startLevel(level); bb.setFiring(true);
    const r = makeRunner();
    while (bb.state !== 'clear' && bb.state !== 'over' && r.t < maxSeconds) r.step(false);
    return { won: bb.state === 'clear', seconds: r.t, heartsLost: 3 - bb.lives, progress: bb.dealt / bb.total };
  }
  return { makeRunner, playLevel };
})();
