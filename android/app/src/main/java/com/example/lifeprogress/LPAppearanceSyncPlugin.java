package com.example.lifeprogress;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;

/**
 * Life Progress — native appearance bridge (V2.1 Phase 2, §3/§9).
 *
 * The web settings screen is the SOURCE OF TRUTH for the notification
 * appearance; this plugin mirrors the already-validated values into the
 * native layer the moment they change, so the notification renderer never
 * has to interpret web storage itself:
 *   · mode (random | builtin | custom) + pinned builtin id + recent history
 *     → SharedPreferences read by LPWallpapers
 *   · the custom photo blob → filesDir/notification-wallpaper-custom.jpg,
 *     written locally. The image NEVER leaves the device (§21): it is not
 *     uploaded, not pushed through APNs/FCM, not sent to Cloudflare or Node.
 *
 * Failure philosophy (§24): mirroring problems are surfaced honestly to the
 * caller but never break the settings flow — the notification falls back to
 * bundled wallpapers.
 */
@CapacitorPlugin(name = "LPAppearanceSync")
public class LPAppearanceSyncPlugin extends Plugin {

    @PluginMethod
    public void syncAppearance(PluginCall call) {
        String mode = call.getString("mode", "random");
        String builtinId = call.getString("builtinId");
        String recent = csvOf(call.getArray("recent"));
        try {
            LPWallpapers.saveAppearance(getContext(), mode, builtinId, recent);
            JSObject result = new JSObject();
            result.put("ok", Boolean.TRUE);
            call.resolve(result);
        } catch (Exception err) {
            call.reject("appearance sync failed: " + err.getMessage());
        }
    }

    @PluginMethod
    public void syncCustomPhoto(PluginCall call) {
        String dataUrl = call.getString("dataUrl");
        if (dataUrl == null || !dataUrl.startsWith("data:image/")) {
            call.reject("dataUrl (image data URL) is required");
            return;
        }
        try {
            int comma = dataUrl.indexOf(',');
            byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            if (bytes.length == 0 || bytes.length > 8 * 1024 * 1024) {
                call.reject("image out of range");
                return;
            }
            Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bmp == null) {
                call.reject("image could not be decoded");
                return;
            }
            File dest = LPWallpapers.customPhotoFile(getContext());
            FileOutputStream out = new FileOutputStream(dest);
            try {
                bmp.compress(Bitmap.CompressFormat.JPEG, 88, out);
            } finally {
                out.close();
            }
            JSObject result = new JSObject();
            result.put("ok", Boolean.TRUE);
            result.put("bytes", bytes.length);
            call.resolve(result);
        } catch (IllegalArgumentException badBase64) {
            call.reject("dataUrl is not valid base64");
        } catch (Exception err) {
            call.reject("custom photo sync failed: " + err.getMessage());
        }
    }

    @PluginMethod
    public void removeCustomPhoto(PluginCall call) {
        try {
            File f = LPWallpapers.customPhotoFile(getContext());
            if (f.exists()) f.delete();
            call.resolve();
        } catch (Exception err) {
            call.reject("custom photo removal failed: " + err.getMessage());
        }
    }

    /**
     * The webview is not yet up when a notification cold-starts the app: the
     * JS side polls consumeNotificationRoute() at boot and receives the route
     * the notification activity/service parked here.
     */
    @PluginMethod
    public void consumeNotificationRoute(PluginCall call) {
        String route = MainActivity.consumePendingRoute(getContext());
        JSObject result = new JSObject();
        result.put("route", route);
        call.resolve(result);
    }

    /** ["a","b"] → "a,b" (LPWallpapers' recent-history format). */
    private static String csvOf(JSArray arr) {
        if (arr == null) return "";
        StringBuilder csv = new StringBuilder();
        for (int i = 0; i < arr.length(); i++) {
            String id = arr.optString(i, null);
            if (id == null || id.isEmpty()) continue;
            if (LPWallpapers.byId(id) == null) continue; // only valid ids (§24)
            if (csv.length() > 0) csv.append(',');
            csv.append(id);
        }
        return csv.toString();
    }
}
