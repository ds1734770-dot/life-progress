import Foundation
import Capacitor

// ============================================================================
// Life Progress — native appearance bridge (V2.1 Phase 2, §3).
//
// The web settings screen is the SOURCE OF TRUTH for the notification
// appearance; this plugin mirrors the already-validated values into the
// shared App Group container (NotificationCategories.swift's LPAppearanceStore)
// the moment they change, so the notification extensions never interpret web
// storage themselves:
//   · mode (random | builtin | custom) + pinned builtin id → the persisted
//     LPNotificationAppearance record in UserDefaults(suiteName: appGroupId)
//   · the custom photo → the App Group container file, copied locally. The
//     image NEVER leaves the device (§21): it is not uploaded, not pushed
//     through APNs, not sent to Cloudflare or Node.
//
// Failure philosophy (§24): mirroring problems are surfaced honestly to the
// caller but never break the settings flow — the extensions fall back to
// bundled wallpapers.
// ============================================================================

@objc(LPAppearanceSyncPlugin)
public class LPAppearanceSyncPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LPAppearanceSyncPlugin"
    public let jsName = "LPAppearanceSync"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "syncAppearance", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncCustomPhoto", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeCustomPhoto", returnType: CAPPluginReturnPromise),
    ]

    @objc public func syncAppearance(_ call: CAPPluginCall) {
        let mode = call.getString("mode") ?? "random"
        let builtinId = call.getString("builtinId")
        // Guard on the native side too: an unknown id never persists (§24).
        if let id = builtinId, LPWallpapers.wallpaper(id: id) == nil {
            call.reject("unknown builtinId: \(id)")
            return
        }
        var appearance = LPAppearanceStore.load()
        appearance.mode = mode
        appearance.builtinId = builtinId
        LPAppearanceStore.save(appearance)
        call.resolve()
    }

    @objc public func syncCustomPhoto(_ call: CAPPluginCall) {
        guard let dataUrl = call.getString("dataUrl"),
              dataUrl.hasPrefix("data:image/"),
              let comma = dataUrl.firstIndex(of: ",") else {
            call.reject("dataUrl (image data URL) is required")
            return
        }
        let base64 = String(dataUrl[dataUrl.index(after: comma)...])
        guard let data = Data(base64Encoded: base64), !data.isEmpty else {
            call.reject("dataUrl is not valid base64")
            return
        }
        if data.count > 8 * 1024 * 1024 {
            call.reject("image out of range")
            return
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("lp-sync-\(UUID().uuidString).jpg")
        do {
            try data.write(to: url, options: .atomic)
            let ok = LPAppearanceStore.storeCustomPhoto(from: url)
            try? FileManager.default.removeItem(at: url)
            if !ok {
                call.reject("custom photo sync failed")
                return
            }
            call.resolve()
        } catch {
            call.reject("custom photo sync failed: \(error.localizedDescription)")
        }
    }

    @objc public func removeCustomPhoto(_ call: CAPPluginCall) {
        LPAppearanceStore.removeCustomPhoto()
        call.resolve()
    }
}
