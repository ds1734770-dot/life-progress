# Notification delivery + immersive reminder — Phase 0 diagnosis

**Status: DIAGNOSIS ONLY. No production code has been changed.**
Baseline before this work: `npm test` → **667 pass / 0 fail**, HEAD `bcb5b85`.

---

## 0. The single most important correction

The owner reported testing **on an iPhone, by opening the site in the browser and
using "Add to Home Screen."** That is the **installed PWA** — the Web Push path
(`js/pushClient.js` → `sw.js` → `js/swPush.js` → Web Push → service worker).
It is **not** the Capacitor native app.

Everything about APNs, `aps-environment`, FCM, `google-services.json`,
`Notification Service/Content Extension`, `LPMessagingService` and
`LifeProgressNotificationActivity` is **not in the path that was tested**. Those
findings are real and must be fixed *if and when the native shell is shipped*,
but they are not the cause of what the owner saw.

This matters because it changes the goal, not just the bug list:

> **On iOS, the immersive wallpaper reminder is not achievable through Web
> Push. Not "hard" — not possible.** iOS Web Push renders a system notification
> whose content iOS controls. WebKit ignores `icon` entirely (the web app's own
> icon is always used), supports no rich media/image, and exposes no action
> buttons. Apple's own Declarative Web Push format is the clearest proof of the
> ceiling: its notification dictionary contains `title`, `lang`, `dir`, `body`,
> `navigate`, `silent`, `app_badge` — **no image field and no actions field
> exist.** There is no `UNNotificationServiceExtension` equivalent a website can
> attach for image content.
>
> The target UX in the brief (wallpaper + large card + big CTA) requires the
> **native iOS app**: APNs `aps.category` → `UNNotificationContentExtension` +
> a `UNNotificationServiceExtension` that attaches the wallpaper. That is the
> only legitimate route, and it needs macOS/Xcode/signing/Apple Developer
> Program — none of which exist here.

So the work splits into two independent tracks. **Track A is what the owner is
actually experiencing today. Track B is the only way to get the desired
experience on iOS.**

---

## 1. Track A — the Web Push path (what was tested)

```
Home Screen web app (iOS/iPadOS: standalone; Android: installed PWA)
  └─ pushCapabilities() / capabilityBlocker()          ← install-required if Safari tab
     └─ Notification.requestPermission()               ← user tap only (correct)
        └─ navigator.serviceWorker.ready                ← requires sw.js to ACTIVATE
           └─ reg.pushManager.subscribe()               ← VAPID from /api/push/vapid-public
              └─ POST /api/push/register                ← CORS must allow the PWA origin
                 └─ DO push_subscriptions (platform='web')  ← endpoint + p256dh + auth
                    └─ DO alarm ≈1/min → tick()
                       └─ occurrence water|gym|goals|journal
                          └─ decideOccurrence() (grace 90s, quiet hours)
                             └─ dispatchNotification() → Web Push RFC8291/8292
                                └─ APPLE/GOOGLE PUSH ENDPOINT
                                   └─ SW `push` event → handlePushEvent()
                                      ├─ processPush(): gates → showNotification()
                                      └─ silent outcome → NOTHING SHOWN   ← ✗ W1
                                         └─ OS displays the notification
                                            └─ notificationclick → hash route
```

### W1 — Silent push suppression revokes the subscription on WebKit (severity: critical)

This is the most likely explanation of "arrives, then stops arriving."

WebKit's own documentation states the rule plainly:

> *"if an event handler doesn't show the user visible notification for any reason
> we revoke its push subscription"* — [WebKit, *Meet Declarative Web Push*](https://webkit.org/blog/16535/meet-declarative-web-push/)

`js/swPush.js#processPush()` deliberately returns **without calling
`showNotification`** in five cases:

| outcome | when it fires |
|---|---|
| `invalid-payload` | malformed/unknown payload |
| `already-delivered` | the dedup marker exists for `category:dateKey` |
| `category-off` / quiet hours / master off | `reminderBlocked()` |
| `not-useful-now` | `ELIGIBILITY[category](ctx)` returns falsy (e.g. water target already met) |

On Chrome/Firefox that is reasonable — a silent push is allowed. **On WebKit it
is a violation of the `userVisibleOnly` promise, and the penalty is losing the
push subscription.** The user then sees nothing, ever, until they re-enable
notifications — which is exactly the reported symptom, and it explains why it is
*intermittent* rather than uniformly broken.

And the collision is easy to trigger, because the dedup space is shared by design:

`js/notifications.js` in-app sweep (runs while the app is **open**) and
`js/swPush.js` both use `key = "<category>:daily"` and `period = dateKey()` —
the same `notificationState` records (`js/swPush.js` comment: *"cross-mechanism
dedup"*). So if the **app is open at the reminder minute**, the in-app sweep
writes the marker first, the push arrives seconds later, `processPush` sees
`already-delivered`, shows nothing — and WebKit revokes the subscription.

**Therefore: opening the app at the wrong moment can permanently kill push.**
That is a design-level bug, and it is WebKit-specific in consequence.

Note the invisible `not-useful-now` case too: the *user* opened the app, drank
the water, the target was met, so the reminder is correctly suppressed — and the
subscription is revoked for it. Perfectly reasonable user behaviour silently
breaks the feature.

### W1a — the in-app sweep is not time-gated, so it pre-kills the push (severity: critical, root cause)

This makes W1 the *normal* outcome rather than an unlucky edge case.

`runReminderSweep()` (`js/notifications.js:480`) is called from **app boot and
foreground** (`js/app.js:85`). It evaluates every category and delivers whatever
eligibility allows. The only gates are `reminderBlocked()` — master enable,
per-category enable, quiet hours — **there is no check of the configured
`times[category]` at all**, and no `times[...]` read anywhere in the sweep path.

The server, by contrast, is strictly time-driven: it computes the occurrence at
the user's chosen wall-clock time (`computeNextOccurrences`).

So the two halves of the system disagree about when a reminder is due:

1. The user opens the app at 09:00. Water is configured for 14:00.
2. The in-app sweep fires the water reminder **immediately**, shows it, and
   writes the dedup marker `water:daily → 2026-01-15`.
3. At 14:00 the server (correctly) sends the real push for the same occurrence.
4. `processPush` sees `already-delivered` → **shows nothing**.
5. On WebKit, step 4 revokes the push subscription.

And the push subscription dies for that device.

So this is not "opening the app at exactly the wrong minute" — **opening the app
at any point before the configured reminder time suppresses that day's push, and
on iOS permanently kills push delivery.** That is the mechanism behind
"notifications are not arriving reliably when backgrounded / locked / closed."

The fix (owner-approved server-side ack) therefore has to include making the
in-app sweep agree with the server's schedule: gate the sweep on the configured
`times[category]`, and have it tell the server when it has handled an occurrence
so the server never sends a push that is already shown. See §6.

### W2 — iOS ignores the wallpaper: the "immersive" look cannot happen in the PWA (severity: expectations)

- `js/swPush.js#notificationOptions()` passes the resolved wallpaper as
  `options.icon`. On iOS **`icon` is completely ignored** — the web app icon is
  always used ([mdn/browser-compat-data#19318](https://github.com/mdn/browser-compat-data/issues/19318)).
  iOS web push also supports no rich media at all.
- The 12 built-in wallpapers, the custom photo pipeline, `resolveWallpaper` and
  the SW wallpaper resolution are therefore **inert on iOS** — real work that can
  never be displayed on that platform.
- On **Android/Chrome** the same code is also leaving value on the table: the
  wallpaper should go in `options.image` (which renders as a large picture),
  not `options.icon`. Android Chrome additionally supports `actions` (up to two
  buttons), `vibrate`, `tag`/`renotify`, `timestamp` and `badge`. That is the
  strongest presentation a PWA can legitimately reach — a genuinely worthwhile
  target for Track A.

### W3 — Node backend `POST /api/push/test` throws on category tests (severity: medium)

`server/api.js:161` uses `ROUTES[category]`, but `ROUTES` is **never imported in
that file** (imports at lines 12–20; `ROUTES` lives in `server/push/domain.js`).
Every categorized test push against `node server.js` → `ReferenceError` → caught
by the outer handler → `500 {"error":"internal error"}`. `cloudflare/do.js:20`
imports it correctly, so the deployed Worker is unaffected. This breaks the
TEST WATER/GYM/GOALS/… buttons in the documented local-dev setup.

### W4 — Registration can fail silently for reasons the user cannot see (severity: high)

The owner has not yet looked at the diagnostics screen, so we do not know whether
the device ever registered. The plausible silent failures, all invisible today:

- **CORS.** `push-config.js` points at `https://life-progress.ds1734770.workers.dev`.
  If `PUSH_ALLOWED_ORIGINS` on the Worker does not exactly match the PWA's origin,
  `corsHeaders()` returns `{}`, the browser blocks the register call, the fetch
  throws, and `subscribeAndRegister` records `status: 'pending'` — *"never a fake
  active"*, but also never surfaced.
- **Service worker install failure.** `sw.js` install does
  `cache.addAll(CORE_ASSETS)` for ~70 assets including 12 wallpaper PNGs. **One
  404 aborts the whole `addAll`, the SW never activates, and
  `navigator.serviceWorker.ready` never resolves** → `subscribeAndRegister`
  throws `PushManager unavailable` / hangs. This failure mode also silently
  disables the entire offline app, so it would be noticed — but it must be
  checked, not assumed.
- **iOS install context.** `capabilityBlocker()` correctly returns
  `install-required` for an iOS Safari *tab*; permission and subscription must be
  created **inside the installed web app**. If the owner granted permission in
  Safari before installing, that grant does not carry over.

### W5 — iOS force-quit, stated precisely (severity: platform limitation)

The repo already documents this honestly in
`js/pushClient.js#iosLifecycleBlocker` (citing WebKit bug 258254): an iOS
Home Screen web app that has been force-quit from the app switcher is not
relaunched to handle pushes.

The two clauses the final report must keep separate:

- *the web app's JavaScript cannot run after force-quit* — guaranteed by the
  platform, no workaround will be built;
- *whether the OS still displays the notification after force-quit* — a
  **platform behaviour that must be established by physical testing**. On iOS the
  push is delivered to `webpushd`, which is a system daemon, so **it is not
  self-evident that a force-quit web app cannot display anything** — this is
  precisely where the original brief is right to insist the two questions are
  different. It will be measured, not asserted.

### W6 — Backgrounded/locked should work, which makes it a diagnostic opportunity

Unlike force-quit, a backgrounded-but-alive or locked iOS web app is a normal
case that Web Push is designed for. The owner reports failures there too. Given
W1, the most probable sequence is: it worked at first, then a single suppression
(most likely `already-delivered` from an open-app collision) revoked the
subscription — after which **every** lifecycle state fails, which the owner would
naturally report as "doesn't work when backgrounded, locked, or closed."
That is one root cause wearing three symptoms.

This is a hypothesis with a specific falsifiable prediction: **the server should
show deliveries succeeding (or `gone`) around the time it stopped.** The DO
already records this (`notification_occurrences.status`,
`push_subscriptions.last_error`, `failure_count`, `last_delivered_at`) and
`GET /api/push/status` exposes it. Nobody has looked yet.

---

## 2. Track B — the native path (real, but not what was tested)

Retained because the requested immersive UX has no other route on iOS. Full
detail was gathered; summary of confirmed defects:

| # | Defect | Evidence |
|---|---|---|
| B1 | **Android does not compile.** `buildRichNotification()` is declared to return `android.app.Notification` and has **no `return`** — closes at line 118. | `LPMessagingService.java:74–118` |
| B2 | **No FCM possible.** No `android/app/google-services.json`; the google-services plugin is applied only if that file exists; `.gitignore` ignores it deliberately. No `FirebaseApp` → `getToken()` throws → `registrationError`, no token ever. | `android/app/build.gradle`, `.gitignore` |
| B3 | **No APNs possible.** `App.entitlements` has only the App Group; `aps-environment` appears in the repo **only** as a TODO in `docs/native-push-migration.md:245`. | `ios/App/App/App.entitlements` |
| B4 | **Config errors delete the registration.** `BadDeviceToken`/`DeviceTokenNotForTopic` → `mapApnsResponse` → `gone` → the DO tick runs `DELETE FROM push_subscriptions`. A bundle-ID mismatch or a sandbox token on the production host permanently unregisters the device. | `server/push/apns.js`, `cloudflare/do.js` tick |
| B5 | Content-extension `Info.plist` uses the **non-existent** key `UNNotificationExtensionInitialFrameSize` (Apple's key is `UNNotificationExtensionInitialContentSizeRatio`) and omits `UNNotificationExtensionDefaultContentHidden`, so the default title/body render *above* the custom view — the "still looks like a normal notification" complaint even in the native case. | `ios/App/NotificationExtension/Info.plist` |
| B6 | **No full-screen intent anywhere.** Zero matches for `FullScreenIntent` / `USE_FULL_SCREEN_INTENT` under `android/`. `IMPORTANCE_HIGH` + `BigPictureStyle` is the entire Android ceiling; `LifeProgressNotificationActivity` is reachable only by tapping a notification and has no `setShowWhenLocked`/`setTurnScreenOn`/edge-to-edge. | `android/` |
| B7 | `presentationOptions` is unset, so **foreground arrivals are suppressed** on iOS (empty `willPresent`) and not posted by the Android plugin. `setForegroundPresentation()` exists but is never called. | `capacitor.config.json`, plugin sources, `js/nativePush.js` |
| B8 | Only `water|gym|goals|journal` are ever scheduled (`CONTENT_CATEGORIES`). `streaks`/`achievements` have copy, channels and test routes but no delivery path. | `server/push/domain.js:22` |

Also unresolved and unverifiable from here: whether the Worker has
`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, `APNS_*` and `FCM_*` secrets set
(`.dev.vars`/`.wrangler` are gitignored; no secret is in the repo — correct).
`GET /api/push/status` and `GET /api/push/vapid-public` will reveal the VAPID
half from the device without exposing anything private.

---

## 3. What each platform can actually deliver (honest ceiling)

| | iOS PWA (tested) | Android PWA | iOS native | Android native |
|---|---|---|---|---|
| Delivery when backgrounded/locked | yes, **if** subscription survives (W1) | yes | yes | yes |
| Delivery after force-quit | platform limit — **must be measured, split into the two clauses (W5)** | yes (tray, if token alive) | alert likely displayed; app cannot run | yes |
| Custom wallpaper in the notification | **impossible** | yes, via `image` (not yet used) | yes, via service extension attachment | yes, via BigPictureStyle |
| Large/expanded card | no | yes (big picture) | yes, content extension | yes (expanded) |
| Action buttons | no | yes (≤2) | yes (`UNNotificationAction`) | yes |
| Full-screen takeover | no | no | no | only where `canUseFullScreenIntent()` allows |
| Realistic "immersive" score | **2/10 — text + app icon** | 7/10 | 9/10 | 9/10 |

The current implementation is asking the iOS PWA to do something the iOS PWA
cannot do. That expectation gap, not just the bugs, is what the owner experienced
as "still a normal notification."

---

## 4. What is genuinely good and must not be broken

- **Scheduling is server-side and app-independent.** The DO alarm owns
  occurrences, claims and dedup; delivery does not need the page alive or the
  service worker awake. Typed outcomes
  (`delivered|gone|transient_failure|permanent_failure|not_configured`) are
  already the right abstraction.
- **Server-side observability already exists** (`/api/push/status`: `lastTickAt`,
  `lastTickResult`, per-device `last_error`, `failure_count`, ledger, occurrence
  counts). The gap is that the *app* never surfaces it.
- **Privacy is genuinely local-first.** Payloads carry only
  `type/category/occurrenceId/dateKey/route/serverTime`. Shared copy for iOS was
  static by design because there is no service-worker context on APNs.
- **Dedup, quiet hours, grace window, claim semantics** are sound and tested.
- **Fallback discipline (`§24`)** is implemented everywhere: a missing wallpaper
  never suppresses a reminder.
- The **RFC 8291/8292 crypto** is a genuine zero-dependency implementation and is
  verified by a real decrypt-side test — Web Push delivery is not the weak link.

---

## 5. Honest limits of this environment

- **iOS physical: NOT TESTED.** Needs macOS, Xcode, signing, App Group
  provisioning, APNs credentials. Not available.
- **Android physical: NOT TESTED.** Needs the Android SDK/Gradle, Firebase
  config, a device, `POST_NOTIFICATIONS` and an OEM battery-optimisation check.
- **Provider credentials: unverified** and will not be guessed at or printed.
- Delivery truth is the device, never a 200. An APNs/FCM/Web Push endpoint
  accepting a message proves nothing about display.

---

## 6. Proposed order (delivery first, presentation second)

**Wave 0 — see, before changing anything.**
1. Build the app, open Settings, and record the on-device diagnostics
   (registration state, permission, subscription, VAPID reachability, SW state,
   iOS lifecycle flag). Also fetch `GET /api/push/status` from the Worker.
   *This converts W1/W4/W6 from hypothesis to fact, and costs nothing.*

**Wave 1 — the path-independent bugs (correct on either track)**
2. **Stop the WebKit revocation (W1).** Every push WebKit hands us must result in
   a visible notification. Preserve the *intent* of the gates without tripping
   the penalty (declare the fallback notification so the OS has something to show
   even when the service worker suppresses), and never suppress for
   `already-delivered` when the earlier delivery was an **in-app** notification
   rather than an OS one. This alone may restore delivery.
3. Fix the `ROUTES` import (W3) + a regression test.
4. Stop treating configuration mistakes as device revocation (B4): topic/
   environment mismatch must never `DELETE` a subscription; only `Unregistered`
   (410) should.
5. Add the missing `return b.build();` (B1) plus a static check so an
   uncompilable service can never pass the suite again.

**Wave 2 — make it visible (diagnostics; requested by the owner)**
6. Settings diagnostics: permission, platform, installed/standalone, SW state,
   subscription, registration, VAPID reachability, provider configuration,
   immersive capability — with a redacted token fingerprint, never a token.
7. Structured `POST /api/push/test` result
   (`{platform, provider, registered, providerConfigured, dispatchOutcome, providerStatus}`)
   surfaced in the test sheet, replacing the current bare toast.
8. Surface the last server-side delivery error in the app so a `gone`/`failed`
   occurrence is visible without `wrangler` logs.

**Wave 3 — make the PWA as strong as the web platform allows**
9. Android: wallpaper via `options.image`, two real `actions`, `vibrate`,
   `tag`/`renotify`, honest `ADD_TO_HOME_SCREEN`-style guidance on iOS explaining
   what iOS does and does not show.
10. iOS: stop pretending — the settings preview must not promise a wallpaper the
    platform will not render; say what will actually appear.

**Wave 4 — the native app, only if the owner wants the real target (Track B)**
11. Owner-side: Firebase project + `google-services.json`; Apple Developer
    Program; Push Notifications capability + `aps-environment`; Worker secrets.
12. Then B1–B8 in the order given, with the iOS extensions rebuilt correctly and
    the Android full-screen path built capability-aware
    (`canUseFullScreenIntent()`), with the Wave-3 style presentation as the
    fallback everywhere.

**Wave 5 — content + tests**
13. Copy through the existing shared copy system; no guilt copy; no fabricated
    progress (the server must never invent "750 / 2500 ml" — it is sent only when
    real).
14. Tests for every new invariant. Keep 667 green; delete nothing.

---

## 6a. Wave 1 progress (verified)

Landed and green: **676/676** (667 baseline + 9 new). Every new test was proven
to FAIL with its bug reintroduced — a regression test that cannot fail is
worthless.

| fix | file | proof |
|---|---|---|
| `ROUTES` imported (Node scheduler delivery path) | `server/scheduler.js` | 2 new tests fail without it |
| `ROUTES` imported (Node categorized test push) | `server/api.js` | 1 new test fails without it |
| `return b.build();` restored (Android could not compile) | `LPMessagingService.java` | new guard test fails without it |
| Topic/environment `BadDeviceToken` no longer classified `gone` (was deleting the device row) | `server/push/apns.js` | new classification test |
| Foreground `presentationOptions` configured (arrivals while open were suppressed) | `capacitor.config.json` | — |

New test file: `test/push-node-delivery.test.js` — drives the REAL
`processSubscription` / `handlePushApi` with an isolated state file and a
stubbed fetch, then **decrypts** the aes128gcm body and asserts on the payload a
browser would actually receive. This is the coverage gap that let a
`ReferenceError` sit on the primary Node delivery path while 667 tests passed.

Still open in Wave 1: the server-side ack (W1a/W1) and the sweep time-gate.

## 7. What the owner's answers changed

- **Tested artifact = installed iPhone PWA.** Native tracks are real but not the
  current failure. See §0.
- **Bundle ID is unverified** by the owner for the installed build; it will not be
  assumed. (It only matters for Track B — the PWA path has no bundle ID.)
- **Android Firebase:** owner can add `google-services.json` *if required* — it is
  required only for Track B, or for testing Android **native**. Android **PWA**
  needs no Firebase.
- **Worker secrets:** unknown. Will be surfaced from the device via
  `/api/push/vapid-public` and `/api/push/status` instead of guessed at. No key
  will ever be printed.
- **streaks/achievements:** *not* intended to be generic periodic reminders.
  Streaks should be **event/time-condition based**, achievements **triggered by
  real unlocks**. That is a scheduling-domain change (new trigger types, not a
  new entry in `CONTENT_CATEGORIES`) and is deliberately queued after delivery
  works.
