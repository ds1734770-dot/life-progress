package com.example.lifeprogress;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Life Progress — notification wallpaper registry (V2.1 Phase 2).
 *
 * Mirror of js/notifyWallpapers.js: the 12 bundled wallpapers, the persisted
 * appearance (random | builtin | custom) and the seeded random selection with
 * a bounded no-immediate-repeat history (§18). The registry reads only
 * bundled assets and app-local storage — nothing is ever downloaded at
 * notification time (§28) and the custom photo never leaves the device (§21).
 */
public final class LPWallpapers {

    private LPWallpapers() {}

    /** One bundled wallpaper. */
    public static final class Wallpaper {
        public final String id;
        public final String name;
        public final String assetPath; // src/main/assets/public/assets/notification-backgrounds/<id>.png (cap-sync bundle)
        public final double overlay;

        Wallpaper(String id, String name, String assetPath, double overlay) {
            this.id = id;
            this.name = name;
            this.assetPath = assetPath;
            this.overlay = overlay;
        }
    }

    /** MUST stay in sync with BUILTIN_WALLPAPERS (asserted by tests). */
    public static final List<Wallpaper> ALL = new ArrayList<>();
    static {
        ALL.add(new Wallpaper("sunset_peak",    "Sunset Mountain", "public/assets/notification-backgrounds/sunset_peak.png",    0.42));
        ALL.add(new Wallpaper("forest_trail",   "Forest Trail",    "public/assets/notification-backgrounds/forest_trail.png",   0.5));
        ALL.add(new Wallpaper("calm_lake",      "Calm Lake",       "public/assets/notification-backgrounds/calm_lake.png",      0.45));
        ALL.add(new Wallpaper("mountain_mist",  "Mountain Peaks",  "public/assets/notification-backgrounds/mountain_mist.png",  0.4));
        ALL.add(new Wallpaper("night_sky",      "Night Sky",       "public/assets/notification-backgrounds/night_sky.png",      0.3));
        ALL.add(new Wallpaper("ocean_dusk",     "Ocean Dusk",      "public/assets/notification-backgrounds/ocean_dusk.png",     0.42));
        ALL.add(new Wallpaper("city_night",     "City Night",      "public/assets/notification-backgrounds/city_night.png",     0.45));
        ALL.add(new Wallpaper("warm_minimal",   "Minimal Warm",    "public/assets/notification-backgrounds/warm_minimal.png",   0.5));
        ALL.add(new Wallpaper("cozy_room",      "Cozy Room",       "public/assets/notification-backgrounds/cozy_room.png",      0.5));
        ALL.add(new Wallpaper("sunrise_valley", "Sunrise Valley",  "public/assets/notification-backgrounds/sunrise_valley.png", 0.45));
        ALL.add(new Wallpaper("autumn_forest",  "Autumn Forest",   "public/assets/notification-backgrounds/autumn_forest.png",  0.45));
        ALL.add(new Wallpaper("training_room",  "Training Room",   "public/assets/notification-backgrounds/training_room.png",  0.5));
    }

    public static Wallpaper byId(String id) {
        if (id == null) return null;
        for (Wallpaper w : ALL) {
            if (w.id.equals(id)) return w;
        }
        return null;
    }

    // ---- Appearance (mirror of the JS-persisted shape) ---------------------

    /** SharedPreferences holding the appearance mirror written by the bridge. */
    public static final String PREFS = "lp_notification_appearance";
    public static final String KEY_MODE = "mode";
    public static final String KEY_BUILTIN_ID = "builtinId";
    public static final String KEY_CROP_X = "cropX";
    public static final String KEY_CROP_Y = "cropY";
    public static final String KEY_CROP_SCALE = "cropScale";
    public static final String KEY_RECENT = "recent";

    public static final String MODE_RANDOM = "random";
    public static final String MODE_BUILTIN = "builtin";
    public static final String MODE_CUSTOM = "custom";

    /** The custom photo file, stored app-locally by the bridge (never uploaded). */
    public static final String CUSTOM_PHOTO_NAME = "notification-wallpaper-custom.jpg";

    public static java.io.File customPhotoFile(Context context) {
        return new java.io.File(context.getFilesDir(), CUSTOM_PHOTO_NAME);
    }

    public static boolean hasCustomPhoto(Context context) {
        return customPhotoFile(context).exists();
    }

    /** Simple immutable appearance snapshot. */
    public static final class Appearance {
        public final String mode;
        public final String builtinId;
        public final String recent; // comma-separated ids, newest first

        Appearance(String mode, String builtinId, String recent) {
            this.mode = mode;
            this.builtinId = builtinId;
            this.recent = recent;
        }
    }

    public static Appearance loadAppearance(Context context) {
        android.content.SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String mode = p.getString(KEY_MODE, MODE_RANDOM);
        if (!MODE_RANDOM.equals(mode) && !MODE_BUILTIN.equals(mode) && !MODE_CUSTOM.equals(mode)) {
            mode = MODE_RANDOM;
        }
        String builtinId = p.getString(KEY_BUILTIN_ID, null);
        if (MODE_BUILTIN.equals(mode) && byId(builtinId) == null) {
            mode = MODE_RANDOM; // dangling pin → degrade, never fail (§24)
        }
        String recent = p.getString(KEY_RECENT, "");
        return new Appearance(mode, builtinId, recent);
    }

    /** Persist the appearance mirror (called from the JS bridge plugin). */
    public static void saveAppearance(Context context, String mode, String builtinId, String recent) {
        android.content.SharedPreferences.Editor e = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        e.putString(KEY_MODE, MODE_RANDOM.equals(mode) || MODE_BUILTIN.equals(mode) || MODE_CUSTOM.equals(mode) ? mode : MODE_RANDOM);
        e.putString(KEY_BUILTIN_ID, byId(builtinId) != null ? builtinId : null);
        e.putString(KEY_RECENT, recent == null ? "" : recent);
        e.apply();
    }

    /** Append a wallpaper id to the recent history (bounded, deduped, §18). */
    public static void rememberRecent(Context context, String wallpaperId) {
        android.content.SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> recent = new LinkedHashSet<>();
        recent.add(wallpaperId);
        String[] parts = p.getString(KEY_RECENT, "").split(",");
        for (String part : parts) {
            if (byId(part.trim()) != null) recent.add(part.trim());
        }
        List<String> list = new ArrayList<>(recent);
        while (list.size() > 4) list.remove(list.size() - 1);
        // Manual join — String.join(CharSequence, Iterable) needs API 26,
        // minSdk is 24 (no desugaring for java.lang in this project).
        StringBuilder csv = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) csv.append(',');
            csv.append(list.get(i));
        }
        p.edit().putString(KEY_RECENT, csv.toString()).apply();
    }

    // ---- Selection (mirror of pickNotificationWallpaper) --------------------

    public static final class Resolved {
        public final Wallpaper wallpaper;   // null when custom
        public final boolean isCustom;
        public final double overlay;

        Resolved(Wallpaper wallpaper, boolean isCustom, double overlay) {
            this.wallpaper = wallpaper;
            this.isCustom = isCustom;
            this.overlay = overlay;
        }
    }

    /**
     * Mode-aware resolution. Custom falls back to random when the photo is
     * missing; builtin falls back to random when the pin is dangling — the
     * notification NEVER fails because of the wallpaper (§24).
     */
    public static Resolved resolve(Context context, String seed) {
        Appearance a = loadAppearance(context);
        if (MODE_CUSTOM.equals(a.mode) && hasCustomPhoto(context)) {
            return new Resolved(null, true, 0.45);
        }
        if (MODE_BUILTIN.equals(a.mode)) {
            Wallpaper pinned = byId(a.builtinId);
            if (pinned != null) return new Resolved(pinned, false, pinned.overlay);
        }
        // ---- random (or degraded mode) ----
        List<Wallpaper> pool = new ArrayList<>();
        for (Wallpaper w : ALL) {
            if (!containsId(a.recent, w.id)) pool.add(w);
        }
        if (pool.isEmpty()) pool = ALL; // history can never starve the pool
        int index;
        if (seed == null || seed.isEmpty()) {
            index = (int) (Math.random() * pool.size());
        } else {
            // djb2 — identical hash to the JS and iOS implementations.
            long h = 5381;
            for (int i = 0; i < seed.length(); i++) {
                h = (h * 33) ^ seed.charAt(i);
            }
            index = (int) (Math.abs(h) % pool.size());
        }
        Wallpaper picked = pool.get(index % pool.size());
        rememberRecent(context, picked.id);
        return new Resolved(picked, false, picked.overlay);
    }

    private static boolean containsId(String csv, String id) {
        if (csv == null || csv.isEmpty()) return false;
        for (String part : csv.split(",")) {
            if (part.trim().equals(id)) return true;
        }
        return false;
    }

    // ---- Image loading (optimized, §28) -------------------------------------

    /**
     * Decode a wallpaper bitmap at notification-appropriate resolution —
     * bundled assets are already 1080×1620, so we downsample during decode
     * (never load the full bitmap first) and never block on network.
     */
    public static Bitmap decodeWallpaper(Context context, Wallpaper w, int maxDimension) {
        try {
            InputStream in = context.getAssets().open(w.assetPath);
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeStream(in, null, bounds);
            in.close();

            int sample = 1;
            int maxSide = Math.max(bounds.outWidth, bounds.outHeight);
            while (maxSide / (sample * 2) >= maxDimension) sample *= 2;

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            InputStream in2 = context.getAssets().open(w.assetPath);
            Bitmap bmp = BitmapFactory.decodeStream(in2, null, opts);
            in2.close();
            return bmp;
        } catch (Exception e) {
            return null;
        }
    }

    /** Decode the stored custom photo with the same downsampling care. */
    public static Bitmap decodeCustomPhoto(Context context, int maxDimension) {
        try {
            Uri uri = Uri.fromFile(customPhotoFile(context));
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeStream(context.getContentResolver().openInputStream(uri), null, bounds);

            int sample = 1;
            int maxSide = Math.max(bounds.outWidth, bounds.outHeight);
            while (maxSide / (sample * 2) >= maxDimension) sample *= 2;

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            return BitmapFactory.decodeStream(context.getContentResolver().openInputStream(uri), null, opts);
        } catch (Exception e) {
            return null;
        }
    }
}
