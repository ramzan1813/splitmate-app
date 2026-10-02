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

If the secrets are missing, the workflow still builds, but signs with the public **debug** key and shows a warning. That's fine for a quick test. An APK signed with the debug key can't be updated by one signed with your real key, though: you'd have to uninstall it first, which deletes the app's data.

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
