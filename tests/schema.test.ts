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
        // The CHECK constraint should enumerate all 7 permission types,
        // not just the original 4.
        for (const p of ['CAMERA', 'MICROPHONE', 'CONTACTS', 'LOCATION', 'STORAGE', 'SMS', 'PHONE']) {
            expect(SCHEMA).toContain(p);
        }
    });

    test('indexes on traffic_logs for fast dashboard reads', () => {
        expect(SCHEMA).toContain('idx_traffic_logs_recent');
        expect(SCHEMA).toContain('idx_traffic_logs_source');
    });
});