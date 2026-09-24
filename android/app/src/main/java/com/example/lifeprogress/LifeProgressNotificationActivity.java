package com.example.lifeprogress;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Life Progress — immersive notification presentation Activity (V2.1 Phase 2, §8).
 *
 * Reached from the rich notification's actions/content tap. Renders the SAME
 * presentation semantics as the iOS content extension and the web preview
 * (wallpaper → overlay → branding → quote → title → body → action hints) —
 * it never duplicates business logic (§11); it mirrors the shared vocabulary
 * from LPPresentationModel/LPWallpapers.
 *
 * This is a normal activity over the app — NOT a full-screen system takeover.
 * Dismiss/hardware-back lands the user in the app on the deep-linked route.
 */
public class LifeProgressNotificationActivity extends Activity {

    private String route = "#/dashboard";
    private String category = LPPresentationModel.GENERAL;

    @Override
    protected void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        IntentReader.read(getIntent(), this);
        render();
    }

    /** Small intent-decoding helper (kept separate for clarity). */
    private static final class IntentReader {
        static void read(android.content.Intent intent, LifeProgressNotificationActivity activity) {
            if (intent == null) return;
            String route = intent.getStringExtra(LPMessagingService.EXTRA_ROUTE);
            String cat = intent.getStringExtra(LPMessagingService.EXTRA_CATEGORY);
            activity.route = route != null && route.startsWith("#/") ? route : "#/dashboard";
            activity.category = LPPresentationModel.normalize(cat);
        }
    }

    private void render() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        // ---- wallpaper background (local resolution, failure-safe §24) -----
        LPWallpapers.Resolved resolved = LPWallpapers.resolve(this, String.valueOf(getIntentHash()));
        Bitmap wall = resolved.isCustom
                ? LPWallpapers.decodeCustomPhoto(this, 1440)
                : LPWallpapers.decodeWallpaper(this, resolved.wallpaper, 1440);

        if (wall != null) {
            ImageView bg = new ImageView(this);
            bg.setImageBitmap(wall);
            bg.setScaleType(ImageView.ScaleType.CENTER_CROP);
            root.addView(bg, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        } else {
            View flat = new View(this);
            flat.setBackgroundColor(Color.rgb(10, 14, 20));
            root.addView(flat, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        }

        // ---- bottom card: branding → quote → title → body → actions --------
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        card.setPadding(pad, pad, pad, pad);
        card.setBackgroundColor(Color.argb(230, 8, 12, 18));

        TextView brand = styledText("Life Progress  ·  REMINDER", 12, 700, 0.92f);
        card.addView(brand);

        TextView quote = styledText("\u201C" + quoteFor(category) + "\u201D", 13, 400, 0.85f);
        quote.setTypeface(quote.getTypeface(), android.graphics.Typeface.ITALIC);
        card.addView(quote, new LinearLayout.LayoutParams(-1, -2) {{ topMargin = dp(4); }});

        TextView title = styledText(titleFor(category), 26, 800, 1f);
        card.addView(title, new LinearLayout.LayoutParams(-1, -2) {{ topMargin = dp(10); }});

        TextView body = styledText(bodyFor(category), 14, 400, 0.95f);
        card.addView(body, new LinearLayout.LayoutParams(-1, -2) {{ topMargin = dp(4); }});

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.END);
        Button primary = new Button(this);
        primary.setText(LPPresentationModel.primaryActionFor(category));
        primary.setTextColor(Color.WHITE);
        primary.getBackground().setColorFilter(LPPresentationModel.accentFor(category), android.graphics.PorterDuff.Mode.SRC_ATOP);
        primary.setOnClickListener(v -> finishAndLaunchApp());
        actions.addView(primary, new LinearLayout.LayoutParams(-2, -2) {{ leftMargin = dp(8); }});

        Button secondary = new Button(this);
        secondary.setText(LPPresentationModel.SECONDARY_ACTION);
        secondary.setTextColor(Color.WHITE);
        secondary.getBackground().setColorFilter(Color.argb(60, 255, 255, 255), android.graphics.PorterDuff.Mode.SRC_ATOP);
        secondary.setOnClickListener(v -> finish());
        actions.addView(secondary);

        card.addView(actions, new LinearLayout.LayoutParams(-1, -2) {{ topMargin = dp(14); }});

        root.addView(card, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        setContentView(root);
    }

    private void finishAndLaunchApp() {
        IntentBridge.launchMainActivity(this, route);
        finish();
    }

    // ---- copy mirrors (same wording family as js/notifyContent.js) ----------

    private String titleFor(String cat) {
        switch (cat) {
            case LPPresentationModel.WATER: return "Drink Water";
            case LPPresentationModel.GYM: return "Time to Train";
            case LPPresentationModel.GOALS: return "One Goal Left";
            case LPPresentationModel.JOURNAL: return "Take a Moment";
            case LPPresentationModel.STREAKS: return "Keep the Streak Alive";
            case LPPresentationModel.ACHIEVEMENTS: return "Achievement Earned";
            default: return "A Moment for You";
        }
    }

    private String bodyFor(String cat) {
        switch (cat) {
            case LPPresentationModel.WATER: return "Stay hydrated, stay consistent.";
            case LPPresentationModel.GYM: return "Your workout is waiting.";
            case LPPresentationModel.GOALS: return "You're almost there.";
            case LPPresentationModel.JOURNAL: return "How was your day?";
            case LPPresentationModel.STREAKS: return "Keep the momentum going.";
            case LPPresentationModel.ACHIEVEMENTS: return "See what you earned.";
            default: return "A quick check-in keeps your progress honest.";
        }
    }

    private String quoteFor(String cat) {
        // Deterministic per (category, day) — the same rule as the JS model.
        String key = new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
                .format(new java.util.Date());
        String s = cat + ":" + key;
        int h = 0;
        for (int i = 0; i < s.length(); i++) h = (h * 31 + s.charAt(i));
        String[] quotes = {
            "Small steps make big progress.",
            "Discipline today builds a stronger tomorrow.",
            "Show up for yourself.",
            "Keep going — future you is grateful.",
            "Progress, not perfection.",
            "One step at a time is still progress.",
            "You promised yourself. Keep the promise.",
        };
        return quotes[Math.abs(h) % quotes.length];
    }

    // ---- ui helpers -----------------------------------------------------------

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private TextView styledText(String text, float sizeSp, int weight, float alpha) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(sizeSp);
        tv.setTypeface(android.graphics.Typeface.create("sans-serif", weight));
        tv.setTextColor(Color.argb((int) (alpha * 255), 255, 255, 255));
        return tv;
    }

    private int getIntentHash() {
        return getIntent() != null && getIntent().getStringExtra(LPMessagingService.EXTRA_OCCURRENCE) != null
                ? getIntent().getStringExtra(LPMessagingService.EXTRA_OCCURRENCE).hashCode()
                : 0;
    }

    /** Bridge to MainActivity launch (kept tiny; route carried as extra). */
    private static final class IntentBridge {
        static void launchMainActivity(Activity activity, String route) {
            android.content.Intent launch = activity.getPackageManager()
                    .getLaunchIntentForPackage(activity.getPackageName());
            if (launch == null) return;
            launch.putExtra(LPMessagingService.EXTRA_ROUTE, route);
            activity.startActivity(launch);
        }
    }
}
