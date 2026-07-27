-- =====================================================================
-- AEGIS MIRROR — PocketBase Migration #1: Initial Schema
-- =====================================================================
-- PocketBase reads migrations from pb_migrations/<timestamp>_name.sql in
-- lexicographic order. Filename is unix epoch seconds — picked so it
-- sorts AFTER any migrations PocketBase creates for its built-in
-- collections (users, settings, etc., which use timestamps in the
-- 1600000000 range).
--
-- This migration creates all 15 application tables + indexes + seed
-- data. It is byte-for-byte equivalent to src/database/schema.sql, but
-- uses PocketBase's preferred migration semantics (IF NOT EXISTS for
-- safety, explicit transaction wrapper).
--
-- Companion source-of-truth file: src/database/schema.sql. Both files
-- must stay in sync; tests/schema.test.ts asserts against the canonical
-- source while this file is what the engine actually applies.
-- =====================================================================

-- PocketBase migrations run inside an implicit transaction; we don't
-- open one ourselves. PRAGMA statements inside a transaction are a
-- no-op in SQLite, so we move them to a separate migration in
-- pb_migrations/1700000001_pragmas.sql below.

-- =====================================================================
-- LAYER 1: STATE & REGISTRY
-- =====================================================================

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    hashed_password TEXT NOT NULL,
    trust_score REAL NOT NULL DEFAULT 1.0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS active_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    profile_type TEXT NOT NULL CHECK(profile_type IN ('Paranoid', 'Emergency', 'Standard', 'Social Diet', 'Custom')) DEFAULT 'Standard',
    custom_rules_json TEXT,
    siren_triggers_enabled INTEGER NOT NULL DEFAULT 1,
    activated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_registry (
    package_name TEXT PRIMARY KEY,
    app_name TEXT NOT NULL,
    signature_hash TEXT NOT NULL,
    is_trusted INTEGER NOT NULL DEFAULT 0,
    first_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS permission_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_name TEXT NOT NULL,
    permission_type TEXT NOT NULL CHECK(permission_type IN ('CAMERA', 'MICROPHONE', 'CONTACTS', 'LOCATION', 'STORAGE', 'SMS', 'PHONE')),
    mocking_behavior TEXT NOT NULL CHECK(mocking_behavior IN ('SILENT', 'NOISE', 'RANDOM', 'STATIC')) DEFAULT 'SILENT',
    FOREIGN KEY(package_name) REFERENCES app_registry(package_name) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_overrides_unique
    ON permission_overrides(package_name, permission_type);

CREATE TABLE IF NOT EXISTS emergency_whitelist (
    rule_id TEXT PRIMARY KEY,
    target_pattern TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS mock_contacts (
    contact_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    email TEXT,
    organization TEXT
);

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

CREATE TABLE IF NOT EXISTS traffic_logs (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source_app TEXT NOT NULL,
    target_destination TEXT NOT NULL,
    security_narrative TEXT NOT NULL,
    action_taken TEXT NOT NULL CHECK(action_taken IN ('ALLOW', 'DENY', 'MOCK')),
    threat_level TEXT NOT NULL DEFAULT 'LOW' CHECK(threat_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    -- watchdog_latency_ms is the engine's measured processing latency
    -- for this single decision. Surfaced in the Live Defense Feed so
    -- the user can see when the engine is operating close to the 50ms
    -- fail-open ceiling.
    watchdog_latency_ms REAL NOT NULL DEFAULT 0.0
);
CREATE INDEX IF NOT EXISTS idx_traffic_logs_recent
    ON traffic_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_traffic_logs_source
    ON traffic_logs(source_app);

CREATE TABLE IF NOT EXISTS vps_sync_state (
    sync_id TEXT PRIMARY KEY,
    last_sync_time DATETIME,
    sync_checksum TEXT,
    pending_records_count INTEGER NOT NULL DEFAULT 0,
    sync_mode TEXT NOT NULL DEFAULT 'PASSIVE' CHECK(sync_mode IN ('PASSIVE', 'ACTIVE', 'EMERGENCY_PUSH'))
);

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

INSERT OR IGNORE INTO emergency_whitelist (rule_id, target_pattern, description) VALUES
    ('em_1', 'gov.alert',        'National Emergency Alert System'),
    ('em_2', 'co.il.redalert',   'Rocket and Missile Defense Siren System'),
    ('em_3', '112',              'Universal Emergency Services'),
    ('em_4', '911',              'Emergency Services Bypass');

INSERT OR IGNORE INTO vps_sync_state (sync_id, last_sync_time, sync_checksum, pending_records_count, sync_mode) VALUES
    ('default', NULL, NULL, 0, 'PASSIVE');

INSERT OR IGNORE INTO sandbox_state (wasm_engine_status, active_restrictions_count, watchdog_latency_ms)
    SELECT 'INITIALIZING', 0, 0.0
    WHERE NOT EXISTS (SELECT 1 FROM sandbox_state);

INSERT OR IGNORE INTO mock_locations (location_id, latitude, longitude, offset_bearing, offset_distance_meters) VALUES
    ('loc_jerusalem', 31.7683, 35.2137, 45.0, 250.0),
    ('loc_london',    51.5074, -0.1278, 180.0, 400.0),
    ('loc_tokyo',     35.6762, 139.6503, 270.0, 350.0);

INSERT OR IGNORE INTO mock_contacts (contact_id, display_name, phone_number, email, organization) VALUES
    ('con_001', 'Alex Reed',  '+1-555-0100', 'alex.reed@example.test',  'Example Corp'),
    ('con_002', 'Sam Carter', '+1-555-0101', 'sam.carter@example.test', 'Example Corp'),
    ('con_003', 'Jordan Lee', '+1-555-0102', 'jordan.lee@example.test', 'Example Corp');