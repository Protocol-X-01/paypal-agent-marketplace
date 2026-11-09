const assert = require('node:assert/strict');
const test = require('node:test');

const withUnsignedAndroidRelease = require('../plugins/with-unsigned-android-release.cjs');
const { withoutDebugReleaseSigning } = withUnsignedAndroidRelease;
const appConfig = require('../app.json');

const template = `android {
    signingConfigs {
        debug { /* Debug credentials are defined by the generated project. */ }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'
            shrinkResources enableShrinkResources.toBoolean()
            minifyEnabled enableMinifyInReleaseBuilds
            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
            def enablePngCrunchInRelease = findProperty('android.enablePngCrunchInReleaseBuilds') ?: 'true'
            crunchPngs enablePngCrunchInRelease.toBoolean()
        }
    }
}
`;

test('prebuild plugin is registered in the Expo configuration', () => {
  assert.ok(appConfig.expo.plugins.includes('./plugins/with-unsigned-android-release.cjs'));
});

test('only the release debug-signing assignment is removed', () => {
  const updated = withoutDebugReleaseSigning(template);
  assert.equal((updated.match(/signingConfig signingConfigs\.debug/g) || []).length, 1);
  assert.match(updated, /debug \{\n\s+signingConfig signingConfigs\.debug\n\s+\}/);
  assert.match(updated, /release \{[\s\S]*?Release signing must be configured separately\.[\s\S]*?minifyEnabled enableMinifyInReleaseBuilds/);
  assert.equal(updated.replace('            // Release signing must be configured separately.', '            signingConfig signingConfigs.debug'), template);
});

test('the generated change is idempotent', () => {
  const updated = withoutDebugReleaseSigning(template);
  assert.equal(withoutDebugReleaseSigning(updated), updated);
});

test('Windows line endings are preserved and the change remains idempotent', () => {
  const windowsTemplate = template.replaceAll('\n', '\r\n');
  const updated = withoutDebugReleaseSigning(windowsTemplate);
  assert.equal(updated.replaceAll('\r\n', '\n'), withoutDebugReleaseSigning(template));
  assert.equal(withoutDebugReleaseSigning(updated), updated);
});

test('the Expo Android mod applies the guard and rejects unsupported Gradle languages', async () => {
  const config = withUnsignedAndroidRelease({ name: 'Synthetic', slug: 'synthetic' });
  const mod = config.mods.android.appBuildGradle;
  const run = (language) => mod({ ...config, modRequest: { platform: 'android' }, modResults: { language, contents: template } });
  const result = await run('groovy');
  assert.equal(result.modResults.contents, withoutDebugReleaseSigning(template));
  await assert.rejects(run('kotlin'), /Unsupported Android app Gradle language/);
});

test('unknown or ambiguous templates abort the signing modification', () => {
  assert.throws(() => withoutDebugReleaseSigning(template.replace('        release {', '        staging {')), /Unrecognized Android signing template/);
  assert.throws(() => withoutDebugReleaseSigning(template + template), /Unrecognized Android signing template/);
  assert.throws(() => withoutDebugReleaseSigning(`${template}\nsigningConfig signingConfigs.debug`), /Unrecognized Android signing template/);
  assert.throws(() => withoutDebugReleaseSigning(null), /contents are unavailable/);
});

test('extra direct signing assignments inside or outside the recognized block are rejected', () => {
  const extraInside = template.replace(
    '            signingConfig signingConfigs.debug\n            def enableShrinkResources',
    '            signingConfig signingConfigs.debug\n            signingConfig = signingConfigs.debug\n            def enableShrinkResources',
  );
  const extraOutside = `${template}\nandroid.buildTypes.release.signingConfig = android.signingConfigs.debug\n`;
  const unsigned = withoutDebugReleaseSigning(template);
  const extraInsideUnsigned = unsigned.replace(
    '            // Release signing must be configured separately.\n            def enableShrinkResources',
    '            // Release signing must be configured separately.\n            signingConfig = signingConfigs.debug\n            def enableShrinkResources',
  );
  const extraOutsideUnsigned = `${unsigned}\nandroid.buildTypes.release.signingConfig = android.signingConfigs.debug\n`;
  for (const value of [extraInside, extraOutside, extraInsideUnsigned, extraOutsideUnsigned]) {
    assert.throws(() => withoutDebugReleaseSigning(value), /Unrecognized Android signing template/);
  }
});
