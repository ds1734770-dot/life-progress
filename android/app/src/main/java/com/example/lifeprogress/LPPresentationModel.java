package com.example.lifeprogress;

import java.util.List;
import java.util.ArrayList;

/**
 * Life Progress — shared notification presentation model (V2.1 Phase 2, §11).
 *
 * The JS model (js/notifyContent.js) remains the SOURCE OF TRUTH for
 * semantics; this file mirrors only the stable vocabulary the native
 * renderer needs — the same approach as iOS's NotificationCategories.swift.
 * Cross-language parity is asserted by test/notification-experience.test.js,
 * which extracts these literals from this file and from the Swift source.
 *
 * Pure data, no I/O — safe to use from any process context.
 */
public final class LPPresentationModel {

    private LPPresentationModel() {}

    // ---- Category ids (wire vocabulary, lowercase — matches js/swPush.js) --
    public static final String WATER = "water";
    public static final String GYM = "gym";
    public static final String GOALS = "goals";
    public static final String JOURNAL = "journal";
    public static final String STREAKS = "streaks";
    public static final String ACHIEVEMENTS = "achievements";
    public static final String GENERAL = "general";

    public static final List<String> CATEGORIES = new ArrayList<>();
    static {
        CATEGORIES.add(WATER);
        CATEGORIES.add(GYM);
        CATEGORIES.add(GOALS);
        CATEGORIES.add(JOURNAL);
        CATEGORIES.add(STREAKS);
        CATEGORIES.add(ACHIEVEMENTS);
        CATEGORIES.add(GENERAL);
    }

    /** Unknown or empty wire categories degrade to general — never invented. */
    public static String normalize(String wireCategory) {
        return CATEGORIES.contains(wireCategory) ? wireCategory : GENERAL;
    }

    /** Category accents (§12) — mirror of CATEGORY_ACCENTS in notifyContent.js. */
    public static int accentFor(String wireCategory) {
        switch (normalize(wireCategory)) {
            case WATER: return 0xFF22B8E6;
            case GYM: return 0xFFF97316;
            case GOALS: return 0xFF2FBF71;
            case JOURNAL: return 0xFFE8C47A;
            case STREAKS: return 0xFFA78BFA;
            case ACHIEVEMENTS: return 0xFFC9A227;
            default: return 0xFF8FA3B8;
        }
    }

    /** Primary action label per category (mirror of presentationFor()). */
    public static String primaryActionFor(String wireCategory) {
        switch (normalize(wireCategory)) {
            case WATER: return "Log Water Now";
            case GYM: return "Start Workout";
            case GOALS: return "Open Goals";
            case JOURNAL: return "Open Journal";
            case STREAKS: return "View Progress";
            case ACHIEVEMENTS: return "View Achievement";
            default: return "Open Life Progress";
        }
    }

    public static final String SECONDARY_ACTION = "Remind Me Later";

    /** Deep-link routes — the SAME allowlist js/notifyContent.js enforces. */
    public static String routeFor(String wireCategory) {
        switch (normalize(wireCategory)) {
            case WATER: return "#/water";
            case GYM: return "#/gym";
            case GOALS: return "#/goals";
            case JOURNAL: return "#/journal";
            case ACHIEVEMENTS: return "#/achievements";
            default: return "#/dashboard";
        }
    }

    /**
     * The payload fields a Life Progress notification carries (from
     * server/push/domain.js buildPushPayload — minimal identity metadata).
     * Extracted once per notification presentation.
     */
    public static final class Payload {
        public final String type;
        public final String category;
        public final String occurrenceId;
        public final String dateKey;
        public final String route;

        public Payload(String type, String category, String occurrenceId, String dateKey, String route) {
            this.type = type;
            this.category = category;
            this.occurrenceId = occurrenceId;
            this.dateKey = dateKey;
            this.route = route;
        }

        /** Defensive read of the FCM data map — never throws, never fabricates. */
        public static Payload from(java.util.Map<String, String> data) {
            if (data == null) return new Payload("", "general", "", "", "#/dashboard");
            return new Payload(
                    orEmpty(data.get("type")),
                    orEmpty(data.get("category")),
                    orEmpty(data.get("occurrenceId")),
                    orEmpty(data.get("dateKey")),
                    orEmpty(data.get("route")));
        }

        private static String orEmpty(String v) { return v == null ? "" : v; }
    }
}
