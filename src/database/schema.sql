-- =====================================================================
-- AEGIS MIRROR: 16-TABLE SQLITE-VEC / POCKETBASE PRODUCTION SCHEMA
-- =====================================================================

-- Table 1: Primary Users
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    hashed_password TEXT NOT NULL,
    trust_score REAL DEFAULT 1.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Table 2: Active User Profile
CREATE TABLE IF NOT EXISTS active_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    profile_type TEXT CHECK(profile_type IN ('Paranoid', 'Emergency', 'Standard', 'Social Diet', 'Custom')) DEFAULT 'Standard',
    custom_rules_json TEXT,
    siren_triggers_enabled INTEGER DEFAULT 1,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Table 3: Installed App Registry
CREATE TABLE IF NOT EXISTS app_registry (
    package_name TEXT PRIMARY KEY,
    app_name TEXT NOT NULL,
    signature_hash TEXT NOT NULL,
    is_trusted INTEGER DEFAULT 0
);

-- Table 4: Local WASM Sandbox State
CREATE TABLE IF NOT EXISTS sandbox_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wasm_engine_status TEXT NOT NULL,
    active_restrictions_count INTEGER DEFAULT 0,
    watchdog_latency_ms REAL DEFAULT 0.0,
    last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Table 5: Dynamic Network Filtering Policies
CREATE TABLE IF NOT EXISTS network_policies (
    policy_id TEXT PRIMARY KEY,
    package_name TEXT NOT NULL,
    domain_rule TEXT NOT NULL,
    port_rule INTEGER DEFAULT 0,
    action TEXT CHECK(action IN ('ALLOW', 'DENY', 'MOCK')) DEFAULT 'ALLOW',
    FOREIGN KEY(package_name) REFERENCES app_registry(package_name)
);

-- Table 6: Per-App Permission Overrides
CREATE TABLE IF NOT EXISTS permission_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_name TEXT NOT NULL,
    permission_type TEXT NOT NULL,
    mocking_behavior TEXT DEFAULT 'SILENT',
    FOREIGN KEY(package_name) REFERENCES app_registry(package_name)
);

-- Table 7: Emergency System Whitelist
CREATE TABLE IF NOT EXISTS emergency_whitelist (
    rule_id TEXT PRIMARY KEY,
    target_pattern TEXT UNIQUE NOT NULL,
    description TEXT
);

-- Table 8: User Custom Inspection Rules
CREATE TABLE IF NOT EXISTS custom_user_rules (
    rule_id TEXT PRIMARY KEY,
    rule_name TEXT NOT NULL,
    regex_pattern TEXT NOT NULL,
    action TEXT CHECK(action IN ('ALLOW', 'DENY', 'MOCK')) DEFAULT 'ALLOW'
);

-- Table 9: Cryptographic Identity Aliases
CREATE TABLE IF NOT EXISTS generated_aliases (
    alias_id TEXT PRIMARY KEY,
    real_identity_id TEXT NOT NULL,
    alias_type TEXT CHECK(alias_type IN ('EMAIL', 'PHONE', 'NAME')) NOT NULL,
    generated_value TEXT NOT NULL
);

-- Table 10: Mock Contacts Registry
CREATE TABLE IF NOT EXISTS mock_contacts (
    contact_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    email TEXT,
    organization TEXT
);

-- Table 11: Mock Geolocation Matrix
CREATE TABLE IF NOT EXISTS mock_locations (
    location_id TEXT PRIMARY KEY,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    offset_bearing REAL DEFAULT 0.0,
    offset_distance_meters REAL DEFAULT 0.0
);

-- Table 12: Real-time Observability Logs
CREATE TABLE IF NOT EXISTS traffic_logs (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    source_app TEXT NOT NULL,
    target_destination TEXT NOT NULL,
    security_narrative TEXT NOT NULL,
    action_taken TEXT NOT NULL,
    threat_level TEXT DEFAULT 'LOW'
);

-- Table 13: VPS Synchronization State
CREATE TABLE IF NOT EXISTS vps_sync_state (
    sync_id TEXT PRIMARY KEY,
    last_sync_time DATETIME,
    sync_checksum TEXT,
    pending_records_count INTEGER DEFAULT 0,
    sync_mode TEXT DEFAULT 'PASSIVE'
);

-- Table 14: Outbound Sync Queue
CREATE TABLE IF NOT EXISTS vps_sync_queue (
    queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload_type TEXT NOT NULL,
    payload_data TEXT NOT NULL
);

-- Table 15: System Performance Metrics
CREATE TABLE IF NOT EXISTS system_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cpu_usage_pct REAL,
    ram_usage_mb REAL,
    network_rx_bytes INTEGER,
    network_tx_bytes INTEGER
);

-- Table 16: LoRa Wearable Nodes & Encryption Registry
CREATE TABLE IF NOT EXISTS lora_nodes (
    node_id TEXT PRIMARY KEY,
    device_name TEXT NOT NULL,
    device_type TEXT CHECK(device_type IN ('GLASSES', 'WATCH', 'EARBUDS', 'SENSOR', 'CUSTOM')) NOT NULL,
    frequency_mhz REAL DEFAULT 868.0,
    encryption_key_hash TEXT NOT NULL,
    signal_rssi INTEGER DEFAULT 0,
    is_paired INTEGER DEFAULT 1,
    last_telemetry_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed Essential Whitelist Rules
INSERT OR IGNORE INTO emergency_whitelist (rule_id, target_pattern, description) VALUES
('em_1', 'gov.alert', 'National Emergency Alert System'),
('em_2', 'co.il.redalert', 'Rocket and Missile Defense Siren System'),
('em_3', '112', 'Universal Emergency Services'),
('em_4', '911', 'Emergency Services Bypass');
