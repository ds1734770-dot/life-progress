package com.example.lifeprogress;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

/**
 * V2.1 — per-category notification channels (master spec §19).
 *
 * The server's FCM message targets channel `lp_<category>` (server/push/fcm.js
 * android.channel_id). Android 8+ REQUIRES the channel to exist before the
 * notification arrives — an unknown channel id makes the OS fall back to a
 * miscellaneous channel (or drop it), which would silently degrade the
 * reminder. Channels are created idempotently at app start (MainActivity
 * onCreate) via the official NotificationChannel API; creation needs no
 * permission and re-creating an existing channel is a no-op.
 *
 * IMPORTANCE_HIGH gives heads-up presentation for time-relevant reminders —
 * this is the official richest presentation for normal (non-call) reminders;
 * no full-screen intents are used (§19: they are restricted and only
 * legitimate for alarm/call semantics).
 */
public final class NotificationChannels {

    /** ids mirror server/push/fcm.js channel_id: `lp_<category>` */
    private static final String[] CHANNEL_IDS = {
            "lp_water", "lp_gym", "lp_goals", "lp_journal",
            "lp_streaks", "lp_achievements", "lp_general",
    };

    private static final String[] CHANNEL_NAMES = {
            "Water reminders", "Workout reminders", "Goal reminders", "Journal reminders",
            "Streak reminders", "Achievements", "General reminders",
    };

    private static final String[] CHANNEL_DESCRIPTIONS = {
            "Stay hydrated, stay consistent",
            "Your workout is waiting",
            "Keep moving your goals forward",
            "Take a moment to reflect",
            "Keep the momentum going",
            "Celebrate your progress",
            "Life Progress check-ins",
    };

    private NotificationChannels() {}

    /** Idempotent — safe to call on every app start. */
    public static void ensure(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        for (int i = 0; i < CHANNEL_IDS.length; i++) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_IDS[i], CHANNEL_NAMES[i], NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription(CHANNEL_DESCRIPTIONS[i]);
            channel.enableLights(true);
            channel.enableVibration(true);
            nm.createNotificationChannel(channel); // existing channel → no-op
        }
    }
}
