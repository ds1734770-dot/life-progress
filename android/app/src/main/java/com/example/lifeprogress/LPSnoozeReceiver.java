package com.example.lifeprogress;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.core.app.NotificationManagerCompat;

/**
 * Life Progress — "Remind Me Later" action (V2.1 Phase 2, §10).
 *
 * Tapping a notification ACTION does not auto-cancel it (only content taps
 * with setAutoCancel do), so this receiver dismisses the exact notification
 * (same tag + id the messaging service used) and does nothing else: no app
 * launch, no rescheduling — the scheduler's next occurrence remains
 * authoritative (dedup semantics untouched). Guarded: a receiver must never
 * throw.
 */
public class LPSnoozeReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            String occurrenceId = intent == null ? null : intent.getStringExtra(LPMessagingService.EXTRA_OCCURRENCE);
            if (occurrenceId == null || occurrenceId.isEmpty()) return;
            NotificationManagerCompat nm = NotificationManagerCompat.from(context);
            if (!nm.areNotificationsEnabled()) return;
            String tag = "lp_" + LPPresentationModel.normalize(categoryOf(occurrenceId));
            nm.cancel(tag, occurrenceId.hashCode());
        } catch (Exception ignored) {
            // Never crash from a dismiss.
        }
    }

    /** occurrenceId shape: deviceKey:category:dateKey — category is part 2. */
    private static String categoryOf(String occurrenceId) {
        String[] parts = occurrenceId.split(":");
        return parts.length >= 2 ? parts[1] : "general";
    }
}
