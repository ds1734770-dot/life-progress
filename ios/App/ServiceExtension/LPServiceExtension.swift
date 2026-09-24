import UserNotifications
import UIKit

// ============================================================================
// Life Progress — Notification Service Extension (V2.1 Phase 2, §2/§3).
//
// Runs before presentation for payloads with `mutable-content: 1` (which the
// server always sets). Responsibilities, strictly bounded:
//   1. validate the Life Progress payload (identity fields present);
//   2. resolve the wallpaper LOCALLY (bundled asset / App Group custom photo)
//      and attach it so even the COLLAPSED notification carries the visual;
//   3. NEVER invent progress, NEVER touch the network, NEVER log content.
//
// Fallback hierarchy (§24): every failure path calls the completion handler
// with the ORIGINAL content — the standard notification always shows.
// ============================================================================

final class LPServiceExtension: UNNotificationServiceExtension {

    /// App Group — matches App + content extension entitlements.
    private static let appGroupId = "group.com.example.lifeprogress.notifications"
    private static let appearanceKey = "notificationAppearance"

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        let content = request.content

        // Not a Life Progress reminder (no route metadata) → pass through.
        guard content.userInfo["route"] is String else {
            contentHandler(content)
            return
        }

        let wire = (content.userInfo["category"] as? String) ?? ""
        let occurrenceId = (content.userInfo["occurrenceId"] as? String) ?? ""

        // Payload sanity: a reminder without its identity fields is not worth
        // decorating — hand back the standard presentation.
        guard !occurrenceId.isEmpty else {
            contentHandler(content)
            return
        }

        // ---- wallpaper resolution (local only, never network) --------------
        guard let attachment = Self.wallpaperAttachment(wireCategory: wire, occurrenceId: occurrenceId) else {
            contentHandler(content) // fallback: standard notification
            return
        }

        let best = content.mutableCopy() as! UNMutableNotificationContent
        best.attachments = [attachment]
        contentHandler(best)
    }

    override func serviceExtensionTimeWillExpire() {
        // Nothing to unwind: we either already called contentHandler or the
        // system presents the original content. No partial mutation is ever
        // left pending (§24).
    }

    // MARK: wallpaper

    /// Resolve + downscale the wallpaper and wrap it as a notification
    /// attachment. Purely local: bundled asset or App Group file (§3).
    static func wallpaperAttachment(wireCategory: String, occurrenceId: String) -> UNNotificationAttachment? {
        let appearance = loadAppearance()
        let resolved = LPWallpaperSelection.resolve(appearance: appearance, seed: occurrenceId)

        var imageData: Data?
        if let url = resolved.customURL {
            imageData = try? Data(contentsOf: url)
        } else if let wallpaper = resolved.wallpaper, let image = LPWallpaperSelection.image(for: wallpaper) {
            imageData = image.jpegData(compressionQuality: 0.85)
        }
        guard let data = imageData, let image = UIImage(data: data) else { return nil }

        // Downscale to notification-appropriate dimensions before attach (§28:
        // no giant originals at notification time). Portrait 800×1200 max.
        let downscaled = Self.downscale(image: image, maxDimension: 1200)
        guard let jpeg = downscaled.jpegData(compressionQuality: 0.8) else { return nil }

        let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lp-wallpaper-\(occurrenceId.hashValue).jpg")
        do {
            try jpeg.write(to: tmp, options: .atomic)
            // `visible` type option — Apple officially supports image attachments.
            return try UNNotificationAttachment(identifier: "lp-wallpaper", url: tmp, options: [UNNotificationAttachmentOptionsTypeHintKey: "public.jpeg"])
        } catch {
            return nil
        }
    }

    private static func downscale(image: UIImage, maxDimension: CGFloat) -> UIImage {
        let maxSide = max(image.size.width, image.size.height)
        guard maxSide > maxDimension, image.size.width > 0 else { return image }
        let scale = maxDimension / maxSide
        let newSize = CGSize(width: floor(image.size.width * scale), height: floor(image.size.height * scale))
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: newSize, format: format)
        return renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: newSize)) }
    }

    // MARK: appearance (duplicated minimal reader — extensions cannot import
    // the app module; the SHAPE mirrors LPAppearanceStore in the shared file)

    private static func loadAppearance() -> LPNotificationAppearance {
        guard let defaults = UserDefaults(suiteName: appGroupId),
              let data = defaults.data(forKey: appearanceKey),
              let appearance = try? JSONDecoder().decode(LPNotificationAppearance.self, from: data) else {
            return .default
        }
        var a = appearance
        if !["random", "builtin", "custom"].contains(a.mode) { a.mode = "random" }
        a.recent = Array(Set(a.recent.filter { LPWallpapers.wallpaper(id: $0) != nil }).prefix(4))
        return a
    }
}
