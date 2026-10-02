// Expo config plugin: signs release builds with your own keystore when these
// environment variables are set (GitHub Actions sets them from repository secrets):
//   SPLITMATE_KEYSTORE           path to the .jks file
//   SPLITMATE_KEYSTORE_PASSWORD  keystore password
//   SPLITMATE_KEY_ALIAS          key alias
//   SPLITMATE_KEY_PASSWORD       key password
// Without them, release builds fall back to the debug key (fine for testing only).
const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_CONFIG = `
        release {
            if (System.getenv("SPLITMATE_KEYSTORE")) {
                storeFile file(System.getenv("SPLITMATE_KEYSTORE"))
                storePassword System.getenv("SPLITMATE_KEYSTORE_PASSWORD")
                keyAlias System.getenv("SPLITMATE_KEY_ALIAS")
                keyPassword System.getenv("SPLITMATE_KEY_PASSWORD")
            }
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes('SPLITMATE_KEYSTORE')) return cfg; // already applied
    // 1) add a release signing config next to the debug one
    src = src.replace(/signingConfigs\s*\{([\s\S]*?debug\s*\{[\s\S]*?\})/, (m) => `${m}${RELEASE_CONFIG}`);
    // 2) make the release build type use it when the keystore is provided
    src = src.replace(
      /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/,
      '$1signingConfig System.getenv("SPLITMATE_KEYSTORE") ? signingConfigs.release : signingConfigs.debug'
    );
    if (!src.includes('signingConfigs.release')) {
      throw new Error('withReleaseSigning: could not patch android/app/build.gradle (template changed?)');
    }
    cfg.modResults.contents = src;
    return cfg;
  });
};
