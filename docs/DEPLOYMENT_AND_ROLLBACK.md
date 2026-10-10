# UniversalDrop — Production Deployment & Rollback Guide

**Target Environment:** Windows 10 / Windows 11 Desktop Agent  
**Process Type:** Local Node.js Background Service / User Agent

---

## 1. Environment Configuration

UniversalDrop uses sensible defaults for offline zero-configuration out-of-the-box usage, with optional environment variable overrides:

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | Integer | `5274` | Local port for Desktop Web Dashboard and Mobile LAN gateway. If occupied, agent attempts `PORT + 1`. |
| `DEVICE_NAME` | String | `<Hostname> (Windows)` | Friendly display name shown on phone pairing screen. |
| `NODE_ENV` | String | `production` | Enables production optimizations and disables debug traces. |

---

## 2. Windows Deployment & Installation Steps

### Prerequisites
- Windows 10/11 (64-bit)
- Node.js (v18.x LTS, v20.x LTS, or v22.x LTS)
- Local network connection (Wi-Fi, Ethernet, or Windows Mobile Hotspot)

### Step 1: Clone & Verify Dependencies
```bash
git clone <repository_url> universaldrop
cd universaldrop
npm ci --only=production
```

### Step 2: Run Automated Quality Check
```bash
npm test
```
All 17 automated regression, security, and performance tests must pass with 0 failures before launching.

### Step 3: Launch Agent
Execute via command prompt or PowerShell:
```bash
npm start
```
Or double-click `start.bat` in the repository root.

The agent will:
1. Verify no existing instance is listening on the target port.
2. Clean up any abandoned temporary files from previous sessions.
3. Start the HTTP and WebSocket server on `0.0.0.0:<PORT>`.
4. Automatically open the default web browser to `http://localhost:<PORT>/pc`.
5. Display the pairing QR code and 6-digit PIN.

---

## 3. Windows Firewall Configuration

When running for the first time, Windows Defender Firewall will prompt:  
*"Windows Defender Firewall has blocked some features of Node.js: Allow on Private Networks."*

**Mandatory Action:**  
- Check **"Private networks, such as home or work network"**.  
- Do **NOT** check "Public networks" unless specifically using a mobile hotspot.  
- This allows incoming connections from your phone on the local subnet while protecting the agent from external access.

---

## 4. Health Checks & Verification

### 4.1 Loopback Health Probe
```bash
curl -I http://127.0.0.1:5274/api/network/interfaces
```
Expected response: `HTTP/1.1 200 OK` with JSON payload containing network candidates.

### 4.2 Security Boundary Verification
```bash
# Verify remote LAN cannot access PC dashboard control endpoint:
# (Simulate non-loopback IP or run from external machine)
curl -s -o /dev/null -w "%{http_code}" http://<LAN_IP>:5274/api/session/current
```
Expected response: `403 Forbidden`.

---

## 5. Rollback Procedures

If an upgrade or build introduces an issue:

### Step 1: Terminate Running Process
In PowerShell:
```powershell
Get-Process -Name node | Where-Object { $_.CommandLine -like "*universaldrop*" } | Stop-Process -Force
```

### Step 2: Switch to Prior Verified Release
```bash
git checkout <previous_git_tag_or_commit_hash>
npm ci --only=production
```

### Step 3: Verify Integrity
```bash
npm test
```

### Step 4: Restart Agent
```bash
npm start
```

---

## 6. Incident Recovery Procedures

| Scenario | Symptom | Action |
| :--- | :--- | :--- |
| **Port Conflict (`EADDRINUSE`)** | Log shows port occupied | UniversalDrop automatically falls back to `PORT + 1`. Check `index.js` which detects running instances and focuses the existing dashboard. |
| **Disk Space Pressure** | Uploads fail with `ENOSPC` | The agent automatically cleans up partial `.part` files on cancellation/failure. Empty `received_files/` or move large files to secondary storage. |
| **Mobile Cannot Reach PC** | Phone shows "Connecting..." indefinitely | Verify PC and phone are on the exact same Wi-Fi subnet or activate Windows Mobile Hotspot and connect phone directly to it. |
| **Stale Temporary Files** | Accumulation of `.part` files after sudden power loss | Restarting UniversalDrop triggers `cleanupTempDirectory()`, immediately unlinking temporary files older than 1 hour. |
