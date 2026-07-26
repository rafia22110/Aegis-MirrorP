# Aegis MirrorP — What's Where

This is the **public mirror** repository. The **private engine** repository
holds the runtime secrets and infrastructure.

## Public Mirror (this repo) — what it contains

| File / directory | Purpose |
|------------------|---------|
| `index.html` | The 3-step wizard + Hub dashboard (single-page PWA) |
| `manifest.json` | PWA manifest (he, RTL, dark theme) |
| `sw.js` | Service worker — offline shell, network-first HTML |
| `src/lib/wizard.js` | Alpine.js wizard logic — DNS, Ads ID, Shield |
| `src/styles/aegis.css` | Shield pulse, liquid-glass, step pills |
| `src/api/*.ts` | Vercel Edge Functions (check-policy, journal, register-test, install-state) |
| `src/database/schema.sql` | SQLite-vec schema — 15 tables + seed data |
| `src/android/MirrorVpnService.kt` | Kotlin VPN service — packet loopback, fail-closed, watchdog |
| `src/android/AndroidManifest.xml` | Android manifest — VPN + foreground service permissions |
| `vps/docker-compose.yml` | Operator-only deployment reference (also in private engine) |
| `vps/Caddyfile` | Operator-only Caddy config (TLS + rate limit) |
| `pb_hooks/main.pb.js` | PocketBase policy router — same logic as the Edge Function fallback |
| `docs/` | Architecture, threat model, this comparison |
| `.github/workflows/ci.yml` | Typecheck + test + Vercel deploy |
| `package.json`, `tsconfig.json`, `vite.config.ts` | Build configuration |
| `vercel.json` | Vercel routing + security headers |

## Private Engine (separate repo) — what's NOT here

| File | Why it's private |
|------|------------------|
| `.env` | Holds `VERCEL_TOKEN`, `AEGIS_ENGINE_URL`, Caddy ACME email |
| `pb_data/data.db` | Live SQLite-vec database — operator's audit trail |
| `pb_data/storage/` | Uploaded user content (if any) |
| `pb_hooks/secrets.pb.js` | Custom hooks that need API keys (e.g. SendGrid for verifier emails) |
| Android signing keystore | `app-release.keystore` and `keystore.properties` |
| `play_store_credentials.json` | Google Play upload key |
| `ACME_EMAIL` env var | Caddy Let's Encrypt contact email |
| `ssh_key` for VPS deploy | Private key, redacted from logs |

## What you can verify from this repo alone

- The full SQLite-vec schema, including seed data.
- The full PocketBase policy router (mirrored in `src/api/check-policy.ts`).
- The full Android VPN service source.
- The full PWA frontend, including the 3-step wizard.
- The deployment topology (Vercel → Caddy → PocketBase).
- The threat model and architecture.

## What you cannot verify

- That the live engine is actually running the same code.
- That the secret-containing environment is configured.
- That the operator's VPS is reachable from your device.

The public mirror's `src/api/check-policy.ts` is designed to fall back to
a sane local response when the engine is unreachable, so the QR scan
demonstrates the wizard flow even without the private engine running.

## License

The public mirror is released under the MIT license. The private engine
is not redistributed. Crown copyright is not asserted over the threat
model or the architecture; you may adopt any of it freely.