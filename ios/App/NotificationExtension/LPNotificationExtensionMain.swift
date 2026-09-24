import UIKit
import UserNotifications
import UserNotificationsUI

// ============================================================================
// Life Progress — Notification Content Extension entry point (V2.1 Phase 2).
//
// NSExtensionMainStoryboard is NOT used: this class is wired via
// NSExtensionPrincipalClass in Info.plist (less storyboards, less to break).
// ============================================================================

@objc(LPNotificationExtensionMain)
final class LPNotificationExtensionMain: LPContentViewController {}
