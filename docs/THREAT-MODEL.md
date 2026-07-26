# Aegis MirrorP — Threat Model

## Adversaries

| Adversary | Reach | Capability |
|-----------|-------|------------|
| **ISP / transit network** | Internet backbone | Can see DNS queries, SNI, destination IPs of every packet |
| **Cross-app trackers** | Other apps on the device | Can read advertising ID, contact list, location, microphone, camera |
| **Background beacon spam** | Network observable | Can repeatedly ping tracking endpoints to fingerprint devices |
| **Compromised app** | Sandboxed but installs get permissions | Can request CAMERA/MICROPHONE/LOCATION/CONTACTS without obvious UI |
| **Engine crash** | Local | If the VPN daemon dies, all traffic leaks unfiltered |
| **Adversarial latency** | Local | If the engine takes >50ms, real apps start failing visibly |

## Defenses

### 1. Private DNS (Step 1)

Aegis Mirror ships with a recommended Private DNS host (`dns.aegis-mirror.example`)
that the operator can run on the VPS. The wizard walks the user through pasting
the host into the system Private DNS settings, which:

- Forwards every DNS query to a resolver the operator controls.
- Strips the originating ISP's ability to log destination domains.
- Optionally blocks known tracker domains at the resolver level.

**Limitations:** This does not hide SNI. For SNI hiding, the operator can
deploy Encrypted Client Hello (ECH) on the resolver.

### 2. Advertising ID reset (Step 2)

Every call to `Settings.Global.ADVERTISING_ID` returns the same per-device
identifier until the user resets it. The wizard opens the Google Ads Privacy
screen so the user can clear the ID. After clearing, every call returns a
new random ID, breaking the cross-app tracking graph.

**Limitations:** Apps that fingerprint via hardware signals (battery level,
screen size, font list) remain fingerprintable. Step 3 addresses this with
mock data.

### 3. Aegis Shield + Virtualization (Step 3)

The VpnService captures every outbound packet on the device. The policy
router on the VPS decides its fate:

| Decision | Behavior |
|----------|----------|
| `ALLOW` | Packet is looped back and sent out normally |
| `DENY`  | Packet is dropped silently; `traffic_logs` records the narrative |
| `MOCK`  | Packet is replaced with a synthetic payload before being sent out |

Additionally, when an app asks for CAMERA, MICROPHONE, LOCATION, or CONTACTS
the engine returns synthetic vectors seeded from the user's trust score.
The app never sees the real data.

**Fail-Closed:** If the engine crashes, the Android "Block connections
without VPN" flag prevents traffic from leaking. GSM voice and SMS
radio channels are exempted via `protect()` so emergency calls still
work.

**Fail-Open watchdog:** If the engine's per-packet latency exceeds 50ms,
the watchdog temporarily releases constraints to keep the device usable.
The decision is logged so the user can see when their shield was throttled.

## Out of scope

- **Nation-state physical access.** If the adversary has the device in
  their hands and can disassemble it, no on-device defense survives.
- **Coerced unlock.** If the user is forced to unlock the device, the
  shield cannot help.
- **Supply-chain compromise.** The private engine repository is the
  operator's responsibility; this public mirror provides static review
  only.

## Audit trail

Every policy decision is recorded in `traffic_logs` with a humanized
narrative. The Live Defense Feed surfaces these decisions to the user
in real time (10-second poll). The audit log is append-only and is
the operator's primary evidence trail for post-incident review.