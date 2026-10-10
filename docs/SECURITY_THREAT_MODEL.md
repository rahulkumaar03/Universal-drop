# UniversalDrop — Defensive Security Threat Model

**Version:** 1.0  
**Scope:** Device-to-Device Local File Transfer Agent & Browser Clients  
**Framework:** STRIDE / OWASP ASVS Defensive Architecture

---

## 1. System Assets

| Asset ID | Asset Name | Description | Sensitivity |
| :--- | :--- | :--- | :--- |
| **A-1** | Transferred User Files | Photos, videos, documents, and archives stored in `received_files/` | High (Confidentiality & Integrity) |
| **A-2** | Active Session Auth Tokens | Cryptographic 32-byte tokens authorizing ongoing transfers | High (Authorization) |
| **A-3** | Pairing PIN & Pairing Tokens | 6-digit alphanumeric PIN and 32-byte single-use tokens displayed on PC monitor | Medium (Temporary Authenticator) |
| **A-4** | Local Host Filesystem | Host Windows system files and directories outside `received_files/` | Critical (Integrity & Protection from Traversal) |
| **A-5** | Host Memory and CPU Resources | Node.js process resources and disk space in temporary folders | High (Availability / DoS Protection) |

---

## 2. Trust Boundaries

```
                 [ Physical Environment ]
              (User Views Screen & Scans QR)
                            │
┌───────────────────────────┴─────────────────────────────┐
│ TRUST BOUNDARY 1: Host Localhost Loopback (127.0.0.1)    │
│  - PC Desktop Dashboard (/pc)                           │
│  - Control Endpoints (/api/pair/approve, /api/session)  │
│  - Local Windows Explorer Launcher                      │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────┴─────────────────────────────┐
│ TRUST BOUNDARY 2: Local Network (Wi-Fi / Hotspot LAN)   │
│  - Mobile Phone Browser (/mobile)                       │
│  - Binary Transfer Streaming (/api/transfer/*)          │
│  - Untrusted LAN Peers (Potential Attackers on Wi-Fi)   │
└─────────────────────────────────────────────────────────┘
```

1. **Boundary 1 (Host PC Loopback):**  
   Components running on `127.0.0.1` / `::1`. The host desktop user has ultimate authority to initiate new sessions, approve or decline pairing, and open the storage folder.
2. **Boundary 2 (Local Area Network / Hotspot):**  
   Any device connected to the local Wi-Fi subnet or Windows Hotspot. Devices here are considered UNTRUSTED until they successfully complete physical pairing with explicit approval.

---

## 3. Attack Surfaces

- **HTTP REST Endpoints:**  
  - Public LAN: `/api/pair/request`, `/api/transfer/start`, `/api/transfer/chunk`, `/api/transfer/complete`, `/api/transfer/cancel`, `/api/files/download/:id`
  - Loopback Only: `/api/session/current`, `/api/session/new`, `/api/pair/approve`, `/api/pair/reject`, `/api/files/open-folder`, `/api/network/select-ip`, `/api/pc/send-file`
- **WebSocket Gateway (`/ws`):**  
  - `type=pc`: Localhost only, relays live transfer states.
  - `type=mobile`: Authenticated mobile clients, relays file offers and chat text.
- **File Ingestion Engine:**  
  - Filename parsing and directory resolution in `server/storage.js`.
  - Binary chunk stream handling in `server/transfer.js`.

---

## 4. Threat Scenarios & Mitigations (STRIDE Matrix)

### 4.1 Spoofing Identity
- **Threat:** A rogue LAN device attempts to impersonate an authorized phone to inject files into the host PC.
- **Mitigation:**
  - Phone must provide both `sessionId` and cryptographically random `pairingToken` (or 6-character high-entropy PIN).
  - Explicit physical approval dialog pops up on PC displaying the device name, IP, and timestamp.
  - Once paired, single-use `pairingToken` is revoked and replaced by a cryptographically random session `authToken` (`crypto.randomBytes(32)`).
  - Constant-time string comparison (`safeCompare`) prevents timing attacks.

### 4.2 Tampering with Data
- **Threat:** Malicious data corruption or out-of-order chunks sent during transmission to forge or corrupt received files.
- **Mitigation:**
  - Incremental SHA-256 calculation computed stream-wise as binary chunks arrive.
  - Finalization requires matching SHA-256 digest before moving from `.part` to `received_files/`.
  - Mismatched files are immediately deleted from disk.
  - Chunks must arrive strictly sequentially (`chunkIndex === chunksReceived`).

### 4.3 Repudiation
- **Threat:** Unacknowledged or untracked transfers.
- **Mitigation:**
  - Structured history logging maintains records of file name, size, direction, timestamp, SHA-256 hash, and status in memory.

### 4.4 Information Disclosure
- **Threat:** LAN eavesdroppers reading files or pairing tokens.
- **Mitigation:**
  - `/api/session/current` and `/ws?type=pc` are strictly prohibited on non-loopback IPs via `requireLocalhost`.
  - Download endpoint (`/api/files/download/:idOrName`) requires valid session token or loopback origin.
  - Directory listing (`/api/files/received`) is protected behind session authentication.

### 4.5 Denial of Service (DoS)
- **Threat:** Flooding pairing requests to brute-force PINs or exhausting server RAM with oversized transfers.
- **Mitigation:**
  - `RateLimiter` locks out client IP after 5 failed attempts for 120 seconds.
  - `MAX_CONCURRENT_TRANSFERS` (default 4) prevents worker exhaustion.
  - `prepareOutgoingStream` pipes files directly to disk without holding files in heap memory.
  - Maximum chunk size bounded to 2 MB; JSON body limit bounded to 100 KB.
  - WebSocket `maxPayload` set to 128 KB.
  - Stale transfers idle for > 60 seconds are automatically aborted and temporary files unlinked.

### 4.6 Elevation of Privilege
- **Threat:** Directory traversal attack writing arbitrary files outside `received_files/` (e.g., into `System32` or startup scripts) or command injection via Windows Explorer.
- **Mitigation:**
  - `sanitizeFilename` strips null bytes, directory separators (`/`, `\`), traversal sequences (`..`), and Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`).
  - Safe file uniqueness resolver (`getUniqueFilePath`) prevents overwriting existing files.
  - `explorer.exe` launched via `child_process.spawn` with array arguments, completely avoiding command shell (`cmd.exe`) interpolation.
  - Executable extensions flagged as potentially dangerous.

---

## 5. Verification Test Matrix

| Threat | Verified By Automated Test | Test File |
| :--- | :--- | :--- |
| **Path Traversal** | `Security: sanitizeFilename prevents path traversal and malicious filenames` | `tests/unit.test.js` |
| **Timing Attacks** | `Security: Cryptographic token generation & constant-time comparison` | `tests/unit.test.js` |
| **Pairing Brute Force** | `Security Hardening: RateLimiter locks out after maximum failed attempts` | `tests/security.test.js` |
| **Corrupt Chunk Injection** | `Transfer Engine: Corrupt chunk causes integrity verification failure and cleanup` | `tests/unit.test.js` |
| **Out-of-Order Chunks** | `Security Hardening: Out-of-order chunk sequence is rejected by TransferEngine` | `tests/security.test.js` |
| **Memory Exhaustion** | `Security Hardening: Streaming prepareOutgoingStream hashes and writes without memory blowup` | `tests/security.test.js` |
| **Resource Leaks / Stale Files** | `Performance & Scalability: Stale transfer timeout cleaner recovers abandoned slots` | `tests/performance.test.js` |

---

## 6. Residual Risk Summary

- **Local Wi-Fi Eavesdropping:** In unencrypted public Wi-Fi environments (without WPA2/WPA3 enterprise), local traffic is visible to passive RF sniffers.  
  *Recommendation:* In untrusted public venues, users should activate the built-in Windows Mobile Hotspot and connect directly to the PC's private Wi-Fi network.
