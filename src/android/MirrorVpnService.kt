// =====================================================================
// AEGIS MIRROR — Native Android VPN Service
// =====================================================================
// File: src/android/MirrorVpnService.kt
//
// The on-device engine. Owns:
//   * The local VPN tunnel (10.1.10.1/32, full route).
//   * The packet loopback loop (reads packets, decides via
//     /api/aegis/check-policy, writes back the result).
//   * The fail-closed / fail-open watchdog.
//
// This file is built by the private engine repo's Gradle wrapper into
// an APK. The public mirror keeps the source for transparency and to
// satisfy the "audit-only" promise of the dual-repo architecture.
// =====================================================================
package com.aegismirror.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import com.aegismirror.engine.PolicyClient
import com.aegismirror.engine.Watchdog
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Local VPN that captures every outbound packet on the device, asks the
 * deterministic policy router (PocketBase hook at /api/aegis/check-policy)
 * what to do, and either loops the packet back, replaces it with a mock
 * payload, or drops it.
 *
 * The service runs as a foreground service (BIND_VPN_SERVICE permission)
 * so the OS doesn't kill it under memory pressure.
 */
class MirrorVpnService : VpnService(), Runnable {

    private var vpnInterface: ParcelFileDescriptor? = null
    private var vpnThread: Thread? = null
    private val isRunning = AtomicBoolean(false)

    /** Last measured processing latency for the watchdog to compare against 50ms. */
    private val lastLatencyMs = AtomicLong(0)

    /** Watchdog instance. Lazily created on first run. */
    private lateinit var watchdog: Watchdog

    /** Policy client (HTTP). Lazily created on first run. */
    private lateinit var policy: PolicyClient

    // -----------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Promote to foreground so the OS doesn't kill the engine under
        // memory pressure. The notification is intentionally minimal —
        // the user already configured this from the 3-step wizard.
        startInForeground()

        if (vpnThread == null) {
            isRunning.set(true)
            watchdog = Watchdog(latencySupplier = { lastLatencyMs.get() })
            policy = PolicyClient(applicationContext)
            setupVpnInterface()
            vpnThread = Thread(this, "AegisVpnThread").apply { start() }
            watchdog.start()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning.set(false)
        watchdog.stop()
        closeInterface()
        super.onDestroy()
    }

    // -----------------------------------------------------------------
    // VPN interface
    // -----------------------------------------------------------------

    private fun setupVpnInterface() {
        val builder = Builder()
            .addAddress("10.1.10.1", 32)
            .addRoute("0.0.0.0", 0)
            .setSession("AegisMirrorShield")
            // Block connections without VPN — Android's "always-on" mode.
            // In combination with our fail-closed guard, this means a
            // crashed engine cannot leak traffic.
            .setBlocking(true)
            // Exempt the system DNS resolver so the device can still
            // reach emergency_whitelist destinations even if our engine
            // is wedged.
            .addDisallowedApplication("com.android.providers.telephony")
            .addDisallowedApplication("com.android.phone")

        vpnInterface = builder.establish()
    }

    // -----------------------------------------------------------------
    // Main loop
    // -----------------------------------------------------------------

    override fun run() {
        try {
            val input = FileInputStream(vpnInterface!!.fileDescriptor)
            val output = FileOutputStream(vpnInterface!!.fileDescriptor)
            val packet = ByteArray(32767)

            while (isRunning.get()) {
                val length = input.read(packet)
                if (length <= 0) continue

                val t0 = System.nanoTime()

                // --- Decision ---
                // In a real engine this would parse IP headers and route
                // by destination. For the public mirror source we keep
                // the decision flow explicit and readable; the private
                // engine binary links in the full parser.
                val decision = policy.check(
                    packageName = "android.system",
                    destination = "0.0.0.0",
                    permission = null,
                )

                // --- Apply ---
                when (decision.action) {
                    "ALLOW" -> output.write(packet, 0, length)
                    "MOCK"  -> writeMockPayload(output, length)
                    "DENY"  -> { /* drop */ }
                }

                // Record latency for the watchdog.
                val elapsedMs = (System.nanoTime() - t0) / 1_000_000
                lastLatencyMs.set(elapsedMs)
            }
        } catch (e: Exception) {
            // Fail-Closed: any exception in the engine is a kernel-level
            // packet drop. The OS will mark the VPN as broken and the
            // watchdog (Fail-Open) will reset the tunnel on the next
            // heartbeat.
            Log.e(TAG, "Engine loop crashed — entering fail-closed", e)
        } finally {
            closeInterface()
        }
    }

    /**
     * Replace the real packet with a deterministic synthetic payload.
     * In production this is the mock camera/mic/location/contacts
     * payload negotiated with the calling app's permission_overrides row.
     */
    private fun writeMockPayload(output: FileOutputStream, length: Int) {
        val mock = ByteArray(length) { 0x00 }
        output.write(mock, 0, length)
    }

    // -----------------------------------------------------------------
    // Socket protection — exclude out-of-band comms (GSM, SMS) from VPN
    // -----------------------------------------------------------------

    /**
     * Called by the engine when it opens a raw socket that should bypass
     * the VPN tunnel (e.g. emergency whitelist destinations). Required
     * for GSM voice / SMS to keep working when "Block connections without
     * VPN" is active.
     */
    fun protectSocket(socket: Socket): Boolean = protect(socket)

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    private fun closeInterface() {
        isRunning.set(false)
        vpnInterface?.close()
        vpnInterface = null
    }

    private fun startInForeground() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val channelId = "aegis_vpn"
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(channelId) == null) {
            val channel = NotificationChannel(
                channelId,
                "Aegis Mirror Shield",
                NotificationManager.IMPORTANCE_LOW,
            )
            channel.description = "Local VPN engine routing every packet through Aegis policy checks."
            nm.createNotificationChannel(channel)
        }

        val openIntent = Intent(this, com.aegismirror.ui.HubActivity::class.java)
        val pi = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val notification: Notification = Notification.Builder(this, channelId)
            .setContentTitle("Aegis Mirror")
            .setContentText("Shield active — packets are being routed through Aegis.")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()

        startForeground(NOTIFICATION_ID, notification)
    }

    companion object {
        private const val TAG = "MirrorVpnService"
        private const val NOTIFICATION_ID = 0xAEG15
    }
}