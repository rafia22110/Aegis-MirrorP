-- =====================================================================
-- AEGIS MIRROR — EMBEDDED COGNITIVE DATA LAYER (ON-DEVICE SQLITE-VEC)
-- =====================================================================
-- This schema is the local source of truth for the Aegis MirrorP public
-- mirror's on-device engine. It is loaded into PocketBase at first boot
-- and is the substrate for the deterministic policy router in
-- pb_hooks/main.pb.js.
--
-- 15 tables, grouped into 4 layers:
--   1. STATE & REGISTRY      (users, active_profile, app_registry, sandbox_state)
--   2. DYNAMIC POLICIES      (network_policies, permission_overrides,
--                             emergency_whitelist, custom_user_rules)
--   3. VIRTUALIZATION        (generated_aliases, mock_contacts, mock_locations)
--   4. OBSERVABILITY         (traffic_logs, vps_sync_state, vps_sync_queue,
--                             system_health)
--
-- PRAGMA notes:
--   * foreign_keys = ON       so app_registry ↔ network_policies / permission_overrides
--                              joins actually enforce referential integrity
--   * journal_mode = WAL      safe for the 50ms write bursts from the policy router
--   * busy_timeout = 5000     lets writes wait rather than SQLITE_BUSY-throwing
-- =====================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

-- =====================================================================
-- LAYER 1: STATE & REGISTRY
-- =====================================================================

-- The single user table. Aegis MirrorP is single-tenant by design —
-- a device has one operator. hashed_password is argon2id with a per-user
-- salt; trust_score is the rolling engine-trust metric (0.0–1.0).
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    hashed_password TEXT NOT NULL,
    trust_score REAL NOT NULL DEFAULT 1.0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The currently active protection profile. The wizard's 3-step installation
-- moves the device through Paranoid (default after first install) →
-- Standard (after 24h stable use) → Social Diet / Custom on user request.
CREATE TABLE IF NOT EXISTS active_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    profile_type TEXT NOT NULL CHECK(profile_type IN ('Paranoid', 'Emergency', 'Standard', 'Social Diet', 'Custom')) DEFAULT 'Standard',
    custom_rules_json TEXT,
    siren_triggers_enabled INTEGER NOT NULL DEFAULT 1,
    activated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Registry of every application installed on the device that Aegis has
-- ever observed. signature_hash is the SHA-256 of the APK signing
-- certificate; is_trusted is set by the install-wizard "Verified Apps"
-- pass during step 3.
CREATE TABLE IF NOT EXISTS app_registry (
    package_name TEXT PRIMARY KEY,
    app_name TEXT NOT NULL,
    signature_hash TEXT NOT NULL,
    is_trusted INTEGER NOT NULL DEFAULT 0,
    first_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Live state of the on-device WASM virtualization sandbox. The watchdog
-- in MirrorVpnService writes watchdog_latency_ms every 500ms; the
-- dashboard reads it for the "Gorgon Matrix Active" indicator.
CREATE TABLE IF NOT EXISTS sandbox_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wasm_engine_status TEXT NOT NULL CHECK(wasm_engine_status IN ('INITIALIZING', 'ACTIVE', 'THROTTLED', 'FROZEN', 'OFFLINE')) DEFAULT 'INITIALIZING',
    active_restrictions_count INTEGER NOT NULL DEFAULT 0,
    watchdog_latency_ms REAL NOT NULL DEFAULT 0.0,
    last_heartbeat DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================================
-- LAYER 2: DYNAMIC POLICIES
-- =====================================================================

-- Per-app, per-destination routing decisions. The policy router queries
-- this with `(package_name, domain_rule)` and gets back ALLOW / DENY /
-- MOCK in <1ms. The combination of step-3 VPN + this table is what
-- actually virtualizes traffic.
CREATE TABLE IF NOT EXISTS network_policies (
    policy_id TEXT PRIMARY KEY,
    package_name TEXT NOT NULL,
    domain_rule TEXT NOT NULL,
    port_rule INTEGER NOT NULL DEFAULT 0,
    action TEXT NOT NULL CHECK(action IN ('ALLOW', 'DENY', 'MOCK')) DEFAULT 'ALLOW',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(package_name) REFERENCES app_registry(package_name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_network_policies_lookup
    ON network_policies(package_name, domain_rule);

-- Per-app, per-permission mocking behavior. When the app asks for
-- CAMERA and the action is MOCK, the engine injects a synthetic video
-- frame; SILENT returns nothing (no error, no data); NOISE returns a
-- flat tone; RANDOM returns a deterministic-per-session fake value.
CREATE TABLE IF NOT EXISTS permission_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_name TEXT NOT NULL,
    permission_type TEXT NOT NULL CHECK(permission_type IN ('CAMERA', 'MICROPHONE', 'CONTACTS', 'LOCATION', 'STORAGE', 'SMS', 'PHONE')),
    mocking_behavior TEXT NOT NULL CHECK(mocking_behavior IN ('SILENT', 'NOISE', 'RANDOM', 'STATIC')) DEFAULT 'SILENT',
    FOREIGN KEY(package_name) REFERENCES app_registry(package_name) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_overrides_unique
    ON permission_overrides(package_name, permission_type);

-- Zero-latency bypass for emergencies. The router checks this BEFORE
-- anything else; a match returns ALLOW immediately so the user can call
-- 911 / rocket-alert endpoints even when the engine is in Paranoid mode.
-- Seed data below includes the four patterns the spec calls out.
CREATE TABLE IF NOT EXISTS emergency_whitelist (
    rule_id TEXT PRIMARY KEY,
    target_pattern TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- User-authored regex rules. The Custom profile type loads these into
-- the router's evaluation loop alongside the seeded network_policies.
CREATE TABLE IF NOT EXISTS custom_user_rules (
    rule_id TEXT PRIMARY KEY,
    rule_name TEXT NOT NULL,
    regex_pattern TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('ALLOW', 'DENY', 'MOCK')) DEFAULT 'ALLOW',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================================
-- LAYER 3: VIRTUALIZATION & IDENTITY MASKING
-- =====================================================================

-- Generated substitute identities. Step-3 creates the EMAIL entry for
-- the active user; PHONE / NAME entries are created on first request
-- from a sandboxed app. generated_value is the deterministic per-user
-- synthetic — re-derived from a seed so the same user always gets the
-- same alias.
CREATE TABLE IF NOT EXISTS generated_aliases (
    alias_id TEXT PRIMARY KEY,
    real_identity_id TEXT NOT NULL,
    alias_type TEXT NOT NULL CHECK(alias_type IN ('EMAIL', 'PHONE', 'NAME')),
    generated_value TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(real_identity_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_aliases_unique
    ON generated_aliases(real_identity_id, alias_type);

-- Mock contacts returned to sandboxed apps that ask for the address
-- book. phone_number / email / organization are deterministic fakes
-- seeded from the user's trust_score + alias_id so cross-app
-- correlation doesn't link identities.
CREATE TABLE IF NOT EXISTS mock_contacts (
    contact_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    email TEXT,
    organization TEXT
);

-- Mock GPS coordinates returned to sandboxed apps that ask for
-- location. offset_bearing + offset_distance_meters are picked per
-- query so successive "where am I" calls don't triangulate to a real
-- device.
CREATE TABLE IF NOT EXISTS mock_locations (
    location_id TEXT PRIMARY KEY,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    offset_bearing REAL NOT NULL DEFAULT 0.0,
    offset_distance_meters REAL NOT NULL DEFAULT 0.0
);

-- =====================================================================
-- LAYER 4: OBSERVABILITY & MANAGEMENT
-- =====================================================================

-- Append-only audit log of every packet the router decided on.
-- security_narrative is the humanized sentence the Live Defense Feed
-- shows ("Aegis safely deflected a background beacon" etc.).
-- The router writes here on every decision, then returns to caller.
CREATE TABLE IF NOT EXISTS traffic_logs (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source_app TEXT NOT NULL,
    target_destination TEXT NOT NULL,
    security_narrative TEXT NOT NULL,
    action_taken TEXT NOT NULL CHECK(action_taken IN ('ALLOW', 'DENY', 'MOCK')),
    threat_level TEXT NOT NULL DEFAULT 'LOW' CHECK(threat_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'))
);
CREATE INDEX IF NOT EXISTS idx_traffic_logs_recent
    ON traffic_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_traffic_logs_source
    ON traffic_logs(source_app);

-- One-row table for the VPS sync engine state. The deploy workflow
-- writes here when the private engine pushes a state update; the
-- public mirror's API reads it to know the last-known-good engine
-- state.
CREATE TABLE IF NOT EXISTS vps_sync_state (
    sync_id TEXT PRIMARY KEY,
    last_sync_time DATETIME,
    sync_checksum TEXT,
    pending_records_count INTEGER NOT NULL DEFAULT 0,
    sync_mode TEXT NOT NULL DEFAULT 'PASSIVE' CHECK(sync_mode IN ('PASSIVE', 'ACTIVE', 'EMERGENCY_PUSH'))
);

-- Outbox of pending records to flush to the VPS at next sync. Used
-- when the device is offline during a state change.
CREATE TABLE IF NOT EXISTS vps_sync_queue (
    queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload_type TEXT NOT NULL CHECK(payload_type IN ('TRAFFIC_LOG', 'PROFILE_CHANGE', 'APP_TRUST', 'EMERGENCY_TRIGGER')),
    payload_data TEXT NOT NULL,
    queued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_vps_sync_queue_pending
    ON vps_sync_queue(queued_at);

-- One row per heartbeat from the engine. Sampled at 1Hz from
-- MirrorVpnService. The dashboard's "system vitals" card reads the
-- most recent row.
CREATE TABLE IF NOT EXISTS system_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cpu_usage_pct REAL,
    ram_usage_mb REAL,
    network_rx_bytes INTEGER,
    network_tx_bytes INTEGER,
    sampled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_system_health_recent
    ON system_health(sampled_at DESC);

-- =====================================================================
-- SEED DATA
-- =====================================================================

-- Pre-seed the four emergency routes called out in the spec.
-- These are checked BEFORE any other policy and ALWAYS allow.
INSERT OR IGNORE INTO emergency_whitelist (rule_id, target_pattern, description) VALUES
    ('em_1', 'gov.alert',        'National Emergency Alert System'),
    ('em_2', 'co.il.redalert',   'Rocket and Missile Defense Siren System'),
    ('em_3', '112',              'Universal Emergency Services'),
    ('em_4', '911',              'Emergency Services Bypass');

-- Seed the vps_sync_state with a single "never synced" row so the
-- engine knows where to start.
INSERT OR IGNORE INTO vps_sync_state (sync_id, last_sync_time, sync_checksum, pending_records_count, sync_mode) VALUES
    ('default', NULL, NULL, 0, 'PASSIVE');

-- Seed sandbox_state with one INITIALIZING row. MirrorVpnService flips
-- this to ACTIVE on first successful packet loopback.
INSERT OR IGNORE INTO sandbox_state (wasm_engine_status, active_restrictions_count, watchdog_latency_ms)
    SELECT 'INITIALIZING', 0, 0.0
    WHERE NOT EXISTS (SELECT 1 FROM sandbox_state);

-- Seed mock_locations with three plausible default spots (Jerusalem /
-- London / Tokyo) so a freshly-installed device has at least one
-- coordinate to return when the first app asks for location.
INSERT OR IGNORE INTO mock_locations (location_id, latitude, longitude, offset_bearing, offset_distance_meters) VALUES
    ('loc_jerusalem', 31.7683, 35.2137, 45.0, 250.0),
    ('loc_london',    51.5074, -0.1278, 180.0, 400.0),
    ('loc_tokyo',     35.6762, 139.6503, 270.0, 350.0);

-- Seed mock_contacts with three harmless placeholder contacts so the
-- first address-book request returns *something* deterministic rather
-- than the user's real contacts.
INSERT OR IGNORE INTO mock_contacts (contact_id, display_name, phone_number, email, organization) VALUES
    ('con_001', 'Alex Reed',  '+1-555-0100', 'alex.reed@example.test',  'Example Corp'),
    ('con_002', 'Sam Carter', '+1-555-0101', 'sam.carter@example.test', 'Example Corp'),
    ('con_003', 'Jordan Lee', '+1-555-0102', 'jordan.lee@example.test', 'Example Corp');