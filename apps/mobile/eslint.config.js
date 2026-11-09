const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  globalIgnores(['dist/*', '.expo/*', 'node_modules/*']),
  expoConfig,
  {
    files: ['tests/**/*.cjs', 'metro.probe.config.cjs'],
    languageOptions: { globals: { __dirname: 'readonly', Buffer: 'readonly' } },
  },
]);
