// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // cloudflare:* are Workers runtime modules, provided at deploy time.
    rules: { 'import/no-unresolved': ['error', { ignore: ['^cloudflare:'] }] },
  },
  {
    // Build output and generated files
    ignores: ['dist/*', 'android/*', 'ios/*', 'relay/.wrangler/*', 'relay/dist/*', 'relay/worker-configuration.d.ts'],
  },
]);
