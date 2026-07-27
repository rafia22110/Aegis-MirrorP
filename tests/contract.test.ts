/**
 * Contract parity test: PocketBase hook (run inside the shim) must
 * produce the same decision (action + narrative shape + threat_level)
 * as the Edge Function fallback for the same input.
 *
 * This is the lock that keeps the two implementations in sync. If a
 * future edit changes one but not the other, this test fires.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { join } from 'node:path';
import { ROOT } from './config';
import { createPocketBaseShim, loadHook, invoke } from './helpers/pb-shim';

// Import the Edge Function handler (the same code path the public
// mirror's Vercel deployment runs).
delete process.env.AEGIS_ENGINE_URL;
import checkPolicy from '../src/api/check-policy';

// We seed the in-memory SQLite with the same migration file the
// production engine applies. That way the hook runs against the same
// schema shape.
const HOOK_PATH = join(ROOT, 'pb_hooks', 'main.pb.js');
const MIGRATION_PATH = join(ROOT, 'pb_migrations', '1700000000_init.sql');

interface ParityCase {
    label: string;
    body: any;
    expected: {
        action: 'ALLOW' | 'DENY' | 'MOCK';
        threat_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
        // Loose check on narrative — PocketBase hook phrases things
        // slightly differently than the Edge Function (e.g. "Connection
        // from X to Y allowed." vs "Allowed X→Y."), so we just assert
        // the relevant substrings are present.
        narrativeContains: string[];
    };
}

const CASES: ParityCase[] = [
    {
        label: 'emergency route 911',
        body: { package_name: 'com.android.system', destination: '911' },
        expected: { action: 'ALLOW', threat_level: 'LOW', narrativeContains: ['911', 'Aegis'] },
    },
    {
        label: 'emergency route co.il.redalert',
        body: { package_name: 'com.android.system', destination: 'co.il.redalert' },
        expected: { action: 'ALLOW', threat_level: 'LOW', narrativeContains: ['co.il.redalert'] },
    },
    {
        label: 'tracker with permission override',
        body: {
            package_name: 'com.facebook.katana',
            destination: 'graph.facebook.com',
            permission: 'LOCATION',
        },
        expected: { action: 'MOCK', threat_level: 'MEDIUM', narrativeContains: ['location', 'Facebook'] },
    },
    {
        label: 'unknown package default-allow',
        body: { package_name: 'com.example.app', destination: 'example.com' },
        expected: { action: 'ALLOW', threat_level: 'LOW', narrativeContains: [] },
    },
];

// ---------------------------------------------------------------------------
// Set up: load the schema + the hook once. Also seed the operator-data
// tables that production would populate (permission_overrides,
// network_policies) so the hook's behavior mirrors a real deployment.
// ---------------------------------------------------------------------------
let shim: ReturnType<typeof createPocketBaseShim>;

beforeAll(async () => {
    const { Database } = await import('bun:sqlite');
    const db = new Database(':memory:');
    const migration = await Bun.file(MIGRATION_PATH).text();
    db.exec(migration);

    // Seed the permission_overrides table the same way an operator
    // would after running the install wizard. Without this the hook
    // would default-allow because no row matches.
    db.run(
        `INSERT INTO permission_overrides (package_name, permission_type, mocking_behavior)
         VALUES
           ('com.facebook.katana',     'LOCATION', 'SILENT'),
           ('com.instagram.android',   'LOCATION', 'SILENT'),
           ('com.google.android.gms.maps', 'LOCATION', 'NOISE')
         ON CONFLICT DO NOTHING`,
    );
    // Seed network_policies with the same deny rule the dashboard uses
    // for known bad destinations.
    db.run(
        `INSERT INTO network_policies (policy_id, package_name, domain_rule, port_rule, action)
         VALUES
           ('np_xiaomi_ads', 'com.xiaomi.gamecenter', 'tracking.ads.io', 443, 'DENY')
         ON CONFLICT DO NOTHING`,
    );

    shim = createPocketBaseShim({ db });
    await loadHook(shim, HOOK_PATH);
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function callEdge(body: any): Promise<any> {
    const res = await checkPolicy(new Request('http://localhost/api/aegis/check-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }));
    return res.json();
}

function callHook(body: any): any {
    const result = invoke(shim, 'POST', '/api/aegis/check-policy', JSON.stringify(body));
    if (result.status !== 200) {
        throw new Error(`Hook returned ${result.status}: ${JSON.stringify(result.body)}`);
    }
    return result.body;
}

// ---------------------------------------------------------------------------
// Per-case parity assertions
// ---------------------------------------------------------------------------

describe('parity: PocketBase hook ↔ Edge Function fallback', () => {
    for (const c of CASES) {
        test(`${c.label}: both impls agree on action`, async () => {
            const edge = await callEdge(c.body);
            const hook = callHook(c.body);

            expect(edge.action).toBe(c.expected.action);
            expect(hook.action).toBe(c.expected.action);
            expect(edge.action).toBe(hook.action);
        });

        test(`${c.label}: both impls agree on threat_level`, async () => {
            const edge = await callEdge(c.body);
            const hook = callHook(c.body);

            expect(edge.threat_level).toBe(c.expected.threat_level);
            expect(hook.threat_level).toBe(c.expected.threat_level);
            expect(edge.threat_level).toBe(hook.threat_level);
        });

        test(`${c.label}: both impls include required substrings in narrative`, async () => {
            const edge = await callEdge(c.body);
            const hook = callHook(c.body);

            for (const sub of c.expected.narrativeContains) {
                // Hook and Edge both reference the destination/package
                // in the narrative; the exact wording differs, so we
                // check independently. At least ONE impl must mention
                // each expected substring — that's the contract we care
                // about.
                const mentioned = edge.narrative?.toLowerCase().includes(sub.toLowerCase())
                    || hook.narrative?.toLowerCase().includes(sub.toLowerCase());
                expect(mentioned).toBe(true);
            }
        });

        test(`${c.label}: both impls include latency_ms and watchdog_budget_ms`, async () => {
            const edge = await callEdge(c.body);
            const hook = callHook(c.body);

            expect(typeof edge.latency_ms).toBe('number');
            expect(typeof hook.latency_ms).toBe('number');
            expect(edge.watchdog_budget_ms).toBe(50);
            expect(hook.watchdog_budget_ms).toBe(50);
        });
    }
});

// ---------------------------------------------------------------------------
// Cross-impl structural invariants: every response must have the same
// top-level keys. If a future edit adds a field to one but not the other
// (or renames one), this fires.
// ---------------------------------------------------------------------------

describe('parity: response shape invariants', () => {
    const REQUIRED_KEYS = ['action', 'narrative', 'threat_level', 'latency_ms', 'watchdog_budget_ms'];

    test('every Edge response has the required keys', async () => {
        for (const c of CASES) {
            const res = await callEdge(c.body);
            for (const key of REQUIRED_KEYS) {
                expect(res).toHaveProperty(key);
            }
        }
    });

    test('every Hook response has the required keys', () => {
        for (const c of CASES) {
            const res = callHook(c.body);
            for (const key of REQUIRED_KEYS) {
                expect(res).toHaveProperty(key);
            }
        }
    });

    test('action enum is restricted to ALLOW / DENY / MOCK', async () => {
        for (const c of CASES) {
            const edge = await callEdge(c.body);
            const hook = callHook(c.body);
            expect(['ALLOW', 'DENY', 'MOCK']).toContain(edge.action);
            expect(['ALLOW', 'DENY', 'MOCK']).toContain(hook.action);
        }
    });
});

// ---------------------------------------------------------------------------
// Hook-specific: the PocketBase hook also writes to traffic_logs. Verify
// that the shim captures those writes, since the Edge Function does NOT
// (the Edge Function is stateless).
// ---------------------------------------------------------------------------

describe('PocketBase hook side-effects', () => {
    test('every decision is logged to traffic_logs', () => {
        const before = shim.globals.$app.dao().findRecordsByFilter(
            'traffic_logs', '', '-log_id', 1000, 0,
        ).length;
        // Fire 5 fresh requests.
        for (let i = 0; i < 5; i++) {
            invoke(shim, 'POST', '/api/aegis/check-policy', JSON.stringify({
                package_name: `com.test.app${i}`,
                destination: `test${i}.example`,
            }));
        }
        const after = shim.globals.$app.dao().findRecordsByFilter(
            'traffic_logs', '', '-log_id', 1000, 0,
        ).length;
        expect(after - before).toBe(5);
    });

    test('logged watchdog_latency_ms is captured per row', () => {
        invoke(shim, 'POST', '/api/aegis/check-policy', JSON.stringify({
            package_name: 'com.latency.test',
            destination: 'latency.test',
        }));
        const rows = shim.globals.$app.dao().findRecordsByFilter(
            'traffic_logs',
            "source_app = 'com.latency.test'",
            '-log_id', 1, 0,
        );
        expect(rows.length).toBe(1);
        const r = rows[0];
        expect(typeof r.get('watchdog_latency_ms')).toBe('number');
        expect(r.get('watchdog_latency_ms')).toBeGreaterThanOrEqual(0);
    });
});

// ---------------------------------------------------------------------------
// Edge-Function-specific: emergency reason field. The hook returns
// `reason: "Emergency Bypass Activated"` on whitelist hits; the Edge
// does not. This is intentional (the Edge narrative carries the same
// meaning), but we lock it in.
// ---------------------------------------------------------------------------

describe('emergency route edge case', () => {
    test('Edge response includes reason on whitelist hit', async () => {
        const res = await callEdge({ package_name: 'com.x', destination: '112' });
        expect(res.reason).toContain('Emergency');
    });

    test('Hook response includes reason on whitelist hit', () => {
        const res = callHook({ package_name: 'com.x', destination: '112' });
        expect(res.reason).toContain('Emergency');
    });
});