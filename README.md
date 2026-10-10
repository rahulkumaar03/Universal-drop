# UniversalDrop

**UniversalDrop** is an offline-first, device-to-device local transfer system for files, photos, videos, and text between a phone and PC/laptop with zero cloud accounts or internet required.

---

## Key Features

- **Offline-First & Local Network**: Transfers run entirely over local Wi-Fi, Ethernet, or Phone/PC Hotspot without touching external cloud servers.
- **Zero Account / Zero Setup**: No registration or login. The phone simply connects through its browser.
- **QR & PIN Pairing**: Scan the generated QR code or enter the short 6-digit session PIN.
- **Explicit Consent**: Connections require manual approval on the host PC before data exchange begins.
- **Chunked Streaming & Backpressure**: Streams files in 64 KB chunks to handle small or large files efficiently without filling memory.
- **SHA-256 Integrity Verification**: Incremental cryptographic checksum computed during transmission and verified upon assembly.
- **Path Traversal Protection**: Filenames are sanitized, preventing arbitrary disk access or execution of received files.
- **Bi-Directional Transfer**:
  - **Phone → PC**: Camera photos, videos, documents, or arbitrary files.
  - **PC → Phone**: Drag & drop desktop files or send instant text/URLs.
- **Synthesized Audio Notifications**: Offline Web Audio API feedback for connection requests and completed transfers.

---

## Architecture Overview

```
Phone Browser (Safari / Chrome / Edge)
      │
      │ Local HTTP / WebSocket
      ▼
Windows UniversalDrop Agent (Node.js)
      ├─ Network Discovery (Wi-Fi, Ethernet, Hotspot detection)
      ├─ Session & Pairing Service (Cryptographic tokens + Expiry)
      ├─ Chunked Transfer Engine (SHA-256 + Backpressure)
      ├─ Security Layer (Filename sanitization + Rate limits)
      └─ Glassmorphism Desktop UI (localhost:5274/pc)
```

---

## Quick Start (Windows)

### 1. Launch with Batch Script
Double-click `start.bat` in the repository root.

### 2. Or Launch via Command Line
```bash
npm install
npm start
```

This starts the UniversalDrop agent on `http://localhost:5274` and automatically opens the Desktop Dashboard in your default browser.

---

## User Journey: Scan → Connect → Send

1. **Launch Agent**: Start UniversalDrop on your PC.
2. **Scan QR Code**: Point your phone camera or QR scanner at the PC screen.
3. **Approve**: An incoming connection banner pops up on the PC. Click **"Approve Connection"**.
4. **Transfer**: Tap **"Photos & Videos"** or **"Files & Docs"** on your phone, or drag and drop files onto the PC dashboard.
5. **Verified**: The file is streamed with a live progress bar, verified via SHA-256, and stored safely in `received_files/`.

---

## Running Tests

Run the test suite covering filename sanitization, session security, chunk streaming, SHA-256 verification, and end-to-end integration:

```bash
npm test
```

---

## Directory Structure

```
universaldrop/
├── server/
│   ├── app.js            # Express & WebSocket server
│   ├── config.js         # Port, chunk size, timeouts, limits
│   ├── network.js        # Auto-detects Wi-Fi, Ethernet, Hotspot
│   ├── security.js       # Sanitization, tokens, SHA-256 helpers
│   ├── session.js        # Pairing handshake & session lifecycle
│   ├── storage.js        # Safe storage in received_files/
│   └── transfer.js       # Chunked streaming & integrity engine
├── public/
│   ├── pc/               # Desktop Agent Dashboard (HTML/CSS/JS)
│   ├── mobile/           # Mobile Phone Client (HTML/CSS/JS)
│   └── shared/           # Web Audio API chime synthesizer
├── tests/
│   ├── unit.test.js      # Unit tests (6 tests)
│   └── integration.test.js # E2E Integration test (1 test)
├── received_files/       # Default folder for incoming files
├── index.js              # Entry point with browser auto-open
├── start.bat             # 1-click Windows launcher
└── package.json
```
