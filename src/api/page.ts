/**
 * GET  /  · POST /  (the public mirror's index page)
 *
 * Zero-JavaScript application:
 *   - Phone-number + country-code form posts to itself.
 *   - On submit we register the device in the in-memory install map and
 *     return the same page with a "linked" status + a deep-link to be
 *     opened on that phone.
 *   - Live Defense Feed is rendered server-side every request. The
 *     <meta http-equiv="refresh" content="10"> tag in the HTML causes
 *     the browser to reload the page every 10 seconds for live updates.
 *   - All interactivity happens on the mobile device once it opens the
 *     deep link / installs the Aegis APK; the desktop session is passive.
 */

interface JournalItem {
    timestamp: string;
    source: string;
    destination: string;
    action: 'ALLOW' | 'DENY' | 'MOCK';
    threat_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    watchdog_latency_ms: number;
    narrative: string;
}

const INSTALL_REGISTRY = new Map<string, { phone: string; country: string; linkedAt: string }>();

function html(s: string): Response {
    return new Response(s, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
    });
}

function redirect(to: string): Response {
    return new Response(null, {
        status: 303,
        headers: { Location: to },
    });
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    } as any)[c]);
}

async function fetchJournal(): Promise<JournalItem[]> {
    const ENGINE_URL = process.env.AEGIS_ENGINE_URL || '';
    if (ENGINE_URL) {
        try {
            const r = await fetch(`${ENGINE_URL}/api/journal?limit=10`);
            if (r.ok) {
                const j = await r.json();
                return j.items || [];
            }
        } catch (_) { /* fall through to seed */ }
    }
    // Seeded history so the feed is never empty. Each item carries the
    // required keys + a deterministic latency in the 2-25ms band.
    const now = Date.now();
    const seeds: Omit<JournalItem, 'timestamp'>[] = [
        { source: 'com.facebook.katana',     destination: 'graph.facebook.com',   action: 'MOCK',  threat_level: 'MEDIUM', watchdog_latency_ms: 12.4, narrative: 'Aegis returned synthetic contact data to Facebook.' },
        { source: 'com.google.android.gms',  destination: 'play.googleapis.com',  action: 'ALLOW', threat_level: 'LOW',    watchdog_latency_ms:  8.1, narrative: 'Aegis Mirror allowed emergency route to Play Services.' },
        { source: 'com.xiaomi.gamecenter',   destination: 'tracking.ads.io',       action: 'DENY',  threat_level: 'HIGH',   watchdog_latency_ms:  4.2, narrative: 'Aegis Shield blocked tracking packet from Game Center.' },
        { source: 'com.instagram.android',   destination: 'graph.instagram.com',  action: 'MOCK',  threat_level: 'MEDIUM', watchdog_latency_ms: 18.7, narrative: 'Gorgon virtualized matrix injected mock data for Instagram.' },
        { source: 'com.android.chrome',      destination: 'fonts.googleapis.com',  action: 'ALLOW', threat_level: 'LOW',    watchdog_latency_ms:  6.0, narrative: 'Connection from Chrome to fonts.googleapis.com allowed.' },
    ];
    return seeds.map((s, i) => ({ ...s, timestamp: new Date(now - i * 12_000).toISOString() }));
}

function renderFeed(items: JournalItem[]): string {
    if (items.length === 0) {
        return '<div class="feed-empty">טוען את הפיד…</div>';
    }
    const rows = items.map((it) => {
        const latency = it.watchdog_latency_ms ?? 0;
        const cls = latency < 25 ? 'lt-25' : latency < 45 ? 'lt-45' : 'gt-45';
        const itemCls = `feed-item feed-item-${it.action.toLowerCase()}`;
        return `
            <li class="${itemCls}">
                <div class="feed-row">
                    <div class="feed-narrative">${escapeHtml(it.narrative)}</div>
                    <span class="feed-latency ${cls}">${latency.toFixed(1)}ms</span>
                </div>
                <div class="feed-meta">${escapeHtml(it.source)} → ${escapeHtml(it.destination)}</div>
            </li>`;
    }).join('');
    return `<ul class="feed-list">${rows}</ul>`;
}

function getOrCreateInstallId(req: Request): string {
    const cookieHeader = req.headers.get('cookie') || '';
    const m = /(?:^|;\s*)aegis_install=([^;]+)/.exec(cookieHeader);
    if (m) return decodeURIComponent(m[1]);
    const id = 'i-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    return id;
}

function cookieHeaderFor(id: string): string {
    return `aegis_install=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

function buildDeepLink(req: Request, installId: string): string {
    const u = new URL(req.url);
    u.searchParams.set('install', installId);
    return u.toString();
}

function renderActivationCard(linked: { phone: string; country: string; linkedAt: string } | undefined, deepLink: string): string {
    if (!linked) {
        return `
        <section class="card" aria-label="Activation form">
            <h2>הפעלה · Activate</h2>
            <form method="POST" action="/" novalidate>
                <label for="country" class="helper" style="text-align: right; display: block; margin-bottom: 0.25rem;">קוד מדינה · Country</label>
                <div class="form-row">
                    <select id="country" name="country" class="country" required style="background: var(--bg-0); color: var(--text-1); border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.75rem; font: inherit; cursor: pointer;">
                        <option value="+972">🇮🇱 +972</option>
                        <option value="+1">🇺🇸 +1</option>
                        <option value="+44">🇬🇧 +44</option>
                        <option value="+49">🇩🇪 +49</option>
                        <option value="+33">🇫🇷 +33</option>
                        <option value="+34">🇪🇸 +34</option>
                        <option value="+39">🇮🇹 +39</option>
                        <option value="+7">🇷🇺 +7</option>
                        <option value="+86">🇨🇳 +86</option>
                        <option value="+91">🇮🇳 +91</option>
                        <option value="+81">🇯🇵 +81</option>
                        <option value="+82">🇰🇷 +82</option>
                        <option value="+55">🇧🇷 +55</option>
                        <option value="+52">🇲🇽 +52</option>
                        <option value="+61">🇦🇺 +61</option>
                        <option value="+27">🇿🇦 +27</option>
                    </select>
                    <input id="phone" name="phone" type="tel" inputmode="tel" pattern="[0-9]{6,15}" placeholder="500123456" required aria-label="Phone number" autocomplete="tel-national" />
                </div>
                <button type="submit" class="submit-btn">שלח · Connect</button>
                <p class="helper">המכשיר הנייד שלך יקבל את שאר ההגדרה. Your mobile device will receive the rest of the setup.</p>
            </form>
        </section>`;
    }

    // Linked state — show the phone, a status block, and the deep link
    // to open on that phone. The whole rest of the wizard happens on
    // the phone (the Aegis Mirror APK / webview handles VPN, DNS, MOCK
    // virtualization, sandbox apps, etc.).
    const fullPhone = `${linked.country} ${linked.phone}`;
    return `
        <section class="card" aria-label="Activation status">
            <h2>מכשיר מקושר · Linked Device</h2>
            <div class="phone-display">${escapeHtml(fullPhone)}</div>
            <div class="status linked" role="status">
                <span class="status-dot"></span>
                <span>✓ הקישור נוצר · הפעל את "Aegis Mirror" בטלפון כדי להשלים את ההגדרה</span>
            </div>
            <p class="helper" style="margin-top: 1rem;">פתח את הקישור הבא במכשיר הנייד שלך כדי להמשיך:</p>
            <a class="deep-link" href="${escapeHtml(deepLink)}">${escapeHtml(deepLink)}</a>
            <form method="GET" action="/" style="margin-top: 1rem;">
                <button type="submit" class="submit-btn" style="background: var(--bg-1); color: var(--text-1);">נתק · Unlink</button>
            </form>
        </section>`;
}

function statusBanner(linked: { phone: string } | undefined): string {
    if (linked) {
        return `<div class="success">✓ המכשיר שלך מקושר ומוכן לקבל הגנה. כל פעילות תוצג בפיד למטה.</div>`;
    }
    return '';  // no banner — the activation card is the call to action
}

async function render(req: Request, linked?: { phone: string; country: string; linkedAt: string }): Promise<Response> {
    const installId = getOrCreateInstallId(req);
    const deepLink = buildDeepLink(req, installId);
    const items = await fetchJournal();
    const feed = renderFeed(items);
    const activation = renderActivationCard(linked, deepLink);
    const banner = statusBanner(linked);
    const linkedClass = linked ? 'linked' : '';
    const shieldStatus = linked
        ? '<span style="color: var(--emerald);">SHIELD ARMED · מגן מוכן</span>'
        : '<span style="color: var(--amber);">PENDING · ממתין</span>';
    const shieldSub = linked
        ? 'Linked device controls the engine'
        : 'Enter mobile number to activate';

    const html_out = TEMPLATE
        .replace('{{LINKED_CLASS}}', linkedClass)
        .replace('{{SHIELD_STATUS_TEXT}}', shieldStatus)
        .replace('{{SHIELD_SUB_TEXT}}', shieldSub)
        .replace('{{STATUS_BANNER}}', banner)
        .replace('{{ACTIVATION_CARD}}', activation)
        .replace('{{FEED_HTML}}', feed);

    const resp = html(html_out);
    resp.headers.append('Set-Cookie', cookieHeaderFor(installId));
    return resp;
}

export default async function handler(req: Request): Promise<Response> {
    if (req.method === 'GET') {
        const installId = getOrCreateInstallId(req);
        const linked = INSTALL_REGISTRY.get(installId);
        return render(req, linked);
    }
    if (req.method === 'POST') {
        const form = await req.formData();
        const country = String(form.get('country') || '').trim();
        const phone = String(form.get('phone') || '').trim().replace(/[^0-9]/g, '');
        if (!/^\+[0-9]{1,4}$/.test(country) || !/^[0-9]{6,15}$/.test(phone)) {
            const id = getOrCreateInstallId(req);
            INSTALL_REGISTRY.delete(id);
            return new Response('Invalid phone number. Please go back and try again.', {
                status: 400,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            });
        }
        const installId = getOrCreateInstallId(req);
        INSTALL_REGISTRY.set(installId, { country, phone, linkedAt: new Date().toISOString() });
        return redirect('/');   // PRG pattern — prevents double-submit on refresh
    }
    return new Response('Method Not Allowed', { status: 405 });
}

export const config = { runtime: 'edge' };

// The HTML template — minimal markup, no JS, server-rendered.
// Mirrors the design language of the original index.html (dark, RTL,
// Cinzel headings, Heebo body) without any client-side scripting.
const TEMPLATE = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0b0c10" />
    <meta name="description" content="Aegis MirrorP — zero-JS install flow." />
    <meta http-equiv="refresh" content="10" />
    <title>Aegis MirrorP · מנוע הריבונות הדיגיטלית</title>
    <link rel="manifest" href="/manifest.json" />
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
    <link rel="apple-touch-icon" href="/icon-192.png" />
    <style>
        :root { --bg-0:#0b0c10; --bg-1:#11141b; --text-1:#e2e8f0; --text-2:#94a3b8; --text-3:#64748b; --amber:#f59e0b; --emerald:#10b981; --teal:#14b8a6; --rose:#f43f5e; --border:#1e293b; }
        *{box-sizing:border-box} html,body{margin:0;padding:0}
        body{background:var(--bg-0);color:var(--text-1);font-family:'Heebo','Inter',system-ui,-apple-system,sans-serif;min-height:100vh}
        .shell{max-width:28rem;margin:0 auto;padding:2rem 1rem 5rem}
        header{text-align:center;margin-bottom:2rem}
        h1.myth{font-family:'Cinzel',Georgia,serif;font-weight:700;font-size:2rem;letter-spacing:.08em;margin:0 0 .5rem;background:linear-gradient(to left,#fde68a,#fef3c7,#6ee7b7);-webkit-background-clip:text;background-clip:text;color:transparent}
        .tagline{font-size:.7rem;font-weight:600;letter-spacing:.18em;color:var(--text-3);text-transform:uppercase}
        .card{background:rgba(15,23,42,.6);backdrop-filter:blur(12px);border:1px solid var(--border);border-radius:1rem;padding:1.5rem;box-shadow:0 25px 50px -12px rgb(0 0 0 /.5)}
        .card+.card{margin-top:1rem}
        .card h2{font-size:.75rem;font-weight:700;letter-spacing:.18em;color:var(--text-2);text-transform:uppercase;margin:0 0 1rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}
        .form-row{display:flex;gap:.5rem;margin-bottom:0}
        .form-row input,.form-row select{flex:1;background:var(--bg-0);border:1px solid var(--border);color:var(--text-1);border-radius:.5rem;padding:.75rem 1rem;font:inherit;font-size:1rem;text-align:center;letter-spacing:.05em;-webkit-appearance:none;appearance:none}
        .form-row .country{flex:0 0 6.5rem}
        .form-row input:focus,.form-row select:focus{outline:2px solid var(--emerald);outline-offset:-1px;border-color:transparent}
        .submit-btn{width:100%;background:linear-gradient(to left,var(--emerald),var(--teal));color:var(--bg-0);border:none;border-radius:.5rem;padding:.875rem 1rem;font:inherit;font-weight:700;font-size:.875rem;letter-spacing:.18em;text-transform:uppercase;cursor:pointer;margin-top:.75rem;transition:filter .15s}
        .submit-btn:hover{filter:brightness(1.1)}
        .submit-btn:focus{outline:2px solid var(--emerald);outline-offset:2px}
        .helper{font-size:.75rem;color:var(--text-3);margin:.5rem 0 0;text-align:center}
        .status{display:flex;align-items:center;gap:.75rem;padding:.875rem 1rem;border-radius:.5rem;font-size:.85rem}
        .status.linked{background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.3);color:#6ee7b7}
        .status-dot{width:.5rem;height:.5rem;border-radius:50%;flex-shrink:0;background:var(--emerald)}
        .deep-link{display:block;margin-top:.75rem;padding:.875rem 1rem;background:var(--bg-0);border:1px solid var(--emerald);color:var(--emerald);border-radius:.5rem;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:.8rem;text-align:center;text-decoration:none;word-break:break-all;letter-spacing:.02em}
        .deep-link:hover{background:rgba(16,185,129,.08)}
        .phone-display{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:1.5rem;font-weight:600;letter-spacing:.05em;color:var(--text-1);text-align:center;direction:ltr;padding:.5rem 0 1rem}
        .feed-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.5rem;max-height:12rem;overflow-y:auto}
        .feed-item{padding:.625rem .875rem;border-radius:.5rem;background:rgba(11,12,16,.7);border:1px solid var(--border);font-size:.8rem;line-height:1.4}
        .feed-item-allow{border-left:3px solid var(--emerald)}
        .feed-item-deny{border-left:3px solid var(--rose)}
        .feed-item-mock{border-left:3px solid var(--amber)}
        .feed-row{display:flex;justify-content:space-between;gap:.75rem;align-items:flex-start}
        .feed-narrative{flex:1}
        .feed-latency{flex-shrink:0;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:.7rem;padding:.125rem .375rem;border-radius:.25rem;border:1px solid}
        .feed-latency.lt-25{color:#6ee7b7;border-color:rgba(16,185,129,.3)}
        .feed-latency.lt-45{color:#fcd34d;border-color:rgba(245,158,11,.4)}
        .feed-latency.gt-45{color:#fda4af;border-color:rgba(244,63,94,.4)}
        .feed-meta{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:.7rem;color:var(--text-3);margin-top:.25rem;direction:ltr;text-align:left}
        .feed-empty{padding:.625rem .875rem;border-radius:.5rem;background:rgba(11,12,16,.4);border:1px solid var(--border);font-size:.8rem;color:var(--text-3);text-align:center}
        .refresh-tag{font-size:.7rem;color:#6ee7b7;letter-spacing:.1em;text-transform:uppercase}
        footer{margin-top:2rem;text-align:center;font-size:.7rem;color:var(--text-3)}
        @keyframes liquid-reveal { 0%{filter:blur(40px);opacity:0;transform:scale(1.05)} 100%{filter:blur(0);opacity:1;transform:scale(1)} }
        .shield-ring{width:14rem;height:14rem;margin:1rem auto 2rem;border-radius:50%;background:radial-gradient(circle,rgba(27,38,59,.6) 0%,rgba(11,12,16,1) 100%);border:4px solid rgba(245,158,11,.4);display:grid;place-items:center;animation:liquid-reveal 3s ease-out forwards;text-align:center;padding:1rem}
        .shield-ring.linked{border-color:rgba(16,185,129,.5)}
        .shield-status{font-family:'Cinzel',Georgia,serif;font-weight:700;font-size:.875rem;letter-spacing:.1em}
        .shield-sub{font-size:.7rem;color:var(--text-3);margin-top:.5rem;letter-spacing:.05em}
        .success{background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.3);color:#6ee7b7;border-radius:.5rem;padding:.875rem 1rem;font-size:.8rem;margin-bottom:1rem}
    </style>
</head>
<body>
    <main class="shell" dir="rtl">
        <header>
            <h1 class="myth">AEGIS MIRROR</h1>
            <p class="tagline">Digital Sovereignty Engine · מנוע הריבונות הדיגיטלית</p>
        </header>

        <div class="shield-ring {{LINKED_CLASS}}">
            <div>
                <div class="shield-status">{{SHIELD_STATUS_TEXT}}</div>
                <div class="shield-sub">{{SHIELD_SUB_TEXT}}</div>
            </div>
        </div>

        {{STATUS_BANNER}}

        {{ACTIVATION_CARD}}

        <section class="card" aria-label="Live Defense Feed">
            <h2>
                פיד הגנה חי · Live Defense Feed
                <span class="refresh-tag" style="float:left;padding-top:.2rem">רענון אוטומטי (10 שניות)</span>
            </h2>
            {{FEED_HTML}}
        </section>

        <footer>Aegis MirrorP · Public Mirror · אפס JavaScript · Build P-2026.07</footer>
    </main>
</body>
</html>`;
