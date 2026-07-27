/**
 * Tiny HTTP server for E2E tests. Imports the production page.ts handler
 * and serves it under "/" + "/api/journal", "/api/install-state", etc.
 *
 * Runs on port 4173 (matches what `vite preview` used to do, so the test
 * URLs are unchanged). Started lazily by the `webServer` block in
 * playwright.config.ts.
 */

import handler from '../../src/api/page.ts';
import journal from '../../src/api/journal.ts';
import installState from '../../src/api/install-state.ts';

const PORT = parseInt(process.env.PORT || '4173', 10);

const server = Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);

        // Route / and any unknown GET to the page handler
        if (url.pathname === '/' || url.pathname === '') {
            return handler(req);
        }
        if (url.pathname === '/api/journal') {
            return journal(req);
        }
        if (url.pathname === '/api/install-state') {
            return installState(req);
        }

        return new Response('Not Found', { status: 404 });
    },
});

console.log(`test-server listening on http://${server.hostname}:${server.port}`);
