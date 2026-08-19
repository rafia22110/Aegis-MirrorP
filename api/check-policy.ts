/**
 * POST /api/aegis/check-policy
 *
 * Vercel Edge Function entry point. Mirrors the PocketBase hook at
 * pb_hooks/main.pb.js — when the operator has the private engine
 * running on the VPS, requests are proxied to it; otherwise this
 * returns a sane default-allow response so the public mirror still
 * works for QR-scan testing.
 */

const ENGINE_URL = process.env.AEGIS_ENGINE_URL || '';

export default async function handler(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

    let body: any = {};
    try {
        body = await req.json();
    } catch (_) {
        return json({ action: 'DENY', reason: 'invalid_json' }, 400);
    }

    // Proxy to the private engine when configured.
    if (ENGINE_URL) {
        try {
            const upstream = await fetch(`${ENGINE_URL}/api/aegis/check-policy`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            return new Response(upstream.body, {
                status: upstream.status,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Aegis-Source': 'engine',
                },
            });
        } catch (err) {
            // Engine down — fall through to the local fallback.
        }
    }

    // Public-mirror local fallback. Apply the same decision tree as the
    // PocketBase hook so QR scans behave identically whether or not the
    // operator has spun up the private engine.
    const packageName = String(body.package_name || 'unknown.app');
    const destination = String(body.destination || 'unknown.domain');
    const permission  = body.permission ? String(body.permission) : null;

    const latency = measureLatency(t0);

    // Emergency whitelist — hardcoded for the public mirror.
    const EMERGENCY = new Set(['gov.alert', 'co.il.redalert', '112', '911']);
    if (EMERGENCY.has(destination)) {
        return json({
            action: 'ALLOW',
            reason: 'Emergency Bypass Activated',
            narrative: `Aegis Mirror allowed emergency route to ${destination}.`,
            threat_level: 'LOW',
            latency_ms: latency,
            watchdog_budget_ms: 50,
        });
    }

    // Permission overrides — hardcoded common cases.
    const MOCK_PACKAGES = new Set([
        'com.facebook.katana',
        'com.instagram.android',
        'com.google.android.gms.maps',
    ]);
    if (permission && MOCK_PACKAGES.has(packageName)) {
        return json({
            action: 'MOCK',
            narrative: `Aegis returned synthetic ${permission.toLowerCase()} data to ${packageName}.`,
            threat_level: 'MEDIUM',
            permission_hint: { mocking_behavior: 'SILENT' },
            latency_ms: latency,
            watchdog_budget_ms: 50,
        });
    }

    // Default allow.
    return json({
        action: 'ALLOW',
        narrative: `Connection from ${packageName} to ${destination} allowed.`,
        threat_level: 'LOW',
        latency_ms: latency,
        watchdog_budget_ms: 50,
    });
}

function measureLatency(t0: number): number {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return Math.round((now - t0) * 100) / 100;
}

function json(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

export const config = { runtime: 'edge' };