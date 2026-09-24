import UIKit
import UserNotifications
import UserNotificationsUI

// ============================================================================
// Life Progress — Notification Content Extension (V2.1 Phase 2, §2).
//
// Apple's officially supported custom presentation for the EXPANDED
// notification (long-press / pull-down). This is NOT a full-screen
// replacement for the lock screen — iOS constrains the extension's frame
// and lifetime, and this renderer works entirely within those limits.
//
// Design (§2/§12): wallpaper → readability overlay → branding row →
// quote → title → subtitle → progress → message. Actions themselves are
// OS-level (registered UNNotificationActions), so the card shows a hint
// row describing them instead of fake buttons.
//
// Fallback hierarchy (§24): any failure → the standard system notification
// (the alert copy already sent in the payload) is still on screen; the
// extension simply contributes nothing. Never suppresses, never crashes.
// ============================================================================

final class LPContentViewController: UIViewController, UNNotificationContentExtension {

    private let stack = UIStackView()
    private var overlayView: UIView?
    private var wallpaperView: UIImageView?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.04, green: 0.06, blue: 0.09, alpha: 1)

        stack.axis = .vertical
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
        ])
    }

    // MARK: UNNotificationContentExtension

    func didReceive(_ notification: UNNotification) {
        let content = notification.request.content
        let wire = (content.userInfo["category"] as? String) ?? ""
        let occurrenceId = (content.userInfo["occurrenceId"] as? String) ?? ""

        // ---- wallpaper (mode-aware, failure-safe; §3/§24) -------------------
        let appearance = LPAppearanceStore.load()
        let resolved = LPWallpaperSelection.resolve(appearance: appearance, seed: occurrenceId)
        applyWallpaper(resolved: resolved)

        // ---- copy: payload alert first (real, personalized by the client
        // engine at send time on web; static shared table server-side).
        // NEVER fabricated here (§13): no numbers unless the payload has them.
        let title = content.title
        let body = content.body
        let category = LPCategory.nativeId(forWireCategory: wire)

        renderBrandRow(category: category, wireCategory: wire)
        renderQuote(category: category, wireCategory: wire)
        renderText(title: title, body: body)
        renderProgressLine(content: content)
        renderActionHint(category: category)
    }

    // MARK: wallpaper

    private func applyWallpaper(resolved: (wallpaper: LPWallpaper?, customURL: URL?, overlay: Double)) {
        var image: UIImage?
        if let url = resolved.customURL, let data = try? Data(contentsOf: url) {
            image = UIImage(data: data)
        } else if let wallpaper = resolved.wallpaper {
            image = LPWallpaperSelection.image(for: wallpaper)
        }
        guard let image = image else { return } // fallback level 3: no wallpaper

        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFill
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.clipsToBounds = true
        view.addSubview(imageView)
        NSLayoutConstraint.activate([
            imageView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: view.topAnchor),
            imageView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        wallpaperView = imageView

        // Readability overlay from the registry value (§12/§23) — a gradient
        // that darkens toward the text area, guaranteeing contrast.
        let alpha = resolved.overlay
        let overlay = GradientOverlayView(topAlpha: alpha - 0.15, bottomAlpha: min(0.9, alpha + 0.25))
        overlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(overlay)
        NSLayoutConstraint.activate([
            overlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: view.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        overlayView = overlay
    }

    // MARK: text construction (all labels built programmatically)

    private func label(text: String, size: CGFloat, weight: UIFont.Weight, alpha: CGFloat = 1) -> UILabel {
        let l = UILabel()
        l.text = text
        l.font = .systemFont(ofSize: size, weight: weight)
        l.textColor = .white.withAlphaComponent(alpha)
        l.numberOfLines = 0
        l.shadowColor = UIColor(white: 0, alpha: 0.6)
        l.shadowOffset = CGSize(width: 0, height: 1)
        return l
    }

    private func renderBrandRow(category: String, wireCategory: String) {
        let row = UIStackView()
        row.axis = .horizontal
        row.spacing = 6
        row.alignment = .center
        // Category icon — SF Symbols (official Apple icon system).
        if let symbol = symbol(for: wireCategory) {
            let icon = UIImageView(image: UIImage(systemName: symbol))
            icon.tintColor = accent(for: wireCategory)
            icon.contentMode = .scaleAspectFit
            icon.widthAnchor.constraint(equalToConstant: 16).isActive = true
            icon.heightAnchor.constraint(equalToConstant: 16).isActive = true
            row.addArrangedSubview(icon)
        }
        let brand = label(text: "Life Progress", size: 12, weight: .bold, alpha: 0.92)
        let kicker = label(text: kicker(for: category), size: 10, weight: .semibold, alpha: 0.7)
        kicker.textAlignment = .right
        row.addArrangedSubview(brand)
        row.addArrangedSubview(kicker)
        stack.addArrangedSubview(row)
    }

    /// Category accent colors (§12) — mirrors js/notifyContent.js#CATEGORY_ACCENTS.
    private func accent(for wireCategory: String) -> UIColor {
        switch wireCategory {
        case "water": return UIColor(red: 0.13, green: 0.72, blue: 0.90, alpha: 1)   // #22b8e6
        case "gym": return UIColor(red: 0.98, green: 0.45, blue: 0.09, alpha: 1)     // #f97316
        case "goals": return UIColor(red: 0.18, green: 0.75, blue: 0.44, alpha: 1)   // #2fbf71
        case "journal": return UIColor(red: 0.91, green: 0.77, blue: 0.48, alpha: 1) // #e8c47a
        case "streaks": return UIColor(red: 0.65, green: 0.55, blue: 0.98, alpha: 1) // #a78bfa
        case "achievements": return UIColor(red: 0.79, green: 0.64, blue: 0.15, alpha: 1) // #c9a227
        default: return UIColor(red: 0.56, green: 0.64, blue: 0.72, alpha: 1)        // #8fa3b8
        }
    }

    /// SF Symbol per category (mirror of CATEGORY_ICONS semantics).
    private func symbol(for wireCategory: String) -> String? {
        switch wireCategory {
        case "water": return "drop.fill"
        case "gym": return "dumbbell.fill"
        case "goals": return "target"
        case "journal": return "book.fill"
        case "streaks": return "flame.fill"
        case "achievements": return "star.fill"
        default: return "bell.fill"
        }
    }

    private func kicker(for category: String) -> String {
        category == LPCategory.achievements ? "UNLOCKED" : "REMINDER"
    }

    private func renderQuote(category: String, wireCategory: String) {
        // Deterministic per (category, day) — the SAME quote rule as the JS
        // model (js/notifyContent.js#quoteFor), so platforms agree per day.
        let key = dayKey()
        var h: UInt32 = 0
        for byte in "\(wireCategory):\(key)".utf8 { h = (h &* 31) &+ UInt32(byte) }
        let quotes = [
            "Small steps make big progress.",
            "Discipline today builds a stronger tomorrow.",
            "Show up for yourself.",
            "Keep going — future you is grateful.",
            "Progress, not perfection.",
            "One step at a time is still progress.",
            "You promised yourself. Keep the promise.",
        ]
        let quote = quotes[Int(h) % quotes.count]
        let quoteLabel = label(text: "\u{201C}\(quote)\u{201D}", size: 12, weight: .medium, alpha: 0.85)
        quoteLabel.font = .italicSystemFont(ofSize: 12)
        stack.addArrangedSubview(quoteLabel)
    }

    private func renderText(title: String, body: String) {
        stack.setCustomSpacing(8, after: stack.arrangedSubviews.last ?? UIView())
        stack.addArrangedSubview(label(text: title, size: 24, weight: .heavy))
        if !body.isEmpty {
            stack.addArrangedSubview(label(text: body, size: 14, weight: .medium, alpha: 0.95))
        }
    }

    /// Progress line — ONLY from payload-carried alert text (e.g. the water
    /// body the eligibility engine personalized). The extension never reads
    /// app data and never invents numbers (§4/§13).
    private func renderProgressLine(content: UNNotificationContent) {
        let body = content.body
        // Surface "N of M" / "x L of y L" style lines already computed by the
        // shared eligibility engine; otherwise skip (no fabrication).
        if let range = body.range(of: "^[\\d.,]+ (?:L|ml).*of|^\\d+ of \\d+ ", options: .regularExpression) {
            let line = String(body[range])
            let l = label(text: line, size: 14, weight: .bold)
            l.textColor = UIColor(red: 0.53, green: 0.64, blue: 0.72, alpha: 1)
            stack.addArrangedSubview(l)
        }
    }

    private func renderActionHint(category: String) {
        let entry = LPCategory.all.first { $0.id == category }
        let hint = LPPaddingLabel(
            text: "\(entry?.primary ?? "Open Life Progress")  ·  \(entry?.snooze ?? "Remind Me Later")",
            size: 12, weight: .bold, alpha: 0.9,
            insets: UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12))
        hint.layer.backgroundColor = UIColor(white: 1, alpha: 0.18).cgColor
        hint.layer.cornerRadius = 14
        hint.clipsToBounds = true
        hint.textAlignment = .center
        stack.setCustomSpacing(12, after: stack.arrangedSubviews.last ?? UIView())
        stack.addArrangedSubview(hint)
    }

    private func dayKey() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        return f.string(from: Date())
    }
}

// MARK: - Small helpers

/// UILabel with text insets — used for the action-hint pill.
final class LPPaddingLabel: UILabel {
    private let insets: UIEdgeInsets

    init(text: String, size: CGFloat, weight: UIFont.Weight, alpha: CGFloat, insets: UIEdgeInsets) {
        self.insets = insets
        super.init(frame: .zero)
        self.text = text
        font = .systemFont(ofSize: size, weight: weight)
        textColor = .white.withAlphaComponent(alpha)
        numberOfLines = 0
    }

    required init?(coder: NSCoder) { fatalError("unsupported") }

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.inset(by: insets))
    }

    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + insets.left + insets.right,
                      height: size.height + insets.top + insets.bottom)
    }
}

/// Vertical gradient overlay used for text readability over wallpapers.
final class GradientOverlayView: UIView {
    private let topAlpha: CGFloat
    private let bottomAlpha: CGFloat

    init(topAlpha: CGFloat, bottomAlpha: CGFloat) {
        self.topAlpha = max(0, topAlpha)
        self.bottomAlpha = max(0, bottomAlpha)
        super.init(frame: .zero)
        isUserInteractionEnabled = false
    }

    required init?(coder: NSCoder) { fatalError("unsupported") }

    override class var layerClass: AnyClass { CAGradientLayer.self }

    override func layoutSubviews() {
        super.layoutSubviews()
        let gradient = layer as? CAGradientLayer
        gradient?.colors = [
            UIColor(red: 0.02, green: 0.03, blue: 0.06, alpha: topAlpha).cgColor,
            UIColor(red: 0.02, green: 0.03, blue: 0.06, alpha: bottomAlpha).cgColor,
        ]
        gradient?.startPoint = CGPoint(x: 0.5, y: 0)
        gradient?.endPoint = CGPoint(x: 0.5, y: 1)
    }
}
