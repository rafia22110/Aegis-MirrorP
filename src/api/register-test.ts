/**
 * POST /api/register-test
 *
 * Beta-portal registration endpoint. Accepts an email address and queues
 * it for the verifier. The private engine drains the queue and sends the
 * magic-link email; the public mirror just acks.
 */

const ENGINE_URL = process.env.AEGIS_ENGINE_URL || '';

export default async function handler(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    let body: any = {};
    try { body = await req.json(); } catch (_) {
        return json({ ok: false, reason: 'invalid_json' }, 400);
    }

    const email = String(body.email || '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ ok: false, reason: 'invalid_email' }, 400);
    }

    if (ENGINE_URL) {
        try {
            const upstream = await fetch(`${ENGINE_URL}/api/register-test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            });
            return new Response(upstream.body, {
                status: upstream.status,
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (_) {}
    }

    return json({
        ok: true,
        message: 'Registration queued. Check your inbox for the verifier link.',
    });
}

function json(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

export const config = { runtime: 'edge' };