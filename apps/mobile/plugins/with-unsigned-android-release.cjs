const { withAppBuildGradle } = require('expo/config-plugins');

// Match the complete generated Expo SDK 57 build-types block. Other literal
// signingConfig references require review; dynamic Gradle code is not analyzed.
const originalBlock = `    buildTypes {
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
    }`;

const unsignedBlock = originalBlock.replace(
  '            signingConfig signingConfigs.debug\n            def enableShrinkResources',
  '            // Release signing must be configured separately.\n            def enableShrinkResources',
);

function count(text, fragment) {
  return text.split(fragment).length - 1;
}

function withoutDebugReleaseSigning(contents) {
  if (typeof contents !== 'string') throw new Error('Android app Gradle contents are unavailable.');
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const original = originalBlock.replaceAll('\n', newline);
  const unsigned = unsignedBlock.replaceAll('\n', newline);
  const originalCount = count(contents, original);
  const unsignedCount = count(contents, unsigned);
  const recognized = originalCount === 1 && unsignedCount === 0 ? original
    : originalCount === 0 && unsignedCount === 1 ? unsigned : null;

  // Conservatively reject any other literal reference, even in comments or
  // strings. This does not prove arbitrary dynamic Gradle logic is safe.
  if (recognized && !/\bsigningConfig\b/.test(contents.replace(recognized, ''))) {
    return recognized === original ? contents.replace(original, unsigned) : contents;
  }

  throw new Error('Unrecognized Android signing template. Review release signing before generating the native project.');
}

function withUnsignedAndroidRelease(config) {
  return withAppBuildGradle(config, (next) => {
    if (next.modResults.language !== 'groovy') {
      throw new Error('Unsupported Android app Gradle language. Review release signing before generating the native project.');
    }
    next.modResults.contents = withoutDebugReleaseSigning(next.modResults.contents);
    return next;
  });
}

module.exports = withUnsignedAndroidRelease;
module.exports.withoutDebugReleaseSigning = withoutDebugReleaseSigning;
