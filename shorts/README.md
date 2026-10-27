# Blob Blaster shorts

YouTube Shorts of Blob Blaster, made on GitHub with nothing installed on your computer: the bot plays the real game in
headless Chrome, frame by frame at 30 fps, the canvas is recorded at exactly 1080×1920, and a script cuts it to music
made in code. (Built on the Glass Run shorts in boidbit/glass-garden.)

## Making shorts

On GitHub: **Actions → Blob Blaster shorts → Run workflow**. Choose how many and what kind (random gives each short a
different kind), and run it. When it is done, open the run and download **blob-blaster-shorts**: an `.mp4` for each
short and a `.txt` with a title, description and hashtags to paste into YouTube.

To make the same shorts again, give the seed the run printed in its **Plan the shorts** step.

## What kind

- **lastheart**: a shaky bot down to its last heart; the hook is a near miss (or the hit) on the last heart
- **odds**: "level N: the bot wins W in T". The bot plays candidate levels first and the numbers are measured
- **giant**: the biggest blob in the game popping, the drop on it
- **speedrun**: level 1, 2, 3… in order (a level the bot could not clear ends the run, it is never skipped)
- **satisfying**: clean pops and splits, a pop counter
- **fail**: a good run, then a bot that keeps looking away loses; the music winds down
- **challenge**: "can the bot beat level N?", attempt after attempt until it does (or the takes run out)

## How each one comes out different

Each short has its own seed, and from it its own levels, backgrounds, bot, length (30 to 50 s), pace, transitions,
colour, words and music. The cut follows what happened (the recorder writes every pop, hit, close call and game over
down with its frame): the first bar is a hook, big moments come on a speed ramp or in slow motion, busy stretches play
as they were, quiet stretches are fast-forwarded or cut out. Every cut is on the beat and the drop lands on the biggest
moment. It ends on "PART 2?", loops back to the start, answers the question, or (for a fail) winds down.

The words always match the picture: numbers come from the recording or the measured odds, "so close" is only said when
80% or more of the level was cleared, and a game over is never followed by "next level?".

The music is synthesised by `music.mjs` (phonk, trap, EDM, lo-fi, cinematic or synthwave, a new key and tune each time),
and so are the game's own sounds (pops, hits, the boom), where they happen in the cut. To hear one of each music style:
`node shorts/music.mjs --demo demo/`.

## Files

- `plan.py`: the recipe for each short (what to record, how to cut it, the words)
- `record.mjs`: plays and records the takes in Chrome (`--dry`: the same takes in `sim.mjs`, events only)
- `director.js`: runs in the page: steps the game, drives the bot (`tools/bot.js`), writes the events down
- `tap.mjs`: the few lines patched into a temporary copy of the game so the recorder sees what happens (the game itself
  is never changed)
- `sim.mjs`: the game's real code in plain Node, no browser: `--check`, bot win rates (`--rates 5,10,15`)
- `edit.py`: cuts the takes into the short; `--selftest` checks the whole cut on made-up takes
- `music.mjs`: the music and the game's sounds

Quick checks without installing anything: `node shorts/sim.mjs --check`, and
`python shorts/plan.py --recipe --style giant > r.json && node shorts/record.mjs --recipe r.json --out dry --dry`.
