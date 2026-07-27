import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the Aegis MirrorP phone-activation flow.
 *
 * Boots a tiny Bun HTTP server (`tests/helpers/page-server.ts`) that
 * imports the production page handler from `src/api/page.ts` and serves
 * it under `/`. The server runs the same code path Vercel runs in
 * production, so the E2E tests cover the real handler.
 *
 * Browser matrix is intentionally minimal — just Chromium. The page is
 * designed for any browser; the QR/JS/Alpine layer was removed in the
 * "zero-JS" refactor so we don't need clipboard / intent stubbing
 * anymore.
 */
export default defineConfig({
    testDir: './tests',
    testMatch: /phone\.spec\.ts/,
    timeout: 30_000,
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: 'http://127.0.0.1:4173',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        actionTimeout: 8_000,
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: {
        command: 'bun run tests/helpers/page-server.ts',
        url: 'http://127.0.0.1:4173',
        timeout: 30_000,
        reuseExistingServer: !process.env.CI,
        stdout: 'ignore',
        stderr: 'pipe',
    },
});