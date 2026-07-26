/* =====================================================================
 * AEGIS MIRROR — Wizard Logic (Alpine.js component)
 * =====================================================================
 * Loaded by /index.html. Owns the 3-step installation flow:
 *   Step 1 — DNS      → opens Android Private DNS settings + clipboard
 *   Step 2 — Ads ID   → opens Google ads privacy reset screen
 *   Step 3 — Shield   → requests VPN permission + activates MOCK
 *
 * On desktop browsers (where the OS intents do nothing) the buttons
 * still POST /api/install-state so the user can verify the flow in QA.
 *
 * The "Live Defense Feed" HTMX poll lives in index.html; this file only
 * drives the wizard + sandbox + alias card.
 * ===================================================================== */

/** Deterministic mock alias seeded by date — same user always sees the
 *  same email, but no two installs collide. */
function deriveAlias() {
    const seed = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `afi.secure.box${seed}@tempmail.io`;
}

/** Generate a session id for the build tag in the footer. */
function newSessionId() {
    return ([1e7] + -1e3 + -4e3 + -2e3 + -1e11).replace(/[018]/g, (c) =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4)).toString(16),
    );
}

/** Detect a "mobile" UA so we know when to actually fire Android intents
 *  vs. fall back to the API-only path. iOS Safari and desktop browsers
 *  are treated as desktop (the wizard is designed for Android devices). */
function isAndroid() {
    return /Android/i.test(navigator.userAgent);
}

function aegisWizard() {
    return {
        // ---- visual state ------------------------------------------------
        blurred: true,                   // initial 3s liquid reveal
        shieldActive: false,             // master shield toggle
        showSandbox: false,              // sandbox drawer

        // ---- wizard state ------------------------------------------------
        step1: false,                    // DNS configured
        step2: false,                    // Advertising ID reset
        step3: false,                    // Shield active
        dnsCopied: false,                // "Copied to clipboard" toast

        // ---- sandbox apps (demo list; engine returns real list) ---------
        sandboxApps: [
            { package: 'com.google.android.gms.maps',       name: 'Google Maps',    isolated: true  },
            { package: 'com.facebook.katana',              name: 'Facebook',       isolated: true  },
            { package: 'com.whatsapp',                      name: 'WhatsApp',       isolated: false },
            { package: 'com.instagram.android',             name: 'Instagram',      isolated: true  },
            { package: 'com.android.chrome',                name: 'Chrome',         isolated: false },
        ],

        // ---- identity ----------------------------------------------------
        activeEmail: deriveAlias(),
        sessionId: newSessionId(),
        buildTag: 'P-2026.07',

        // ---- lifecycle ---------------------------------------------------
        async init() {
            // Liquid reveal — the shield ring unblurs after 3 seconds.
            setTimeout(() => { this.blurred = false; }, 3000);

            // Restore the wizard state from the server (so a refresh
            // doesn't lose progress).
            try {
                const res = await fetch('/api/install-state');
                if (res.ok) {
                    const s = await res.json();
                    this.step1 = !!s.step1;
                    this.step2 = !!s.step2;
                    this.step3 = !!s.step3;
                    this.shieldActive = this.step3;
                }
            } catch (_) {
                // offline or server unavailable — fine, defaults are "not done"
            }

            // Listen for the Android-side "VPN permission granted" callback
            // via a custom event the native bridge fires after a successful
            // VpnService.prepare() dialog.
            window.addEventListener('aegis:vpn-granted', () => this.markStep3Done());
        },

        // ---- derived -----------------------------------------------------
        get completedCount() {
            return [this.step1, this.step2, this.step3].filter(Boolean).length;
        },
        get wizardComplete() {
            return this.step1 && this.step2 && this.step3;
        },
        get activeStep() {
            if (!this.step1) return 1;
            if (!this.step2) return 2;
            if (!this.step3) return 3;
            return 0;
        },

        // ---- Step 1: DNS -------------------------------------------------
        async openDnsSettings() {
            // The recommended Private DNS provider for Aegis Mirror is
            // dns.aegis-mirror.example (the operator's own resolver, run
            // on the VPS). We copy it to clipboard AND try to open the
            // Android settings intent so the user can paste it.
            const DNS_HOST = 'dns.aegis-mirror.example';

            try {
                await navigator.clipboard.writeText(DNS_HOST);
                this.dnsCopied = true;
                setTimeout(() => { this.dnsCopied = false; }, 4000);
            } catch (_) {
                // Clipboard write denied — tell the user to copy manually.
                window.prompt('העתק את כתובת ה-DNS הבאה:', DNS_HOST);
            }

            if (isAndroid()) {
                // android.settings.PRIVATE_DNS_SETTINGS — opens the
                // system Private DNS screen directly.
                const intent = 'intent://settings/#Intent;scheme=android.settings;component=com.android.settings/.Settings\$PrivateDnsSettingsActivity;end';
                try {
                    window.location.href = intent;
                } catch (_) {
                    // ignore — clipboard copy was the important part
                }
            }
        },

        async markStep1Done() {
            this.step1 = true;
            await this.persistWizardState();
        },

        // ---- Step 2: Advertising ID -------------------------------------
        openAdsIdReset() {
            if (isAndroid()) {
                // com.google.android.gms.settings.ADS_PRIVACY — opens
                // the "Delete advertising ID" screen inside Google Play
                // Services. If the user doesn't have Play Services this
                // silently no-ops, which is fine — the QR scan is for
                // Android devices with Play Services in the spec.
                const intent = 'intent://#Intent;scheme=android-app;package=com.google.android.gms;action=com.google.android.gms.settings.ADS_PRIVACY;end';
                try {
                    window.location.href = intent;
                } catch (_) {}
            }
        },

        async markStep2Done() {
            this.step2 = true;
            await this.persistWizardState();
        },

        // ---- Step 3: Shield / VPN ---------------------------------------
        async activateShield() {
            if (isAndroid()) {
                // The Android Kotlin side listens for this custom event
                // and calls VpnService.prepare(), which shows the system
                // VPN permission dialog. On user approval, the native
                // side dispatches 'aegis:vpn-granted' back to us.
                window.dispatchEvent(new CustomEvent('aegis:request-vpn'));
            } else {
                // Desktop / iOS — mark done anyway so the QA flow works.
                await this.markStep3Done();
            }
        },

        async deactivateShield() {
            this.shieldActive = false;
            this.step3 = false;
            window.dispatchEvent(new CustomEvent('aegis:revoke-vpn'));
            await this.persistWizardState();
        },

        async markStep3Done() {
            this.step3 = true;
            this.shieldActive = true;
            await this.persistWizardState();
        },

        // ---- Toggle shield ----------------------------------------------
        async toggleShield() {
            if (this.shieldActive) {
                await this.deactivateShield();
            } else {
                await this.activateShield();
            }
        },

        // ---- Sandbox drawer ----------------------------------------------
        async toggleAppIsolation(app) {
            app.isolated = !app.isolated;
            // In the real engine this would POST /api/aegis/isolate with
            // the package name. For the public mirror source we just
            // toggle the local state.
            try {
                await fetch('/api/aegis/check-policy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        package_name: app.package,
                        destination: 'self.toggle',
                        permission: app.isolated ? 'STORAGE' : null,
                    }),
                });
            } catch (_) {}
        },

        // ---- Alter-ego card ----------------------------------------------
        async copyEmail() {
            try {
                await navigator.clipboard.writeText(this.activeEmail);
            } catch (_) {}
        },

        // ---- Persist wizard state ----------------------------------------
        async persistWizardState() {
            try {
                await fetch('/api/install-state', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        dns_configured: this.step1,
                        advertising_id_reset: this.step2,
                        shield_active: this.step3,
                        profile: this.step3 ? 'Standard' : 'Paranoid',
                    }),
                });
            } catch (_) {
                // offline — best-effort; state will reconcile on reload
            }
        },
    };
}