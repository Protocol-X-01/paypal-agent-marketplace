// Resolve the app's small @/lib source imports in synthetic UI tests.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const files = {
  '@/lib/palette': 'src/lib/palette.ts',
  '@/lib/business-thresholds': 'src/lib/business-thresholds.ts',
  '@/lib/business-threshold-preferences': 'src/lib/business-threshold-preferences.ts',
};
const cache = new Map();
const values = new Map();
const asyncStorage = {
  __esModule: true,
  default: {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); },
  },
};

module.exports = function loadMobileAlias(name) {
  const relativePath = files[name];
  if (!relativePath) throw new Error(`Unsupported mobile test alias: ${name}`);
  if (cache.has(name)) return cache.get(name);
  const filename = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('exports', 'require', 'module', code)(loaded.exports, (dependency) => {
    if (dependency === '@react-native-async-storage/async-storage') return asyncStorage;
    if (dependency === './business-thresholds') return module.exports('@/lib/business-thresholds');
    throw new Error(`Unexpected dependency in mobile test alias ${name}: ${dependency}`);
  }, loaded);
  cache.set(name, loaded.exports);
  return loaded.exports;
};
