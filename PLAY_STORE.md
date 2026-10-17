# Blob Blaster – Google Play checklist

Package name: `com.boidbit.blobblaster` — **permanent** once you upload to Play. Change it in `capacitor.config.json`
and `android/app/build.gradle` (and the Java folder / `MainActivity` package) *before* the first upload if you want another one.

## 1. Make your upload key (on your own computer, once)
You need Java (JDK 17+) installed, or use the one bundled with Android Studio.

```bash
keytool -genkeypair -v -storetype PKCS12 -keystore blob-blaster-upload.jks \
  -alias upload -keyalg RSA -keysize 2048 -validity 10000
```
- Keep `blob-blaster-upload.jks` and its passwords in a password manager **and a backup**. Never commit them (they are git-ignored).
- Use the same upload key for all your future games if you like, or a new one per game.
- With Play App Signing (default and required for new apps) Google holds the real app-signing key; this is only your *upload* key,
  and Google can reset it if you lose it.

Then copy `android/keystore.properties.example` to `android/keystore.properties` and fill in the path and passwords.

## 2. Build the AAB (the file Play wants)
```bash
npm install
npm run sync          # copies www/ into the Android project
cd android
./gradlew bundleRelease -PversionCode=1
# -> android/app/build/outputs/bundle/release/app-release.aab
```
Every new upload needs a **higher `versionCode`** (`-PversionCode=2`, 3, …). Bump `versionName` in `android/app/build.gradle` for user-facing versions.
Android Studio works too: open the `android/` folder → Build → Generate Signed App Bundle.

**Or let GitHub build it:** repo → Settings → Secrets and variables → Actions, add
`UPLOAD_KEYSTORE_BASE64` (`base64 -w0 blob-blaster-upload.jks`), `UPLOAD_KEYSTORE_PASSWORD`, `UPLOAD_KEY_ALIAS` (`upload`), `UPLOAD_KEY_PASSWORD`.
Every push to `main` then produces a debug APK (for phone testing) and a signed AAB under the run's Artifacts. Without the secrets only the debug APK is built.

Test the APK on your phone first: `adb install app-debug.apk` or just download the artifact on the phone.

## 3. Privacy policy URL
Repo → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/docs`.
Policy URL will be `https://boidbit.github.io/bob-blaster/privacy.html` (edit the email in `docs/privacy.html` if you want a different one).

## 4. Play Console steps
1. Create app → name **Blob Blaster**, Game, Free.
2. **App content** forms: Privacy policy (URL above) · Ads: **No** · App access: all functionality available · Content rating questionnaire (no violence beyond cartoon blobs, no user content → should come out Everyone/PEGI 3) · Target audience: 13+ is simplest (choosing under-13 triggers Families policy requirements) · News app: No · Government app: No · Financial features: none.
3. **Data safety**: "Does your app collect or share any required user data types?" → **No**. Data is not collected, nothing shared. (The only permission is VIBRATE.)
4. **Store listing** — graphics are in `store/`:
   - App icon: `store/icon-512.png`
   - Feature graphic: `store/feature-graphic.png`
   - Phone screenshots: `store/phone-1.png` … `phone-4.png` (1080×1920)
   - Short description (80 chars): `Pop the bouncing blobs with your cannon. Quick, colourful and easy to learn!`
   - Full description:
     > Blob Blaster is a fast, colourful arcade shooter. Slide to move your cannon, hold fire and pop the bouncing number blobs before they land on you. Big blobs split into smaller ones, combos stack up, and every level throws something new at you.
     >
     > • One-thumb controls · • Your cannon gets stronger automatically as you reach higher levels · • Six different backgrounds, or let the game shuffle them · • Sound, vibration and background settings · • No ads, no sign-up, works offline
5. **Release**:
   - **Personal developer accounts created after Nov 2023 must run a closed test with at least 12 testers opted in for 14 continuous days** before you can apply for production. Plan this first: Testing → Closed testing → create track → upload the AAB → add testers (Google Group or email list) → ask them to opt in and keep the app installed for 14 days.
   - Then Dashboard → "Apply for production" → answer the questions → create the production release.
6. Target API: the project already targets API 36 (Play requires 36 from 31 Aug 2026).

## Reusing this for your other games
Copy the repo, replace `www/index.html`, change `appId`/`appName` in `capacitor.config.json`, `applicationId`/`namespace` in `android/app/build.gradle` (+ Java package folder), regenerate icons (`assets/` → `npm run assets`), reuse the same upload key.
