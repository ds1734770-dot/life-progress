# Native App Migration — Architecture & Decision Record

**Status:** COMPLETE (Phases 1–7): Capacitor scaffolding → multi-platform dispatcher + DO schema → iOS APNs → Android FCM → cross-platform hardening. All three transports implemented behind one dispatcher.
**Started:** 2026-09-17 · Branch: `main`

## Validation status at a glance

| Layer | Status |
|---|---|
| Automated tests (636) | ✅ PASSING |
| Providers (Web Push / APNs / FCM) | ✅ Implemented, mocked-transport verified |
| iOS physical delivery (token, locked, background, force-quit, cold-start tap) | ⏳ **DEFERRED — requires macOS/Xcode + Apple Developer + physical iPhone.** Automated mocks do NOT count. The PWA force-quit limitation is NOT considered solved until this runs. |
| Android physical delivery | ⏳ **PENDING — no Android device available.** Automated mocks do NOT count. |
| Deployment | ⏳ NOT deployed (no authorization) |

---

## 1. Current architecture (unchanged, production)

```
Life Progress PWA (GitHub Pages, static ES modules)
        ↓ Web Push subscription (VAPID)
Cloudflare Worker  (cloudflare/worker.js — stateless API)
        ↓
Durable Object     (cloudflare/do.js — SQLite, LPPushDO)
        ↓
Self-rescheduling DO alarm (~1/min) — the production scheduler
        ↓
occurrence eligibility → quiet hours → atomic claim (occurrence_id PK)
        ↓
Web Push delivery  (server/push/webpush.js — RFC 8291/8292 WebCrypto)
        ↓
Service worker (sw.js) → js/swPush.js → OS notification
```

Shared runtime-neutral core: `server/push/domain.js` (occurrences, grace
window, quiet hours, minimal payload), `server/push/http.js` (CORS,
registration validation), `server/push/webpush.js` (isomorphic crypto).
Node backend (`server.js`, `server/`) remains the local-dev shape.

## 2. Target architecture

```
                         LIFE PROGRESS
                              |
                    Shared application
              (same ES modules, same IndexedDB)
                              |
              ┌───────────────┼───────────────┐
             WEB             IOS           ANDROID
              |               |               |
        PWA / Web Push   Capacitor+APNs  Capacitor+FCM
              └───────────────┼───────────────┘
                              |
                     Cloudflare Worker
                              |
                       Durable Object
                              |
                    Notification scheduler
              (alarm → occurrences → claims — unchanged)
                              |
                     Delivery dispatcher        ← later phase
                    /        |        \
               WebPush      APNs      FCM
```

One scheduler, one occurrence model, three transports. The scheduler never
learns platform specifics; a dispatcher chooses the provider per device.

## 3. Why Capacitor

Decided in the Implementation Readiness Report, re-verified against the repo:

- The app is **100% static ES modules with relative paths** (deployed at
  domain root or subpath today) — Capacitor's `webDir` model maps 1:1, no
  bundler needed or added.
- Screen → domain → storage layering is preserved; the same modules run in
  the WKWebView / Android WebView.
- Camera stack (`js/camera/*`, standard `getUserMedia` + `ImageCapture` +
  canvas) and MediaPipe assets are **vendored same-origin**
  (`vendor/mediapipe/`, WASM + `pose_landmarker_lite.task`), so they load
  from the local bundle; WebView WASM/SIMD is supported on iOS 15+ and
  modern Android WebView.
- Official `@capacitor/push-notifications` (later phase) exposes the APNs
  token on iOS and the FCM token on Android through one API — exactly the
  per-platform credential model the backend needs.
- Rejected: React Native / Flutter (full UI rewrite — violates the core
  mandate), TWA (no native FCM transport), hand-rolled WKWebView shells
  (reimplements Capacitor without the plugin ecosystem).

## 4. What Phase 1 changed

| Area | Change |
|---|---|
| `scripts/build-web.js` (new) | Whitelist copy of the frontend runtime into `www/`; secret-pattern guard fails the build on credential-like files; verifies app shell + camera + MediaPipe/WASM/model assets are present. |
| `www/` (generated, gitignored) | Native web bundle. Never hand-edited; source of truth stays the repo root. |
| `capacitor.config.json` (new) | `appId: com.example.lifeprogress` (**temporary — must be finalized before store preparation**), `webDir: www`, `androidScheme: https` (secure context for getUserMedia/WebCrypto). JSON, not `.ts`, to avoid adding a TypeScript toolchain to a zero-bundler project. |
| `ios/`, `android/` (new) | Capacitor 8 native shells. Version-controlled; generated build outputs and the copied `public/`/`assets/public` bundles are gitignored. |
| `js/platform.js` (new) | The web/native boundary: `isNative()`, `getPlatform()` (`'web'|'ios'|'android'`), `platformInfo()`. Detects Capacitor's real injected bridge (`window.Capacitor.isNativePlatform()` / `getPlatform()`), validates its shape, and degrades to `'web'` on any absence/malformation/throw. No user-agent sniffing. |
| `js/app.js` (minimal edit) | Two explicit gates: native shells skip service-worker registration and Web Push re-sync. Web behavior is untouched. Documented as the temporary boundary until native push lands. |
| `sw.js` (minimal edit) | `js/platform.js` added to precache; cache bumped `life-progress-v1.14` → `v1.15` so the updated shell propagates. SW logic unchanged. |
| `package.json` | Capacitor 8.5.2 as devDependencies only; scripts `build:web`, `cap:sync`, `cap:open:ios`, `cap:open:android`; `test/platform.test.js` registered. Runtime code keeps zero dependencies. |
| `.gitignore` | `/www/`, Apple credentials (`*.p8`, `*.pem`, provisioning), Xcode/Gradle build output, Firebase credential files (`google-services.json`, `GoogleService-Info.plist`, service-account JSON), `.env*`. The `ios/` and `android/` projects themselves stay versioned per Capacitor's repo guidance. |

## 5. What intentionally did NOT change

- All notification semantics, Web Push flow, VAPID handling, dedup, quiet
  hours, timezone math (`js/timeCore.js`, `server/push/domain.js`).
- Cloudflare Worker, Durable Object, scheduler, alarm trigger, schema.
- `js/db.js` (IndexedDB `life-progress-db` V5), export/import, wipe.
- Camera/pose code (`js/camera/*`, `js/pose/*`, `vendor/mediapipe/*`).
- GitHub Pages deployment, PWA manifest, `push-config.js`.
- All 20 pre-existing test files.

## 6. Intentionally deferred (later phases)

- APNs provider + iOS push registration; FCM provider + Android push
  registration (backend dispatcher, `push_subscriptions` platform/token
  migration, native push plugin, deep-link bridging, diagnostics updates).
- No Apple/Firebase credentials, no push entitlements, no bundle-ID
  finalization in this phase.

## 7. iOS PWA limitation — still true for the PWA

The documented PWA/WebKit limitation stands: on iOS, when the Home Screen
web app is **force-quit or swiped away** from the app switcher, background
Web Push delivery stops (no live process for webpushd to wake; WebKit bug
258254). Backgrounded-but-alive and locked-screen delivery keep working.
`js/pushClient.js#iosLifecycleBlocker` continues to surface this honestly.

**Phase 1 does not solve notifications.** The native iOS application is
intended to receive reminders through APNs in a later phase, which removes
that dependency on a live web-app process.

## 8. WebView storage caveat (documented, accepted)

The native apps keep the existing local-first storage: the same IndexedDB
(`life-progress-db` V5) inside the WebView, same export/import, same wipe.
No second database, no cloud sync, no data migration. Known caveat: WebKit
may evict WKWebView website data under device storage pressure; the
existing export/import is the user-level mitigation. Revisit if native
file-backed storage is ever added — deliberately not in Phase 1.

## 9. Native build workflow

```
npm run build:web     # repo-root web app → www/ (whitelist + guards)
npx cap sync          # www/ → ios/App/App/public + android assets
npm run cap:open:ios  # Xcode
npm run cap:open:android  # Android Studio
```

## 10. Phase 2 — multi-platform delivery foundation (complete)

- `server/push/dispatch.js`: `dispatchNotification(device, payload, deps)` —
  the single seam between the scheduler and platform providers.
  `resolveProvider()`: `web`→Web Push, `ios`→APNs, `android`→FCM,
  unknown→null (registration rejected). Providers return typed outcomes:
  `delivered | gone | transient_failure | permanent_failure | not_configured`.
  Provider throws are caught → transient; a tick can never crash.
- `server/push/http.js`: platform-aware validation. Legacy bodies (no
  `platform`) validate byte-identically → `web`. Native bodies require a
  `token` and no Web Push fields; unknown platforms are rejected, never coerced.
- `cloudflare/do.js`: additive, idempotent `migrateSchema()` — `PRAGMA
  table_info` detection → `ALTER TABLE ADD COLUMN platform TEXT NOT NULL
  DEFAULT 'web'` / `token TEXT` (try-ALTER fallback if PRAGMA is ever
  unavailable). No table rebuild; existing rows become `platform='web',
  token=NULL` and keep delivering without re-registration.
- `server/scheduler.js` / `server/api.js`: same dispatcher, same typed
  outcomes; legacy result shape preserved so retry bookkeeping is untouched.
- Web Push crypto (`server/push/webpush.js` — RFC 8291/8188/8292) and
  `server/push/domain.js` remain byte-identical.

## 11. Phase 3 — iOS APNs native delivery (complete in code; physical validation DEFERRED)

### Delivery path

```
DO alarm → occurrence → dispatchNotification
  → resolveProvider('ios') → server/push/apns.js
  → ES256 JWT (token auth) → HTTP/2 api.push.apple.com
  → apns-topic = bundle ID → alert push, priority 10
  → typed outcome → existing occurrence bookkeeping
```

### APNs provider (`server/push/apns.js`)

- **Token-based auth only** — ES256 JWT signed with the Apple `.p8` key on
  raw WebCrypto: header `{alg:'ES256', kid:APNS_KEY_ID}`, claims
  `{iss:APNS_TEAM_ID, iat:now}`. No certificates. Node adapters reuse the
  same WebCrypto path (Node ≥ 16 `crypto.subtle`), so JWT logic is shared.
- **Payload transform**: the dispatcher hands providers the shared minimal
  payload (`buildPushPayload`); the provider wraps it for APNs — `aps`
  alert copy comes from the SAME copy table as the service worker
  (`js/swPush.js`), so wording stays in sync; `route` goes into `userInfo`
  for tap deep links. No private user data added.
- **Response mapping**: 200→delivered · 400 BadDeviceToken / 410
  Unregistered→gone · 429/5xx→transient · other 4xx→permanent ·
  network throw→transient · missing/invalid config→not_configured.
  Native devices are never sent through Web Push.
- **Runtime handling**: APNs requires HTTP/2. Workers' global `fetch`
  negotiates HTTP/2 and is the provider's default transport; Node's global
  fetch speaks HTTP/1.1, so `server/push/nodeHttp2.js` adapts `node:http2`
  to the same transport contract. One provider, two runtimes, no duplicated
  business logic.

### iOS client (`js/nativePush.js`, Capacitor 8 + @capacitor/push-notifications)

- Gated on `js/platform.js`; **inert on web** (test-verified).
- Flow: checkNotifications → requestPermissions → addListener('registration')
  → `POST /api/push/register` with `platform:'ios'`, `token`, existing
  preferences schema (no endpoint/p256dh/auth) → token refresh via the
  `'registrationError'`+re-register path updates the SAME deviceKey row.
- Taps: `addListener('pushNotificationActionPerformed')` → `userInfo.route`
  → existing hash routes (`#/water`, `#/gym`, …), allowlisted; cold start
  handled (late listener registration), no duplicate navigation.
- Foreground: notifications are presented while the app is open (Capacitor
  foreground presentation), consistent with existing copy semantics.
- Listeners are tracked and cleaned up; a hardened tap handler can never
  throw during teardown.

### Diagnostics & settings (`js/screens/notificationsSettings.js`)

Native iOS shows honest APNs states (native-available, permission
not-requested/denied, token-unavailable, backend-pending/registered,
backend-not-configured). The old web-only PWA message about iOS pausing
delivery when swiped away is NOT shown in native mode. Web/PWA keeps the
existing Web Push UI unchanged.

### Honest status

- **No real-device APNs delivery has been verified.** Force-quit/swiped-away
  behavior can only be claimed solved after the physical iPhone matrix
  (spec §28) is executed. Xcode build/device run requires a dev machine.

## 12. Manual Apple Developer prerequisites (NOT configured)

Everything below is pending; nothing has been enrolled, created, or uploaded:

1. **Apple Developer Program** membership ($99/yr).
2. **App ID / Bundle ID** — replace temporary `com.example.lifeprogress`
   (in `capacitor.config.json` + `ios/App/App.xcodeproj/project.pbxproj`) with
   the final ID, then `npx cap sync ios`.
3. **Push Notifications capability** on the App ID; add
   `aps-environment` entitlement (development first, then production) and
   `UIBackgroundModes: [remote-notifications]` in `Info.plist` if remote
   background wake is later needed — alert pushes over APNs do not require it.
4. **APNs Auth Key (.p8)** — create in the Apple Developer portal (one key
   covers sandbox + production). Record the **Key ID** and **Team ID**.
5. **Secrets** (never committed): set via `wrangler secret put` on the
   Worker — `APNS_PRIVATE_KEY` (PEM), `APNS_KEY_ID`, `APNS_TEAM_ID`,
   `APNS_BUNDLE_ID`, and `APNS_ENV=production|sandbox` (default:
   `production`). These exact names are the canonical scheme implemented in
   `server/push/apns.js` (`APNS_ENV_KEYS`) — do not introduce aliases. The provider reads
   only env config and returns honest `not_configured` when unset — safe to
   deploy before secrets exist.
6. **Physical iPhone test matrix** — install via Xcode/TestFlight; verify
   app open / background / locked / swiped away / force-quit / reboot /
   permission denied-then-granted / tap deep link / quiet hours /
   duplicates / timezone. Document results here.
7. **Key rotation/revocation** — revoke in the portal, replace secrets,
   restart; tokens remain valid (they're device-side). Old JWTs die with
   the key because provider tokens are minted per-send.
8. Later: privacy disclosure, icons/splash, App Store metadata.

FCM/Android: see §13.

## 13. Phase 5 — Android FCM native delivery (complete in code; physical validation PENDING)

### Delivery path

```
DO alarm → occurrence → dispatchNotification
  → resolveProvider('android') → server/push/fcm.js
  → OAuth2 RS256 service-account JWT → access token (cached 55 min)
  → POST fcm.googleapis.com/v1/projects/{id}/messages:send
  → notification (system-tray) + data (identity only) + android config
  → typed outcome → existing occurrence bookkeeping
```

### FCM provider (`server/push/fcm.js`)

- **Auth**: OAuth 2.0 service-account flow — RS256 JWT
  (`iss = client_email`, `scope = firebase.messaging`,
  `aud = oauth2.googleapis.com/token`) signed with raw WebCrypto
  (`RSASSA-PKCS1-v1_5` + SHA-256), exchanged for a short-lived access token.
  No Firebase Admin SDK (Node-only). Accepts the service-account JSON or a
  raw PEM; double-escaped `\n` sequences from secret stores are normalized.
- **Runtime**: unlike APNs, Google's endpoint accepts HTTP/1.1 — BOTH runtimes
  use global fetch. No extra adapter. One provider, zero duplication.
- **Message shape**: `notification` (title/body from the SHARED copy table in
  `js/swPush.js` — one copy system across web/iOS/Android) so Android shows
  the message in the system tray even when the app process is dead (§5.9);
  `data` carries ONLY identity metadata (type/category/occurrenceId/dateKey/
  route) for deep links + dedup — no personal content; `android.priority`
  HIGH for reminders, DEFAULT for tests; `channel_id` per category.
- **Response mapping**: 200→delivered · 404/410 + UNREGISTERED→gone ·
  429/5xx→transient · 401/403 (server identity)→not_configured · other
  4xx→permanent. Network throw→transient; key/JSON errors→not_configured
  (signing vs transport failures are distinguished).
- **Canonical env names** (`FCM_ENV_KEYS`): `FCM_PROJECT_ID`,
  `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`. Set via `wrangler secret put`;
  never committed, never logged, never in frontend/Android source.

### Android client

The Phase 3 client (`js/nativePush.js`) was generalized to both platforms —
the Capacitor plugin exposes FCM tokens on Android through the same
`registration` event. Registration posts `platform:'android'` + opaque token
(no endpoint/p256dh/auth); rotation reuses the SAME deviceKey; taps deep-link
through the shared allowlisted hash routes; foreground messages are presented
by the plugin. Remains inert on web (test-enforced).

### Android build configuration (§5.10) — manual prerequisites

1. **Firebase project** → add an Android app with the FINAL application ID
   (currently temporary `com.example.lifeprogress` in
   `android/app/build.gradle` — do not silently promote it).
2. **`google-services.json`** → drop into `android/app/`. Capacitor's
   generated gradle applies the google-services plugin automatically when the
   file is present. It is gitignored — never commit it.
3. **Server credentials** → Firebase console → Project settings → Service
   accounts → *Generate New Private Key*; set `FCM_PROJECT_ID`,
   `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` as Cloudflare secrets.
4. **Release signing** → generate a keystore locally (`*.jks`), configure
   `keystore.properties`/`key.properties` (both gitignored); Play Store also
   accepts App Signing by Google Play.
5. **Physical device matrix** (§28): app open / background / locked / removed
   from Recents / force-quit / reboot / permission / battery optimization /
   tap deep link / quiet hours / duplicates / timezone — all PENDING until an
   Android device is available.

## 14. Phase 6 — hardening results (audit + one fix)

- **One identity model** (§6.1): all platforms register through
  `validateRegistration` + the same upsert; native rows carry no Web Push
  fields.
- **One dispatch path** (§6.2): every platform flows
  scheduler → occurrence → `dispatchNotification` → provider; legacy rows
  (no platform) still route as web through the dispatcher.
- **Occurrence semantics unchanged** (§6.3): occurrence IDs, timezone/DST
  math, quiet hours, grace window, dedup, alarm scheduling untouched.
- **One copy system** (§6.4): `js/swPush.js` copy table serves web, APNs
  (`toApnsPayload`) and FCM (`toFcmMessage`); only transport formatting
  differs.
- **Quiet hours** (§6.5): proven identical at DO level for web and Android.
- **Dedup** (§6.6): atomic occurrence claims proven single-delivery across
  repeat ticks; distinct per-device/per-day occurrence ids never collide.
- **Failures** (§6.7): gone→cleanup, transient→retain, permanent→retain+
  record, not_configured→retain; provider throws are contained as transient —
  one broken device never stops others (proven with two devices).
- **Token lifecycle** (§6.8): rotation/unregister proven for both platforms.
- **Platform switching** (§6.9): web→android and android→ios on one deviceKey
  deterministically replace platform+token (no duplicate identities).
- **Transport independence** (§6.10): **fix landed** — the DO tick's
  missing-VAPID bail previously blocked ALL delivery; it now applies only to
  web-only populations, so native devices are never blocked by web credential
  absence. Web-era behavior preserved for web-only deployments.
- **Native/web separation** (§6.10): native never touches service worker /
  PushManager / VAPID; web never touches APNs/FCM.

## 15. Final secret configuration reference

| Secret | Used by | Notes |
|---|---|---|
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push | Existing — unchanged |
| `APNS_PRIVATE_KEY` (PEM), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_ENV=production\|sandbox` | iOS/APNs | `.p8` key; sandbox host auto-selected |
| `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` | Android/FCM | service-account JSON or PEM accepted |

All set via `wrangler secret put` on the Worker; all optional at deploy time
(providers report honest `not_configured` per device until set).
