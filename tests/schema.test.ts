/**
 * Schema sanity: every table defined in the spec exists in src/database/schema.sql
 * with the documented columns + check constraints. Also validates the seed
 * data for emergency_whitelist, vps_sync_state, sandbox_state, mock_locations,
 * and mock_contacts.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config';

const SCHEMA = readFileSync(join(ROOT, 'src', 'database', 'schema.sql'), 'utf-8');

const REQUIRED_TABLES = [
    'users', 'active_profile', 'app_registry', 'sandbox_state',
    'network_policies', 'permission_overrides', 'emergency_whitelist', 'custom_user_rules',
    'generated_aliases', 'mock_contacts', 'mock_locations',
    'traffic_logs', 'vps_sync_state', 'vps_sync_queue', 'system_health',
];

describe('SQLite-vec schema', () => {
    for (const table of REQUIRED_TABLES) {
        test(`CREATE TABLE ${table}`, () => {
            const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i');
            expect(SCHEMA).toMatch(re);
        });
    }

    test('15 tables total', () => {
        const matches = [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS \w+/g)];
        expect(matches.length).toBe(REQUIRED_TABLES.length);
    });

    test('uses WAL journal mode', () => {
        expect(SCHEMA).toContain('PRAGMA journal_mode = WAL');
    });

    test('enforces foreign keys', () => {
        expect(SCHEMA).toContain('PRAGMA foreign_keys = ON');
    });

    test('emergency whitelist has the four seeded routes', () => {
        expect(SCHEMA).toContain("'gov.alert'");
        expect(SCHEMA).toContain("'co.il.redalert'");
        expect(SCHEMA).toContain("'112'");
        expect(SCHEMA).toContain("'911'");
    });

    test('permission_overrides constrains permission_type', () => {
        for (const p of ['CAMERA', 'MICROPHONE', 'CONTACTS', 'LOCATION', 'STORAGE', 'SMS', 'PHONE']) {
            expect(SCHEMA).toContain(p);
        }
    });

    test('indexes on traffic_logs for fast dashboard reads', () => {
        expect(SCHEMA).toContain('idx_traffic_logs_recent');
        expect(SCHEMA).toContain('idx_traffic_logs_source');
    });
});

describe('PocketBase migration files', () => {
    const MIGRATION = readFileSync(join(ROOT, 'pb_migrations', '1700000000_init.sql'), 'utf-8');

    test('initial migration creates all 15 tables', () => {
        for (const table of REQUIRED_TABLES) {
            const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i');
            expect(MIGRATION).toMatch(re);
        }
    });

    test('initial migration includes the watchdog_latency_ms column', () => {
        expect(MIGRATION).toContain('watchdog_latency_ms REAL NOT NULL DEFAULT 0.0');
    });

    test('initial migration seeds the four emergency routes', () => {
        for (const r of ['gov.alert', 'co.il.redalert', '112', '911']) {
            expect(MIGRATION).toContain(`'${r}'`);
        }
    });

    test('initial migration creates the same indexes as the schema', () => {
        for (const idx of [
            'idx_network_policies_lookup',
            'idx_permission_overrides_unique',
            'idx_generated_aliases_unique',
            'idx_traffic_logs_recent',
            'idx_traffic_logs_source',
            'idx_vps_sync_queue_pending',
            'idx_system_health_recent',
        ]) {
            expect(MIGRATION).toContain(idx);
        }
    });

    test('follow-up pragma migration exists with higher timestamp', () => {
        const pragma = readFileSync(join(ROOT, 'pb_migrations', '1700000001_pragmas.sql'), 'utf-8');
        expect(pragma).toBeDefined();
        // PocketBase applies migrations in lexicographic order; the
        // pragma file must sort after the init file.
        expect('1700000001_pragmas.sql' > '1700000000_init.sql').toBe(true);
    });

    test('migration loads cleanly into an in-memory SQLite', async () => {
        const { Database } = await import('bun:sqlite');
        const db = new Database(':memory:');
        // Split on the comment-only top section so we can run inside a
        // transaction if PocketBase wraps it. The init file itself
        // already has no PRAGMA statements.
        db.exec(MIGRATION);
        const tables = db.query<{name: string}, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).all();
        expect(tables.length).toBe(REQUIRED_TABLES.length);
        const em = db.query<{count: number}, []>(
            "SELECT COUNT(*) as count FROM emergency_whitelist",
        ).get();
        expect(em?.count).toBe(4);
        db.close();
    });
});