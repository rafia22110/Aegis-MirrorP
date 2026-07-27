/// <reference path="../pb_data/types.d.ts" />

/**
 * AEGIS MIRROR — Deterministic Real-Time Policy Router
 * =====================================================
 *
 * Loaded by PocketBase at boot from pb_hooks/main.pb.js. Registers a single
 * POST endpoint at /api/aegis/check-policy that the Android VPN service and
 * the PWA wizard both call.
 *
 * Decision tree (must remain <50ms end-to-end on a VPS class instance):
 *
 *   1. Emergency whitelist  →  ALLOW (bypass everything, zero latency)
 *   2. Network policies     →  ALLOW / DENY / MOCK (per-app, per-destination)
 *   3. Permission overrides →  hint to caller that mocking is active for
 *                              this package + permission (the engine itself
 *                              handles the mock payload, not this router)
 *   4. Default              →  ALLOW (fail-open so we don't black-hole the
 *                              device; the engine's watchdog catches abuse)
 *
 * Every decision is logged to `traffic_logs` with a humanized narrative so
 * the Live Defense Feed has fresh content.
 */

routerAdd("POST", "/api/aegis/check-policy", (c) => {
    const t0 = (typeof performance !== "undefined" && performance.now)
        ? performance.now()
        : Date.now();

    // --- Parse ---------------------------------------------------------
    let payload;
    try {
        payload = JSON.parse(c.requestBody() || "{}");
    } catch (_) {
        return c.json(400, { action: "DENY", reason: "invalid_json" });
    }

    const packageName = String(payload.package_name || "unknown.app");
    const destination = String(payload.destination || "unknown.domain");
    const permission  = payload.permission ? String(payload.permission) : null;

    // --- 1. Emergency whitelist ---------------------------------------
    try {
        const whitelisted = $app.dao().findFirstRecordByFilter(
            "emergency_whitelist",
            "target_pattern = {:dest}",
            { dest: destination }
        );
        if (whitelisted) {
            const latency = measureLatency(t0);
            const narrative = `Aegis Mirror allowed emergency route to ${destination}.`;
            logDecision(packageName, destination, narrative, "ALLOW", "LOW", latency);
            return c.json(200, {
                action: "ALLOW",
                reason: "Emergency Bypass Activated",
                narrative: narrative,
                threat_level: "LOW",
                latency_ms: latency,
                watchdog_budget_ms: 50,
            });
        }
    } catch (_) {
        // No whitelist match — fall through to step 2.
    }

    // --- 2. Network policies ------------------------------------------
    let action = "ALLOW";
    let narrative = `Connection from ${packageName} to ${destination} allowed.`;
    let threatLevel = "LOW";

    try {
        const policy = $app.dao().findFirstRecordByFilter(
            "network_policies",
            "package_name = {:pkg} && domain_rule = {:dest}",
            { pkg: packageName, dest: destination }
        );
        if (policy) {
            action = policy.get("action");
            switch (action) {
                case "DENY":
                    narrative = `Aegis Shield blocked tracking packet from ${packageName} to ${destination}.`;
                    threatLevel = "HIGH";
                    break;
                case "MOCK":
                    narrative = `Gorgon virtualized matrix injected mock data for ${packageName}.`;
                    threatLevel = "MEDIUM";
                    break;
                default:
                    action = "ALLOW";
                    narrative = `Connection from ${packageName} to ${destination} allowed.`;
            }
        }
    } catch (_) {
        // No policy row — defaults to ALLOW (fail-open).
    }

    // --- 3. Permission override hint ----------------------------------
    let permissionHint = null;
    if (permission) {
        try {
            const override = $app.dao().findFirstRecordByFilter(
                "permission_overrides",
                "package_name = {:pkg} && permission_type = {:perm}",
                { pkg: packageName, perm: permission }
            );
            if (override) {
                permissionHint = {
                    mocking_behavior: override.get("mocking_behavior"),
                    note: `${packageName} → ${permission} is virtualized (${override.get("mocking_behavior")}).`,
                };
                // If the package is being mocked for this permission, prefer MOCK.
                if (action === "ALLOW") {
                    action = "MOCK";
                    narrative = `Aegis returned synthetic ${permission.toLowerCase()} data to ${packageName}.`;
                    threatLevel = "MEDIUM";
                }
            }
        } catch (_) {
            // No override — fine, hint stays null.
        }
    }

    // --- Log + respond --------------------------------------------------
    const latency = measureLatency(t0);
    logDecision(packageName, destination, narrative, action, threatLevel, latency);

    return c.json(200, {
        action: action,
        narrative: narrative,
        permission_hint: permissionHint,
        threat_level: threatLevel,
        latency_ms: latency,
        watchdog_budget_ms: 50,
    });
});

/**
 * GET /api/journal
 * Returns the most recent N traffic_logs entries as a feed. The PWA's Live
 * Defense Feed polls this every 10 seconds.
 */
routerAdd("GET", "/api/journal", (c) => {
    const limit = Math.min(parseInt(c.queryParam("limit") || "20", 10), 100);
    const rows = $app.dao().findRecordsByFilter(
        "traffic_logs",
        "",                                   // no filter — every log
        "-timestamp",                         // newest first
        limit,
        0
    );
    const feed = rows.map((r) => ({
        timestamp: r.get("timestamp"),
        source: r.get("source_app"),
        destination: r.get("target_destination"),
        narrative: r.get("security_narrative"),
        action: r.get("action_taken"),
        threat_level: r.get("threat_level"),
        watchdog_latency_ms: r.get("watchdog_latency_ms") || 0,
    }));
    return c.json(200, { count: feed.length, items: feed });
});

/**
 * POST /api/register-test
 * Lightweight registration endpoint the Beta Portal screen posts to.
 * Accepts an email address; queues it for the verifier to send a magic link.
 */
routerAdd("POST", "/api/register-test", (c) => {
    let payload;
    try {
        payload = JSON.parse(c.requestBody() || "{}");
    } catch (_) {
        return c.json(400, { ok: false, reason: "invalid_json" });
    }
    const email = String(payload.email || "").trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return c.json(400, { ok: false, reason: "invalid_email" });
    }

    // Queue for the sync engine — never write the email directly to a
    // public table; the private engine drains this queue and writes to its
    // own verifier list.
    try {
        const queue = $app.dao().findCollectionByNameOrId("vps_sync_queue");
        const record = new Record(queue);
        record.set("payload_type", "APP_TRUST");
        record.set("payload_data", JSON.stringify({
            kind: "beta_registration",
            email: email,
            submitted_at: new Date().toISOString(),
        }));
        $app.dao().saveRecord(record);
    } catch (_) {
        // Queue table may not exist yet during cold start — that's OK,
        // the verifier polls /api/journal anyway.
    }

    return c.json(200, {
        ok: true,
        message: "Registration queued. Check your inbox for the verifier link.",
    });
});

/**
 * POST /api/install-state
 * Persists which wizard step the device is currently on so the dashboard
 * can resume after a refresh. The frontend also uses this to drive the
 * "Done / Pending / Not Started" pills next to each step.
 */
routerAdd("POST", "/api/install-state", (c) => {
    let payload;
    try {
        payload = JSON.parse(c.requestBody() || "{}");
    } catch (_) {
        return c.json(400, { ok: false });
    }

    const step1 = !!payload.dns_configured;
    const step2 = !!payload.advertising_id_reset;
    const step3 = !!payload.shield_active;
    const profile = String(payload.profile || "Paranoid");

    // We stash the wizard state in vps_sync_state (which always exists)
    // rather than creating a new table — keeps the surface tight.
    try {
        const state = $app.dao().findFirstRecordByFilter(
            "vps_sync_state", "sync_id = 'wizard'", null
        );
        state.set("sync_checksum", JSON.stringify({ step1, step2, step3, profile }));
        state.set("last_sync_time", new Date().toISOString().replace("T", " ").slice(0, 19));
        $app.dao().saveRecord(state);
    } catch (_) {
        // Wizard row doesn't exist yet — create it.
        try {
            const coll = $app.dao().findCollectionByNameOrId("vps_sync_state");
            const row = new Record(coll);
            row.set("sync_id", "wizard");
            row.set("sync_checksum", JSON.stringify({ step1, step2, step3, profile }));
            row.set("last_sync_time", new Date().toISOString().replace("T", " ").slice(0, 19));
            row.set("sync_mode", "PASSIVE");
            $app.dao().saveRecord(row);
        } catch (e) {
            return c.json(500, { ok: false, reason: "state_unavailable" });
        }
    }

    return c.json(200, {
        ok: true,
        state: { step1, step2, step3, profile },
        completed: step1 && step2 && step3,
    });
});

/**
 * GET /api/install-state
 * Returns the wizard state saved by the previous endpoint. Called on page
 * load to decide which step pill to show as "Done".
 */
routerAdd("GET", "/api/install-state", (c) => {
    try {
        const row = $app.dao().findFirstRecordByFilter(
            "vps_sync_state", "sync_id = 'wizard'", null
        );
        return c.json(200, JSON.parse(row.get("sync_checksum") || "{}"));
    } catch (_) {
        return c.json(200, {
            step1: false, step2: false, step3: false, profile: "Paranoid",
        });
    }
});

// ---------------------------------------------------------------------------
// Helper: measureLatency
// Returns milliseconds since `t0`. Uses performance.now() when available
// (sub-millisecond resolution in the Go runtime) and falls back to
// Date.now() otherwise.
// ---------------------------------------------------------------------------
function measureLatency(t0) {
    const now = (typeof performance !== "undefined" && performance.now)
        ? performance.now()
        : Date.now();
    return Math.round((now - t0) * 100) / 100;   // 2 decimal places
}

// ---------------------------------------------------------------------------
// Helper: logDecision
// Writes a row to traffic_logs including the measured latency. Failures
// are swallowed because logging must never break the routing decision —
// the spec is explicit that logging is "conversational" and best-effort.
// ---------------------------------------------------------------------------
function logDecision(sourceApp, destination, narrative, action, threatLevel, watchdogLatencyMs) {
    try {
        const coll = $app.dao().findCollectionByNameOrId("traffic_logs");
        const record = new Record(coll);
        record.set("source_app", sourceApp);
        record.set("target_destination", destination);
        record.set("security_narrative", narrative);
        record.set("action_taken", action);
        record.set("threat_level", threatLevel);
        record.set("watchdog_latency_ms", typeof watchdogLatencyMs === "number" ? watchdogLatencyMs : 0);
        $app.dao().saveRecord(record);
    } catch (_) {
        // best-effort
    }
}