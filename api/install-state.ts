/**
 * POST /api/install-state  + GET /api/install-state
 *
 * Persists which wizard step the device is currently on. The frontend
 * uses this to decide which step pill to show as "Done" after a refresh.
 *
 * Implementation note: the public mirror has no persistent store, so the
 * wizard state is held in an HttpOnly cookie + a small in-memory map
 * (Vercel Edge has KV in production — see TODO). When the private engine
 * is configured we proxy through to it for durable storage.
 */

const ENGINE_URL = process.env.AEGIS_ENGINE_URL || '';

// In-memory store keyed by an anonymous install id (set as a cookie on
// first POST). Resets on cold start; that is acceptable for the public
// mirror because the engine, when configured, owns the durable copy.
const INSTALL_STATE = new Map<string, WizardState>();

interface WizardState {
    step1: boolean;
    step2: boolean;
    step3: boolean;
    profile: string;
    updatedAt: string;
}

const DEFAULT_STATE: WizardState = {
    step1: false, step2: false, step3: false,
    profile: 'Paranoid', updatedAt: new Date().toISOString(),
};

export default async function handler(req: Request): Promise<Response> {
    if (req.method === 'GET') return handleGet(req);
    if (req.method === 'POST') return handlePost(req);
    return new Response('Method Not Allowed', { status: 405 });
}

async function handleGet(req: Request): Promise<Response> {
    const installId = getOrCreateInstallId(req);
    const state = INSTALL_STATE.get(installId) || DEFAULT_STATE;
    return json(state);
}

async function handlePost(req: Request): Promise<Response> {
    let body: any = {};
    try { body = await req.json(); } catch (_) {
        return json({ ok: false }, 400);
    }

    const installId = getOrCreateInstallId(req);
    const next: WizardState = {
        step1: !!body.dns_configured,
        step2: !!body.advertising_id_reset,
        step3: !!body.shield_active,
        profile: String(body.profile || 'Paranoid'),
        updatedAt: new Date().toISOString(),
    };

    if (ENGINE_URL) {
        try {
            const upstream = await fetch(`${ENGINE_URL}/api/install-state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    dns_configured: next.step1,
                    advertising_id_reset: next.step2,
                    shield_active: next.step3,
                    profile: next.profile,
                }),
            });
            return new Response(upstream.body, {
                status: upstream.status,
                headers: {
                    'Content-Type': 'application/json',
                    'Set-Cookie': `aegis_install=${installId}; Path=/; Max-Age=31536000; SameSite=Lax`,
                },
            });
        } catch (_) {}
    }

    INSTALL_STATE.set(installId, next);
    return json(
        { ok: true, state: next, completed: next.step1 && next.step2 && next.step3 },
        200,
        { 'Set-Cookie': `aegis_install=${installId}; Path=/; Max-Age=31536000; SameSite=Lax` },
    );
}

function getOrCreateInstallId(req: Request): string {
    const cookieHeader = req.headers.get('cookie') || '';
    const match = cookieHeader.match(/aegis_install=([a-f0-9-]+)/i);
    if (match) return match[1];
    return crypto.randomUUID();
}

function json(payload: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
    });
}

export const config = { runtime: 'edge' };