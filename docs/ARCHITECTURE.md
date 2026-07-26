# Aegis MirrorP — Architecture

## Layers

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Layer 0: User                                                            │
│   Scans QR → opens Aegis MirrorP PWA → sees 3-step wizard                │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Layer 1: PWA Frontend (Vercel, public mirror)                            │
│   index.html  +  manifest.json  +  sw.js  +  src/lib/wizard.js           │
│   - Tailwind CDN, Alpine.js, HTMX                                       │
│   - Service Worker caches the shell for offline access                   │
│   - Calls /api/* via Vercel Edge Functions                               │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Layer 2: Edge API (Vercel Edge Functions, public mirror)                 │
│   /api/aegis/check-policy  - proxies to engine, has local fallback       │
│   /api/journal             - returns live defense feed                   │
│   /api/register-test       - beta-portal email registration              │
│   /api/install-state       - GET/POST wizard state                      │
│                                                                          │
│   If AEGIS_ENGINE_URL is set, all requests are proxied to the engine.    │
│   Otherwise, local fallback responses keep the QR scan functional.       │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Layer 3: Private Engine (VPS, private repo)                              │
│   Caddy (TLS termination)  +  PocketBase (SQLite-vec)                    │
│   - 15 tables, seeded with emergency whitelist + mock vectors            │
│   - pb_hooks/main.pb.js implements the deterministic policy router       │
│   - <50ms p50 latency target for /api/aegis/check-policy                 │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Layer 4: Android Kernel (device, private repo)                           │
│   MirrorVpnService.kt captures every packet                              │
│   PolicyClient.kt calls /api/aegis/check-policy for each packet          │
│   Watchdog.kt enforces 50ms latency ceiling (fail-open)                  │
│   protect() exempts GSM/SMS radion from VPN loopback                     │
└──────────────────────────────────────────────────────────────────────────┘
```

## Data flow: a single packet

1. **App on Android** opens a socket to `graph.facebook.com:443`.
2. **MirrorVpnService** captures the packet in its `run()` loop.
3. **PolicyClient** POSTs `{package_name: "com.facebook.katana", destination: "graph.facebook.com"}` to the engine.
4. **PocketBase hook** checks `emergency_whitelist` (miss), then `network_policies` (miss — default allow), then `permission_overrides` (hit — `MOCK` behavior).
5. **Hook** writes a row to `traffic_logs` with the narrative: *"Gorgon virtualized matrix injected mock data for Facebook."*
6. **Hook** returns `{action: "MOCK", narrative: "...", threat_level: "MEDIUM", permission_hint: {mocking_behavior: "SILENT"}}`.
7. **VpnService** writes a synthetic payload back to the tunnel.
8. **PWA** polls `/api/journal` and the new log row appears in the Live Defense Feed.

## Build pipeline

```
git push origin main
   │
   ├─ GitHub Actions: bun install → typecheck → test → build
   │                  (PASS required)
   │
   └─ Vercel: edge deploy
        - Reads AEGIS_ENGINE_URL from environment
        - Wires /api/* rewrites to Edge Functions
        - Serves index.html, manifest.json, sw.js, src/* at root
```

## Robustness rules

1. **Fail-Closed by default.** If the engine is unreachable from the device,
   the VpnService drops packets. The "Block connections without VPN" flag
   keeps the device offline rather than leaking.
2. **Fail-Open watchdog.** If the engine is slow (>50ms p50), the watchdog
   locally allows the packet and logs a "throttled" event. This prevents
   the user from being stuck without internet during engine hiccups.
3. **Emergency whitelist always wins.** The router checks `emergency_whitelist`
   before anything else. A match returns `ALLOW` in <1ms. The four seeded
   patterns are `gov.alert`, `co.il.redalert`, `112`, `911`.
4. **Logging is best-effort.** A failure to write to `traffic_logs` must
   never delay the routing decision. The router swallows log errors.
5. **No secrets in the public mirror.** The `.gitignore` strips `.env`,
   `.db`, `vps/`, `pb_data/`, and any state from the public repo. The
   private engine repo holds the secrets.