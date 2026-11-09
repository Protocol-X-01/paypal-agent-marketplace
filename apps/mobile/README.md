# PayPal Markets mobile

An Expo client for iOS and Android that brings the PayPal Markets reference prices and chart endpoints into a native, phone-first interface.

## Start locally

```sh
npm install
npx expo start
```

The default market API is the public Render demo at `https://paypal-markets-companion.onrender.com`. Later hosted checks on 2026-11-06 covered display-currency quotes, historical charts, three-minute candles, GB/US catalog browsing, and product search; see the [deployment record](../../docs/DEPLOYMENT-CANDIDATE-20261106.md) for the tested revision and limits. Those checks verify server routes, not this native client or physical-device acceptance. To use a different compatible server, copy `.env.example` to `.env.local` and set `EXPO_PUBLIC_API_BASE_URL` to its base URL. This is public app configuration; never put a provider key or other secret in an `EXPO_PUBLIC_*` variable.

For an Expo Web preview that uses the local Next.js API, run this from `apps/mobile` while the website/API is running on port 3000:

```sh
EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3000 npm run web -- --port 8081
```

The local API allows the `localhost:8081` and `127.0.0.1:8081` browser origins only in development. The public Render API does not allow arbitrary local browser origins; use the exact hosted HTTPS origin in the server's `MOBILE_WEB_ORIGINS` setting when preparing a hosted Expo Web deployment. Do not add localhost origins to production settings. A phone's `127.0.0.1` normally refers to the phone itself; the USB Android debug setup below forwards those ports to the computer. Wi-Fi device checks need a host LAN address reachable from the phone.

### USB-connected Android debug app

Keep the website/API server on port 3000. In a separate terminal from `apps/mobile`, start Expo **without** `--web` so it serves native Android bundles on port 8081:

```sh
EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3000 npm run start -- --port 8081 --localhost
```

With the phone connected by USB, forward the device's loopback ports to the computer:

```sh
adb reverse tcp:8081 tcp:8081
adb reverse tcp:3000 tcp:3000
adb reverse --list
```

This lets the already-installed debug app reach Metro and the local API at `127.0.0.1`. Reapply the mappings after reconnecting USB if `adb reverse --list` is empty. Expo Web's `npm run web -- --port 8081` is for browser preview; use the native `npm run start` command above for an Android development build. These commands do not build or install an APK. Release builds and signed-device acceptance are separate.

## Current screens

Navigation keeps the bottom tab bar when space is narrow or text is enlarged, and changes to a compact left rail when the available width can still fit the paired tablet panels. Markets, Portfolio, Business, and Shop also reflow their content and product grids by available width. Physical tablet review remains open.

- **Markets:** the seven tracked assets, CoinGecko reference prices in a choice of 27 display currencies, selectable history ranges, price/market-cap/volume charts, and loading, offline, and saved-data states. The display preference stays on this device and does not change a wallet or payment currency.
- **Shop:** Channel3 product discovery and shared curated categories through the PayPal Markets server proxy, with Channel3 CDN thumbnails and local collections. New installs start with US/USD; customers can choose another supported region, and a saved choice is preserved. It is independent of the market and portfolio display currency. Changing region clears current offers and retailer checks, but keeps saved lists. The first save creates Favourites if no list exists. Each saved item keeps its title, Channel3 product ID, available brand name, and storefront when known. When a priced offer is returned, it also keeps one local last-seen price and retrieval time; retailer URLs and full offers are never saved. Treat the snapshot as historical and recheck the exact product before purchase; live retailer links expire from the app view after five minutes.
- **Portfolio:** quantities typed by the customer and saved on this device, plus an estimate using the latest available reference prices.
- **Business:** a local, unverified two-period report preview for PayPal Business account holders, or a clearly labeled fictional example. Compare the supplied periods and sales channels for transactions, gross and refunds. Paste a CSV using the exact columns in the on-screen example; the app neither uploads nor saves it. The input and parsed report clear when leaving Business, choosing Clear, or when a native background notification is received. The device keyboard, clipboard, or system snapshots may retain a copy; avoid identifying or very small customer groups. An optional native-only PayPal activity preview accepts separately copied report text after explicit confirmations. Neither report has a live merchant connection or alerts. PayPal's separate internal Operations concept is not part of this customer workspace and has no company feed.
- **Venmo note draft:** manually entered handle, amount, and message can be copied as text. Up to five contacts can be added manually and selected to fill the recipient field. Handles that differ from [Venmo's published username guidance](https://help.venmo.com/cs/articles/check-or-edit-your-username-vhel208) are flagged for manual review; existing entries are preserved, and the app does not verify Venmo accounts. The client never sends, requests, opens Venmo, connects a wallet, imports the address book, or syncs contacts to an account.

Portfolio quantities accept digits with one decimal point or decimal comma, up to 10 decimal places and 32 characters. A complete quantity is queued for saving when its field loses focus or when the customer chooses Save valid quantities; the save status reports the outcome. Unsupported or incomplete entries stay visible while the app remains open, do not replace the previously saved quantity, and withhold the portfolio estimate until corrected. Unsaved drafts are not persisted across app termination. Estimates use floating-point arithmetic: a quantity can only be estimated if it is at most one trillion with at most 15 significant decimal digits, and an individual or total estimated value must be at most one trillion display-currency units. Larger or more precise supported quantities can still be saved as entered. Estimates are also withheld while saved holdings are unavailable or awaiting a recovery choice, when any entered asset lacks a reference price, or when a positive result underflows to zero. Positive prices and estimates below 0.00000001 of the display currency are shown as less than the smallest displayed value. The Portfolio screen shows the retrieval time, each entered holding's provider-reported update time when available, and a manual refresh. Retrieval time alone does not establish quote freshness. Shop images are requested from the Channel3 CDN without credentials or redirects; the CDN can receive the device IP address. The loader accepts up to 2 MiB per image, with three requests and 8 MiB of accepted image data retained at once. Native transport buffering and image caches mean these are not hard peak-memory or immediate-erasure guarantees. Unsupported images use a placeholder; Android and iOS runtime verification of this loader remains open.

Market and chart requests start alongside their optional local cache reads, and a network response can appear immediately. A late cache read is compared by retrieval time: a saved view with a later timestamp is shown with a warning, and the older response is available through “Show latest response.” That choice does not itself replace the saved cache. Cache writes wait for a successful read and recheck the stored timestamp. Writes are serialized per key within one app runtime; separate runtimes can still race between the timestamp check and write. If the cache read stalls or fails, live data can still appear, but it is not saved for offline use in that load. Retrieval timestamps indicate when a snapshot was fetched, not a guarantee that every underlying provider price is current; device or service clocks can differ, and a future-dated saved timestamp can be wrong. If the saved display-currency preference cannot be read promptly, the app starts with USD and shows a notice to check the choice for this session. It does not overwrite the saved preference unless the customer chooses a currency.

Expo Router's CommonJS URI-decoder dependency is locally routed through a small compatibility adapter to the patched upstream decoder. Ordinary synthetic URLs are covered by tests; malformed encoded inputs can behave differently from the former decoder. Android and iOS runtime checks are still required. Remove the adapter once Expo supplies a compatible fix.

Manually entered Venmo display names and handles use Expo SecureStore, backed by Android Keystore-encrypted preferences or the iOS Keychain. The list has strict count and field limits, can be removed one contact at a time, and has an explicit forget-all control. Contact data is not sent to a service, synced to an account, or read from the address book. SecureStore data can have different uninstall behavior on Android and iOS; forgetting it in the app removes the saved contact data.

On Android and iOS, manually entered holdings use Expo SecureStore. When an older unencrypted copy exists, the app verifies a secure copy and asks which readable copy to keep; it preserves unreadable data rather than overwriting it. Expo Web uses unencrypted browser storage and displays a warning. Channel3 collections, the shopping-region choice, and the display-currency preference use ordinary device storage. Holdings are not sent to the market service. Product search phrases go through the configured PayPal Markets API to Channel3; saved collection items may keep a last-seen price, currency, and retrieval time on this device, but never retailer URLs or full offers. The Venmo panel remains a draft-only aid: copying is optional, and no payment, request, or Venmo handoff occurs. Do not store wallet keys, account credentials, or recovery phrases here.

Before saving holdings, the app compares the current stored bytes with its last verified copy. A failed write or verification pauses later saves and keeps edits visible in the current session; retry checks for the exact previously confirmed or attempted copy before writing. An unexpected stored copy remains untouched and can be loaded only after explicitly discarding the visible edits. The storage APIs do not provide atomic comparison and writing across separate app runtimes, so another runtime can still change data between the check and write.

Business report amounts use the currency in the CSV and its numeric minor-unit scale from [SIX's ISO 4217 list](https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml), pinned to the list published 2026-09-17. Unsupported and historical codes outside this current-currency list are rejected, as are current codes with no numeric minor unit. The list needs updating as the standard changes; changing the shopping region or portfolio display currency does not convert a report.

The optional PayPal activity preview reads copied text only after the customer explicitly confirms authorization and that they copied one complete export covering both selected UTC periods. It counts only completed T0006/T0007 credit rows and displays unverified totals, not amounts, unique customers, retention, or complete sales. The app does not upload or save the copied report, and clears its preview on leaving Business or receiving a native background notification; a pending read is invalidated. The operating system, clipboard, keyboard, other apps, or system snapshots may retain or expose copied text or what was visible on screen, and the app does not clear the clipboard. Notification timing and system snapshots are outside the app's control. Original file bytes and complete copying cannot be verified. The 4 MiB parser limit applies after clipboard retrieval; a device may reject a large copy earlier. Android/iOS clipboard behavior, accessibility, and lifecycle still need device checks. Expo Web directs customers to the website's separate file preview; native file-picker parity remains open.

## Local verification

Run from `apps/mobile`:

```sh
node --test --test-concurrency=1 tests/*.test.cjs
npm run lint
npm run typecheck
```

The serial test run keeps the decoder's time-bounded regression check from competing with the other test files. The Business tests compare native and website parsing and formatting, including the pinned currency scales and behavior when a native runtime lacks full currency formatting support. On 2026-11-06, separate offline Expo exports successfully produced Android and iOS JavaScript bundles. Those bundles are not signed applications, and these checks do not replace physical-device acceptance.

On 2026-11-07, the Expo Web preview at `localhost:8081` using the local Next.js API loaded seven CoinGecko reference assets, chart history, and 24 UK Audio products from the Channel3 curated catalog. This is local web integration evidence; it does not prove native Android/iOS behavior or physical-device acceptance.

## Native acceptance

The client can be opened in Expo Go when the installed Expo Go version supports this project's Expo SDK, or in a development build. A debug build was installed and opened on a Xiaomi; the latest currency, marketplace, and Business interactions require physical-device acceptance. Production signing and App Store/Play Store release remain separate work.

The configured launcher artwork is applied when Expo generates native assets. An existing generated Android project or installed debug app can still show its older icon until the native assets are regenerated and a new build is installed; review local native changes before regenerating them. The app and adaptive-icon images are configured as separate assets so the operating system can apply its own mask.

The Expo prebuild plugin removes the generated Android release variant's debug-key assignment; debug builds keep their normal debug signing. With the expected template and no later changes, a release remains unsigned until an independently configured release key is supplied. The plugin checks the complete known SDK-57 build-types block and stops for other literal `signingConfig` references; it does not evaluate arbitrary dynamic Gradle logic or changes applied afterward. EAS can inject its signing configuration after prebuild, but that path and the final artifact's signing certificate have not been verified for this app. Review and verify the signed release before any installation or distribution, and keep signing credentials outside the repository.

## Customer sign-in integration status

Native sign-in remains disabled. The strict client, secure-storage adapter and lifecycle coordinator are implemented locally and tested with synthetic transport/storage. The root session provider and Account panel now use them; public sample flags still keep sign-in disabled. The sample public settings require an explicit HTTPS auth origin and verified Android/iOS return URLs; market API configuration is deliberately separate. Never put an API secret in public build configuration.

Browser handoff requires a new compatible native build, real domain association verification and the configured server login flow. Android cancellation can unblock local cleanup while its browser tab remains visible. Guest data is preserved; owner-specific portfolio storage now accepts an identity fence and revision without resetting public charts; the root app supplies the session fence and revision. Contacts, saved Shop collections and private screen boundaries now use the same account scope. Real provider, verified-link and device acceptance are still required before login can be enabled. See `docs/CUSTOMER-NATIVE-AUTH.md` at the repository root for the full contract and remaining acceptance gates.
