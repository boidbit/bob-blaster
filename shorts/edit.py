#!/usr/bin/env python3
"""Cuts the recorded takes of one short into a finished YouTube Short (1080x1920, 30 fps, 30-50 s).
(Taken from the Glass Run shorts in boidbit/glass-garden, fitted to Blob Blaster.)

What it does, from the recipe (shorts/plan.py) and what the game did while it played (the .jsonl beside each take):
  - the hook: the first bar is the best moment (or the tensest: the last heart), with big words on it
  - the body: big moments (giant blobs, hits, close calls, the level cleared) on a speed ramp or in slow motion,
    busy stretches as they were, dull stretches fast-forwarded or cut out; every cut lands on the beat
  - transitions between shots (white flash, zoom, whip, glitch, glass shatter, iris)
  - the music (shorts/music.mjs), made to fit: its drop lands on the biggest moment; the game's own sounds
    (pops, hits, the boom) are made there too, where they happen in the cut
  - the ending: a still with "PART 2?", a loop back to the start, the answer (cleared, or out of hearts), or a fail
    with the music winding down. The words always match the picture.

  python3 shorts/edit.py --recipe recipe.json --takes takes/ --out out/ --name short-01
  python3 shorts/edit.py --selftest work/ [--style challenge,speedrun]     made-up takes, to check the whole cut quickly
"""
import argparse
import bisect
import json
import math
import os
import random
import re
import subprocess
import sys
import wave
from collections import OrderedDict

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plan as P  # noqa: E402

ROOT = os.path.dirname(HERE)
W, H, FPS, SR = 1080, 1920, 30, 48000
INK = (26, 10, 42)

# how much each kind of moment is worth to the edit (pops by blob size: 0 smallest .. 3 the giant)
POP_W = [0.8, 1.4, 3.0, 6.0]
BIG = 4.5
OUTCOME = ("win", "over")
# transitions: how long the incoming shot plays its part, and how long the outgoing one plays its part (seconds)
IN_DUR = {"flash": 0.22, "zoom": 0.2, "whip": 0.17, "glitch": 0.14, "shatter": 0.55, "iris": 0.32}
OUT_DUR = {"flash": 0.1, "zoom": 0.17, "whip": 0.14, "glitch": 0.1, "shatter": 0.0, "iris": 0.0}
EMOJI = {"lastheart": "😳", "odds": "🎲", "giant": "🫧", "speedrun": "⚡", "satisfying": "🤤", "fail": "💀", "challenge": "🤖"}
# hooks that only fit when the recording has the moment they speak of
NEEDS_ONE = ("{lives}", "LAST HEART", "ONE MORE HIT")
NEEDS_GIANT = ("BIGGEST", "{hp}", "POP *THIS?*")
NEEDS_OVER = ("UNTIL", "THE ENDING", "SO CLOSE", "RUINED")


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, **kw)


def read_events(path):
    out = []
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8"):
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    out.sort(key=lambda e: e.get("f", 0))
    return out


def probe_frames(path):
    p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
                        "stream=nb_read_packets", "-of", "csv=p=0", path], capture_output=True, text=True)
    try:
        return int(p.stdout.strip().split(",")[0])
    except ValueError:
        return 0


def probe_size(path):
    p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                        "-of", "csv=p=0", path], capture_output=True, text=True)
    try:
        w, h = p.stdout.strip().split(",")[:2]
        return int(w), int(h)
    except ValueError:
        return 0, 0


def probe_duration(path):
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    try:
        return float(p.stdout.strip())
    except ValueError:
        return 0.0


def read_wav(path):
    with wave.open(path, "rb") as w:
        n, ch = w.getnframes(), w.getnchannels()
        a = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    return a.reshape(-1, ch) if ch > 1 else np.repeat(a[:, None], 2, axis=1)


def write_wav(path, a):
    a = np.clip(a, -1.0, 1.0)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((a * 32767).astype(np.int16).tobytes())


def fix_words(text):
    """'1 HEARTS' -> '1 HEART', '2 HEART LEFT' -> '2 HEARTS LEFT' (the numbers come from the recording)"""
    text = re.sub(r"(\*?\b1\*?) (HEART|POP|WIN|TRIE)S\b", lambda m: m.group(1) + " " + m.group(2).replace("TRIE", "TRY"), text)
    text = re.sub(r"(\*?\b(?:[02-9]|\d\d+)\*?) HEART LEFT", r"\1 HEARTS LEFT", text)
    return text


# ---------- the takes ----------
class Moment:
    __slots__ = ("s", "w", "kind", "ev")

    def __init__(self, s, w, kind, ev):
        self.s, self.w, self.kind, self.ev = s, w, kind, ev


class Take:
    def __init__(self, i, spec, folder):
        self.i = i
        self.spec = spec
        self.avi = os.path.join(folder, spec["name"] + ".avi")
        self.events = read_events(os.path.join(folder, spec["name"] + ".jsonl"))
        self.nframes = probe_frames(self.avi) if os.path.exists(self.avi) else 0
        start = next((e for e in self.events if e.get("e") == "start"), None)
        end = next((e for e in self.events if e.get("e") == "end"), None)
        self.started = start is not None
        self.f0 = start["f"] if start else 0
        self.level = int((start or {}).get("level") or spec.get("level") or 1)
        self.outcome = (end or {}).get("outcome") or spec.get("outcome", "")
        self.final = bool(spec.get("final"))
        self.attempt = 0
        self.s0 = self.f0 / FPS + 0.15
        self.s1 = max(self.s0, self.nframes / FPS - 0.1)
        self.moments = self._moments()

    def ok(self):
        return self.started and self.nframes > FPS * 4 and self.s1 - self.s0 > 4.0

    def _moments(self):
        out = []
        for e in self.events:
            s = e.get("f", 0) / FPS
            if s < self.s0 or s > self.s1:
                continue
            k = e.get("e")
            w = 0.0
            if k == "pop":
                c = int(e.get("c", 1))
                w = POP_W[min(3, max(0, int(e.get("s", 0))))] + (0.35 * min(c, 10) if c >= 3 else 0.0)
            elif k == "win":
                w = 10.0
            elif k == "over":
                w = 9.5
            elif k == "hurt" and e.get("lives", 3) >= 1:
                # the hit that takes the last heart is the game over itself
                w = 6.0 + (1.5 if e.get("lives") == 1 else 0.0)
            elif k == "close":
                w = 2.0 + 4.0 * float(e.get("v", 0.0)) + (1.5 if e.get("lives") == 1 else 0.0)
            if w > 0:
                out.append(Moment(s, w, k, e))
        out.sort(key=lambda m: m.s)
        return out

    def outcome_moment(self):
        return next((m for m in self.moments if m.kind in OUTCOME), None)


class Reader:
    """Frames of one take, read in order from ffmpeg, with a little cache for looking back."""

    def __init__(self, take):
        self.path = take.avi
        self.n = max(1, take.nframes)
        self.proc = None
        self.pos = 0
        self.cache = OrderedDict()

    def close(self):
        if self.proc:
            try:
                self.proc.stdout.close()
                self.proc.kill()
                self.proc.wait()
            except OSError:
                pass
            self.proc = None

    def _open(self, i):
        self.close()
        t = max(0.0, (i - 0.5) / FPS)
        # never stretched: a picture of another shape is scaled to cover the frame and cut from the middle
        fit = "scale=%d:%d:force_original_aspect_ratio=increase:flags=bicubic,crop=%d:%d" % (W, H, W, H)
        self.proc = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", "%.4f" % t, "-i", self.path, "-an",
                                      "-vf", fit, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                                     stdout=subprocess.PIPE, bufsize=W * H * 3 * 2)
        self.pos = i

    def get(self, i):
        i = int(min(max(i, 0), self.n - 1))
        f = self.cache.get(i)
        if f is not None:
            self.cache.move_to_end(i)
            return f
        if self.proc is None or i < self.pos or i > self.pos + 120:
            self._open(i)
        size = W * H * 3
        while self.pos <= i:
            raw = self.proc.stdout.read(size)
            if len(raw) < size:
                # past the last frame: hold the last one there is
                self.n = max(1, self.pos)
                if self.cache:
                    return self.cache[next(reversed(self.cache))]
                return np.zeros((H, W, 3), np.uint8)
            self.cache[self.pos] = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
            self.pos += 1
            while len(self.cache) > 24:
                self.cache.popitem(last=False)
        return self.cache[i]


# ---------- shots ----------
class Curve:
    """Playback speed through a shot, from key points [(seconds into the shot, speed)];
    gives how far into the footage each moment of the shot is."""

    def __init__(self, dur, keys):
        ku = np.array([float(k[0]) for k in keys])
        kv = np.array([float(k[1]) for k in keys])
        order = np.argsort(ku, kind="stable")
        ku, kv = ku[order], kv[order]
        m = max(2, int(dur * 240) + 1)
        self.us = np.linspace(0.0, dur, m)
        self.vs = np.interp(self.us, ku, kv)
        du = dur / (m - 1)
        self.cum = np.concatenate([[0.0], np.cumsum((self.vs[1:] + self.vs[:-1]) * 0.5 * du)])

    def off(self, u):
        return np.interp(u, self.us, self.cum)

    def speed(self, u):
        return np.interp(u, self.us, self.vs)


class Unit:
    """One shot of the short: a stretch of one take, played with a speed curve, `beats` long."""

    def __init__(self, take, kind, beats, keys, beat, src0=0.0, impact=None, mom=None, value=0.0, how="real"):
        self.take, self.kind, self.beats, self.keys, self.beat = take, kind, beats, keys, beat
        self.src0, self.impact, self.mom, self.value, self.how = src0, impact, mom, value, how
        self.trans = "cut"
        self.freeze = 0.0
        self.punch = 0.0
        self.rebuild()

    def rebuild(self):
        self.dur = self.beats * self.beat
        self.curve = Curve(self.dur, self.keys)

    def src(self, u):
        if self.freeze > 0:
            u = np.minimum(u, self.dur - self.freeze)
        return self.src0 + self.curve.off(u)

    def speed(self, u):
        v = self.curve.speed(u)
        if self.freeze > 0:
            v = np.where(np.asarray(u) > self.dur - self.freeze, 0.0, v)
        return v

    def span(self):
        return float(self.src(0.0)), float(self.src(self.dur))

    def out_time(self, s):
        """seconds into this shot at which footage second `s` is shown, or None"""
        a, b = self.span()
        if s < a - 1e-6 or s > b + 1e-6:
            return None
        u = float(np.interp(s, self.src0 + self.curve.cum, self.curve.us))
        return u if u <= self.dur - self.freeze + 1e-6 else None


class Txt:
    def __init__(self, t0, t1, text, size, y, anim="pop"):
        self.t0, self.t1, self.text, self.size, self.y, self.anim = t0, t1, text, size, y, anim
        self.sprite = None


# ---------- the editor ----------
class Editor:
    def __init__(self, rec, takes, work):
        self.rec = rec
        self.style = rec["style"]
        self.work = work
        self.r = random.Random(rec["seed"] * 31 + 7)
        takes = [t for t in takes if t.ok()]
        if self.style == "speedrun":
            # level 1, 2, 3... with none missing: a level that is not there ends the run
            takes.sort(key=lambda t: t.level)
            run_ = []
            for t in takes:
                if t.level == len(run_) + 1:
                    run_.append(t)
            takes = run_ or takes
            if takes:
                takes[-1].final = True   # the last level cleared is the run's big moment
        # the last word (the attempt whose result is the answer) goes last
        takes.sort(key=lambda t: (t.final, 0))
        for i, t in enumerate(takes):
            t.i = i
        if self.style in ("odds", "challenge"):
            for t in takes:
                t.attempt = 1 + sum(1 for u in takes if u.level == t.level and u.i < t.i)
        self.takes = takes
        if not self.takes:
            raise SystemExit("no usable takes")
        ed = rec["edit"]
        self.pace = ed["pace"]
        self.ending = ed["ending"]
        self.hook_kind = ed["hook"]
        self.pool = ed["transitions"] or ["flash"]
        self.small = [x for x in ("flash", "zoom", "glitch", "whip") if x in self.pool] or ["flash"]
        self.bpm = rec["music"]["bpm"]
        self.beat = 60.0 / self.bpm
        self.bar = 4 * self.beat
        lo, hi = math.ceil(30.0 / self.bar), math.floor(50.0 / self.bar)
        # no longer than the play there is to cut it from (a cut uses about 1.2 s of play for each second):
        # a bot that loses early leaves less, and a short padded with a still frame is a poor short
        play = sum(t.s1 - t.s0 for t in self.takes)
        length = min(ed["length"], max(30.0, play / 1.2))
        self.lo_bars = lo
        self.bars = int(min(max(math.floor(length / self.bar), lo), hi))
        self.total = self.bars * 4
        self.texts = []
        self.pop_times = []
        self.hook_n = 1
        self.hook_mom = None
        # the result that answers the video's question: the last word's cleared level, or its game over
        fin = next((t for t in reversed(self.takes) if t.final), None)
        self.answer = fin.outcome_moment() if fin is not None else None
        self.answer_take = fin if self.answer is not None else None

    # sizes
    def beats_for(self, sec, even=True):
        b = max(2, int(round(sec / self.beat)))
        if even and b % 2:
            b += 1
        return b

    def interest(self, take, a, b):
        return sum(m.w for m in take.moments if a <= m.s <= b)

    def fits(self, u):
        a, b = u.span()
        return a >= u.take.s0 - 1e-6 and b <= u.take.s1 + 1e-6

    # shot makers
    def moment_unit(self, take, m, beats, lead_beats, how):
        """a shot with moment m on a beat, lead_beats into it. A moment near the start or the end of a take (a level
        cleared, the cannon blown up) gets a longer or shorter run-up instead, so it stays on the beat (and the drop
        can land on it); only when no run-up fits is the shot slid off the beat."""
        leads = [lead_beats] + list(range(lead_beats + 1, beats)) + list(range(lead_beats - 1, 0, -1))
        for lb in leads:
            u = self.moment_shot(take, m, beats, lb, how)
            if self.fits(u):
                return u
        # no room for the run-up or the follow-through: as it was, slid to fit
        u = Unit(take, "moment", beats, [(0, 1.0)], self.beat, mom=m, value=m.w * 3, how="real")
        if u.dur > take.s1 - take.s0:
            return None
        u.src0 = min(max(m.s - lead_beats * self.beat, take.s0), take.s1 - u.dur)
        u.impact = m.s - u.src0
        u.punch = 0.05
        return u

    def moment_shot(self, take, m, beats, lead_beats, how):
        beat = self.beat
        lead = lead_beats * beat
        if how == "slam":
            vin = self.r.uniform(1.7, 2.3)
            keys = [(0, vin), (max(0.0, lead - 0.15), vin), (lead, 0.42), (lead + beat, 0.42), (lead + beat + 0.3, 1.0)]
        elif how == "slow":
            keys = [(0, 1.0), (max(0.0, lead - 0.12), 1.0), (lead, 0.45), (lead + 1.3 * beat, 0.45), (lead + 1.3 * beat + 0.3, 1.0)]
        elif how == "soft":
            keys = [(0, 1.25), (max(0.0, lead - 0.1), 1.25), (lead, 0.75), (lead + beat, 0.75), (lead + beat + 0.25, 1.0)]
        else:
            keys = [(0, 1.0)]
        u = Unit(take, "moment", beats, keys, beat, impact=lead, mom=m, value=m.w * 3, how=how)
        u.src0 = m.s - float(u.curve.off(lead))
        u.punch = {"slam": 0.11, "slow": 0.07, "soft": 0.06}.get(how, 0.05)
        return u

    def clip_unit(self, take, start, beats, value=0.0):
        u = Unit(take, "clip", beats, [(0, 1.0)], self.beat, value=value)
        if u.dur > take.s1 - take.s0:
            return None
        u.src0 = min(max(start, take.s0), take.s1 - u.dur)
        return u

    def ff_unit(self, take, a, b, beats):
        dur = beats * self.beat
        p = ((b - a) / dur - 0.3) / 0.7
        if p < 1.5 or p > 6.5:
            return None
        return Unit(take, "ff", beats, [(0, 1.0), (dur * 0.3, p), (dur * 0.7, p), (dur, 1.0)], self.beat, src0=a, value=0.5)

    def pick_how(self, m):
        if m.kind in OUTCOME:
            # the game slows down by itself when a level is cleared
            return self.r.choice(["soft", "real"])
        w = {"flow": (0.2, 0.45, 0.35), "mixed": (0.4, 0.3, 0.3), "hyper": (0.6, 0.2, 0.2)}[self.pace]
        return self.r.choices(["slam", "slow", "real"], weights=w)[0]

    def spoils(self, m):
        """a flash-forward hook must not give away the answer the video is about"""
        return m.kind in OUTCOME and self.style in ("odds", "challenge", "fail")

    @staticmethod
    def is_giant(m):
        return m is not None and m.kind in ("pop", "win") and m.ev.get("s") == 3

    # the plan
    def make_hook(self):
        beats = 4
        if self.hook_kind == "low":
            low = []
            for t in self.takes:
                for m in t.moments:
                    # a near miss on the last heart, or the hit that leaves one heart
                    if m.kind == "close" and m.ev.get("lives") == 1:
                        low.append((0, -m.w, t, m))
                    elif m.kind == "hurt" and m.ev.get("lives") == 1:
                        low.append((1, -m.w, t, m))
            if low:
                low.sort(key=lambda x: (x[0], x[1]))
                _, _, t, m = low[0]
                u = self.moment_unit(t, m, beats, 2, "real")
                if u:
                    u.kind = "hook"
                    self.hook_n = 1
                    return u
            self.hook_kind = "flash"
        if self.hook_kind == "flash":
            big = sorted([(m.w, t, m) for t in self.takes for m in t.moments if m.w >= BIG and not self.spoils(m)], key=lambda x: -x[0])
            giants = [x for x in big if self.is_giant(x[2])]
            if self.style == "giant" and giants:
                big = giants   # the video is about the giant blob: the hook is one popping
            if big:
                _, t, m = big[1] if len(big) > 1 and self.r.random() < 0.35 and self.style != "giant" else big[0]
                u = self.moment_unit(t, m, beats, 1, "real" if m.kind in OUTCOME else "slam")
                if u:
                    u.kind = "hook"
                    self.hook_n = max(1, int(m.ev.get("lives", 1) or 1))
                    self.hook_mom = m
                    return u
            self.hook_kind = "cold"
        t = self.takes[0]
        first = next((m for m in t.moments if m.s > t.s0 + 0.8 and m.w >= 1.4 and not self.spoils(m)), None)
        u = self.clip_unit(t, (first.s - 0.5) if first else t.s0 + 0.5, beats)
        u.kind = "hook"
        u.impact = (first.s - u.src0) if first and first.s - u.src0 < u.dur else None
        u.mom = first
        u.punch = 0.06
        return u

    def candidates(self):
        C = []
        lo, hi = {"flow": (2.4, 4.5), "mixed": (1.8, 3.2), "hyper": (1.2, 2.4)}[self.pace]
        for t in self.takes:
            bigs = []
            for m in sorted([m for m in t.moments if m.w >= BIG], key=lambda m: -m.w):
                if all(abs(m.s - b.s) > 1.2 for b in bigs):
                    bigs.append(m)
            for m in bigs:
                beats = self.beats_for(3.2 if m.w < 8 else 4.4)
                lead = max(1, min(beats - 2, int(round(beats * 0.4))))
                u = self.moment_unit(t, m, beats, lead, self.pick_how(m))
                if u:
                    C.append(u)
            # busy stretches: where blobs pop thick and fast
            grid = np.arange(t.s0 + 0.5, t.s1 - 0.5, 0.25)
            vals = [self.interest(t, x - 1.0, x + 1.0) for x in grid]
            peaks = []
            for i in np.argsort(vals)[::-1]:
                if vals[i] < 2.0 or len(peaks) >= 8:
                    break
                x = float(grid[i])
                if any(abs(x - p) < 2.5 for p in peaks) or any(abs(x - m.s) < 1.6 for m in bigs):
                    continue
                peaks.append(x)
                beats = self.beats_for(self.r.uniform(lo, hi))
                u = self.clip_unit(t, x - beats * self.beat * 0.4, beats, value=vals[i])
                if u:
                    C.append(u)
            if not bigs and not peaks:
                u = self.clip_unit(t, t.s0 + 0.5, self.beats_for(3.0), value=0.5)
                if u:
                    C.append(u)
        return C

    def clash(self, u, chosen, hook):
        a, b = u.span()
        for v in chosen + [hook]:
            if v.take is not u.take:
                continue
            if v is hook and self.hook_kind == "flash":
                continue
            c, d = v.span()
            if a < d + 0.25 and c < b + 0.25:
                return True
        return False

    def select(self, C, budget, hook):
        chosen, used = [], 0
        reserve = {"flow": 0.0, "mixed": 0.12, "hyper": 0.2}[self.pace] * budget
        # the answer first (it is what the video is about), then something from every take, then the best of the rest
        if self.answer is not None:
            must = next((u for u in C if u.mom is self.answer), None)
            if must is None:
                must = self.moment_unit(self.answer_take, self.answer, self.beats_for(4.4),
                                        max(1, int(round(self.beats_for(4.4) * 0.4))), "real")
            if must is not None and used + must.beats <= budget:
                chosen.append(must)
                used += must.beats
        for t in self.takes:
            if any(u.take is t for u in chosen):
                continue
            mine = sorted([u for u in C if u.take is t], key=lambda u: -u.value)
            for u in mine:
                if used + u.beats <= budget and not self.clash(u, chosen, hook):
                    chosen.append(u)
                    used += u.beats
                    break
        for u in sorted(C, key=lambda u: -u.value):
            if any(u is c for c in chosen) or used + u.beats > budget - reserve or self.clash(u, chosen, hook):
                continue
            chosen.append(u)
            used += u.beats
        chosen.sort(key=lambda u: (u.take.i, u.span()[0]))
        return chosen, used

    def connect(self, chosen, used, budget, hook):
        """fast-forward between shots of one take where there is time to"""
        seq = []
        ffp = {"flow": 0.3, "mixed": 0.5, "hyper": 0.65}[self.pace]
        prev = hook if self.hook_kind != "flash" else None
        for u in chosen:
            if prev is not None and prev.take is u.take:
                a, b = prev.span()[1], u.span()[0]
                if b - a > 0.4 and self.r.random() < ffp:
                    for fb in ((2, 4) if self.pace == "hyper" else (4, 2)):
                        if used + fb <= budget:
                            f = self.ff_unit(u.take, a, b, fb)
                            if f:
                                seq.append(f)
                                used += fb
                                break
            seq.append(u)
            prev = u
        return seq, used

    def max_beats(self, u):
        return self.beats_for(6.0 if u.kind == "clip" else 6.5)

    def fill(self, seq, used, budget, hook):
        for _ in range(300):
            if used >= budget:
                break
            rem = budget - used
            step = 2 if rem >= 2 else 1
            best = None
            for i, u in enumerate(seq):
                if u.kind not in ("clip", "moment") or u.beats + step > self.max_beats(u):
                    continue
                a, b = u.span()
                end = b + step * self.beat * float(u.curve.vs[-1])
                nxt = seq[i + 1] if i + 1 < len(seq) else None
                limit = nxt.span()[0] - 0.1 if (nxt is not None and nxt.take is u.take) else u.take.s1
                if end > limit:
                    continue
                score = self.interest(u.take, b, end) + (1.0 if u.kind == "clip" else 0.3) + self.r.random() * 0.5
                if best is None or score > best[0]:
                    best = (score, u)
            if best:
                best[1].beats += step
                best[1].rebuild()
                used += step
                continue
            if rem < 2:
                break
            nu = self.new_clip(seq, hook, min(rem, self.beats_for(2.4)))
            if nu is None:
                break
            key = (nu.take.i, nu.span()[0])
            at = len(seq)
            for i, u in enumerate(seq):
                if (u.take.i, u.span()[0]) > key:
                    at = i
                    break
            seq.insert(at, nu)
            used += nu.beats
        return used

    def new_clip(self, seq, hook, beats):
        if beats < 1:
            return None
        dur = beats * self.beat
        best = None
        for t in self.takes:
            spans = sorted([u.span() for u in seq + [hook] if u.take is t])
            free, x = [], t.s0
            for a, b in spans:
                if a - x > 0:
                    free.append((x, a))
                x = max(x, b)
            free.append((x, t.s1))
            for a, b in free:
                if b - a < dur + 0.3:
                    continue
                for s in np.arange(a + 0.15, b - dur - 0.15 + 1e-6, 0.25):
                    v = self.interest(t, s, s + dur) + self.r.random() * 0.1
                    if best is None or v > best[0]:
                        best = (v, t, float(s))
        if best is None:
            return None
        return self.clip_unit(best[1], best[2], beats, value=best[0])

    def replays(self, seq, used, budget):
        """when the play runs short: the best moments once more, in slow motion, each just after it was first seen"""
        bigs = sorted([u for u in seq if u.kind == "moment" and u.mom is not None and u.mom.w >= BIG], key=lambda u: -u.mom.w)
        for u in bigs[:2]:
            room = budget - used
            if room < 4:
                break
            beats = min(self.beats_for(3.2), room - room % 2)
            rp = self.moment_unit(u.take, u.mom, beats, max(1, min(beats - 2, int(round(beats * 0.4)))), "slow")
            if rp is None:
                continue
            rp.kind = "replay"
            rp.value = 0.0
            seq.insert(next(i for i, v in enumerate(seq) if v is u) + 1, rp)
            used += rp.beats
        return used

    def climax(self, seq):
        cands = [u for u in seq if u.mom is not None and u.impact is not None and u.kind == "moment"]
        if not cands:
            return None
        if self.answer is not None:
            ans = next((u for u in cands if u.mom is self.answer), None)
            if ans is not None:
                return ans
        bonus = 5.0 if self.style == "giant" else 0.0   # the drop on the giant blob, not on the level cleared
        return max(cands, key=lambda u: u.mom.w + (0.5 if u.mom.kind in OUTCOME else 0.0) + (bonus if self.is_giant(u.mom) else 0.0))

    def align(self, hook, seq, end):
        """put the biggest moment on a bar line, so the music's drop lands on it; returns the drop bar"""
        cl = self.climax(seq)
        if cl is None:
            return max(2, self.bars // 2)
        i = next(k for k, u in enumerate(seq) if u is cl)
        start = hook.beats + sum(u.beats for u in seq[:i])
        lead_b = cl.impact / self.beat
        ib = start + lead_b
        if abs(ib - round(ib)) > 0.05:
            return max(2, min(self.bars - 1, int(round(ib / 4.0))))
        ib = int(round(ib))
        delta = (-ib) % 4
        if delta == 0:
            return max(2, min(self.bars - 1, ib // 4))
        # the moment a little later or earlier inside its own shot, the shot as long as it was
        lb0 = int(round(lead_b))
        for lb, at in ((lb0 + delta, ib + delta), (lb0 - (4 - delta), ib - (4 - delta))):
            if 1 <= lb <= cl.beats - 1:
                nu = self.moment_shot(cl.take, cl.mom, cl.beats, lb, cl.how)
                if self.fits(nu) and not self.clash_near(nu, seq, i):
                    nu.value = cl.value
                    seq[i] = nu
                    return max(2, min(self.bars - 1, at // 4))
        # a longer run-up inside the shot, the beats taken from the end
        if end.beats - delta >= 2:
            nu = self.moment_unit(cl.take, cl.mom, cl.beats + delta, int(round(lead_b)) + delta, cl.how)
            if nu is not None and abs(nu.impact - (lead_b + delta) * self.beat) < 0.02 and not self.clash_near(nu, seq, i):
                nu.value = cl.value
                seq[i] = nu
                end.beats -= delta
                return max(2, min(self.bars - 1, (ib + delta) // 4))
        # or the shot before it a little shorter, the beats given to the end
        back = 4 - delta
        if i > 0 and seq[i - 1].kind == "clip" and seq[i - 1].beats - back >= 2:
            seq[i - 1].beats -= back
            seq[i - 1].rebuild()
            end.beats += back
            return max(2, min(self.bars - 1, (ib - back) // 4))
        return max(2, min(self.bars - 1, int(round(ib / 4.0))))

    def clash_near(self, u, seq, i):
        a, b = u.span()
        for k in (i - 1, i + 1):
            if 0 <= k < len(seq) and seq[k].take is u.take:
                c, d = seq[k].span()
                if a < d - 0.05 and c < b - 0.05:
                    return True
        return False

    def finish_end(self, end, last):
        """the end plays on from the last shot, then holds still under the last words (part2, fail, won). When the
        take has too little left, what there is plays in slow motion, so the still is short, never a long freeze."""
        t = last.take
        end.take = t
        end.src0 = last.span()[1]
        end.keys = [(0, 1.0)]
        end.rebuild()
        avail = max(0.0, t.s1 - end.src0)
        hold = min(1.6, end.dur * 0.5) if self.ending in ("part2", "fail", "won") else 0.0
        play = end.dur - hold
        v = 1.0 if avail >= play else max(0.35, avail / max(play, 1e-3))
        if v < 1.0:
            end.keys = [(0, v)]
            end.rebuild()
        end.freeze = min(end.dur, max(hold, end.dur - avail / v))

    def assign_trans(self, units):
        units[0].trans = "flash"
        p_small = {"flow": 0.15, "mixed": 0.3, "hyper": 0.45}[self.pace]
        for i in range(1, len(units)):
            u, p = units[i], units[i - 1]
            if u.kind == "replay" or p.kind == "replay":
                # into and out of a replay: a clear break, so it reads as a replay
                u.trans = self.r.choice([x for x in ("flash", "glitch", "zoom") if x in self.pool] or ["flash"])
            elif u.kind == "end" or u.kind == "ff" or p.kind == "ff":
                u.trans = "cut"
            elif u.take is p.take:
                gap = u.span()[0] - p.span()[1]
                if p.kind == "hook" and self.hook_kind == "flash":
                    u.trans = self.r.choice(self.pool)
                elif -0.05 <= gap < 0.4:
                    u.trans = "cut"
                else:
                    u.trans = self.r.choice(self.small) if self.r.random() < p_small else "cut"
            else:
                u.trans = self.r.choice(self.pool)

    def plan(self):
        hook = self.make_hook()
        end = Unit(self.takes[-1], "end", 4, [(0, 1.0)], self.beat)
        budget = self.total - hook.beats - end.beats
        chosen, used = self.select(self.candidates(), budget, hook)
        seq, used = self.connect(chosen, used, budget, hook)
        used = self.fill(seq, used, budget, hook)
        used = self.replays(seq, used, budget)
        # still short of play: a shorter short (down to 30 s), so the end is never a long still
        short = budget - used
        if short >= 4:
            k = min(short // 4, self.bars - self.lo_bars)
            self.bars -= k
            self.total -= 4 * k
        end.beats = self.total - hook.beats - used
        self.drop = self.align(hook, seq, end)
        last = next((u for u in reversed(seq) if u.kind != "replay"), hook)
        # the ending follows what the last shot shows (a game over is never followed by "next level?")
        lt = self.last_take = last.take
        over = next((m for m in lt.moments if m.kind == "over"), None)
        win = next((m for m in lt.moments if m.kind == "win"), None)
        shown_over = over is not None and last.span()[1] >= over.s - 0.5
        shown_win = win is not None and last.span()[1] >= win.s - 0.2
        if self.ending == "answer":
            self.ending = "fail" if shown_over else "won" if shown_win else "part2"
        elif shown_over:
            self.ending = "fail"
        elif self.ending == "fail":
            self.ending = "won" if shown_win else "part2"
        self.finish_end(end, last)
        units = [hook] + seq + [end]
        self.assign_trans(units)
        assert sum(u.beats for u in units) == self.total, "the shots do not add up to the length"
        self.units = units
        self.T = [0.0]
        for u in units:
            self.T.append(self.T[-1] + u.dur)
        self.cl = self.climax(seq)
        self.cl_t = None
        if self.cl is not None:
            k = next(j for j, u in enumerate(units) if u is self.cl)
            self.cl_t = self.T[k] + self.cl.impact

    # ---------- what is on screen, and the cues for the music ----------
    def on_screen(self, kinds, replays=False):
        """(time in the short, unit index, speed, event) for each event of these kinds that is seen"""
        out = []
        for k, u in enumerate(self.units):
            if u.kind == "replay" and not replays:
                continue
            a, b = u.span()
            for e in u.take.events:
                if e.get("e") not in kinds:
                    continue
                s = e["f"] / FPS
                if a <= s <= b:
                    ut = u.out_time(s)
                    if ut is not None:
                        out.append((self.T[k] + ut, k, float(u.speed(ut)), e))
        out.sort(key=lambda x: x[0])
        return out

    def label_for(self, u):
        if not self.rec["edit"].get("label"):
            return ""
        text = "LEVEL %d" % u.take.level
        if self.style in ("odds", "challenge") and sum(1 for t in self.takes if t.level == u.take.level) > 1:
            text += " / TRY %d" % u.take.attempt
        return text

    def plan_texts(self):
        tx = self.rec["text"]
        pops = self.on_screen(("pop", "win"))
        self.pop_times = [p[0] for p in pops]
        hurts = self.on_screen(("hurt",))
        giants = [int(p[3].get("hp", 0)) for p in pops if p[3].get("s") == 3]
        levels = sorted(set(u.take.level for u in self.units))
        total = self.T[-1]
        st = self.rec.get("stats") or {}
        level = st.get("level") or self.last_take.level if self.style in ("odds", "challenge") else self.last_take.level
        # how much of the level was cleared when the hearts ran out (the game's own "% cleared")
        over_takes = [t for t in self.takes if t.outcome == "over"]
        lost_at = over_takes[-1] if over_takes else None
        if self.last_take.outcome == "over":
            lost_at = self.last_take
        progress = 0
        if lost_at is not None:
            ticks = [e for e in lost_at.events if e.get("e") == "tick"]
            progress = int(100 * float(ticks[-1].get("p", 0))) if ticks else 0
        fill = {"lives": self.hook_n, "level": level, "wins": st.get("wins", 0), "tries": st.get("tries", 0),
                "pct": st.get("pct", 0), "hp": max(giants) if giants else 0, "pops": len(pops), "sec": int(round(total)),
                "last": max(levels), "levels": len(levels), "lost": len(hurts), "progress": progress}

        def filled(s):
            for k, v in fill.items():
                s = s.replace("{%s}" % k, str(v))
            return fix_words(s)

        hook = tx["hook"]
        # a hook only says what the video shows
        has_one = self.hook_kind == "low"
        has_giant = self.hook_mom is not None and self.hook_mom.kind in ("pop", "win") and self.hook_mom.ev.get("s") == 3
        has_over = any(m.kind == "over" for t in self.takes for m in t.moments)
        if (any(x in hook for x in NEEDS_ONE) and not has_one) or (self.style == "giant" and any(x in hook for x in NEEDS_GIANT) and not has_giant):
            hook = P.HOOK_PLAIN.get(self.style, "WATCH *THIS*")
        if self.style == "fail" and not has_over and any(x in hook for x in NEEDS_OVER):
            hook = "WATCH *THIS*"
        if "CLOSE" in hook and progress < 80:
            hook = "WAIT FOR *THE ENDING*"
        if self.style == "odds" and not st.get("tries"):
            hook = "LEVEL {level} IS *TOUGH*"
        texts = [Txt(0.0, min(2.8, total), filled(hook), 92, 0.30, "pop")]

        def free(t0, t1):
            return all(t1 <= x.t0 or t0 >= x.t1 for x in texts)

        if self.cl_t is not None:
            t = self.cl_t
            kind = self.cl.mom.kind
            react = tx["react_bad"] if kind in ("over", "hurt") else tx["react"]
            if kind == "win" and self.style in ("odds", "challenge"):
                react = "YES!"
            if self.rec["edit"].get("react") and free(t + 0.05, t + 1.25):
                texts.append(Txt(t + 0.05, t + 1.25, react, 104, 0.40, "slam"))
            if self.r.random() < 0.45 and free(t - self.bar, t - 0.1) and t - self.bar > 3.0:
                texts.append(Txt(t - self.bar, t - 0.1, tx["before"], 76, 0.30, "pop"))
        for k, u in enumerate(self.units):
            if u.kind == "replay" and free(self.T[k] + 0.1, self.T[k] + 1.3):
                texts.append(Txt(self.T[k] + 0.1, self.T[k] + 1.3, "REPLAY", 64, 0.18, "pop"))
        end_txt = "" if self.ending == "loop" else tx["end"].get(self.ending, "")
        if "CLOSE" in end_txt and progress < 80:
            end_txt = "OUT OF HEARTS."
        end_txt = filled(end_txt)
        if end_txt:
            e = self.units[-1]
            t0 = max(self.T[-2] + 0.2, total - max(e.freeze, 1.6))
            texts = [x for x in texts if x.t1 <= t0 or x.t0 >= total]
            texts.append(Txt(t0, total + 1.0, end_txt, 110, 0.42, "slam"))
        self.texts = [x for x in texts if x.text.strip()]
        self.fill_values = fill

    def cues(self):
        cues = []
        for k, u in enumerate(self.units):
            t = self.T[k]
            if k > 0 and u.trans in ("whip", "zoom", "shatter", "glitch", "iris"):
                cues.append({"t": t, "type": "whoosh", "dur": 0.4, "gain": 0.4})
            if k > 0 and u.trans in ("shatter", "flash"):
                cues.append({"t": t, "type": "impact", "gain": 0.3})
            if u.impact is not None and u.mom is not None and u.kind in ("moment", "hook") and u is not self.cl:
                cues.append({"t": t + u.impact, "type": "impact", "gain": 0.22 + 0.025 * min(u.mom.w, 10.0)})
        if self.cl_t is not None:
            on_drop = abs(self.cl_t - self.drop * self.bar) < 0.08
            if not on_drop:
                cues.append({"t": self.cl_t, "type": "boom", "gain": 0.6})
            if self.r.random() < 0.4:
                cues.append({"t": self.cl_t, "type": "reverse", "gain": 0.3})
            if self.ending == "fail" and self.cl.mom.kind == "over":
                cues.append({"t": self.cl_t + 0.15, "type": "tapestop", "dur": 0.9})
        if self.ending == "fail" and not any(c["type"] == "tapestop" for c in cues):
            # the music winds down as the last picture stops
            e = self.units[-1]
            cues.append({"t": self.T[-2] + e.dur - e.freeze, "type": "tapestop", "dur": 0.9})
        cues += self.game_cues()
        return cues

    def game_cues(self):
        """the game's own sounds where its events are seen; deeper in slow motion, thinner when fast-forwarded"""
        out = []
        last_pew = -1.0
        for t, k, v, e in self.on_screen(("pop", "win", "hurt", "over", "shot"), replays=True):
            kind = e["e"]
            rate = min(1.0, max(0.5, v))
            gain = 1.0 if v <= 1.3 else max(0.3, 1.3 / v)
            pan = max(-0.6, min(0.6, (float(e.get("x", 180)) - 180.0) / 180.0 * 0.6))
            if kind == "shot":
                if v > 1.3 or t - last_pew < 0.1:
                    continue
                last_pew = t
                out.append({"t": t, "type": "g_pew", "rate": rate, "gain": gain, "pan": pan})
            elif kind in ("pop", "win"):
                if v > 2.5 and int(e.get("s", 0)) == 0 and self.r.random() < 0.5:
                    continue
                out.append({"t": t, "type": "g_pop", "s": int(e.get("s", 0)), "c": int(e.get("c", 1)), "rate": rate, "gain": gain, "pan": pan})
                if kind == "win":
                    out.append({"t": t, "type": "g_win", "rate": rate, "gain": gain})
            elif kind == "hurt":
                out.append({"t": t, "type": "g_hurt", "rate": rate, "gain": gain, "pan": pan})
            elif kind == "over":
                out.append({"t": t, "type": "g_die", "rate": rate, "gain": gain, "pan": pan})
        return out

    # ---------- sound ----------
    def music(self):
        ms = self.rec["music"]
        cues_path = os.path.join(self.work, "cues.json")
        with open(cues_path, "w") as f:
            json.dump(self.cues(), f)
        out = os.path.join(self.work, "music.wav")
        end = "loop" if self.ending in ("loop", "fail") else "hit"
        run(["node", os.path.join(HERE, "music.mjs"), "--style", ms["style"], "--bpm", str(self.bpm), "--bars", str(self.bars),
             "--drop", str(self.drop), "--seed", str(ms["seed"]), "--end", end, "--cues", cues_path,
             "--game-db", str(self.rec["edit"].get("game_db", -3.0)), "--out", out, "--info", os.path.join(self.work, "music.json")])
        return read_wav(out)

    # ---------- pictures ----------
    def setup_look(self):
        g = self.rec["edit"]["grade"]
        x = np.arange(256, dtype=np.float32)
        base = np.clip((x - 128.0) * g["contrast"] + 128.0, 0, 255)
        b = np.clip(base - g["warm"] * 120, 0, 255)
        r = np.clip(base + g["warm"] * 120, 0, 255)
        self.lut = np.stack([b, base, r], axis=1).astype(np.uint8).reshape(1, 256, 3)
        self.sat = g["sat"]
        self.white = np.full((H, W, 3), 255, np.uint8)
        self.red = np.zeros((H, W, 3), np.uint8)
        self.red[..., 2] = 255
        self.font = font_path(self.work)
        acc = self.rec["edit"].get("accent", "#FFD23F").lstrip("#")
        self.accent = tuple(int(acc[i:i + 2], 16) for i in (0, 2, 4))
        self.small_cache = {}
        self.cells = {}
        for t in self.texts:
            t.sprite = text_sprite(t.text, self.font, t.size, self.accent)

    def grade(self, img):
        img = cv2.LUT(img, self.lut)
        if abs(self.sat - 1.0) > 0.01:
            gray = cv2.cvtColor(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
            img = cv2.addWeighted(img, self.sat, gray, 1.0 - self.sat, 0)
        return img

    def sample(self, rd, u, uu):
        s = float(u.src(uu))
        v = float(u.speed(uu))
        x = s * FPS
        if v > 1.6:
            k = min(5, max(2, int(round(v))))
            idx = sorted(set(int(round(i)) for i in np.linspace(x - (v - 1) / 2, x + (v - 1) / 2, k)))
            acc = np.zeros((H, W, 3), np.float32)
            for i in idx:
                cv2.accumulate(rd.get(i), acc)
            return (acc / len(idx)).astype(np.uint8)
        i0 = int(math.floor(x))
        fr = x - i0
        if v < 0.85 and 0.08 < fr < 0.92:
            return cv2.addWeighted(rd.get(i0), 1.0 - fr, rd.get(i0 + 1), fr, 0)
        return rd.get(int(round(x)))

    def shot_fx(self, u, uu, tau, n, img):
        z, dx, dy = 1.0, 0.0, 0.0
        if u.impact is not None and uu >= u.impact and u.punch > 0:
            d = uu - u.impact
            z += u.punch * math.exp(-d / 0.12)
            sh = 16.0 * math.exp(-d / 0.18) * (1.4 if u.how == "slam" else 1.0)
            dx += sh * math.sin(n * 12.9898)
            dy += sh * math.sin(n * 78.233)
        in_freeze = u.freeze > 0 and uu > u.dur - u.freeze
        if self.pace == "hyper" and not in_freeze:
            ph = (tau % self.beat) / self.beat
            z += 0.014 * math.exp(-ph * 7.0)
        if self.pace == "flow" and u.kind == "clip":
            z += 0.035 * uu / max(u.dur, 1e-3)
        k = 0.0
        if in_freeze:
            k = min(1.0, max(0.0, (uu - (u.dur - u.freeze)) / max(u.freeze, 1e-3)))
            z += 0.07 * k
        if abs(z - 1.0) > 1e-3 or abs(dx) > 0.3 or abs(dy) > 0.3:
            M = cv2.getRotationMatrix2D((W / 2.0, H / 2.0), 0.0, z)
            M[0, 2] += dx
            M[1, 2] += dy
            img = cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        if in_freeze:
            gray = cv2.cvtColor(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
            img = cv2.addWeighted(img, 1.0 - 0.55 * k, gray, 0.55 * k, 0)
            img = cv2.convertScaleAbs(img, alpha=1.0 - 0.3 * k)
            if self.ending == "fail":
                img = cv2.addWeighted(img, 1.0, self.red, 0.12 * k, 0)
        return img

    # transitions
    def zoom(self, img, s, blur=0):
        outs = []
        for j in range(blur + 1):
            M = cv2.getRotationMatrix2D((W / 2.0, H / 2.0), 0.0, s * (1.0 + 0.035 * j))
            outs.append(cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT))
        if len(outs) == 1:
            return outs[0]
        acc = np.zeros((H, W, 3), np.float32)
        for o in outs:
            cv2.accumulate(o, acc)
        return (acc / len(outs)).astype(np.uint8)

    def shift(self, img, dx, blur):
        if blur > 1:
            img = cv2.blur(img, (int(blur), 1))
        M = np.float32([[1, 0, dx], [0, 1, 0]])
        return cv2.warpAffine(img, M, (W, H), borderMode=cv2.BORDER_REFLECT)

    def glitch(self, img, a, n):
        rng = random.Random(n * 7919)
        b, g, r = cv2.split(img)
        d = int(30 * a)
        img = cv2.merge([np.roll(b, -d, axis=1), g, np.roll(r, d, axis=1)])
        for _ in range(int(4 + 6 * a)):
            y0 = rng.randrange(0, H - 40)
            h = rng.randrange(16, 140)
            img[y0:y0 + h] = np.roll(img[y0:y0 + h], rng.randint(-int(90 * a) - 1, int(90 * a) + 1), axis=1)
        return img

    def trans_out(self, kind, img, q, n):
        q = min(1.0, max(0.0, q))
        if kind == "flash":
            a = q * q
            return cv2.addWeighted(img, 1.0 - a, self.white, a, 0)
        if kind == "zoom":
            return self.zoom(img, 1.0 + 0.55 * q * q, 2)
        if kind == "whip":
            return self.shift(img, -W * 0.6 * q * q, 2 + 150 * q)
        if kind == "glitch":
            return self.glitch(img, q, n)
        return img

    def trans_in(self, kind, img, frozen, p, n, key):
        p = min(1.0, max(0.0, p))
        if kind == "flash":
            a = (1.0 - p) ** 1.6
            return cv2.addWeighted(img, 1.0 - a, self.white, a, 0)
        if kind == "zoom":
            return self.zoom(img, 1.0 + 0.32 * (1.0 - p) ** 2, 1 if p < 0.5 else 0)
        if kind == "whip":
            return self.shift(img, W * 0.6 * (1.0 - p) ** 2, 2 + 150 * (1.0 - p))
        if kind == "glitch":
            return self.glitch(img, 1.0 - p, n)
        if frozen is None:
            return img
        if kind == "iris":
            cx, cy = W // 2, int(H * 0.45)
            rad = int((p ** 1.4) * 1250)
            mask = np.zeros((H, W), np.uint8)
            cv2.circle(mask, (cx, cy), rad, 255, -1, cv2.LINE_AA)
            out = np.where(mask[..., None] > 127, img, frozen)
            cv2.circle(out, (cx, cy), rad, (255, 255, 255), 10, cv2.LINE_AA)
            return out
        if kind == "shatter":
            if key not in self.cells:
                self.cells[key] = shatter_cells(key)
            return shatter(img, frozen, p, self.cells[key])
        return img

    def small_text(self, text, size):
        spr = self.small_cache.get((text, size))
        if spr is None:
            spr = text_sprite(text, self.font, size, self.accent)
            self.small_cache[(text, size)] = spr
        return spr

    def overlays(self, img, tau, unit):
        for t in self.texts:
            if not (t.t0 <= tau < t.t1):
                continue
            k, rem = tau - t.t0, t.t1 - tau
            scale, alpha = 1.0, 1.0
            if t.anim == "slam":
                if k < 0.09:
                    scale, alpha = 1.9 - 0.9 * (k / 0.09), k / 0.09
            else:
                if k < 0.1:
                    scale = 0.5 + 0.62 * (k / 0.1)
                elif k < 0.18:
                    scale = 1.12 - 0.12 * ((k - 0.1) / 0.08)
            if rem < 0.14:
                alpha *= rem / 0.14
                scale *= 0.96 + 0.04 * rem / 0.14
            img = blit(img, t.sprite, W / 2.0, H * t.y, scale, alpha)
        body = self.T[1] <= tau < self.T[-2]
        label = self.label_for(unit) if body else ""
        if label:
            img = blit(img, self.small_text(label, 50), W / 2.0, H * 0.062, 1.0, 0.95)
        if self.rec["edit"].get("counter") and self.pop_times and body:
            c = bisect.bisect_right(self.pop_times, tau)
            if c > 0:
                last = self.pop_times[c - 1]
                bump = 1.0 + 0.16 * math.exp(-max(0.0, tau - last) / 0.08)
                img = blit(img, self.small_text("POPS *%d*" % c, 60), W / 2.0, H * (0.115 if label else 0.075), bump, 0.95)
        return img

    def render(self, out_mp4, audio_wav):
        units, T = self.units, self.T
        nframes = int(round(T[-1] * FPS))
        readers = {}
        enc = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", "%dx%d" % (W, H),
                                "-r", str(FPS), "-i", "-", "-i", audio_wav, "-map", "0:v", "-map", "1:a",
                                "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-profile:v", "high",
                                "-c:a", "aac", "-b:a", "192k", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", str(SR),
                                "-movflags", "+faststart", "-shortest", out_mp4], stdin=subprocess.PIPE)
        k = 0
        last_base, frozen = None, None
        for n in range(nframes):
            tau = n / FPS
            while k + 1 < len(units) and tau >= T[k + 1] - 1e-9:
                k += 1
                frozen = last_base
            u = units[k]
            # never below 0: a frame on the very start of a shot can land a hair before it (fractional powers of a
            # negative number are complex in Python)
            uu = max(0.0, tau - T[k])
            rd = readers.get(u.take.i)
            if rd is None:
                rd = readers[u.take.i] = Reader(u.take)
            base = self.shot_fx(u, uu, tau, n, self.sample(rd, u, uu))
            img = base
            if k > 0 or u.trans == "flash":
                if u.trans in IN_DUR and uu < IN_DUR[u.trans]:
                    img = self.trans_in(u.trans, img, frozen, uu / IN_DUR[u.trans], n, k)
            if k + 1 < len(units):
                nt = units[k + 1].trans
                left = T[k + 1] - tau
                if OUT_DUR.get(nt, 0.0) > 0 and left < OUT_DUR[nt]:
                    img = self.trans_out(nt, img, 1.0 - left / OUT_DUR[nt], n)
            elif self.ending == "loop" and nframes - n <= 4:
                a = min(1.0, max(0.0, (5 - (nframes - n)) / 5.0))
                img = cv2.addWeighted(img, 1.0 - a * a, self.white, a * a, 0)
            img = self.overlays(self.grade(img), tau, u)
            enc.stdin.write(np.ascontiguousarray(img).tobytes())
            last_base = base
            if n % 150 == 0:
                print("  frame %d / %d" % (n, nframes), flush=True)
        enc.stdin.close()
        enc.wait()
        for rd in readers.values():
            rd.close()
        if enc.returncode != 0:
            raise SystemExit("ffmpeg could not write the video")

    def summary(self):
        out = {"style": self.style, "bpm": self.bpm, "bars": self.bars, "drop": self.drop, "seconds": round(self.T[-1], 2),
               "pace": self.pace, "ending": self.ending, "hook": self.hook_kind, "pops": len(self.pop_times),
               "values": self.fill_values, "stats": self.rec.get("stats"), "shots": []}
        for k, u in enumerate(self.units):
            a, b = u.span()
            out["shots"].append({"at": round(self.T[k], 2), "kind": u.kind, "take": u.take.spec["name"], "level": u.take.level,
                                 "beats": u.beats, "from": round(a, 2), "to": round(b, 2), "how": u.how, "trans": u.trans,
                                 "moment": u.mom.kind if u.mom is not None else None, "freeze": round(u.freeze, 2)})
        out["texts"] = [{"at": round(t.t0, 2), "to": round(t.t1, 2), "text": t.text} for t in self.texts]
        return out


# ---------- drawing ----------
def font_path(work):
    """the game's own display font (Lilita One, shipped in www/fonts), as a TTF for Pillow"""
    out = os.path.join(work, "lilita-one.ttf")
    if os.path.exists(out):
        return out
    try:
        from fontTools.ttLib import TTFont
        f = TTFont(os.path.join(ROOT, "www", "fonts", "lilita-one-latin-400-normal.woff2"))
        f.flavor = None
        f.save(out)
        return out
    except Exception as e:  # noqa: BLE001
        print("font: falling back (%s)" % e)
        for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "C:/Windows/Fonts/arialbd.ttf"):
            if os.path.exists(p):
                return p
        raise


def text_sprite(text, font_file, size, accent, maxw=960):
    """words, white with a thick ink edge (the game's outline colour) and a soft shadow; *these words* in the accent
    colour. BGRA."""
    font = ImageFont.truetype(font_file, size)
    words, hl = [], False
    for raw in text.split():
        w = raw
        starts, ends = w.startswith("*"), w.endswith("*") and len(w) > 1
        w = w.strip("*")
        on = hl or starts
        words.append((w, on))
        if starts and not ends:
            hl = True
        if ends:
            hl = False
        if raw == "*":
            hl = not hl
    space = font.getlength(" ")
    lines, cur, cw = [], [], 0.0
    for w, on in words:
        lw = font.getlength(w)
        if cur and cw + space + lw > maxw:
            lines.append((cur, cw))
            cur, cw = [], 0.0
        cw = cw + (space if cur else 0.0) + lw
        cur.append((w, on, lw))
    if cur:
        lines.append((cur, cw))
    stroke = max(4, int(size * 0.11))
    lh = int(size * 1.12)
    cw_max = max(c for _, c in lines) if lines else 10
    Wc, Hc = int(cw_max + 2 * stroke + 40), int(len(lines) * lh + 2 * stroke + 40)
    layer = Image.new("RGBA", (Wc, Hc), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    y = stroke + 14
    for ws, lw in lines:
        x = (Wc - lw) / 2.0
        for w, on, wl in ws:
            col = accent + (255,) if on else (255, 255, 255, 255)
            d.text((x, y), w, font=font, fill=col, stroke_width=stroke, stroke_fill=INK + (255,))
            x += wl + space
        y += lh
    alpha = layer.split()[3].filter(ImageFilter.GaussianBlur(size * 0.08))
    shadow = Image.new("RGBA", (Wc, Hc), (0, 0, 0, 0))
    shadow.putalpha(alpha.point(lambda v: int(v * 0.6)))
    canvas = Image.new("RGBA", (Wc, Hc), (0, 0, 0, 0))
    canvas.alpha_composite(shadow, (0, int(size * 0.06)))
    canvas.alpha_composite(layer)
    a = np.array(canvas)
    return np.ascontiguousarray(a[..., [2, 1, 0, 3]])


def blit(img, spr, cx, cy, scale=1.0, alpha=1.0):
    if alpha <= 0.01 or spr is None:
        return img
    if abs(scale - 1.0) > 1e-3:
        h, w = spr.shape[:2]
        spr = cv2.resize(spr, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_LINEAR)
    h, w = spr.shape[:2]
    x0, y0 = int(cx - w / 2), int(cy - h / 2)
    xa, ya, xb, yb = max(0, x0), max(0, y0), min(W, x0 + w), min(H, y0 + h)
    if xb <= xa or yb <= ya:
        return img
    if not img.flags.writeable:
        img = img.copy()
    s = spr[ya - y0:yb - y0, xa - x0:xb - x0]
    a = s[..., 3:4].astype(np.float32) * (alpha / 255.0)
    roi = img[ya:yb, xa:xb].astype(np.float32)
    img[ya:yb, xa:xb] = (roi * (1.0 - a) + s[..., :3].astype(np.float32) * a).astype(np.uint8)
    return img


def shatter_cells(seed):
    rng = np.random.default_rng(seed + 11)
    cx, cy = W * rng.uniform(0.35, 0.65), H * rng.uniform(0.35, 0.55)
    pts = [(cx + rng.normal(0, 230), cy + rng.normal(0, 300)) for _ in range(14)]
    pts += [(rng.uniform(0, W), rng.uniform(0, H)) for _ in range(14)]
    sub = cv2.Subdiv2D((0, 0, W, H))
    for x, y in pts:
        sub.insert((float(min(max(x, 2), W - 3)), float(min(max(y, 2), H - 3))))
    facets, centers = sub.getVoronoiFacetList([])
    maxd = math.hypot(W, H) / 2
    cells = []
    for poly, c in zip(facets, centers):
        poly = np.clip(np.array(poly), [0, 0], [W - 1, H - 1]).astype(np.int32)
        x0, y0 = poly.min(axis=0)
        x1, y1 = poly.max(axis=0)
        if x1 - x0 < 4 or y1 - y0 < 4:
            continue
        mask = np.zeros((y1 - y0 + 1, x1 - x0 + 1), np.uint8)
        cv2.fillPoly(mask, [poly - [x0, y0]], 255)
        dist = math.hypot(c[0] - cx, c[1] - cy)
        cells.append({"poly": poly, "box": (int(x0), int(y0), int(x1), int(y1)), "mask": mask, "c": (float(c[0]), float(c[1])),
                      "delay": 0.22 * dist / maxd, "vx": (c[0] - cx) * rng.uniform(0.5, 1.4), "vy": (c[1] - cy) * rng.uniform(0.3, 1.0) - rng.uniform(150, 450),
                      "rot": rng.uniform(-50, 50)})
    return cells


def shatter(img_b, frozen, p, cells):
    """the last picture breaks like glass and falls away, showing the next shot behind it"""
    if p < 0.12:
        out = frozen.copy()
        cv2.polylines(out, [c["poly"] for c in cells], True, (255, 255, 255), 3, cv2.LINE_AA)
        return cv2.addWeighted(out, 0.75, np.full_like(out, 255), 0.25 * (1 - p / 0.12), 0)
    out = img_b.copy()
    q = (p - 0.12) / 0.88
    for c in cells:
        pi = min(1.0, max(0.0, (q - c["delay"]) / 0.7))
        if pi >= 1.0:
            continue
        x0, y0, x1, y1 = c["box"]
        patch = frozen[y0:y1 + 1, x0:x1 + 1]
        cxp, cyp = c["c"][0] - x0, c["c"][1] - y0
        M = cv2.getRotationMatrix2D((cxp, cyp), c["rot"] * pi, 1.0 - 0.35 * pi)
        M[0, 2] += x0 + c["vx"] * pi
        M[1, 2] += y0 + c["vy"] * pi + 2600 * pi * pi
        ph, pw = patch.shape[:2]
        corners = np.array([[0, 0, 1], [pw, 0, 1], [0, ph, 1], [pw, ph, 1]], np.float64) @ M.T
        dx0, dy0 = int(math.floor(corners[:, 0].min())), int(math.floor(corners[:, 1].min()))
        dx1, dy1 = int(math.ceil(corners[:, 0].max())), int(math.ceil(corners[:, 1].max()))
        xa, ya, xb, yb = max(0, dx0), max(0, dy0), min(W, dx1), min(H, dy1)
        if xb <= xa or yb <= ya:
            continue
        Ml = M.copy()
        Ml[0, 2] -= xa
        Ml[1, 2] -= ya
        wp = cv2.warpAffine(patch, Ml, (xb - xa, yb - ya))
        wm = cv2.warpAffine(c["mask"], Ml, (xb - xa, yb - ya))
        roi = out[ya:yb, xa:xb]
        np.copyto(roi, wp, where=(wm[..., None] > 127))
        if pi < 0.5:
            edges = cv2.Canny(wm, 50, 150)
            roi[edges > 0] = (255, 255, 255)
    return out


# ---------- the whole cut ----------
def make(rec, takes_dir, out_dir, name):
    os.makedirs(out_dir, exist_ok=True)
    work = os.path.join(out_dir, name + "-work")
    os.makedirs(work, exist_ok=True)
    takes = [Take(i, t, takes_dir) for i, t in enumerate(rec["takes"])]
    for t in takes:
        size = probe_size(t.avi) if os.path.exists(t.avi) else (0, 0)
        print("take %s: %s, level %d, %s, %dx%d, %d frames, %d moments" % (
            t.spec["name"], "ok" if t.ok() else "NOT USABLE", t.level, t.outcome or "-", size[0], size[1], t.nframes, len(t.moments)))
        if t.ok() and size != (W, H):
            print("  not %dx%d: cut to shape from the middle, never stretched" % (W, H))
    ed = Editor(rec, takes, work)
    ed.plan()
    ed.plan_texts()
    summ = ed.summary()
    with open(os.path.join(out_dir, name + ".json"), "w") as f:
        json.dump(summ, f, indent=1)
    print("cut: %d shots, %.1f s, %s bpm, drop at bar %d, ending %s" % (len(ed.units), ed.T[-1], ed.bpm, ed.drop, ed.ending), flush=True)
    for t in ed.texts:
        print("  %5.1f-%5.1f  %s" % (t.t0, t.t1, t.text))
    # an ending that is mostly a still picture is a poor ending (one Glass Run short froze for 15 s)
    freeze = ed.units[-1].freeze
    if freeze > 4.5:
        raise SystemExit("the ending would be a %.1f s still frame" % freeze)
    music = ed.music()
    n = int(round(ed.T[-1] * SR))
    if len(music) < n:
        music = np.concatenate([music, np.zeros((n - len(music), 2), np.float32)])
    wav = os.path.join(work, "mix.wav")
    write_wav(wav, music[:n])
    ed.setup_look()
    mp4 = os.path.join(out_dir, name + ".mp4")
    ed.render(mp4, wav)
    # the finished short is checked like the takes were: the right shape, the right length
    size, dur = probe_size(mp4), probe_duration(mp4)
    print("made %s: %dx%d, %.1f s" % (mp4, size[0], size[1], dur))
    if size != (W, H):
        raise SystemExit("the short came out %dx%d, not %dx%d" % (size[0], size[1], W, H))
    if not 29.0 <= dur <= 51.0:
        raise SystemExit("the short is %.1f s long" % dur)
    write_notes(rec, summ, os.path.join(out_dir, name + ".txt"))
    return mp4


def write_notes(rec, summ, path):
    hook = summ["texts"][0]["text"].replace("*", "") if summ["texts"] else "Blob Blaster"
    words = []
    for w in hook.split():
        words.append(w if any(ch.isdigit() for ch in w) else w[:1].upper() + w[1:].lower())
    title = "%s %s | Blob Blaster #shorts" % (" ".join(words), EMOJI.get(rec["style"], ""))
    lines = [" ".join(words), "", "Blob Blaster: slide the cannon, pop the bouncing blobs before they land on you.",
             "A bot plays the real game in this video."]
    st = rec.get("stats") or {}
    if st.get("tries"):
        lines.append("The odds are real: before recording, the bot played level %d %d times and cleared it %d times."
                     % (st["level"], st["tries"], st["wins"]))
    lines += ["The music is original, made in code for this video.", "", P.TITLE_TAGS]
    with open(path, "w", encoding="utf-8") as f:
        f.write("TITLE:\n%s\n\nDESCRIPTION:\n%s\n\nHASHTAGS:\n%s\n\nSTYLE: %s   MUSIC: %s %d bpm   LENGTH: %.1f s   ENDING: %s\n"
                % (title[:100], "\n".join(lines), P.TITLE_TAGS, rec["style"], rec["music"]["style"], rec["music"]["bpm"],
                   summ["seconds"], summ["ending"]))


# ---------- a check of the whole cut, with made-up takes ----------
def fake_events(t, frames, r, outcome):
    """what the game might have written for a take: pops, splits, hits, close calls, shots, and how it ended"""
    f0 = 12
    ev = [{"e": "start", "f": f0, "level": t["level"], "theme": t["theme"], "lives": 3, "blobs": 4, "hp": 60}]
    for f in range(f0, frames - 10, 6):
        ev.append({"e": "tick", "f": f, "lives": 3, "n": 3, "left": 1, "p": 0.5})
    for f in range(f0 + 5, frames - 20):
        if f % 3 == 0:
            ev.append({"e": "shot", "f": f, "n": 1})
    lives = 3
    end = frames - int(2.2 * FPS)
    f = f0
    while f < end - 30:
        f += r.randint(6, 26)
        x = r.random()
        if x < 0.72:
            s = r.choice([0, 0, 0, 1, 1, 2, 3])
            ev.append({"e": "pop", "f": f, "s": s, "hp": 8 * (s + 1), "x": r.randint(20, 340), "y": r.randint(100, 500), "c": r.randint(1, 7)})
        elif x < 0.85:
            ev.append({"e": "close", "f": f, "v": round(r.random(), 2), "s": r.randint(0, 3), "lives": lives})
        elif x < 0.92 and lives > 1 and (t.get("want") == "lives1" or outcome == "over"):
            lives -= 1
            ev.append({"e": "hurt", "f": f, "lives": lives, "s": 2, "x": 180})
    if t.get("want") == "giant":
        ev.append({"e": "pop", "f": end - 60, "s": 3, "hp": 48, "x": 180, "y": 300, "c": 1})
    if outcome == "win":
        ev.append({"e": "win", "f": end, "s": 0, "hp": 3, "x": 200, "y": 400, "c": 3})
        ev.append({"e": "clear", "f": end + 54, "lives": lives})
    elif outcome == "over":
        ev.append({"e": "hurt", "f": end, "lives": 0, "s": 1, "x": 180})
        ev.append({"e": "over", "f": end, "x": 180})
    ev.append({"e": "end", "f": frames, "outcome": outcome, "lives": lives})
    ev.sort(key=lambda e: e["f"])
    return ev


def selftest(work, style):
    os.makedirs(work, exist_ok=True)
    rec = P.recipe(424242, style)
    rec["edit"]["transitions"] = ["flash", "zoom", "whip", "glitch", "shatter", "iris"]
    rec["edit"]["counter"] = True
    if rec.get("stats"):
        rec["stats"].update({"level": 9, "wins": 3, "tries": 12, "pct": 25})
    tdir = os.path.join(work, "takes")
    os.makedirs(tdir, exist_ok=True)
    r = random.Random(5)
    takes = list(rec["takes"])
    if style in ("odds", "challenge"):
        # two attempts: the first lost, the second (the last word) cleared
        first = dict(takes[0], name="t2", final=False)
        takes = [dict(first, name="t1"), dict(takes[0], name="t2")]
    for k, t in enumerate(takes):
        if t["level"] == "pick":
            t["level"] = 9
        dur = 16.0 + r.uniform(0, 8)
        frames = int(dur * FPS)
        avi = os.path.join(tdir, t["name"] + ".avi")
        # a moving test picture (a stretch would show on its circles), in another colour for each take
        run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=%dx%d:rate=%d:duration=%.2f" % (W, H, FPS, dur),
             "-vf", "hue=h=%d" % (k * 70), "-c:v", "mjpeg", "-q:v", "6", "-an", avi])
        if t.get("final"):
            outcome = "over" if style == "fail" else "win"
        elif style in ("odds", "challenge"):
            outcome = "over"
        else:
            outcome = r.choice(["win", "win", "over"])
        with open(os.path.join(tdir, t["name"] + ".jsonl"), "w") as fh:
            for e in fake_events(t, frames, r, outcome):
                fh.write(json.dumps(e) + "\n")
        t["outcome"] = outcome
    rec["takes"] = takes
    with open(os.path.join(work, "recipe.json"), "w") as f:
        json.dump(rec, f, indent=1)
    mp4 = make(rec, tdir, os.path.join(work, "out"), "selftest-" + style)
    summ = json.load(open(os.path.join(work, "out", "selftest-" + style + ".json")))
    # the words must match the picture
    if style in ("odds", "challenge") and summ["ending"] != "won":
        raise SystemExit("selftest %s: the last attempt was cleared, but the ending is %s" % (style, summ["ending"]))
    if style == "fail" and summ["ending"] != "fail":
        raise SystemExit("selftest fail: the run was lost, but the ending is %s" % summ["ending"])
    if any("{" in t["text"] for t in summ["texts"]):
        raise SystemExit("selftest %s: a word was not filled in: %s" % (style, summ["texts"]))
    print("selftest %s: %.1f s, ending %s, ok" % (style, summ["seconds"], summ["ending"]))
    return mp4


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--recipe")
    ap.add_argument("--takes")
    ap.add_argument("--out", default="out")
    ap.add_argument("--name", default="short")
    ap.add_argument("--selftest")
    ap.add_argument("--style", default="challenge")
    a = ap.parse_args()
    if a.selftest:
        for style in a.style.split(","):
            selftest(os.path.join(a.selftest, style), style)
        return
    make(json.load(open(a.recipe)), a.takes, a.out, a.name)


if __name__ == "__main__":
    main()
