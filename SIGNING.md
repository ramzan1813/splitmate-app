# Signing the APK with your own key

Your release key comes **in a separate zip** (`splitmate-signing-keys.zip`), so this project folder is safe to upload to GitHub. **Never commit the keystore or passwords to the repository.** Keep the signing zip somewhere safe, such as a password manager or a private drive. If you lose it, you can't publish updates that install over the existing app.

The signing zip contains:

| File | What it is |
|---|---|
| `splitmate-release.jks` | The keystore (RSA 4096, valid ~27 years, alias `splitmate`) |
| `splitmate-release.jks.base64.txt` | The same keystore as text, for the GitHub secret |
| `passwords.txt` | The keystore password, key password and alias |

## Add the 4 GitHub secrets (about 2 minutes, no admin rights needed)

In your repository, go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret name | Value |
|---|---|
| `SPLITMATE_KEYSTORE_BASE64` | the whole content of `splitmate-release.jks.base64.txt` |
| `SPLITMATE_KEYSTORE_PASSWORD` | the value after `SPLITMATE_KEYSTORE_PASSWORD=` in `passwords.txt` |
| `SPLITMATE_KEY_PASSWORD` | the value after `SPLITMATE_KEY_PASSWORD=` |
| `SPLITMATE_KEY_ALIAS` | `splitmate` |

Run the workflow again. The log says **"Signing with your release key."**

If the secrets are missing, test builds (`[build]` / `[apk]`) still build but are signed with the public **debug** key and show a warning. **Releases refuse to build without the release key**, and every build checks the APK's signing certificate against the fingerprint below: a release signed with any other key fails instead of being published. (Override the expected fingerprint with the repository variable `EXPECTED_SIGNER_SHA256` only if you ever switch keys on purpose.) The fingerprint is also printed in the build log and in each release's notes.

## Building locally instead (optional)

You need JDK 17 and the Android SDK (Android Studio). Run:

```bash
npx expo prebuild -p android
# macOS/Linux
export SPLITMATE_KEYSTORE=/path/to/splitmate-release.jks
export SPLITMATE_KEYSTORE_PASSWORD=...  SPLITMATE_KEY_PASSWORD=...  SPLITMATE_KEY_ALIAS=splitmate
cd android && ./gradlew assembleRelease
# Windows (PowerShell): $env:SPLITMATE_KEYSTORE="C:\keys\splitmate-release.jks"  ... then .\gradlew.bat assembleRelease
```

The APK is in `android/app/build/outputs/apk/release/`.

## Certificate fingerprint

SHA-256: `87:7F:6B:CA:6A:D8:50:0E:00:F5:26:C1:C5:49:DF:17:86:7D:A3:87:7A:87:F7:7B:62:DA:C7:5E:44:D8:5D:22`

## "App not installed" when updating

Android installs a new version over the existing app only if **all three** match:

| Check | Must be |
|---|---|
| Package name | the same (`com.splitmate.app`, kept after the rename to EvenUp) |
| Signing certificate | the same key as the installed app |
| `versionCode` | higher than the installed app's |

Every GitHub release is signed with the certificate above, so a release always updates an app installed from an earlier
release. If the update is refused, the installed app came from somewhere else, signed with a different key: a local
debug build (`expo run:android`), an EAS build (`npm run build:apk` uses Expo's own key), or a test build made without
the secrets.

**Check which key an APK uses** (needs only Node):

```bash
node scripts/apk-signer.mjs EvenUp-2.2.0.apk          # prints "v2 877f6bca…5d22" for releases
```

To check the app installed on a phone, pull it with adb first:

```bash
adb shell pm path com.splitmate.app                    # e.g. package:/data/app/…/base.apk
adb pull /data/app/…/base.apk installed.apk
node scripts/apk-signer.mjs installed.apk
```

If the installed app is signed with another key, Android will never update it in place. To move to the release:

1. Sync every group (status *Synced*). Shared groups live on the server and come back by joining again.
2. Export a backup (Settings → Export backup) for groups that were never shared.
3. Uninstall, install the release APK, then rejoin shared groups through their invite links. Import the backup only
   for groups that were never shared: an import always creates a new, separate group.

Install release APKs only from now on, so every future version updates in place.
