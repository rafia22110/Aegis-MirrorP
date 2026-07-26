/**
 * GET /api/journal?limit=N
 *
 * Returns the most recent N traffic log entries. The PWA's Live Defense
 * Feed polls this every 10s. When the private engine is reachable, this
 * proxies to it; otherwise it returns a small seeded history so the
 * feed is never empty.
 */

const ENGINE_URL = process.env.AEGIS_ENGINE_URL || '';

export default async function handler(req: Request): Promise<Response> {
    if (req.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);

    if (ENGINE_URL) {
        try {
            const upstream = await fetch(`${ENGINE_URL}/api/journal?limit=${limit}`);
            return new Response(upstream.body, {
                status: upstream.status,
                headers: { 'Content-Type': 'application/json', 'X-Aegis-Source': 'engine' },
            });
        } catch (_) {}
    }

    // Public-mirror fallback feed — a small canned history so the QR
    // scan page never looks empty.
    const items = SEED_FEED.slice(0, limit).map((entry, i) => ({
        ...entry,
        timestamp: new Date(Date.now() - i * 12_000).toISOString(),
    }));

    return json({ count: items.length, items });
}

const SEED_FEED = [
    { source: 'com.facebook.katana', destination: 'graph.facebook.com',  action: 'MOCK',  threat_level: 'MEDIUM', narrative: 'Gorgon virtualized matrix injected mock data for Facebook.' },
    { source: 'com.google.android.gms', destination: 'play.googleapis.com', action: 'ALLOW', threat_level: 'LOW',    narrative: 'Aegis Mirror allowed emergency route to Play Services.' },
    { source: 'com.instagram.android', destination: 'graph.instagram.com', action: 'MOCK',  threat_level: 'MEDIUM', narrative: 'Aegis returned synthetic location data to Instagram.' },
    { source: 'com.android.chrome',  destination: 'fonts.googleapis.com',  action: 'ALLOW', threat_level: 'LOW',    narrative: 'Connection from Chrome to fonts.googleapis.com allowed.' },
    { source: 'com.xiaomi.gamecenter', destination: 'tracking.ads.io',    action: 'DENY',  threat_level: 'HIGH',   narrative: 'Aegis Shield blocked tracking packet from Game Center.' },
];

function json(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

export const config = { runtime: 'edge' };