import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    static var appearanceSyncRegistered = false

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        // V2.1 Phase 2 — the app's own native bridge (notification appearance
        // sync, §3). The web settings screen stays the source of truth; this
        // plugin only mirrors validated values into the shared container the
        // notification extensions read. Idempotent; registered once per app run.
        DispatchQueue.main.async { [weak self] in
            guard !SceneDelegate.appearanceSyncRegistered else { return } // never duplicated
            guard let bridge = (self?.window?.rootViewController as? CAPBridgeViewController)?.bridge else { return }
            SceneDelegate.appearanceSyncRegistered = true
            bridge.registerPluginInstance(LPAppearanceSyncPlugin())
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
