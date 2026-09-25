package com.example.lifeprogress;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;

import androidx.annotation.NonNull;

/**
 * Life Progress — rich foreground presentation for FCM messages (V2.1 Phase 2).
 *
 * Contract: this service EXTENDS the Capacitor push plugin's MessagingService
 * (an app may register only ONE com.google.firebase.MESSAGING_EVENT receiver;
 * the app manifest's declaration overrides the plugin's own entry). super's
 * handling is always invoked first so token rotation and the
 * `pushNotificationReceived` JS event keep working unchanged. For real Life
 * Progress reminders (identified by their occurrenceId) the plugin's plain
 * foreground presentation is then REPLACED with the immersive Life Progress
 * notification built locally (wallpaper + branding + category styling +
 * actions, same notification id so nothing doubles up).
 *
 * Background delivery is untouched: FCM system-tray presentation shows the
 * server's notification block with the `lp_*` channel targeting — the
 * standard rich fallback (§24 level 3). Both paths use the SAME channel ids,
 * so the user sees one consistent per-category presentation.
 *
 * Full-screen intents are deliberately NOT used (§7/§19): they are restricted
 * by the OS and legitimate only for alarm/call semantics. IMPORTANCE_HIGH
 * channels + BigPictureStyle is the richest officially supported experience
 * for ordinary reminders.
 */
public class LPMessagingService extends com.capacitorjs.plugins.pushnotifications.MessagingService {

    public static final String ACTION_PRIMARY = "com.example.lifeprogress.LP_PRIMARY";
    public static final String ACTION_SNOOZE = "com.example.lifeprogress.LP_SNOOZE";
    public static final String EXTRA_CATEGORY = "lp_category";
    public static final String EXTRA_ROUTE = "lp_route";
    public static final String EXTRA_OCCURRENCE = "lp_occurrence";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        // Token rotation + the JS pushNotificationReceived event (plugin).
        super.onMessageReceived(message);

        RemoteMessage.Notification src = message.getNotification();
        java.util.Map<String, String> data = message.getData();
        LPPresentationModel.Payload payload = LPPresentationModel.Payload.from(data);

        // Only decorate real Life Progress reminders; anything else keeps the
        // plugin's default handling.
        if (payload.occurrenceId.isEmpty()) return;

        String category = LPPresentationModel.normalize(payload.category);
        NotificationManagerCompat nm = NotificationManagerCompat.from(this);

        // REPLACE the plugin's plain foreground presentation with the
        // immersive one — SAME id, so if the plugin ever posts first (it only
        // does when `presentationOptions` is configured, which it is not),
        // this update overwrites it instead of stacking a second notification.
        android.app.Notification rich = buildRichNotification(this, payload, src);
        nm.notify(tagFor(category), (int) (payload.occurrenceId.hashCode()), rich);
    }

    /** Build the immersive notification (public for the activity + tests). */
    public static android.app.Notification buildRichNotification(
            Context context, LPPresentationModel.Payload payload, RemoteMessage.Notification src) {
        String category = LPPresentationModel.normalize(payload.category);
        int accent = LPPresentationModel.accentFor(category);

        String title = src != null && src.getTitle() != null ? src.getTitle() : "Life Progress";
        String body = src != null && src.getBody() != null ? src.getBody() : "Time for a quick check-in.";

        // ---- wallpaper (local, failure-safe, §24) --------------------------
        LPWallpapers.Resolved resolved = LPWallpapers.resolve(context, payload.occurrenceId);
        Bitmap wall = resolved.isCustom
                ? LPWallpapers.decodeCustomPhoto(context, 1200)
                : LPWallpapers.decodeWallpaper(context, resolved.wallpaper, 1200);

        NotificationCompat.Builder b = new NotificationCompat.Builder(context, "lp_" + category)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setColor(accent)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(wall != null
                        ? new NotificationCompat.BigPictureStyle()
                            .bigPicture(wall)
                            .bigLargeIcon(null)
                        : new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setDefaultVibrate(new long[]{0, 180})
                .addPerson("life-progress://reminder"); // condensed-to-expanded hint

        if (wall != null) b.setLargeIcon(Bitmap.createScaledBitmap(wall, 256, 256, true));

        // ---- content intent: deep link into the allowlisted route ----------
        b.setContentIntent(deepLinkIntent(context, payload.route, payload.occurrenceId));

        // ---- actions: PRIMARY + SNOOZE (§10) --------------------------------
        b.addAction(new NotificationCompat.Action.Builder(
                0,
                LPPresentationModel.primaryActionFor(category),
                primaryPendingIntent(context, payload)).build());
        b.addAction(new NotificationCompat.Action.Builder(
                0,
                LPPresentationModel.SECONDARY_ACTION,
                snoozePendingIntent(context, payload)).build());

        // V2.1 FIX — the method declares `android.app.Notification` as its
        // return type but never returned: javac rejected the whole module with
        // "missing return statement", so android/app could not be assembled at
        // all (no APK, therefore no notification, on any lifecycle state).
        return b.build();
    }

    // ---- pending intents -----------------------------------------------------

    /** Open the app on the allowlisted route (existing hash router). */
    private static PendingIntent deepLinkIntent(Context context, String route, String occurrenceId) {
        Intent intent = new Intent(context, LifeProgressNotificationActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("lifeprogress://notification" + (route == null ? "" : route)));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        intent.putExtra(EXTRA_ROUTE, route == null ? "#/dashboard" : route);
        intent.putExtra(EXTRA_OCCURRENCE, occurrenceId);
        return PendingIntent.getActivity(
                context,
                occurrenceId.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** PRIMARY_ACTION → activity with the action flag (§10 semantics). */
    private static PendingIntent primaryPendingIntent(Context context, LPPresentationModel.Payload payload) {
        Intent intent = new Intent(context, LifeProgressNotificationActivity.class);
        intent.setAction(ACTION_PRIMARY);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        intent.putExtras(deepLinkExtras(payload));
        return PendingIntent.getActivity(
                context,
                ("primary:" + payload.occurrenceId).hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** SNOOZE → silent dismiss broadcast (no app launch). */
    private static PendingIntent snoozePendingIntent(Context context, LPPresentationModel.Payload payload) {
        Intent intent = new Intent(context, LPSnoozeReceiver.class);
        intent.setAction(ACTION_SNOOZE);
        intent.putExtra(EXTRA_OCCURRENCE, payload.occurrenceId);
        return PendingIntent.getBroadcast(
                context,
                ("snooze:" + payload.occurrenceId).hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static android.os.Bundle deepLinkExtras(LPPresentationModel.Payload payload) {
        android.os.Bundle bundle = new android.os.Bundle();
        bundle.putString(EXTRA_ROUTE, payload.route == null || payload.route.isEmpty() ? "#/dashboard" : payload.route);
        bundle.putString(EXTRA_CATEGORY, payload.category);
        bundle.putString(EXTRA_OCCURRENCE, payload.occurrenceId);
        return bundle;
    }

    private static String tagFor(String category) {
        return "lp_" + category;
    }

    /** Public helper the activity uses to forward a primary action into the app. */
    public static Intent primaryAppIntent(Context context, String route) {
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) return new Intent(context, MainActivity.class);
        launch.putExtra(EXTRA_ROUTE, route);
        return launch;
    }
}
