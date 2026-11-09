# Router decoder compatibility adapter

Expo Router 57 uses the CommonJS API of `query-string` 7, which expects a callable CommonJS `decode-uri-component`. The upstream decoder's patched 0.5.1 release is an ES module. This private adapter loads that exact upstream release through the `upstream-decoder` npm alias and preserves the original decoder's literal-plus-to-space behavior.

Upstream `decode-uri-component` 0.5.1 is MIT-licensed; its package contains its copyright and license notice. Include that notice in any distribution's third-party license notices. The adapter is private and marked UNLICENSED; it does not change the upstream license.

The fixed decoder uses a single-pass algorithm to address GHSA-vcc3-ghjq-m6fr and GHSA-qr28-fpjm-wq7f. Some malformed inputs intentionally decode differently from version 0.2.2. See the compatibility tests before changing this adapter. Do not force the ESM package into the old callable CommonJS import.

Remove this adapter when Expo supplies a compatible, reviewed fix for the project's SDK version. Compare route parsing and URL serialization before removing it; the SDK 58 Router migration changes some serialization details.
