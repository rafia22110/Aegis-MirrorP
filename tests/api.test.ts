/**
 * API contract tests. We invoke the Edge Functions directly (no Vercel
 * runtime needed) and verify the response shape — including the local
 * fallback when AEGIS_ENGINE_URL is unset (the default in CI).
 */

import { describe, test, expect } from 'bun:test';

// Force the local fallback path by not setting AEGIS_ENGINE_URL.
delete process.env.AEGIS_ENGINE_URL;
delete process.env.AEGIS_INSTALL_STATE;

import checkPolicy from '../src/api/check-policy';
import journal from '../src/api/journal';
import registerTest from '../src/api/register-test';
import installState from '../src/api/install-state';

function req(url: string, init: RequestInit = {}): Request {
    return new Request(`http://localhost${url}`, init);
}

function jsonBody<T>(res: Response): Promise<T> {
    return res.json() as Promise<T>;
}

describe('POST /api/aegis/check-policy', () => {
    test('allows emergency routes regardless of package', async () => {
        const res = await checkPolicy(req('/api/aegis/check-policy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                package_name: 'com.anything',
                destination: '911',
            }),
        }));
        expect(res.status).toBe(200);
        const body = await jsonBody<any>(res);
        expect(body.action).toBe('ALLOW');
        expect(body.reason).toContain('Emergency');
    });

    test('mocks known tracking packages when permission is requested', async () => {
        const res = await checkPolicy(req('/api/aegis/check-policy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                package_name: 'com.facebook.katana',
                destination: 'graph.facebook.com',
                permission: 'LOCATION',
            }),
        }));
        const body = await jsonBody<any>(res);
        expect(body.action).toBe('MOCK');
        expect(body.permission_hint.mocking_behavior).toBe('SILENT');
    });

    test('default-allow for unknown packages', async () => {
        const res = await checkPolicy(req('/api/aegis/check-policy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                package_name: 'com.example',
                destination: 'example.com',
            }),
        }));
        const body = await jsonBody<any>(res);
        expect(body.action).toBe('ALLOW');
        expect(body.threat_level).toBe('LOW');
    });

    test('rejects non-POST', async () => {
        const res = await checkPolicy(req('/api/aegis/check-policy', { method: 'GET' }));
        expect(res.status).toBe(405);
    });

    test('rejects invalid JSON with 400', async () => {
        const res = await checkPolicy(req('/api/aegis/check-policy', {
            method: 'POST',
            body: 'not json',
        }));
        expect(res.status).toBe(400);
    });

    test('every response carries a watchdog_latency_ms budget header', async () => {
        const cases = [
            { package_name: 'com.a', destination: '911' },
            { package_name: 'com.facebook.katana', destination: 'x', permission: 'LOCATION' },
            { package_name: 'com.example', destination: 'example.com' },
        ];
        for (const body of cases) {
            const res = await checkPolicy(req('/api/aegis/check-policy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }));
            const j = await jsonBody<any>(res);
            expect(typeof j.latency_ms).toBe('number');
            expect(j.latency_ms).toBeGreaterThanOrEqual(0);
            expect(j.watchdog_budget_ms).toBe(50);
        }
    });

    test('latency never exceeds the 50ms watchdog budget on a healthy run', async () => {
        const res = await checkPolicy(req('/api/aegis/check-policy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ package_name: 'com.example', destination: 'example.com' }),
        }));
        const j = await jsonBody<any>(res);
        expect(j.latency_ms).toBeLessThan(50);
    });
});

describe('GET /api/journal', () => {
    test('returns seed feed when engine is offline', async () => {
        const res = await journal(req('/api/journal?limit=5'));
        const body = await jsonBody<any>(res);
        expect(body.count).toBeGreaterThan(0);
        expect(body.items.length).toBeLessThanOrEqual(5);
        for (const item of body.items) {
            expect(item).toHaveProperty('narrative');
            expect(item).toHaveProperty('action');
            expect(item).toHaveProperty('timestamp');
            expect(item).toHaveProperty('watchdog_latency_ms');
        }
    });

    test('feed items have valid action enum', async () => {
        const res = await journal(req('/api/journal?limit=20'));
        const body = await jsonBody<any>(res);
        for (const item of body.items) {
            expect(['ALLOW', 'DENY', 'MOCK']).toContain(item.action);
        }
    });

    test('feed items have watchdog_latency_ms in 0-100ms range', async () => {
        const res = await journal(req('/api/journal?limit=20'));
        const body = await jsonBody<any>(res);
        for (const item of body.items) {
            expect(typeof item.watchdog_latency_ms).toBe('number');
            expect(item.watchdog_latency_ms).toBeGreaterThanOrEqual(0);
            expect(item.watchdog_latency_ms).toBeLessThanOrEqual(100);
        }
    });

    test('rejects non-GET', async () => {
        const res = await journal(req('/api/journal', { method: 'POST' }));
        expect(res.status).toBe(405);
    });
});

describe('POST /api/register-test', () => {
    test('accepts a valid email', async () => {
        const res = await registerTest(req('/api/register-test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'test@example.com' }),
        }));
        const body = await jsonBody<any>(res);
        expect(body.ok).toBe(true);
    });

    test('rejects an invalid email', async () => {
        const res = await registerTest(req('/api/register-test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'not-an-email' }),
        }));
        expect(res.status).toBe(400);
    });

    test('rejects empty body', async () => {
        const res = await registerTest(req('/api/register-test', {
            method: 'POST',
            body: '{}',
        }));
        expect(res.status).toBe(400);
    });
});

describe('GET /api/install-state', () => {
    test('returns default state when empty', async () => {
        const res = await installState(req('/api/install-state'));
        const body = await jsonBody<any>(res);
        expect(body.step1).toBe(false);
        expect(body.step2).toBe(false);
        expect(body.step3).toBe(false);
        expect(body.profile).toBe('Paranoid');
    });
});

describe('POST /api/install-state', () => {
    test('persists and returns the new state', async () => {
        const post = await installState(req('/api/install-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dns_configured: true,
                advertising_id_reset: true,
                shield_active: false,
                profile: 'Standard',
            }),
        }));
        const body = await jsonBody<any>(post);
        expect(body.ok).toBe(true);
        expect(body.state.step1).toBe(true);
        expect(body.state.step2).toBe(true);
        expect(body.state.step3).toBe(false);
        expect(body.completed).toBe(false);
    });

    test('completed=true when all three steps done', async () => {
        const post = await installState(req('/api/install-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dns_configured: true,
                advertising_id_reset: true,
                shield_active: true,
                profile: 'Standard',
            }),
        }));
        const body = await jsonBody<any>(post);
        expect(body.completed).toBe(true);
    });
});

describe('methods', () => {
    test('install-state rejects PUT', async () => {
        const res = await installState(req('/api/install-state', { method: 'PUT' }));
        expect(res.status).toBe(405);
    });
});