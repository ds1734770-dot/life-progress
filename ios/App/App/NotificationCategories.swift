import Foundation
import UserNotifications
import UIKit

// ============================================================================
// Life Progress — shared notification model (V2.1 Phase 2).
//
// This file compiles into BOTH the main app target and the notification
// extensions (APP_EXTENSION flag). It is deliberately lightweight: no web
// view, no database, no app boot — only the pieces a notification context
// may legally touch (§4: never initialize the whole app in an extension).
//
// SOURCE OF TRUTH: the JS presentation model remains authoritative for
// semantics (§11). This file mirrors ONLY the stable vocabulary:
//   · category ids   ↔ server/push/apns.js#apnsCategoryId
//   · wallpaper ids  ↔ js/notifyWallpapers.js#BUILTIN_WALLPAPERS
//   · random policy  ↔ js/notifyWallpapers.js#pickNotificationWallpaper
// Cross-language parity is asserted by test/notification-experience.test.js
// and test/push-apns.test.js, which extract these literals from source.
// ============================================================================

/// Native category identifiers (UPPER_SNAKE per Apple convention). MUST stay
/// in sync with apnsCategoryId() on the server and the registration below.
enum LPCategory {
    static let water       = "WATER_REMINDER"
    static let gym         = "GYM_REMINDER"
    static let goals       = "GOALS_REMINDER"
    static let journal     = "JOURNAL_REMINDER"
    static let streaks     = "STREAK_REMINDER"
    static let achievements = "ACHIEVEMENT_REMINDER"
    static let general     = "GENERAL_REMINDER"

    /// Action identifiers shared by every category (semantics per §5/§10).
    static let primaryAction = "PRIMARY_ACTION"
    static let snoozeAction  = "SNOOZE_ACTION"

    /// Every category with its per-category action titles. The primary action
    /// opens the app (.foreground) so the existing deep-link router can run;
    /// snooze is a background no-op that just dismisses (Remind Me Later).
    static var all: [(id: String, primary: String, snooze: String)] {
        [
            (water,        "Log Water Now",    "Remind Me Later"),
            (gym,          "Start Workout",    "Remind Me Later"),
            (goals,        "Open Goals",       "Remind Me Later"),
            (journal,      "Open Journal",     "Remind Me Later"),
            (streaks,      "View Progress",    "Remind Me Later"),
            (achievements, "View Achievement", "Remind Me Later"),
            (general,      "Open Life Progress", "Remind Me Later"),
        ]
    }

    /// Wire category (lowercase, from the payload) → native id. Mirrors the
    /// server mapping exactly.
    static func nativeId(forWireCategory wire: String?) -> String {
        switch wire {
        case "water": return water
        case "gym": return gym
        case "goals": return goals
        case "journal": return journal
        case "streaks": return streaks
        case "achievements": return achievements
        default: return general
        }
    }
}

// ============================================================================
// Wallpaper registry — mirror of js/notifyWallpapers.js (§3: the extension
// must reach the bundled wallpapers; they are bundled into every target).
// ============================================================================

struct LPWallpaper {
    let id: String
    let name: String
    let file: String   // bundled asset name in assets/notification-backgrounds/
    let overlay: Double
}

enum LPWallpapers {
    /// MUST stay in sync with BUILTIN_WALLPAPERS (asserted by tests).
    static let all: [LPWallpaper] = [
        LPWallpaper(id: "sunset_peak",    name: "Sunset Mountain", file: "sunset_peak",    overlay: 0.42),
        LPWallpaper(id: "forest_trail",   name: "Forest Trail",    file: "forest_trail",   overlay: 0.5),
        LPWallpaper(id: "calm_lake",      name: "Calm Lake",       file: "calm_lake",      overlay: 0.45),
        LPWallpaper(id: "mountain_mist",  name: "Mountain Peaks",  file: "mountain_mist",  overlay: 0.4),
        LPWallpaper(id: "night_sky",      name: "Night Sky",       file: "night_sky",      overlay: 0.3),
        LPWallpaper(id: "ocean_dusk",     name: "Ocean Dusk",      file: "ocean_dusk",     overlay: 0.42),
        LPWallpaper(id: "city_night",     name: "City Night",      file: "city_night",     overlay: 0.45),
        LPWallpaper(id: "warm_minimal",   name: "Minimal Warm",    file: "warm_minimal",   overlay: 0.5),
        LPWallpaper(id: "cozy_room",      name: "Cozy Room",       file: "cozy_room",      overlay: 0.5),
        LPWallpaper(id: "sunrise_valley", name: "Sunrise Valley",  file: "sunrise_valley", overlay: 0.45),
        LPWallpaper(id: "autumn_forest",  name: "Autumn Forest",   file: "autumn_forest",  overlay: 0.45),
        LPWallpaper(id: "training_room",  name: "Training Room",   file: "training_room",  overlay: 0.5),
    ]

    static func wallpaper(id: String?) -> LPWallpaper? {
        guard let id = id else { return nil }
        return all.first { $0.id == id }
    }

    static var fallback: LPWallpaper { all[0] }
}

// ============================================================================
// Appearance — the persisted notification-wallpaper preference, mirroring the
// JS shape (mode: random|builtin|custom). Stored in the SHARED App Group so
// the content extension can read what the app saved (§3). Only preferences
// and the local custom photo live here — nothing is ever transmitted.
// ============================================================================

struct LPNotificationAppearance: Codable, Equatable {
    var mode: String = "random"
    var builtinId: String? = nil
    var cropX: Double = 0.5
    var cropY: Double = 0.5
    var cropScale: Double = 1.0
    var recent: [String] = []

    static let `default` = LPNotificationAppearance()
}

enum LPAppearanceStore {
    /// App Group identifier — must match the entitlements of App + extensions.
    static let appGroupId = "group.com.example.lifeprogress.notifications"
    static let defaultsKey = "notificationAppearance"
    static let customPhotoName = "notification-wallpaper-custom.jpg"

    static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroupId)
    }

    static func load() -> LPNotificationAppearance {
        guard let defaults = defaults,
              let data = defaults.data(forKey: defaultsKey),
              let appearance = try? JSONDecoder().decode(LPNotificationAppearance.self, from: data) else {
            return .default
        }
        var a = appearance
        if !["random", "builtin", "custom"].contains(a.mode) { a.mode = "random" }
        if LPWallpapers.wallpaper(id: a.builtinId) == nil { a.builtinId = nil }
        a.recent = Array(Set(a.recent.filter { LPWallpapers.wallpaper(id: $0) != nil }).prefix(4))
        return a
    }

    static func save(_ appearance: LPNotificationAppearance) {
        guard let defaults = defaults,
              let data = try? JSONEncoder().encode(appearance) else { return }
        defaults.set(data, forKey: defaultsKey)
    }

    /// The user's custom photo, copied into the shared container by the app
    /// (never uploaded, never in any payload — §3). Nil when not set.
    static func customPhotoURL() -> URL? {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            return nil
        }
        let url = container.appendingPathComponent(customPhotoName)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// App-side write path: copy the processed local image into the container.
    static func storeCustomPhoto(from url: URL) -> Bool {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            return false
        }
        let dest = container.appendingPathComponent(customPhotoName)
        do {
            if FileManager.default.fileExists(atPath: dest.path) {
                try FileManager.default.removeItem(at: dest)
            }
            try FileManager.default.copyItem(at: url, to: dest)
            return true
        } catch {
            return false
        }
    }

    static func removeCustomPhoto() {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else { return }
        let dest = container.appendingPathComponent(customPhotoName)
        try? FileManager.default.removeItem(at: dest)
    }
}

// ============================================================================
// Selection — mirror of pickNotificationWallpaper(): pinned builtin → custom
// marker → deterministic random that excludes the recent history (§18).
// ============================================================================

enum LPWallpaperSelection {
    /// One wallpaper file bundled in this target, loaded by name.
    /// The shared folder is a FOLDER REFERENCE, so inside the bundle it keeps
    /// its directory: <bundle>/notification-backgrounds/<id>.png. (The synced
    /// web copy lives under public/assets/… — that shape is tried too, plus
    /// the flat name in case a future project change flattens the folder.)
    static func image(for wallpaper: LPWallpaper) -> UIImage? {
        UIImage(named: "notification-backgrounds/\(wallpaper.file)")
            ?? UIImage(named: "assets/notification-backgrounds/\(wallpaper.file)")
            ?? UIImage(named: wallpaper.file)
    }

    /// Resolve the wallpaper for one notification occurrence.
    /// `seed` should be the occurrenceId so the same notification never flips
    /// images between renders; empty seed → true random (previews).
    static func resolve(appearance: LPNotificationAppearance, seed: String) -> (wallpaper: LPWallpaper?, customURL: URL?, overlay: Double) {
        let a = appearance
        if a.mode == "custom" {
            if let url = LPAppearanceStore.customPhotoURL() {
                return (nil, url, 0.45)
            }
            // Custom photo missing → degrade to random, never fail (§24).
        } else if a.mode == "builtin", let pinned = LPWallpapers.wallpaper(id: a.builtinId) {
            return (pinned, nil, pinned.overlay)
        }
        // ---- random ----
        let pool = LPWallpapers.all.filter { !a.recent.contains($0.id) }
        let candidates = pool.isEmpty ? LPWallpapers.all : pool
        let index: Int
        if seed.isEmpty {
            index = Int.random(in: 0..<candidates.count)
        } else {
            // djb2 — byte-for-byte the same hash the JS side uses.
            var h: UInt32 = 5381
            for byte in seed.utf8 { h = (h &* 33) ^ UInt32(byte) }
            index = Int(h % UInt32(candidates.count))
        }
        return (candidates[index], nil, candidates[index].overlay)
    }
}

#if !APP_EXTENSION
// ============================================================================
// App-side registration (main target only): categories + actions at launch,
// and the appearance↔container sync the JS bridge calls after every change.
// ============================================================================
import Capacitor

enum LPNotificationSetup {
    /// Register every category with its actions. Called once at app start.
    static func registerCategories() {
        var categories = Set<UNNotificationCategory>()
        for entry in LPCategory.all {
            let primary = UNNotificationAction(
                identifier: LPCategory.primaryAction,
                title: entry.primary,
                options: [.foreground])
            let snooze = UNNotificationAction(
                identifier: LPCategory.snoozeAction,
                title: entry.snooze,
                options: [])
            categories.insert(UNNotificationCategory(
                identifier: entry.id,
                actions: [primary, snooze],
                intentIdentifiers: [],
                options: []))
        }
        UNUserNotificationCenter.current().setNotificationCategories(categories)
    }

    /// Mirror the JS-persisted appearance into the shared container (called by
    /// the LPAppearanceSync bridge plugin after every settings change).
    @objc public static func syncAppearance(mode: String, builtinId: String?, cropX: Double, cropY: Double, cropScale: Double) {
        var a = LPAppearanceStore.load()
        a.mode = mode
        a.builtinId = builtinId
        a.cropX = cropX
        a.cropY = cropY
        a.cropScale = cropScale
        LPAppearanceStore.save(a)
    }

    /// Copy the processed custom photo into the shared container.
    @objc public static func syncCustomPhoto(sourceURL: URL) -> Bool {
        LPAppearanceStore.storeCustomPhoto(from: sourceURL)
    }

    @objc public static func removeCustomPhoto() {
        LPAppearanceStore.removeCustomPhoto()
    }
}
#endif
