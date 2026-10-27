#!/usr/bin/env node
// Music for the Blob Blaster shorts, made from code: every drum, bass, chord and melody is synthesised here
// (no samples, nothing to license), in one of six styles, and fitted to the edit: a hook bar, a groove, a build,
// the drop on the big moment, and an end. (Taken from the Glass Run shorts in boidbit/glass-garden.) The editor
// (shorts/edit.py) also hands over cues to mix in: whooshes on transitions, impacts on big moments, a tape stop when
// a run fails, and the game's own sounds (g_pop, g_hurt, g_die, g_win, g_pew) where they happen in the cut, since the
// game's WebAudio sounds are not recorded.
//
//   node shorts/music.mjs --style phonk --bpm 140 --bars 22 --drop 12 --seed 7 --end hit --cues cues.json --game-db -3 --out music.wav
//   node shorts/music.mjs --demo <folder>      one of each style, to listen to
//
// styles: phonk, trap, edm, lofi, cinematic, synthwave.  end: hit (a last impact), loop (keeps going), fail (tape stop)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 48000;
const TAU = Math.PI * 2;
export const STYLES = ['phonk', 'trap', 'edm', 'lofi', 'cinematic', 'synthwave'];
export const BPM = { phonk: [128, 148], trap: [136, 156], edm: [122, 128], lofi: [74, 88], cinematic: [92, 108], synthwave: [100, 116] };

// ---------- small tools ----------
function rngOf(seed) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * r());
  r.pick = (xs) => xs[Math.floor(r() * xs.length)];
  r.chance = (p) => r() < p;
  return r;
}
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const N = (sec) => Math.max(1, Math.round(sec * SR));
let noise = rngOf(99);
const white = () => noise() * 2 - 1;

// a stereo bus: sounds are added at a time, with a gain and a place left to right
class Bus {
  constructor(n) {
    this.n = n;
    this.L = new Float32Array(n);
    this.R = new Float32Array(n);
  }
  add(snd, t, gain = 1, pan = 0) {
    const s0 = Math.round(t * SR);
    const a = (clamp(pan, -1, 1) + 1) * Math.PI / 4;
    const gl = gain * Math.cos(a) * Math.SQRT2, gr = gain * Math.sin(a) * Math.SQRT2;
    const L = snd.L || snd, R = snd.R || snd;
    const len = L.length;
    for (let i = Math.max(0, -s0); i < len; i++) {
      const j = s0 + i;
      if (j >= this.n) break;
      this.L[j] += L[i] * gl;
      this.R[j] += R[i] * gr;
    }
  }
  mix(o, gain = 1) {
    for (let i = 0; i < this.n; i++) {
      this.L[i] += o.L[i] * gain;
      this.R[i] += o.R[i] * gain;
    }
  }
  scale(fn) {
    for (let i = 0; i < this.n; i++) {
      const g = fn(i);
      this.L[i] *= g;
      this.R[i] *= g;
    }
  }
}

// a state-variable filter (lp, bp, hp); the cutoff can be a number, or a function of the sample number
function svf(x, mode, cut, q = 0.707) {
  const out = new Float32Array(x.length);
  const m = mode === 'lp' ? 0 : mode === 'bp' ? 1 : 2;
  const k = 1 / q;
  let ic1 = 0, ic2 = 0, g = 0, a1 = 0, a2 = 0, a3 = 0, last = -1;
  const fn = typeof cut === 'function';
  for (let i = 0; i < x.length; i++) {
    const c = fn ? cut(i) : cut;
    if (c !== last) {
      g = Math.tan(Math.PI * clamp(c, 10, SR * 0.45) / SR);
      a1 = 1 / (1 + g * (g + k));
      a2 = g * a1;
      a3 = g * a2;
      last = c;
    }
    const v3 = x[i] - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    out[i] = m === 0 ? v2 : m === 1 ? v1 : x[i] - k * v1 - v2;
  }
  return out;
}
const svfBus = (b, mode, cut, q) => {
  b.L = svf(b.L, mode, cut, q);
  b.R = svf(b.R, mode, cut, q);
};

function blep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

// an oscillator: sine, saw, square or tri; f is a number or a function of time
function osc(wave, f, dur, phase = 0) {
  const n = N(dur);
  const out = new Float32Array(n);
  const fn = typeof f === 'function';
  let ph = phase;
  for (let i = 0; i < n; i++) {
    const fi = fn ? f(i / SR) : f;
    const dt = fi / SR;
    let s;
    if (wave === 'sine') s = Math.sin(TAU * ph);
    else if (wave === 'saw') s = 2 * ph - 1 - blep(ph, dt);
    else if (wave === 'square') s = (ph < 0.5 ? 1 : -1) + blep(ph, dt) - blep((ph + 0.5) % 1, dt);
    else s = 4 * Math.abs(ph - 0.5) - 1;
    out[i] = s;
    ph += dt;
    if (ph >= 1) ph -= 1;
  }
  return out;
}

// attack, decay to sustain, held until `hold`, then release; times in seconds
function env(n, a, d, s, hold, rel) {
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v;
    if (t < a) v = t / a;
    else if (t < hold) v = s + (1 - s) * Math.exp(-(t - a) / Math.max(d, 1e-4));
    else {
      const h = s + (1 - s) * Math.exp(-(hold - a) / Math.max(d, 1e-4));
      v = h * Math.exp(-(t - hold) / Math.max(rel, 1e-4));
    }
    e[i] = v;
  }
  return e;
}
function mul(x, e, g = 1) {
  for (let i = 0; i < x.length; i++) x[i] *= e[i] * g;
  return x;
}
function addInto(a, b, g = 1) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) a[i] += b[i] * g;
  return a;
}
function drive(x, d) {
  const k = Math.tanh(d);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * d) / k;
  return x;
}
function noiseBuf(dur) {
  const x = new Float32Array(N(dur));
  for (let i = 0; i < x.length; i++) x[i] = white();
  return x;
}

// ---------- drums ----------
function kick({ dur = 0.45, f0 = 150, f1 = 48, pd = 0.04, decay = 0.3, click = 0.5, dr = 1.2 } = {}) {
  const n = N(dur);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f1 + (f0 - f1) * Math.exp(-t / pd);
    ph += f / SR;
    x[i] = Math.sin(TAU * ph) * Math.exp(-t / decay) + white() * click * Math.exp(-t / 0.0025);
  }
  return dr > 1 ? drive(x, dr) : x;
}
function snare({ tone = 185, decay = 0.13, bright = 4000, body = 0.5 } = {}) {
  const n = N(decay * 4);
  const nz = svf(noiseBuf(decay * 4), 'hp', 900);
  const x = svf(nz, 'lp', bright);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (tone * (1 + 0.5 * Math.exp(-t / 0.01))) / SR;
    x[i] = x[i] * Math.exp(-t / decay) * 0.8 + Math.sin(TAU * ph) * body * Math.exp(-t / 0.05);
  }
  return x;
}
function clap({ decay = 0.14, cut = 1200 } = {}) {
  const n = N(0.5);
  const raw = noiseBuf(0.5);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let e = 0;
    for (const o of [0, 0.011, 0.023]) if (t >= o) e = Math.max(e, Math.exp(-(t - o) / 0.007));
    if (t >= 0.03) e = Math.max(e, 0.7 * Math.exp(-(t - 0.03) / decay));
    raw[i] *= e;
  }
  return svf(raw, 'bp', cut, 1.2);
}
const HAT_F = [205.3, 304.4, 369.6, 522.7, 540, 800];
function hat({ decay = 0.035, open = false, cut = 7500 } = {}) {
  const dur = open ? 0.6 : 0.15;
  const n = N(dur);
  const x = new Float32Array(n);
  for (const f of HAT_F) addInto(x, osc('square', f * 1.6, dur, noise()), 0.12);
  for (let i = 0; i < n; i++) x[i] = x[i] * 0.6 + white() * 0.5;
  const y = svf(x, 'hp', cut);
  const d = open ? 0.2 : decay;
  for (let i = 0; i < n; i++) y[i] *= Math.exp(-i / SR / d);
  return y;
}
function cymbal(dur = 2.2) {
  const n = N(dur);
  const x = new Float32Array(n);
  for (const f of HAT_F) addInto(x, osc('square', f * 2.3, dur, noise()), 0.1);
  for (let i = 0; i < n; i++) x[i] = x[i] * 0.4 + white() * 0.6;
  const y = svf(x, 'hp', 4500);
  for (let i = 0; i < n; i++) y[i] *= Math.exp(-i / SR / (dur * 0.35)) * Math.min(1, i / 60);
  return y;
}
function tom(f = 90, decay = 0.45) {
  const n = N(decay * 3);
  const x = new Float32Array(n);
  let ph = 0;
  const nz = svf(noiseBuf(decay * 3), 'lp', 900);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (f * (1 + 0.8 * Math.exp(-t / 0.03))) / SR;
    x[i] = Math.sin(TAU * ph) * Math.exp(-t / decay) + nz[i] * 0.5 * Math.exp(-t / 0.05);
  }
  return drive(x, 1.6);
}
function cowbell(f, dur = 0.32) {
  const x = osc('square', f, dur, 0);
  addInto(x, osc('square', f * 1.48, dur, 0.3), 0.75);
  const y = svf(x, 'bp', f * 2.2, 1.6);
  const n = y.length;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    y[i] *= Math.min(1, t / 0.002) * (0.65 * Math.exp(-t / 0.05) + 0.35 * Math.exp(-t / (dur * 0.5)));
  }
  return y;
}
function rim() {
  const x = osc('sine', 1700, 0.06);
  addInto(x, osc('square', 820, 0.06), 0.4);
  for (let i = 0; i < x.length; i++) x[i] *= Math.exp(-i / SR / 0.012);
  return x;
}

// ---------- bass and keys ----------
function b808(freq, dur, { from = 0, glide = 0.07, decay = 1.2, dr = 2.5 } = {}) {
  const len = dur + 0.08;
  const n = N(len);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = from ? from * Math.pow(freq / from, Math.min(1, t / glide)) : freq;
    ph += f / SR;
    const a = Math.min(1, t / 0.004) * Math.exp(-t / decay) * (t > dur ? Math.exp(-(t - dur) / 0.02) : 1);
    x[i] = (Math.sin(TAU * ph) + 0.18 * Math.sin(2 * TAU * ph)) * a;
  }
  return drive(x, dr);
}
function subBass(freq, dur) {
  const x = osc('saw', freq, dur + 0.05);
  const y = svf(x, 'lp', freq * 4);
  addInto(y, osc('sine', freq, dur + 0.05), 0.8);
  return mul(y, env(y.length, 0.004, 0.12, 0.6, dur, 0.02));
}
// subtractive voice: a few detuned saws (or squares) through a low-pass that closes after the attack
function voice(freq, dur, { wave = 'saw', voices = 1, detune = 0.15, cut0 = 6000, cut1 = 800, cutDecay = 0.15, q = 0.9,
  a = 0.003, d = 0.2, s = 0.5, rel = 0.12, vib = 0 } = {}) {
  const len = dur + rel * 4;
  const n = N(len);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let v = 0; v < voices; v++) {
    const det = voices === 1 ? 0 : ((v / (voices - 1)) * 2 - 1) * detune;
    const f = freq * Math.pow(2, det / 12);
    const o = osc(wave, vib ? (t) => f * (1 + vib * Math.sin(TAU * 5.2 * t) * Math.min(1, t / 0.3)) : f, len, noise());
    const pan = voices === 1 ? 0 : ((v / (voices - 1)) * 2 - 1) * 0.8;
    const gl = Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2 / Math.sqrt(voices);
    const gr = Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2 / Math.sqrt(voices);
    addInto(L, o, gl);
    addInto(R, o, gr);
  }
  const cut = (i) => cut1 + (cut0 - cut1) * Math.exp(-i / SR / cutDecay);
  const e = env(n, a, d, s, dur, rel);
  return { L: mul(svf(L, 'lp', cut, q), e), R: mul(svf(R, 'lp', cut, q), e) };
}
// an electric piano: a little FM, a bell at the start, a slow wobble left to right
function rhodes(freq, dur) {
  const len = dur + 1.2;
  const n = N(len);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const I = 1.6 * Math.exp(-t / 0.22) + 0.25;
    const s = Math.sin(TAU * freq * t + I * Math.sin(TAU * freq * t)) + 0.08 * Math.sin(TAU * freq * 7.1 * t) * Math.exp(-t / 0.03);
    const e = Math.min(1, t / 0.003) * Math.exp(-t / 1.4) * (t > dur ? Math.exp(-(t - dur) / 0.25) : 1);
    const trem = 0.5 + 0.5 * Math.sin(TAU * 4.4 * t);
    L[i] = s * e * (0.75 + 0.25 * trem);
    R[i] = s * e * (1 - 0.25 * trem);
  }
  return { L, R };
}
// a bell or piano: a few partials, the high ones dying first
function bell(freq, dur, bright = 1) {
  const len = Math.min(dur + 1.5, 3);
  const n = N(len);
  const x = new Float32Array(n);
  const parts = [[1, 1, 1.3], [2, 0.45 * bright, 0.8], [3, 0.25 * bright, 0.5], [4.2, 0.12 * bright, 0.3], [5.4, 0.08 * bright, 0.2]];
  for (const [m, amp, d] of parts) {
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      x[i] += Math.sin(TAU * freq * m * t) * amp * Math.exp(-t / d);
    }
  }
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] *= Math.min(1, t / 0.002) * (t > dur + 0.3 ? Math.exp(-(t - dur - 0.3) / 0.2) : 1);
  }
  return x;
}
// a dark, huge brass hit, for the drop of the cinematic music
function braam(freq, dur = 2.4) {
  const v = voice(freq, dur, { voices: 5, detune: 0.18, cut0: 300, cut1: 300, a: 0.04, d: 1.0, s: 0.6, rel: 0.6 });
  const n = v.L.length;
  const cut = (i) => 250 + 2200 * Math.min(1, i / SR / 0.25) * Math.exp(-Math.max(0, i / SR - 0.25) / 0.9);
  v.L = drive(svf(v.L, 'lp', cut, 1.4), 1.8);
  v.R = drive(svf(v.R, 'lp', cut, 1.4), 1.8);
  const sub = osc('sine', freq / 2, n / SR);
  const e = env(n, 0.02, 1.2, 0.3, dur, 0.5);
  addInto(v.L, mul(sub, e), 0.6);
  addInto(v.R, sub, 0.6);
  return v;
}

// ---------- effects ----------
function riser(dur) {
  const n = N(dur);
  const L = noiseBuf(dur), R = noiseBuf(dur);
  const cut = (i) => 300 * Math.pow(30, i / n);
  const l = svf(L, 'bp', cut, 1.5), r = svf(R, 'bp', cut, 1.5);
  const tone = osc('saw', (t) => 160 * Math.pow(6, t / dur), dur);
  const tl = svf(tone, 'lp', 2500);
  for (let i = 0; i < n; i++) {
    const k = Math.pow(i / n, 2.2);
    l[i] = (l[i] + tl[i] * 0.25) * k;
    r[i] = (r[i] + tl[i] * 0.25) * k;
  }
  return { L: l, R: r };
}
function impact(dur = 2.5, low = 55) {
  const n = N(dur);
  const x = new Float32Array(n);
  let ph = 0;
  const nz = svf(noiseBuf(dur), 'lp', 1800);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (low * (1 + 1.4 * Math.exp(-t / 0.08))) / SR;
    x[i] = Math.sin(TAU * ph) * Math.exp(-t / 0.9) + nz[i] * Math.exp(-t / 0.25) * 0.8;
  }
  return drive(x, 1.5);
}
function whoosh(dur = 0.45, dir = 1) {
  const n = N(dur);
  const cut = (i) => {
    const k = Math.sin(Math.PI * i / n);
    return 400 + 5200 * k * k;
  };
  const L = svf(noiseBuf(dur), 'bp', cut, 1.1), R = svf(noiseBuf(dur), 'bp', cut, 1.1);
  for (let i = 0; i < n; i++) {
    const k = Math.pow(Math.sin(Math.PI * Math.pow(i / n, 0.8)), 2);
    const p = dir * ((i / n) * 2 - 1);
    L[i] *= k * (1 - 0.6 * p);
    R[i] *= k * (1 + 0.6 * p);
  }
  return { L, R };
}
function reverse(x) {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[x.length - 1 - i];
  return y;
}
function crackle(dur, rate = 9) {
  const n = N(dur);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = white() * 0.012;
    if (noise() < rate / SR) {
      const a = noise() * 0.5 + 0.1;
      for (let k = 0; k < 40 && i + k < n; k++) x[i + k] += (noise() * 2 - 1) * a * Math.exp(-k / 6);
    }
  }
  return svf(x, 'bp', 2500, 0.6);
}

// ---------- the game's own sounds ----------
// Blob Blaster's sounds are WebAudio oscillators and filtered noise (sfx in www/index.html); the same recipes here.
// p bends pitch and length together: below 1 (slow motion) deeper and longer.
function layer(...xs) {
  const out = new Float32Array(Math.max(...xs.map((x) => x.length)));
  for (const x of xs) addInto(out, x);
  return out;
}
function gTone(wave, f0, f1, dur, vol, p = 1) {
  dur /= p;
  const x = osc(wave, (t) => f0 * p * Math.pow(f1 / f0, clamp(t / dur, 0, 1)), dur + 0.02);
  for (let i = 0; i < x.length; i++) x[i] *= vol * Math.pow(1e-4 / vol, clamp(i / SR / dur, 0, 1));
  return x;
}
function gNoise(dur, vol, cut, p = 1) {
  dur /= p;
  const n = N(dur);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = white() * Math.max(0, 1 - (i * p) / (0.5 * SR));
  const y = svf(x, 'lp', cut * p, 1);
  for (let i = 0; i < n; i++) y[i] *= vol * Math.pow(1e-4 / vol, clamp(i / SR / dur, 0, 1));
  return y;
}
function gameSound(c) {
  const p = clamp(c.rate ?? 1, 0.4, 1.5);
  if (c.type === 'g_pew') return gTone('square', 1200, 600, 0.045, 0.014, p);
  if (c.type === 'g_pop') {
    const s = c.s || 0, f = (440 - s * 60) * (1 + Math.min(c.c || 1, 8) * 0.06);
    return layer(gNoise(0.18 + s * 0.06, 0.22 + s * 0.05, 1500 - s * 220, p), gTone('sine', f, 70, 0.22 + s * 0.05, 0.25, p));
  }
  if (c.type === 'g_hurt') return layer(gTone('saw', 260, 90, 0.3, 0.12, p), gNoise(0.2, 0.2, 600, p));
  if (c.type === 'g_die') return layer(gNoise(0.7, 0.4, 700, p), gTone('saw', 300, 40, 0.8, 0.15, p));
  if (c.type === 'g_win') {
    const out = new Float32Array(N((0.08 * 4 + 0.3) / p));
    [523, 659, 784, 1046, 1318].forEach((f, i) => {
      const x = gTone('tri', f, f, 0.28, 0.12, p), s0 = N((i * 0.08) / p);
      for (let k = 0; k < x.length && s0 + k < out.length; k++) out[s0 + k] += x[k];
    });
    return out;
  }
  return new Float32Array(1);
}
// how much a game sound pushes the music down for a moment, so it is heard
const DUCK = { g_pop: (c) => ((c.s || 0) >= 2 ? 0.25 : 0.1), g_hurt: () => 0.35, g_die: () => 0.5, g_win: () => 0.3 };

// a plain reverb (Freeverb: eight combs and four all-passes a side)
function reverb(bus, room = 0.82, damp = 0.35, wet = 1) {
  const sc = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const alls = [556, 441, 341, 225];
  const out = new Bus(bus.n);
  for (const [src, dst, spread] of [[bus.L, out.L, 0], [bus.R, out.R, 23]]) {
    const acc = new Float32Array(bus.n);
    for (const c of combs) {
      const len = Math.round((c + spread) * sc);
      const buf = new Float32Array(len);
      let idx = 0, store = 0;
      for (let i = 0; i < bus.n; i++) {
        const y = buf[idx];
        store = y * (1 - damp) + store * damp;
        buf[idx] = src[i] * 0.015 + store * room;
        acc[i] += y;
        if (++idx >= len) idx = 0;
      }
    }
    for (const a of alls) {
      const len = Math.round((a + spread) * sc);
      const buf = new Float32Array(len);
      let idx = 0;
      for (let i = 0; i < bus.n; i++) {
        const b = buf[idx];
        const y = -acc[i] + b;
        buf[idx] = acc[i] + b * 0.5;
        acc[i] = y;
        if (++idx >= len) idx = 0;
      }
    }
    for (let i = 0; i < bus.n; i++) dst[i] = acc[i] * wet;
  }
  return out;
}
function delay(bus, time, fb = 0.35, wet = 0.3) {
  const d = Math.round(time * SR);
  const out = new Bus(bus.n);
  for (let i = 0; i < bus.n; i++) {
    const l = i >= d ? out.R[i - d] * fb + bus.L[i - d] : 0;
    const r = i >= d ? out.L[i - d] * fb + bus.R[i - d] : 0;
    out.L[i] = l;
    out.R[i] = r;
  }
  for (let i = 0; i < bus.n; i++) {
    out.L[i] *= wet;
    out.R[i] *= wet;
  }
  return out;
}

// ---------- harmony and melody ----------
const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
};
const PROGS = {
  phonk: [[0, 0, 5, 5], [0, 1, 0, 6], [0, 5, 6, 4], [0, 0, 1, 1], [0, 6, 5, 6]],
  trap: [[0, 5, 3, 4], [0, 0, 5, 4], [0, 6, 5, 4], [0, 3, 5, 4]],
  edm: [[0, 5, 2, 6], [5, 3, 0, 4], [0, 3, 5, 4], [0, 6, 5, 6], [3, 4, 0, 0]],
  lofi: [[1, 4, 0, 0], [0, 3, 6, 2], [3, 2, 1, 0], [0, 5, 3, 4], [1, 4, 2, 5]],
  cinematic: [[0, 5, 3, 4], [0, 6, 5, 4], [0, 3, 0, 4], [0, 5, 6, 4]],
  synthwave: [[0, 5, 3, 6], [0, 6, 5, 6], [5, 3, 0, 4], [0, 3, 6, 5]],
};

class Song {
  constructor(o) {
    Object.assign(this, o);
    this.beat = 60 / this.bpm;
    this.stepDur = this.beat / 4;
    this.n = N(this.bars * 4 * this.beat);
    this.secs = [];
    for (let b = 0; b < this.bars; b++) {
      let s = 'groove';
      if (b === 0) s = 'intro';
      else if (b === this.drop - 1) s = 'build';
      else if (b >= this.drop) s = 'drop';
      if (b === this.bars - 1 && this.end !== 'loop' && b > this.drop) s = 'outro';
      this.secs.push(s);
    }
    this.kicks = [];
  }
  at(bar, step = 0) {
    const swing = step % 2 === 1 ? (this.swing || 0) * this.stepDur : 0;
    return (bar * 16 + step) * this.stepDur + swing;
  }
  sec(bar) {
    return this.secs[clamp(bar, 0, this.bars - 1)];
  }
  is(bar, ...names) {
    return names.includes(this.sec(bar));
  }
  deg(bar) {
    return this.prog[bar % this.prog.length];
  }
  // a scale step (0 = the key note, 7 = an octave up) as a note number, from the key note in `oct`
  note(idx, oct = 0) {
    const s = this.scale;
    const o = Math.floor(idx / 7);
    return this.root + 12 * (o + oct) + s[((idx % 7) + 7) % 7];
  }
  chord(bar, size = 3, oct = 0) {
    const d = this.deg(bar);
    const out = [];
    for (let k = 0; k < size; k++) out.push(this.note(d + 2 * k, oct));
    return out;
  }
  // a one-bar tune in scale steps over the chord: [{step, idx, len}]
  motif(density, grid = 1, lo = 0, hi = 9) {
    const r = this.r;
    const notes = [];
    let idx = r.int(2, 5);
    for (let s = 0; s < 16; s += grid) {
      const strong = s % 4 === 0;
      if (r() < (strong ? density + 0.2 : density - 0.1) || s === 0) {
        idx = clamp(idx + r.pick([-2, -1, -1, 0, 1, 1, 2, 3, -3, 4]), lo, hi);
        notes.push({ step: s, idx, len: grid });
      }
    }
    for (let i = 0; i < notes.length; i++) notes[i].len = Math.min(4, (i + 1 < notes.length ? notes[i + 1].step : 16) - notes[i].step);
    return notes;
  }
  // the tune for a bar: the motif moved onto this bar's chord, with a new ending every fourth bar
  tune(bar, A, B) {
    const m = (bar % 4 === 3 && B) ? B : A;
    const d = this.deg(bar);
    return m.map((x) => ({ ...x, idx: x.idx + d }));
  }
  sidechain(depth = 0.6, rel = 0.14) {
    const g = new Float32Array(this.n).fill(1);
    for (const t of this.kicks) {
      const s0 = Math.round(t * SR);
      for (let i = 0; i < N(rel * 4) && s0 + i < this.n; i++) {
        const v = 1 - depth * Math.exp(-i / SR / rel) * Math.min(1, i / 48 + 0.3);
        if (s0 + i >= 0) g[s0 + i] = Math.min(g[s0 + i], v);
      }
    }
    return (i) => g[i];
  }
}

// ---------- the styles ----------
// each fills drums, bass, keys (chords and pads), lead and fx buses, and says how the master filter moves
function phonk(S, B) {
  const r = S.r;
  const A = S.motif(0.62, 1, 0, 9), A2 = S.motif(0.62, 1, 0, 9);
  const kpat = r.pick([[0, 10], [0, 7, 10], [0, 3, 10, 11], [0, 6, 10]]);
  const bell = r.range(0.85, 1.15);
  for (let b = 0; b < S.bars; b++) {
    const sec = S.sec(b);
    // cowbell tune: the sound of phonk
    if (sec !== 'outro' || b === S.bars - 1) {
      for (const x of S.tune(b, A, A2)) {
        if (sec === 'outro' && x.step > 0) continue;
        const f = mtof(S.note(x.idx, 2)) * bell;
        B.lead.add(cowbell(f, sec === 'outro' ? 1.2 : 0.3), S.at(b, x.step), sec === 'drop' ? 0.34 : 0.28, (x.idx % 2 ? 0.25 : -0.25));
      }
    }
    if (sec === 'intro' || sec === 'outro') {
      B.bass.add(b808(mtof(S.note(S.deg(b), -2)), S.beat * 2.5, { dr: 3 }), S.at(b, 0), 0.75);
      B.drums.add(kick({ dur: 0.6, decay: 0.45, dr: 2 }), S.at(b, 0), 0.9);
      continue;
    }
    const full = sec === 'drop';
    if (sec === 'build') {
      for (let s = 0; s < 16; s += s < 8 ? 2 : 1) B.drums.add(snare({ decay: 0.08 }), S.at(b, s), 0.12 + 0.3 * (s / 16));
      continue;
    }
    for (const s of (full ? kpat : [0, 10])) {
      B.drums.add(kick({ dur: 0.5, decay: 0.35, dr: 2.2 }), S.at(b, s), 0.85);
      S.kicks.push(S.at(b, s));
    }
    for (const s of [4, 12]) B.drums.add(clap({ cut: 1300 }), S.at(b, s), 0.55);
    for (let s = 0; s < 16; s += 2) B.drums.add(hat({ decay: 0.03 }), S.at(b, s), s % 4 === 2 ? 0.16 : 0.1, 0.3);
    if (full && r.chance(0.5)) for (const s of [13, 14, 15]) B.drums.add(hat({ decay: 0.02 }), S.at(b, s), 0.1, 0.3);
    // 808 on the kicks, sliding into the next chord
    const root = mtof(S.note(S.deg(b), -2));
    const next = mtof(S.note(S.deg(b + 1), -2));
    if (full || sec === 'groove') {
      for (let k = 0; k < kpat.length; k++) {
        const s = kpat[k];
        const len = ((k + 1 < kpat.length ? kpat[k + 1] : 16) - s) * S.stepDur;
        const last = k === kpat.length - 1;
        B.bass.add(b808(last && next !== root && r.chance(0.5) ? next : root, len, { from: k === 0 ? 0 : root * 1.5, dr: full ? 3.5 : 2.2, glide: 0.05 }),
          S.at(b, s), full ? 0.6 : 0.45);
      }
    }
    if (full && (b - S.drop) % 4 === 0) B.fx.add(cymbal(2), S.at(b, 0), 0.25);
  }
  return { reverb: { drums: 0.06, lead: 0.28, keys: 0.3, bass: 0 }, side: 0.4 };
}

function trap(S, B) {
  const r = S.r;
  const A = S.motif(0.45, 2, 0, 8), A2 = S.motif(0.45, 2, 0, 8);
  const kpat = r.pick([[0, 6, 10], [0, 7, 11], [0, 3, 10], [0, 10, 13]]);
  for (let b = 0; b < S.bars; b++) {
    const sec = S.sec(b);
    const ch = S.chord(b, 3, 0);
    if (sec !== 'outro') for (const m of ch) B.keys.add(voice(mtof(m), S.beat * 4, { voices: 3, detune: 0.12, cut0: 1600, cut1: 900, a: 0.25, s: 0.8, rel: 0.4 }), S.at(b, 0), 0.08);
    for (const x of S.tune(b, A, A2)) {
      if (sec === 'outro' && x.step > 0) continue;
      B.lead.add(bell(mtof(S.note(x.idx, 1)), x.len * S.stepDur, 0.8), S.at(b, x.step), sec === 'drop' ? 0.2 : 0.16, 0.15);
    }
    if (sec === 'intro' || sec === 'outro') {
      B.bass.add(b808(mtof(S.note(S.deg(b), -2)), S.beat * 3, { dr: 2 }), S.at(b, 0), 0.8);
      B.drums.add(kick({ dur: 0.6, decay: 0.5 }), S.at(b, 0), 0.8);
      continue;
    }
    if (sec === 'build') {
      for (let s = 0; s < 16; s += s < 8 ? 2 : 1) B.drums.add(snare({ decay: 0.07 }), S.at(b, s), 0.1 + 0.3 * (s / 16));
      continue;
    }
    const full = sec === 'drop';
    for (const s of kpat) {
      B.drums.add(kick({ dur: 0.5, decay: 0.3 }), S.at(b, s), 0.8);
      S.kicks.push(S.at(b, s));
    }
    B.drums.add(clap({ cut: 1500 }), S.at(b, 8), 0.5);
    B.drums.add(snare({ decay: 0.12 }), S.at(b, 8), 0.35);
    // hats: eighths, with quick rolls now and then
    for (let s = 0; s < 16; s += 2) {
      if (full && r.chance(0.28)) {
        const n = r.pick([3, 4, 6]);
        for (let k = 0; k < n; k++) B.drums.add(hat({ decay: 0.018 }), S.at(b, s) + (k * 2 * S.stepDur) / n, 0.08 + 0.02 * k, 0.35);
      } else B.drums.add(hat({ decay: 0.03 }), S.at(b, s), 0.12, 0.35);
    }
    const root = mtof(S.note(S.deg(b), -2));
    for (let k = 0; k < kpat.length; k++) {
      const s = kpat[k];
      const len = ((k + 1 < kpat.length ? kpat[k + 1] : 16) - s) * S.stepDur;
      const glide = k > 0 && r.chance(0.35);
      B.bass.add(b808(glide ? root * 1.5 : root, len, { from: glide ? root : 0, dr: full ? 2.6 : 1.8, decay: 2 }), S.at(b, s), full ? 0.65 : 0.5);
    }
    if (full && (b - S.drop) % 4 === 0) B.fx.add(cymbal(2.2), S.at(b, 0), 0.22);
  }
  return { reverb: { drums: 0.05, lead: 0.3, keys: 0.35, bass: 0 }, side: 0.3 };
}

function edm(S, B) {
  const r = S.r;
  const A = S.motif(0.55, 1, 2, 10), A2 = S.motif(0.55, 1, 2, 10);
  const stab = r.pick([[0, 3, 6, 10, 12], [0, 3, 6, 8, 11, 14], [0, 2, 4, 6, 8, 10, 12, 14], [0, 6, 8, 14]]);
  for (let b = 0; b < S.bars; b++) {
    const sec = S.sec(b);
    const ch = S.chord(b, 4, 0);
    const root = S.note(S.deg(b), -2);
    if (sec === 'drop') {
      for (const s of stab) for (const m of ch) B.keys.add(voice(mtof(m), S.stepDur * 1.6, { voices: 7, detune: 0.22, cut0: 7000, cut1: 1500, cutDecay: 0.12, s: 0.4 }), S.at(b, s), 0.07);
      for (const x of S.tune(b, A, A2)) B.lead.add(voice(mtof(S.note(x.idx, 1)), x.len * S.stepDur, { voices: 5, detune: 0.16, cut0: 6000, cut1: 2000, cutDecay: 0.2, s: 0.5 }), S.at(b, x.step), 0.13);
    } else if (sec !== 'outro') {
      // the tune as a soft pluck before the drop
      for (const x of S.tune(b, A, A2)) B.lead.add(voice(mtof(S.note(x.idx, 1)), x.len * S.stepDur, { wave: 'square', cut0: 3500, cut1: 600, cutDecay: 0.08, s: 0.1, rel: 0.1 }), S.at(b, x.step), 0.11);
      for (const m of ch) B.keys.add(voice(mtof(m), S.beat * 4, { voices: 3, detune: 0.1, cut0: 1200, cut1: 1200, a: 0.3, s: 0.8, rel: 0.5 }), S.at(b, 0), 0.06);
    } else {
      for (const m of ch) B.keys.add(voice(mtof(m), S.beat * 3, { voices: 7, detune: 0.22, cut0: 6000, cut1: 900, cutDecay: 0.6, s: 0.5, rel: 0.8 }), S.at(b, 0), 0.08);
    }
    if (sec === 'intro' || sec === 'outro') {
      B.drums.add(kick({ decay: 0.4 }), S.at(b, 0), 0.9);
      continue;
    }
    if (sec === 'build') {
      for (let s = 0; s < 16; s++) {
        const every = s < 8 ? 4 : s < 12 ? 2 : 1;
        if (s % every === 0) B.drums.add(snare({ decay: 0.07, bright: 5000 }), S.at(b, s), 0.12 + 0.35 * (s / 16));
      }
      for (let s = 0; s < 8; s += 4) B.drums.add(kick(), S.at(b, s), 0.7);
      continue;
    }
    for (let s = 0; s < 16; s += 4) {
      B.drums.add(kick({ decay: 0.28, f0: 170 }), S.at(b, s), 0.9);
      S.kicks.push(S.at(b, s));
    }
    for (const s of [4, 12]) B.drums.add(clap(), S.at(b, s), 0.5);
    for (let s = 2; s < 16; s += 4) B.drums.add(hat({ open: true }), S.at(b, s), 0.11, 0.25);
    if (sec === 'drop') for (let s = 0; s < 16; s += 1) if (s % 4 !== 2) B.drums.add(hat({ decay: 0.02 }), S.at(b, s), 0.05, -0.3);
    for (let s = 2; s < 16; s += 4) B.bass.add(subBass(mtof(root), S.stepDur * 1.8), S.at(b, s), 0.55);
    if (sec === 'drop' && (b - S.drop) % 4 === 0) B.fx.add(cymbal(2.4), S.at(b, 0), 0.25);
  }
  return { reverb: { drums: 0.05, lead: 0.22, keys: 0.25, bass: 0 }, side: 0.7 };
}

function lofi(S, B) {
  const r = S.r;
  S.swing = 0.28;
  const A = S.motif(0.3, 2, 2, 9), A2 = S.motif(0.3, 2, 2, 9);
  for (let b = 0; b < S.bars; b++) {
    const sec = S.sec(b);
    const ch = S.chord(b, 4, 0);
    const late = r.chance(0.4) ? 1 : 0;
    for (let k = 0; k < ch.length; k++) B.keys.add(rhodes(mtof(ch[k]), S.beat * 3.6), S.at(b, late) + k * 0.012, 0.13);
    if (sec !== 'intro') for (const x of S.tune(b, A, A2)) {
      if (sec === 'outro' && x.step > 0) continue;
      B.lead.add(bell(mtof(S.note(x.idx, 1)), x.len * S.stepDur * 1.5, 0.6), S.at(b, x.step), 0.12, -0.2);
    }
    B.bass.add(mul(osc('sine', mtof(S.note(S.deg(b), -1)), S.beat * 2.8), env(N(S.beat * 2.8), 0.01, 0.6, 0.7, S.beat * 2.5, 0.08)), S.at(b, 0), 0.42);
    B.bass.add(mul(osc('sine', mtof(S.note(S.deg(b) + 4, -1)), S.beat * 1.2), env(N(S.beat * 1.2), 0.01, 0.4, 0.6, S.beat, 0.08)), S.at(b, 10), 0.32);
    if (sec === 'intro' || sec === 'outro' || sec === 'build') {
      if (sec === 'build') for (const s of [0, 4, 8, 12]) B.drums.add(rim(), S.at(b, s), 0.18);
      continue;
    }
    const full = sec === 'drop';
    for (const s of [0, 7, 10]) {
      if (!full && s === 7) continue;
      B.drums.add(kick({ decay: 0.25, f0: 120, f1: 50, click: 0.2 }), S.at(b, s), 0.7);
      S.kicks.push(S.at(b, s));
    }
    for (const s of [4, 12]) B.drums.add(snare({ decay: 0.1, bright: 3000, body: 0.35 }), S.at(b, s), 0.4);
    for (let s = 0; s < 16; s += 2) B.drums.add(hat({ decay: 0.03, cut: 6000 }), S.at(b, s), r.range(0.06, 0.12), 0.3);
  }
  B.fx.add(crackle(S.n / SR), 0, 0.9);
  return { reverb: { drums: 0.08, lead: 0.3, keys: 0.22, bass: 0 }, side: 0.25, warm: 7000 };
}

function cinematic(S, B) {
  const r = S.r;
  const A = S.motif(0.35, 2, 0, 8), A2 = S.motif(0.35, 2, 0, 8);
  const ost = r.pick([[0, 1, 2, 1], [0, 2, 1, 2], [0, 1, 2, 3]]);
  for (let b = 0; b < S.bars; b++) {
    const sec = S.sec(b);
    const ch = S.chord(b, 3, 0);
    for (const m of [ch[0] - 12, ...ch]) B.keys.add(voice(mtof(m), S.beat * 4, { voices: 3, detune: 0.1, cut0: 1400, cut1: 1400, a: 0.4, s: 0.9, rel: 0.6, vib: 0.004 }), S.at(b, 0), 0.06);
    if (sec === 'drop' || sec === 'groove' || sec === 'build') {
      // strings, short and quick on the chord
      for (let s = 0; s < 16; s++) {
        const m = ch[ost[s % 4] % ch.length] + (s % 8 >= 4 ? 12 : 0);
        B.lead.add(voice(mtof(m), S.stepDur * 0.8, { voices: 2, detune: 0.08, cut0: 3200, cut1: 1500, cutDecay: 0.05, s: 0.3, rel: 0.05 }), S.at(b, s), sec === 'drop' ? 0.07 : 0.05, s % 2 ? 0.3 : -0.3);
      }
    }
    if (sec === 'drop') for (const x of S.tune(b, A, A2)) B.lead.add(voice(mtof(S.note(x.idx, 1)), x.len * S.stepDur, { voices: 3, detune: 0.12, cut0: 2500, cut1: 1800, a: 0.04, s: 0.8, vib: 0.006 }), S.at(b, x.step), 0.09);
    if (sec === 'intro' || sec === 'outro' || (sec === 'drop' && (b - S.drop) % 2 === 0)) {
      B.bass.add(braam(mtof(S.note(S.deg(b), -1)), sec === 'drop' ? S.beat * 4 : 2.4), S.at(b, 0), sec === 'drop' ? 0.35 : 0.45);
      B.drums.add(tom(55, 0.8), S.at(b, 0), 0.9);
    }
    if (sec === 'intro' || sec === 'outro') continue;
    const full = sec === 'drop';
    const pat = sec === 'build' ? [0, 2, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15] : full ? [0, 3, 6, 8, 10, 12, 14] : [0, 8, 14];
    for (const s of pat) {
      B.drums.add(tom(s % 4 === 0 ? 70 : 105, s % 4 === 0 ? 0.5 : 0.25), S.at(b, s), sec === 'build' ? 0.3 + 0.4 * s / 16 : 0.6, s % 4 ? 0.3 : -0.1);
      if (s % 8 === 0) S.kicks.push(S.at(b, s));
    }
    if (full) for (const s of [4, 12]) B.drums.add(snare({ decay: 0.2, bright: 3500 }), S.at(b, s), 0.4);
    if (full && (b - S.drop) % 4 === 0) B.fx.add(cymbal(3), S.at(b, 0), 0.25);
  }
  return { reverb: { drums: 0.2, lead: 0.3, keys: 0.4, bass: 0.15 }, side: 0.15 };
}

function synthwave(S, B) {
  const r = S.r;
  const A = S.motif(0.4, 2, 2, 10), A2 = S.motif(0.4, 2, 2, 10);
  const arpUp = r.chance(0.5);
  for (let b = 0; b < S.bars; b++) {
    const sec = S.sec(b);
    const ch = S.chord(b, 4, 0);
    for (const m of ch) B.keys.add(voice(mtof(m), S.beat * 4, { voices: 4, detune: 0.14, cut0: 2000, cut1: 1600, a: 0.15, s: 0.8, rel: 0.4 }), S.at(b, 0), 0.05);
    if (sec !== 'intro' && sec !== 'outro') {
      for (let s = 0; s < 16; s++) {
        const k = arpUp ? s % 4 : 3 - (s % 4);
        B.lead.add(voice(mtof(ch[k] + 12 * (s % 8 >= 4 ? 1 : 0)), S.stepDur * 0.9, { wave: 'square', cut0: 4000, cut1: 900, cutDecay: 0.06, s: 0.2, rel: 0.05 }), S.at(b, s), 0.05, s % 2 ? 0.35 : -0.35);
      }
    }
    if (sec === 'drop') for (const x of S.tune(b, A, A2)) B.lead.add(voice(mtof(S.note(x.idx, 1)), x.len * S.stepDur, { voices: 2, detune: 0.1, cut0: 3500, cut1: 2500, a: 0.01, s: 0.8, vib: 0.008 }), S.at(b, x.step), 0.1);
    if (sec === 'intro' || sec === 'outro') {
      B.drums.add(kick({ decay: 0.4 }), S.at(b, 0), 0.8);
      B.bass.add(subBass(mtof(S.note(S.deg(b), -2)), S.beat * 2), S.at(b, 0), 0.5);
      continue;
    }
    if (sec === 'build') {
      for (let s = 0; s < 16; s += s < 8 ? 2 : 1) B.drums.add(snare({ decay: 0.08 }), S.at(b, s), 0.1 + 0.3 * s / 16);
      continue;
    }
    for (let s = 0; s < 16; s += sec === 'drop' ? 4 : 8) {
      B.drums.add(kick({ decay: 0.3 }), S.at(b, s), 0.85);
      S.kicks.push(S.at(b, s));
    }
    // the big gated snare of the eighties
    for (const s of [4, 12]) B.drums.add(snare({ decay: 0.22, bright: 6000, body: 0.6 }), S.at(b, s), 0.45);
    for (let s = 0; s < 16; s += 2) B.drums.add(hat({ decay: 0.025 }), S.at(b, s), 0.08, 0.3);
    const root = mtof(S.note(S.deg(b), -2));
    for (let s = 0; s < 16; s += 2) B.bass.add(subBass(s % 4 === 2 ? root * 2 : root, S.stepDur * 1.6), S.at(b, s), 0.4);
    if (sec === 'drop' && (b - S.drop) % 4 === 0) B.fx.add(cymbal(2.4), S.at(b, 0), 0.22);
  }
  return { reverb: { drums: 0.18, lead: 0.25, keys: 0.3, bass: 0 }, side: 0.5, delay: 0.75 };
}

const MAKERS = { phonk, trap, edm, lofi, cinematic, synthwave };

// ---------- putting it together ----------
export function make({ style = 'phonk', bpm = 0, bars = 20, drop = 10, seed = 1, end = 'hit', cues = [], gameDb = -3 }) {
  const r = rngOf(seed * 7919 + STYLES.indexOf(style) * 104729);
  noise = rngOf(seed ^ 0x5bd1e995);
  if (!bpm) bpm = Math.round(r.range(...BPM[style]));
  bars = Math.max(4, bars);
  drop = clamp(drop, 2, bars - 1);
  const scale = style === 'phonk' ? r.pick(['phrygian', 'minor']) : style === 'lofi' ? r.pick(['dorian', 'minor']) :
    style === 'trap' || style === 'cinematic' ? r.pick(['harmonic', 'minor']) : 'minor';
  const S = new Song({ style, bpm, bars, drop, end, r, root: 48 + r.int(0, 11), scale: SCALES[scale], prog: r.pick(PROGS[style]) });
  const n = S.n;
  const B = { drums: new Bus(n), bass: new Bus(n), keys: new Bus(n), lead: new Bus(n), fx: new Bus(n) };
  const mixp = MAKERS[style](S, B);

  // the kick pushes the rest down a little, so it punches through
  if (mixp.side) {
    const g = S.sidechain(mixp.side);
    B.bass.scale(g);
    B.keys.scale(g);
    if (style !== 'lofi') B.lead.scale((i) => 0.5 + 0.5 * g(i));
  }
  const music = new Bus(n);
  music.mix(B.drums, 1);
  music.mix(B.bass, 1);
  music.mix(B.keys, 1);
  music.mix(B.lead, 1);
  if (mixp.delay) music.mix(delay(B.lead, S.beat * mixp.delay, 0.38, 0.3));
  const send = new Bus(n);
  for (const k of ['drums', 'lead', 'keys', 'bass']) send.mix(B[k], mixp.reverb[k] || 0);
  send.mix(B.fx, 0.3);
  music.mix(reverb(send, 0.84, 0.3, 2.2));
  music.mix(B.fx, 1);

  // the master filter: muffled through the hook bar (opening up), a high-pass rising through the build
  const bar = 4 * S.beat;
  const introLp = r.chance(0.55);
  const lp = (i) => {
    const t = i / SR;
    const b = Math.floor(t / bar);
    if (b === 0 && introLp) return 600 * Math.pow(10, t / bar);
    return mixp.warm || 19000;
  };
  const hp = (i) => {
    const t = i / SR;
    const b = Math.floor(t / bar);
    if (S.sec(b) !== 'build') return 20;
    return 20 * Math.pow(40, (t - b * bar) / bar);
  };
  svfBus(music, 'lp', lp);
  svfBus(music, 'hp', hp);

  // a breath of silence just before the drop, now and then
  if (r.chance(0.5)) {
    const t0 = drop * bar - S.beat * 0.5;
    music.scale((i) => {
      const t = i / SR;
      return t > t0 && t < drop * bar ? Math.max(0, 1 - (t - t0) / 0.02) : 1;
    });
  }

  // drop and end: the build's riser, a crash on the drop, an impact on the last bar
  const fx = new Bus(n);
  if (drop >= 1) fx.add(riser(bar * 0.95), (drop - 1) * bar, 0.35);
  fx.add(cymbal(2.6), drop * bar, 0.3);
  fx.add(impact(2.5), drop * bar, 0.55);
  fx.add(impact(2.2, 48), 0, 0.5);
  if (end === 'hit') fx.add(impact(2.5), (bars - 1) * bar, 0.6);

  // the editor's cues
  const game = new Bus(n);
  const duck = new Float32Array(n).fill(1);
  for (const c of cues) {
    const t = c.t;
    if (c.type.startsWith('g_')) {
      game.add(gameSound(c), t, c.gain ?? 1, c.pan ?? 0);
      const d = DUCK[c.type] ? DUCK[c.type](c) : 0;
      for (let k = 0, s0 = Math.round(t * SR); d > 0 && k < N(0.3); k++) {
        if (s0 + k >= 0 && s0 + k < n) duck[s0 + k] = Math.min(duck[s0 + k], 1 - d * Math.exp(-k / (0.09 * SR)));
      }
    } else if (c.type === 'whoosh') fx.add(whoosh(c.dur || 0.45, r.chance(0.5) ? 1 : -1), t - (c.dur || 0.45) * 0.6, c.gain ?? 0.45);
    else if (c.type === 'impact') fx.add(impact(1.8, r.range(45, 60)), t, c.gain ?? 0.5);
    else if (c.type === 'boom') fx.add(impact(2.4, 40), t, c.gain ?? 0.7);
    else if (c.type === 'riser') fx.add(riser(c.dur || bar), t - (c.dur || bar), c.gain ?? 0.3);
    else if (c.type === 'reverse') fx.add({ L: reverse(cymbal(1.6)), R: reverse(cymbal(1.6)) }, t - 1.6, c.gain ?? 0.3);
    else if (c.type === 'tapestop') tapeStop(music, t, c.dur || 0.8);
    else if (c.type === 'gap') music.scale((i) => {
      const x = i / SR;
      return x > t - (c.dur || 0.2) && x < t ? 0.05 : 1;
    });
  }
  const fxv = reverb(fx, 0.7, 0.4, 0.5);
  music.mix(fx, 1);
  music.mix(fxv, 1);

  // the game's sounds over the music, at gameDb against the music's loudness (loud parts only, so the gaps between
  // pops do not count)
  const loudRms = (b) => {
    let s = 0, k = 0;
    for (let i = 0; i < b.n; i++) {
      const v = Math.max(Math.abs(b.L[i]), Math.abs(b.R[i]));
      if (v > 1e-3) { s += b.L[i] * b.L[i] + b.R[i] * b.R[i]; k += 2; }
    }
    return k ? Math.sqrt(s / k) : 0;
  };
  const gr = loudRms(game), mr = loudRms(music);
  if (gr > 1e-6) {
    music.scale((i) => duck[i]);
    const gg = mr > 1e-6 ? clamp((mr * Math.pow(10, gameDb / 20)) / gr, 0.2, 40) : 1;
    music.mix(game, gg);
    music.mix(reverb(game, 0.6, 0.5, 0.25), gg);
  }

  // master: a little glue, then the peak at -1 dB
  let peak = 1e-6;
  for (let i = 0; i < n; i++) {
    music.L[i] = Math.tanh(music.L[i] * 1.2);
    music.R[i] = Math.tanh(music.R[i] * 1.2);
    peak = Math.max(peak, Math.abs(music.L[i]), Math.abs(music.R[i]));
  }
  const g = 0.89 / peak;
  for (let i = 0; i < n; i++) {
    music.L[i] *= g;
    music.R[i] *= g;
  }
  // a short fade at the very end, so it never clicks
  for (let i = 0; i < N(0.03); i++) {
    const k = i / N(0.03);
    music.L[n - 1 - i] *= k;
    music.R[n - 1 - i] *= k;
  }
  return { bus: music, info: { style, bpm, beat: S.beat, bars, drop, scale, root: S.root, secs: S.secs, seconds: n / SR } };
}

// the music winds down like a tape when the power goes, then silence
function tapeStop(bus, t, dur) {
  const s0 = Math.round(t * SR);
  if (s0 >= bus.n) return;
  const L = bus.L.slice(), R = bus.R.slice();
  let pos = s0;
  const n = N(dur);
  for (let i = 0; i < bus.n - s0; i++) {
    if (i < n) {
      const rate = Math.pow(1 - i / n, 1.6);
      pos += rate;
      const j = Math.floor(pos), f = pos - j;
      const a = j < bus.n - 1 ? 1 - i / n * 0.3 : 0;
      bus.L[s0 + i] = (j < bus.n - 1 ? L[j] * (1 - f) + L[j + 1] * f : 0) * a;
      bus.R[s0 + i] = (j < bus.n - 1 ? R[j] * (1 - f) + R[j + 1] * f : 0) * a;
    } else {
      bus.L[s0 + i] = 0;
      bus.R[s0 + i] = 0;
    }
  }
}

export function wav(file, bus) {
  const n = bus.n;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(clamp(bus.L[i], -1, 1) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(clamp(bus.R[i], -1, 1) * 32767), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      o[k] = v;
    }
  }
  return o;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const o = parseArgs(process.argv.slice(2));
  if (o.demo) {
    fs.mkdirSync(o.demo, { recursive: true });
    let seed = Number(o.seed || 1);
    for (const style of STYLES) {
      const t0 = Date.now();
      const { bus, info } = make({ style, bars: style === 'lofi' ? 8 : 12, drop: style === 'lofi' ? 4 : 6, seed: seed++, end: 'hit' });
      const f = path.join(o.demo, `demo-${style}.wav`);
      wav(f, bus);
      console.log(`${f}  ${info.bpm} bpm  ${info.seconds.toFixed(1)} s  made in ${Date.now() - t0} ms`);
    }
  } else {
    const cues = o.cues ? JSON.parse(fs.readFileSync(o.cues, 'utf8')) : [];
    const { bus, info } = make({
      style: o.style || 'phonk', bpm: Number(o.bpm || 0), bars: Number(o.bars || 20), drop: Number(o.drop || 10),
      seed: Number(o.seed || 1), end: o.end || 'hit', cues, gameDb: Number(o['game-db'] ?? -3),
    });
    wav(o.out || 'music.wav', bus);
    if (o.info) fs.writeFileSync(o.info, JSON.stringify(info, null, 1));
    console.log(`music: ${info.style} ${info.bpm} bpm, ${info.bars} bars, drop at bar ${info.drop}, ${info.seconds.toFixed(2)} s`);
  }
}
