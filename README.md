# Blob Blaster

Arcade shooter: slide the cannon, pop the bouncing number blobs. Single-file HTML5 canvas game (`www/index.html`) wrapped for Android with [Capacitor](https://capacitorjs.com).

The cannon's **fire rate and damage rise automatically with the level** — there's no shop. Formulas are in the game file (`fireRate`, `damage`); `tools/balance-sim.mjs` plays it with a bot to check difficulty stays winnable.

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
