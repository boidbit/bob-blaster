#!/usr/bin/env python3
"""Plans Blob Blaster shorts. Each short gets a recipe from its seed: a style (what the video is about and how the
bot plays), the takes to record (level, background, bot, when to stop), how to cut it (length, pace, ending,
transitions, colour), the music (style, tempo) and the words on screen.

  python3 shorts/plan.py --matrix --count 5 [--style random] [--seed 123]   the list of shorts, for the workflow
  python3 shorts/plan.py --recipe --seed 12301 --style giant                one short's recipe, as JSON

Only the standard library: it also runs on a computer with nothing installed.
"""
import argparse
import json
import random
import sys
import time

STYLES = ["lastheart", "odds", "giant", "speedrun", "satisfying", "fail", "challenge"]
THEMES = ["night", "desert", "ocean", "snow", "meadow", "lava"]

# how the bot plays. "pro" is tools/bot.js as it is; the others now and then look away for a moment
# (lapse: looks away per second on average, dur: for how long, after: not before this many seconds)
BOTS = {
    "pro": {"lapse": 0.0, "dur": [0.3, 0.6], "after": 0.0},
    "shaky": {"lapse": 0.35, "dur": [0.35, 0.8], "after": 4.0},
}

# music for each style of short, and the tempo range of each music style (as in shorts/music.mjs)
MUSIC_FOR = {
    "lastheart": ["phonk", "trap", "cinematic"],
    "odds": ["cinematic", "trap", "phonk"],
    "giant": ["edm", "phonk", "trap"],
    "speedrun": ["edm", "synthwave", "phonk"],
    "satisfying": ["lofi", "synthwave", "edm"],
    "fail": ["trap", "phonk"],
    "challenge": ["cinematic", "phonk", "edm"],
}
BPM = {"phonk": (128, 148), "trap": (136, 156), "edm": (122, 128), "lofi": (74, 88), "cinematic": (92, 108), "synthwave": (100, 116)}

# the first words on screen. *word* is drawn in the highlight colour. Every number is filled in from what was
# recorded or measured: {lives} hearts left, {level} the level, {wins}/{tries} the bot's measured wins, {pct} the
# same in per cent, {hp} the biggest blob's HP, {pops} blobs popped in the video, {sec} seconds of video,
# {last} the last level of a speedrun, {levels} how many levels, {progress} how much of the level was cleared when
# the hearts ran out ("so close" is only said when that is 80% or more)
HOOKS = {
    "lastheart": ["*{lives}* HEART LEFT...", "ONE MORE HIT AND IT'S *OVER*", "LAST HEART. *NO PRESSURE.*", "HEART RATE: *200*",
                  "DON'T. GET. *HIT.*"],
    "odds": ["LEVEL {level}: THE BOT WINS *{wins} IN {tries}*", "THE BOT BEATS LEVEL {level} *{pct}%* OF THE TIME",
             "LEVEL {level}: *{wins} WINS IN {tries} TRIES*"],
    "giant": ["THE *BIGGEST* BLOB IN THE GAME", "*{hp} HP* BLOB VS ONE CANNON", "HOW MANY SHOTS TO POP *THIS?*", "WAIT FOR THE *BIG ONE*"],
    "speedrun": ["LEVEL 1 TO {last} IN *{sec}* SECONDS", "*{levels}* LEVELS IN *{sec}* SECONDS", "SPEEDRUN: *LEVEL 1 TO {last}*"],
    "satisfying": ["THE MOST *SATISFYING* POPS", "*{pops}* POPS IN *{sec}* SECONDS", "TELL ME THIS ISN'T *SATISFYING*", "WATCH THEM *SPLIT*"],
    "fail": ["THIS RUN WAS PERFECT... *UNTIL*", "WAIT FOR *THE ENDING*", "SO CLOSE. *SO CLOSE.*", "ONE MISTAKE *RUINED IT*"],
    "challenge": ["CAN THE BOT BEAT *LEVEL {level}?*", "LEVEL {level} VS *THE BOT*", "IS LEVEL {level} *TOO HARD?*"],
}
# hooks that need a number the recording may not give (no 1-heart moment, no giant blob): used instead then
HOOK_PLAIN = {"lastheart": "DON'T. GET. *HIT.*", "giant": "WAIT FOR THE *BIG ONE*"}
REACT = ["NO WAY", "SO CLEAN", "BOOM", "TOO EASY", "INSANE", "WHAT?!", "SATISFYING", "POP!"]
REACT_TENSE = ["SAVED!", "CLOSE ONE", "PHEW", "STILL ALIVE", "HOW?!"]
REACT_BAD = ["OH NO", "NOOO", "OUCH"]
BEFORE_BIG = ["WAIT FOR IT...", "HERE IT COMES...", "WATCH THIS"]
ENDS = {
    "part2": ["PART 2?", "NEXT LEVEL?", "HOW FAR CAN IT GO?", "COMMENT YOUR *BEST LEVEL*"],
    "fail": ["SO CLOSE...", "OUT OF HEARTS.", "ONE MORE TRY?", "*GAME OVER*", "*{progress}%* CLEARED..."],
    "clean": ["*{pops}* POPS. *{lost}* HEARTS LOST.", "FOLLOW FOR *MORE*", "SATISFYING? *YES.*", ""],
    "won": ["IT DID IT!", "LEVEL {level}: *CLEARED*", "TOO EASY?"],
}
TITLE_TAGS = "#shorts #blobblaster #satisfying #gaming #mobilegame #arcade #bot"
ACCENTS = ["#FFD23F", "#FF5E9C", "#3FB7F0", "#3CCB6C", "#FF9F45", "#B98CFF"]


def recipe(seed, style):
    r = random.Random(seed)
    takes = []

    def take(level, bot="pro", max_time=110.0, want="", tries=0, final=False, tail_win=2.4, tail_over=1.8):
        b = dict(BOTS[bot]) if isinstance(bot, str) else bot
        takes.append({
            "name": "t%d" % (len(takes) + 1), "level": level, "theme": r.choice(THEMES), "seed": r.randrange(1, 10 ** 6),
            "bot": b, "max_time": round(max_time, 1), "tail_win": tail_win, "tail_over": tail_over,
            "want": want, "tries": tries, "final": final,
        })

    # the bot's measured odds choose the level for some styles (shorts/record.mjs plays it this many times first)
    stats = None
    # how to make one more take when the bot lost early and there is too little to cut from
    more = {"levels": [2, 6], "bot": "pro"}
    if style == "lastheart":
        for lv in r.sample(range(3, 8), 2):
            take(lv, "shaky", 100, want="lives1", tries=3)
        more = {"levels": [3, 7], "bot": "shaky"}
    elif style == "odds":
        stats = {"levels": [4, 12], "trials": 12, "aim": 35, "range": [10, 60]}
        take("pick", final=True, max_time=150)
        more = {"attempt": True}
    elif style == "challenge":
        stats = {"levels": [6, 14], "trials": 12, "aim": 20, "range": [5, 50]}
        take("pick", final=True, max_time=150)
        more = {"attempt": True}
    elif style == "giant":
        for lv in r.sample(range(5, 9), 2):
            take(lv, want="giant", tries=2)
        more = {"levels": [5, 8], "bot": "pro"}
    elif style == "speedrun":
        last = r.randint(5, 7)
        for lv in range(1, last + 1):
            take(lv, max_time=90, want="win", tries=4, tail_win=1.2)
        more = None   # level 1, 2, 3... in order: no random extra level in between
    elif style == "satisfying":
        for lv in r.sample(range(2, 7), 3):
            take(lv, max_time=90)
        more = {"levels": [2, 6], "bot": "pro"}
    elif style == "fail":
        take(r.randint(2, 4), max_time=70)
        fail_bot = {"lapse": 0.9, "dur": [0.5, 1.1], "after": round(r.uniform(8.0, 16.0), 1)}
        take(r.randint(5, 8), fail_bot, 120, want="over", tries=3, final=True)
        more = {"levels": [2, 4], "bot": "pro"}
    if more is not None:
        more["themes"] = r.sample(THEMES, 4)

    music = r.choice(MUSIC_FOR[style])
    if style == "fail":
        ending = "fail"
    elif style in ("odds", "challenge"):
        ending = "answer"   # whatever the last attempt shows: cleared, or out of hearts
    else:
        ending = r.choice(["loop", "part2", "clean", "loop"])
    pace = {"speedrun": ["hyper", "mixed"], "giant": ["hyper", "mixed"], "satisfying": ["flow", "mixed"],
            "lastheart": ["mixed", "flow"], "odds": ["mixed", "flow"], "challenge": ["mixed", "hyper"], "fail": ["mixed", "flow"]}[style]
    trans = r.sample(["flash", "zoom", "whip", "glitch", "shatter", "iris"], r.choice([3, 4]))
    return {
        "seed": seed, "style": style,
        "takes": takes, "stats": stats, "more": more,
        "edit": {
            "length": r.randint(30, 50),
            "pace": r.choice(pace),
            "ending": ending,
            "hook": "low" if style == "lastheart" else "flash" if style == "giant" else r.choice(["flash", "flash", "cold"]),
            "transitions": trans,
            "counter": style == "satisfying" or (style in ("giant", "speedrun") and r.random() < 0.4),
            "label": style in ("speedrun", "odds", "challenge"),
            "react": r.random() < 0.75,
            "grade": {"sat": round(r.uniform(1.0, 1.15), 2), "contrast": round(r.uniform(1.0, 1.1), 2), "warm": round(r.uniform(-0.03, 0.05), 3)},
            "accent": r.choice(ACCENTS),
            "game_db": {"lofi": -1.0, "cinematic": -2.0, "synthwave": -2.0}.get(music, -3.0),
        },
        "music": {"style": music, "bpm": r.randint(*BPM[music]), "seed": r.randrange(1, 10 ** 6)},
        "text": {
            "hook": r.choice(HOOKS[style]),
            "react": r.choice(REACT_TENSE if style in ("lastheart", "challenge", "odds") else REACT),
            "react_bad": r.choice(REACT_BAD),
            "before": r.choice(BEFORE_BIG),
            "end": {k: r.choice(v) for k, v in ENDS.items()},
        },
    }


def styles_for(count, style, r):
    if style != "random":
        return [style] * count
    out = []
    while len(out) < count:
        bag = STYLES[:]
        r.shuffle(bag)
        out += bag
    return out[:count]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--matrix", action="store_true")
    ap.add_argument("--recipe", action="store_true")
    ap.add_argument("--count", type=int, default=3)
    ap.add_argument("--style", default="random")
    ap.add_argument("--seed", default="")
    a = ap.parse_args()
    if a.style != "random" and a.style not in STYLES:
        sys.exit("style must be random or one of: " + ", ".join(STYLES))
    base = int(a.seed) if str(a.seed).strip() else int(time.time()) % 1000000
    if a.matrix:
        r = random.Random(base)
        styles = styles_for(a.count, a.style, r)
        inc = [{"n": i + 1, "seed": base * 100 + i + 1, "style": s} for i, s in enumerate(styles)]
        print("seed %d" % base, file=sys.stderr)
        print("matrix=" + json.dumps({"include": inc}))
    else:
        print(json.dumps(recipe(base, a.style if a.style != "random" else random.Random(base).choice(STYLES)), indent=1))


if __name__ == "__main__":
    main()
