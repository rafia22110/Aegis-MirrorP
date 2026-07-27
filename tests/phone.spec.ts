/**
 * Playwright E2E test for the zero-JS phone-activation flow.
 *
 * The page is rendered entirely server-side by src/api/page.ts. The
 * test verifies the user-visible invariants:
 *
 *   1. First visit shows the activation form (country + phone number).
 *   2. Submitting the form redirects to "/" with the linked state.
 *   3. The linked state shows the phone number + a deep-link to be
 *      opened on that phone.
 *   4. The Live Defense Feed renders rows from /api/journal.
 *   5. The <meta http-equiv="refresh"> tag is present (no JS polling).
 *
 * No mocks: the tests run against the production code path through
 * tests/helpers/page-server.ts.
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// 1. Activation form is shown on first visit
// ---------------------------------------------------------------------------
test('first visit shows the activation form with country + phone fields', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('h1', { hasText: 'AEGIS MIRROR' })).toBeVisible();

    // The activation card has both the country select and the phone input.
    const select = page.locator('select[name="country"]');
    const phone = page.locator('input[name="phone"]');
    await expect(select).toBeVisible();
    await expect(phone).toBeVisible();
    // Israel is the default selection (per the project locale).
    await expect(select).toHaveValue('+972');

    // The submit button is present.
    const submit = page.locator('button[type="submit"]', { hasText: /שלח|Connect/ });
    await expect(submit).toBeVisible();

    // The Live Defense Feed renders server-side.
    await expect(page.locator('section[aria-label="Live Defense Feed"]')).toBeVisible();

    // The auto-refresh meta tag is present so we don't need JS polling.
    const refresh = page.locator('meta[http-equiv="refresh"]');
    await expect(refresh).toHaveAttribute('content', '10');
});

// ---------------------------------------------------------------------------
// 2. Submitting the form persists the phone + shows the linked state
// ---------------------------------------------------------------------------
test('submitting the form persists the phone number and renders the linked card', async ({ page }) => {
    await page.goto('/');

    // The cookie is set on first GET so we should have it after page.goto.
    const cookiesBefore = await page.context().cookies();
    const hasInstallCookie = cookiesBefore.some((c) => c.name === 'aegis_install');
    expect(hasInstallCookie).toBe(true);

    // Fill the form and submit.
    await page.locator('select[name="country"]').selectOption('+1');
    await page.locator('input[name="phone"]').fill('2025551234');
    await page.locator('button[type="submit"]').click();

    // After the 303 redirect back to /, the linked card is visible.
    await expect(page).toHaveURL(/\/$/);
    const linked = page.locator('section[aria-label="Activation status"]');
    await expect(linked).toBeVisible();

    // The phone is displayed in the linked card.
    await expect(linked.locator('text=+1 2025551234')).toBeVisible();

    // The deep-link points to the current origin with ?install=<id>.
    const deepLink = linked.locator('a.deep-link');
    const href = await deepLink.getAttribute('href');
    expect(href).toMatch(/\?install=i-/);
});

// ---------------------------------------------------------------------------
// 3. Linked state persists across page loads (cookie-based)
// ---------------------------------------------------------------------------
test('linked state survives a full page reload', async ({ page }) => {
    await page.goto('/');
    await page.locator('input[name="phone"]').fill('500123456');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('section[aria-label="Activation status"]')).toBeVisible();

    // Hard refresh — the linked state should still be there.
    await page.reload();
    await expect(page.locator('section[aria-label="Activation status"]')).toBeVisible();
    await expect(page.locator('text=+972 500123456')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 4. Invalid phone submission returns a 400 error
// ---------------------------------------------------------------------------
test('submitting an invalid phone number returns a 400 error', async ({ request }) => {
    const res = await request.post('/', {
        form: { country: '+1', phone: 'abc' },
        maxRedirects: 0,
    });
    expect(res.status()).toBe(400);
});

// ---------------------------------------------------------------------------
// 5. Live Defense Feed renders rows from /api/journal
// ---------------------------------------------------------------------------
test('Live Defense Feed shows narrative rows + watchdog latency chips', async ({ page }) => {
    await page.goto('/');

    const feed = page.locator('section[aria-label="Live Defense Feed"]');
    await expect(feed).toBeVisible();

    // The fallback journal returns 5 seeded items; each one renders as
    // a <li.feed-item> with a latency badge.
    const items = feed.locator('li.feed-item');
    await expect(items).toHaveCount(5);

    // The watchdog latency badge is present on each item.
    const latencies = feed.locator('span.feed-latency');
    await expect(latencies.first()).toBeVisible();
    expect(await latencies.count()).toBeGreaterThanOrEqual(5);

    // Each item has the source → destination meta line.
    const meta = feed.locator('div.feed-meta');
    await expect(meta.first()).toContainText('→');
});

// ---------------------------------------------------------------------------
// 6. Shield ring reflects the linked state
// ---------------------------------------------------------------------------
test('shield ring shows PENDING before submission and SHIELD ARMED after', async ({ page }) => {
    await page.goto('/');
    const ring = page.locator('.shield-ring');
    await expect(ring).toBeVisible();
    await expect(ring).not.toHaveClass(/linked/);
    await expect(ring.locator('text=PENDING')).toBeVisible();

    await page.locator('input[name="phone"]').fill('500123456');
    await page.locator('button[type="submit"]').click();

    await expect(page.locator('.shield-ring.linked')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.shield-ring')).toContainText('SHIELD ARMED');
});

// ---------------------------------------------------------------------------
// 7. No <script> tags in the rendered HTML (zero-JS invariant)
// ---------------------------------------------------------------------------
test('rendered HTML contains zero <script> tags', async ({ page }) => {
    await page.goto('/');
    const scriptCount = await page.locator('script').count();
    expect(scriptCount).toBe(0);
});
