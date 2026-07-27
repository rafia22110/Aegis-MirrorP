import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the Aegis MirrorP wizard test.
 *
 * Boots `vite preview` on a fixed port (4173), waits for it, then runs
 * the wizard spec against the served bundle. We use preview (not dev)
 * because the wizard relies on the built artifact that Vercel will
 * actually ship.
 *
 * Browser matrix is intentionally minimal — just Chromium. The wizard
 * is designed for Android WebView, but the same flow works in desktop
 * Chromium with clipboard + intent navigation stubbed.
 */
export default defineConfig({
    testDir: './tests',
    testMatch: /wizard\.spec\.ts/,
    timeout: 30_000,
    fullyParallel: false,                     // single wizard, single browser
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
        command: 'bunx vite preview --port 4173 --host 127.0.0.1 --strictPort',
        url: 'http://127.0.0.1:4173',
        timeout: 30_000,
        reuseExistingServer: !process.env.CI,
        stdout: 'ignore',
        stderr: 'pipe',
    },
});