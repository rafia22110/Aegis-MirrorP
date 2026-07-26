# Aegis MirrorP

> **Digital Sovereignty Engine** — On-device privacy shield with deterministic network policy routing, identity virtualization, and emergency whitelist bypass.

Aegis MirrorP is the public mirror of the **Aegis Mirror** private engine. It contains the
PWA frontend, the SQLite-vec cognitive schema, the Android VPN kernel source, and the
documentation. Sensitive infrastructure files (PocketBase Go binary, Caddy reverse-proxy
config, VPS deployment scripts, and API credentials) live exclusively in the private
repository.

---

## What This Is

Aegis Mirror gives the user three one-tap shields against modern surveillance:

| Step | Hebrew Label | English Label | What It Does |
|------|--------------|---------------|--------------|
| 1 | חסימת תשתיות | Infrastructure Block (DNS) | Pushes the device to a Private DNS provider so ISP-level trackers can't resolve destinations |
| 2 | מחיקת טביעת אצבע | Fingerprint Erasure (Advertising ID) | Opens the OS Advertising-ID reset screen and walks the user through deletion |
| 3 | הפעלת מגן האגיס | Aegis Shield Activation (Virtualization) | Captures the local VPN permission and switches the engine to `MOCK` mode — every app that asks for camera/mic/location/contacts gets deterministic synthetic vectors instead of the real data |

After the three steps, the device is in **Shield Active** state. The shield stays on by
default; the user can flip to **Bypass** for compatibility with banking apps or voice
calls. Real-time defenses, mock-data decisions, and emergency whitelist bypasses are
visible in the **Live Defense Feed**.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  PUBLIC MIRROR (this repo)                                          │
│                                                                     │
│  index.html  ────  manifest.json  ────  sw.js  ────  PWA shell     │
│       │                                                             │
│       ▼                                                             │
│  src/api/*.ts  ────  HTTP (Vercel Edge)  ────  →  POST /api/...    │
│                                                                     │
│  src/database/schema.sql  (SQLite-vec, 15 tables, on-device)        │
│  src/android/*.kt        (VpnService, packet loopback)             │
│  docs/                    (architecture, threat model)              │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTPS (Vercel ↔ VPS, secrets only)
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  PRIVATE ENGINE (sealed repo, never committed here)                 │
│                                                                     │
│  vps/docker-compose.yml  (Caddy ↔ PocketBase)                       │
│  vps/Caddyfile           (TLS termination)                          │
│  pb_hooks/main.pb.js     (deterministic policy router)              │
│  pb_data/                (live SQLite-vec store)                    │
│  .env                    (VERCEL_TOKEN, VPS_SSH_KEY, secrets)       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start (Public Mirror — Frontend Only)

You can run the PWA locally without the backend. The wizard works offline; only
Live Defense Feed and policy check require the server.

```bash
# Install
npm install

# Dev (Vite HMR on http://localhost:5173)
npm run dev

# Build for Vercel
npm run build

# Deploy (configure VERCEL_TOKEN first)
npx vercel --prod --yes
```

The PWA installs as a standalone app on Android and iOS via the system "Add to
Home Screen" flow. Scanning the deployment QR lands directly on the 3-step
wizard at `/`.

---

## Full System Build (Private Engine — for the operator)

> The following is documented for the maintainer; the public mirror does not
> include these files because they hold credentials and runtime state.

```bash
# 1. Clone the private repo alongside this one
git clone <private-aegis-engine-repo> ../aegis-engine

# 2. Bring up the VPS stack (PocketBase + Caddy on a private bridge network)
cd ../aegis-engine/vps
docker-compose up -d --build

# 3. Apply the SQLite-vec schema
docker exec aegis_pocketbase /pb/pocketbase migrate up

# 4. Build the Android APK (Gradle)
cd ../aegis-engine/src/android
./gradlew assembleRelease

# 5. Wire CI/CD — push to main triggers:
#    - Vercel:    redeploys the PWA from the PUBLIC mirror
#    - SSH/VPS:   git pull + docker-compose up on the engine host
```

---

## Repository Layout

```
Aegis-MirrorP/
├── index.html                 # 3-step wizard + Hub dashboard (single-page)
├── manifest.json              # PWA manifest
├── sw.js                      # Service worker (offline shell)
├── package.json               # Vite build, Vercel deploy
├── vercel.json                # Vercel routing (rewrites → /api/*)
├── vite.config.ts             # Build config
├── tsconfig.json              # TS strict
│
├── src/
│   ├── api/                   # HTTP handlers (Vercel functions)
│   │   ├── check-policy.ts    # POST /api/aegis/check-policy
│   │   ├── journal.ts         # GET  /api/journal
│   │   ├── register-test.ts   # POST /api/register-test
│   │   └── install-state.ts   # POST /api/install-state
│   ├── database/
│   │   └── schema.sql         # 15 tables + seed data
│   ├── android/               # Kotlin VPN service (source only)
│   │   ├── MirrorVpnService.kt
│   │   └── AndroidManifest.xml
│   ├── styles/
│   │   └── aegis.css          # liquid-glass, shield pulses
│   └── lib/
│       ├── dns.ts             # Android DNS intent helpers
│       ├── ads-id.ts          # Advertising-ID reset intent
│       └── shield.ts          # VPN + MOCK activation flow
│
├── tests/
│   ├── wizard.spec.ts         # Playwright: 3-step flow
│   ├── api.spec.ts            # Bun:test: API contracts
│   └── schema.spec.ts         # bun:sqlite: schema sanity
│
├── docs/
│   ├── THREAT-MODEL.md
│   ├── ARCHITECTURE.md
│   └── COMPARISON.md          # What this repo provides vs. the private engine
│
├── .github/
│   └── workflows/
│       └── ci.yml             # typecheck + test on PR
│
└── .gitignore                 # Strips db, .env, VPS configs from public mirror
```

---

## Threat Model Summary

| Adversary | Defense |
|-----------|---------|
| ISP / network observer | Private DNS (step 1) + VPN tunnel loopback |
| Cross-app trackers | Advertising-ID reset (step 2) + per-app MOCK virtualization (step 3) |
| Background beacon spam | Deterministic policy router: every packet is matched against `emergency_whitelist → network_policies → permission_overrides` in <50ms |
| Engine crash | Fail-Closed: kernel-level packet drop + GSM/SMS radio exemption (Android `protect()`) |
| Latency-induced lag | Fail-Open watchdog: if processing exceeds 50ms, constraints release for one cycle |

See [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) for the full version.

---

## License

The public mirror is released under the MIT license. The private engine
(containing credential paths and live runtime data) is not redistributed.

Aegis MirrorP — *Build the shield, then disappear.*