# Blob Blaster

Arcade shooter: slide the cannon, pop the bouncing number blobs. Single-file HTML5 canvas game (`www/index.html`) wrapped for Android with [Capacitor](https://capacitorjs.com).

The cannon is **the same on every level** (9 shots/sec, 1 damage) and there is no shop. Levels get harder because the blobs do: more of them, bigger, with more total HP (`hpTarget` / `levelShape` in the game file). `tools/balance-sim.mjs` plays levels with a bot; roughly it wins ~100% of levels 1-3, ~80% around level 10, ~40% at level 20 and almost never past level 35.

## Develop
```bash
npm install
npm run serve                 # open www/ in a desktop browser (or just open www/index.html)
npm run sync                  # copy www/ into android/
cd android && ./gradlew assembleDebug    # debug APK (needs Android SDK / Android Studio)
```
Release / Play Store steps: see [PLAY_STORE.md](PLAY_STORE.md).

## Tools (need a Chromium: `CHROME_PATH=/path/to/chrome`)
- `node tools/ui-test.mjs` – UI/flow checks + screenshots in `test-output/`
- `node tools/balance-sim.mjs` – bot win-rate table per level
- `node tools/store-assets.mjs` – regenerates `store/` listing graphics
- `node tools/make-icons.mjs` then `npm run assets` – regenerates app icon + splash
