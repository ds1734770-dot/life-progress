package com.example.lifeprogress;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** Same prefs file the wallpaper registry uses — one notification namespace. */
    private static final String PREFS = "lp_notification_appearance";
    private static final String KEY_PENDING_ROUTE = "pendingRoute";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // V2.1 Phase 2 — the app's own native bridge (appearance sync +
        // notification-route consume). Registered BEFORE super.onCreate so the
        // bridge picks it up when it loads.
        registerPlugin(LPAppearanceSyncPlugin.class);
        super.onCreate(savedInstanceState);
        // V2.1 — idempotent per-category channels (lp_water, lp_gym, …) so FCM
        // system-tray delivery targets an existing channel. No permission, no
        // new plugin, no full-screen intent (§19).
        NotificationChannels.ensure(getApplicationContext());
        takeRouteFromIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        takeRouteFromIntent(intent);
    }

    /**
     * A notification (content tap or primary action) landed here with a route.
     * The route is persisted FIRST, then pushed into the webview when possible:
     * if the app JS has not booted yet, its boot-time
     * consumeNotificationRoute() call delivers it instead — a route is
     * delivered exactly once, never lost, never doubled (§10).
     */
    private void takeRouteFromIntent(Intent intent) {
        if (intent == null) return;
        String route = intent.getStringExtra(LPMessagingService.EXTRA_ROUTE);
        if (route == null) return;
        intent.removeExtra(LPMessagingService.EXTRA_ROUTE);
        deliverRoute(route);
    }

    private void deliverRoute(String route) {
        if (route == null || !route.matches("^#/[a-z]+$")) return; // allowlist §10
        SharedPreferences.Editor editor = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        editor.putString(KEY_PENDING_ROUTE, route);
        editor.apply();
        if (bridge == null || bridge.getWebView() == null) return;
        // Route is already validated against ^#/[a-z]+$ — safe to interpolate.
        String js = "window.__LP_PENDING_ROUTE__ = '" + route + "';";
        bridge.getWebView().post(() -> bridge.getWebView().evaluateJavascript(js, result ->
                getSharedPreferences(PREFS, MODE_PRIVATE)
                        .edit()
                        .remove(KEY_PENDING_ROUTE)
                        .apply()));
    }

    /**
     * Boot-time delivery (called from the LPAppearanceSyncPlugin): returns and
     * clears the pending route when the direct webview push above never ran.
     */
    static String consumePendingRoute(android.content.Context context) {
        SharedPreferences p = context.getSharedPreferences(PREFS, MODE_PRIVATE);
        String route = p.getString(KEY_PENDING_ROUTE, null);
        if (route != null) p.edit().remove(KEY_PENDING_ROUTE).apply();
        return route != null && route.matches("^#/[a-z]+$") ? route : null;
    }
}
