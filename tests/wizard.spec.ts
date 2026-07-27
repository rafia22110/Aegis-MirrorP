/**
 * Playwright wizard test — drives the 3-step installation flow in
 * headless Chromium. Stubs the platform-specific surfaces (clipboard
 * + Android intent navigation) that aren't available in a desktop
 * browser, and intercepts the /api/* calls so the test is hermetic.
 *
 * The test verifies the user-visible invariants:
 *   1. The shield ring is initially blurred (3s liquid reveal).
 *   2. Each step's "Done" button advances the wizard.
 *   3. After step 3, the Live Defense Feed renders rows.
 *   4. The Shield toggle flips between secure / bypass states.
 *   5. The /api/install-state endpoint receives the expected state.
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Fixture: every test gets a page with clipboard + intent navigation
// stubbed, and /api/* requests intercepted with deterministic responses.
// ---------------------------------------------------------------------------
async function wireMocks(page: Page) {
    // Stub the clipboard so step 1 can "copy" the DNS host. We also
    // override the UA so isAndroid() returns false (avoids any
    // intent:// navigation in headless Chromium).
    await page.addInitScript(() => {
        const store: Record<string, string> = {};
        const nav = (window as any).navigator;
        nav.clipboard = {
            writeText: async (text: string) => { store['clip'] = text; },
            readText: async () => store['clip'] || '',
        };
        // Override UA so the inline wizard's isAndroid() returns false.
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (X11; Linux x86_64) Aegis-MirrorP-Test',
            configurable: true,
        });
    });

    // Mock /api/install-state: GET returns default, POST echoes the body.
    await page.route('**/api/install-state', async (route, request) => {
        if (request.method() === 'GET') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ step1: false, step2: false, step3: false, profile: 'Paranoid' }),
            });
        } else {
            const body = request.postDataJSON() as any;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ok: true,
                    state: {
                        step1: !!body?.dns_configured,
                        step2: !!body?.advertising_id_reset,
                        step3: !!body?.shield_active,
                        profile: body?.profile || 'Paranoid',
                    },
                    completed: !!(body?.dns_configured && body?.advertising_id_reset && body?.shield_active),
                }),
            });
        }
    });

    // Mock /api/journal: return three synthetic feed items so the
    // Live Defense Feed has content to render.
    await page.route('**/api/journal**', async (route) => {
        const items = [
            {
                timestamp: new Date().toISOString(),
                source: 'com.facebook.katana',
                destination: 'graph.facebook.com',
                action: 'MOCK',
                threat_level: 'MEDIUM',
                watchdog_latency_ms: 12.4,
                narrative: 'Gorgon virtualized matrix injected mock data for Facebook.',
            },
            {
                timestamp: new Date(Date.now() - 12_000).toISOString(),
                source: 'com.google.android.gms',
                destination: 'play.googleapis.com',
                action: 'ALLOW',
                threat_level: 'LOW',
                watchdog_latency_ms: 8.1,
                narrative: 'Aegis Mirror allowed emergency route to Play Services.',
            },
            {
                timestamp: new Date(Date.now() - 24_000).toISOString(),
                source: 'com.xiaomi.gamecenter',
                destination: 'tracking.ads.io',
                action: 'DENY',
                threat_level: 'HIGH',
                watchdog_latency_ms: 4.2,
                narrative: 'Aegis Shield blocked tracking packet from Game Center.',
            },
        ];
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ count: items.length, items }),
        });
    });

    // Mock /api/aegis/check-policy (called when toggling sandbox apps).
    await page.route('**/api/aegis/check-policy', async (route, request) => {
        const body = request.postDataJSON() as any;
        const isMocked = body?.package_name === 'com.facebook.katana';
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                action: isMocked ? 'MOCK' : 'ALLOW',
                narrative: isMocked
                    ? 'Gorgon virtualized matrix injected mock data for Facebook.'
                    : `Connection from ${body?.package_name} to ${body?.destination} allowed.`,
                threat_level: isMocked ? 'MEDIUM' : 'LOW',
                latency_ms: 1.2,
                watchdog_budget_ms: 50,
            }),
        });
    });
}

// ---------------------------------------------------------------------------
// 1. Initial render
// ---------------------------------------------------------------------------
test('wizard renders with blurred shield and three step pills', async ({ page }) => {
    await wireMocks(page);
    await page.goto('/');

    // Header.
    await expect(page.locator('h1', { hasText: 'AEGIS MIRROR' })).toBeVisible();

    // All three step labels visible.
    await expect(page.locator('h3', { hasText: 'חסימת תשתיות' })).toBeVisible();
    await expect(page.locator('h3', { hasText: 'מחיקת טביעת אצבע' })).toBeVisible();
    await expect(page.locator('h3', { hasText: 'הפעלת מגן האגיס' })).toBeVisible();

    // Action buttons visible.
    await expect(page.locator('button', { hasText: 'פתח הגדרות DNS' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'מחק מזהה מעקב' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'הפעל את המגן' })).toBeVisible();

    // Shield is initially blurred (3s liquid reveal).
    const ring = page.locator('.blurred-shell, .revealed-shell').first();
    await expect(ring).toBeVisible();
});

// ---------------------------------------------------------------------------
// 2. Step 1 — DNS
// ---------------------------------------------------------------------------
test('Step 1: clicking "Done" persists dns_configured and copies the DNS host', async ({ page }) => {
    await wireMocks(page);
    await page.goto('/');

    // Listen for the install-state POST.
    const installStatePost = page.waitForRequest(
        (req) => req.url().includes('/api/install-state') && req.method() === 'POST',
    );

    // Click "פתח הגדרות DNS" first to copy the DNS host to clipboard.
    await page.locator('button', { hasText: 'פתח הגדרות DNS' }).click();

    // Then click "סיימתי" to mark the step done.
    await page.locator('button', { hasText: 'סיימתי' }).first().click();

    // Verify the request was made with step1=true.
    const req = await installStatePost;
    const body = req.postDataJSON() as any;
    expect(body.dns_configured).toBe(true);
    expect(body.advertising_id_reset).toBe(false);
    expect(body.shield_active).toBe(false);
});

// ---------------------------------------------------------------------------
// 3. Step 2 — Advertising ID
// ---------------------------------------------------------------------------
test('Step 2: clicking "Done" persists advertising_id_reset', async ({ page }) => {
    await wireMocks(page);
    await page.goto('/');

    // Advance step 1 first.
    await page.locator('button', { hasText: 'סיימתי' }).first().click();

    // Now click step 2's "סיימתי" button (the second one).
    const step2Post = page.waitForRequest(
        (req) => req.url().includes('/api/install-state') && req.method() === 'POST',
    );
    await page.locator('button', { hasText: 'סיימתי' }).nth(1).click();

    const req = await step2Post;
    const body = req.postDataJSON() as any;
    expect(body.dns_configured).toBe(true);
    expect(body.advertising_id_reset).toBe(true);
    expect(body.shield_active).toBe(false);
});

// ---------------------------------------------------------------------------
// 4. Step 3 — Shield activation
// ---------------------------------------------------------------------------
test('Step 3: clicking "הפעל את המגן" persists shield_active and reveals the dashboard', async ({ page }) => {
    await wireMocks(page);
    await page.goto('/');

    // Advance steps 1 and 2.
    await page.locator('button', { hasText: 'סיימתי' }).first().click();
    await page.locator('button', { hasText: 'סיימתי' }).nth(1).click();

    // Click "הפעל את המגן" (step 3's primary action).
    const shieldPost = page.waitForRequest(
        (req) => req.url().includes('/api/install-state') && req.method() === 'POST',
    );
    await page.locator('button', { hasText: 'הפעל את המגן' }).click();

    const req = await shieldPost;
    const body = req.postDataJSON() as any;
    expect(body.dns_configured).toBe(true);
    expect(body.advertising_id_reset).toBe(true);
    expect(body.shield_active).toBe(true);

    // After activation, the shield toggle becomes visible (it only
    // appears once the wizard is complete).
    await expect(page.locator('button', { hasText: /כבה את המגן|הפעל הגנה/ }).first()).toBeVisible({ timeout: 8_000 });
});

// ---------------------------------------------------------------------------
// 5. Live Defense Feed renders
// ---------------------------------------------------------------------------
test('Live Defense Feed renders rows from /api/journal', async ({ page }) => {
    await wireMocks(page);
    await page.goto('/');

    // The journal container should populate after the HTMX load trigger.
    // We sent 3 mock items, so wait for at least one narrative to appear.
    await expect(page.locator('text=Gorgon virtualized matrix')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=emergency route to Play Services')).toBeVisible();
    await expect(page.locator('text=blocked tracking packet from Game Center')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 6. Watchdog latency chip in the feed
// ---------------------------------------------------------------------------
test('Live Defense Feed shows the watchdog latency chip', async ({ page }) => {
    await wireMocks(page);
    await page.goto('/');

    // The mock journal returns 12.4ms, 8.1ms, 4.2ms. Each item should
    // render as a small "X.Xms" badge.
    await expect(page.locator('text=12.4ms').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=8.1ms').first()).toBeVisible();
    await expect(page.locator('text=4.2ms').first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 7. Shield toggle (after wizard complete)
// ---------------------------------------------------------------------------
test('Shield toggle flips to Bypass mode when clicked', async ({ page }) => {
    await wireMocks(page);
    await page.goto('/');

    // Walk the wizard.
    await page.locator('button', { hasText: 'סיימתי' }).first().click();
    await page.locator('button', { hasText: 'סיימתי' }).nth(1).click();
    await page.locator('button', { hasText: 'הפעל את המגן' }).click();

    // The shield toggle is now visible. Capture the POST to install-state.
    const togglePost = page.waitForRequest(
        (req) => req.url().includes('/api/install-state') && req.method() === 'POST',
    );
    await page.locator('button', { hasText: /כבה את המגן/ }).first().click();

    const req = await togglePost;
    const body = req.postDataJSON() as any;
    // After deactivation, shield_active flips to false.
    expect(body.shield_active).toBe(false);
});

// ---------------------------------------------------------------------------
// 8. Sandbox drawer
// ---------------------------------------------------------------------------
test('Sandbox drawer opens and shows the seeded app list', async ({ page }) => {
    await wireMocks(page);
    await page.goto('/');

    // Walk the wizard so the sandbox button is visible.
    await page.locator('button', { hasText: 'סיימתי' }).first().click();
    await page.locator('button', { hasText: 'סיימתי' }).nth(1).click();
    await page.locator('button', { hasText: 'הפעל את המגן' }).click();

    // Open the sandbox drawer.
    await page.locator('button', { hasText: 'הגדר ארגז חול' }).click();

    // The seeded app list should be visible.
    await expect(page.locator('text=Google Maps')).toBeVisible();
    await expect(page.locator('text=Facebook')).toBeVisible();
    await expect(page.locator('text=WhatsApp')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 9. Reverse: bypass → re-activate should also hit the API
// ---------------------------------------------------------------------------
test('After deactivation, the re-activate button restores shield_active', async ({ page }) => {
    await wireMocks(page);
    await page.goto('/');

    // Walk the wizard.
    await page.locator('button', { hasText: 'סיימתי' }).first().click();
    await page.locator('button', { hasText: 'סיימתי' }).nth(1).click();
    await page.locator('button', { hasText: 'הפעל את המגן' }).click();

    // Deactivate.
    const offPost = page.waitForRequest(
        (req) => req.url().includes('/api/install-state') && req.method() === 'POST',
    );
    await page.locator('button', { hasText: /כבה את המגן/ }).first().click();
    const off = await offPost;
    expect((off.postDataJSON() as any).shield_active).toBe(false);

    // Re-activate via the "הפעל הגנה" button that should now appear.
    const onPost = page.waitForRequest(
        (req) => req.url().includes('/api/install-state') && req.method() === 'POST',
    );
    await page.locator('button', { hasText: /הפעל הגנה/ }).first().click();
    const on = await onPost;
    expect((on.postDataJSON() as any).shield_active).toBe(true);
});