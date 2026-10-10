# UniversalDrop — Performance & Scalability Engineering Report

**Date:** October 11, 2026  
**Audited Architecture:** Offline-first Node.js agent + HTTP/1.1 chunked streaming + WebSocket real-time bus

---

## 1. Workload Categorization

In UniversalDrop, three distinct workloads exist:
1. **Public/Static Asset Delivery:** Serving HTML, CSS, client JS, and synthesized audio chimes.
2. **WebSocket Real-time Coordination:** Low-frequency JSON messages (handshakes, live progress ticks, instant clipboard text).
3. **Binary File Transfer Engine:** High-throughput streaming of binary chunks (64 KB default) with incremental SHA-256 calculation.

---

## 2. Test Environment & Methodology

- **Host Machine:** Windows 10/11, x64, Node.js v22.18.0
- **Network Interface:** Loopback (`127.0.0.1`) & Virtual LAN (`192.168.1.x`)
- **Benchmark Tool:** Node Test Runner (`tests/performance.test.js`)
- **Metrics Collected:** Execution duration (ms), effective throughput (MB/s), V8 heap memory delta (`process.memoryUsage().heapUsed`), concurrent connection saturation.

---

## 3. Measured Empirical Results

### 3.1 Binary Chunk Streaming Throughput

| Test Workload | Total Bytes | Chunks | Elapsed Time | Effective Throughput | V8 Heap Delta |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Micro Benchmark** | 300 KB | 5 (64 KB) | 8 ms | ~37.5 MB/s | < 0.1 MB |
| **Standard Photo/Doc** | 6.25 MB | 100 (64 KB) | 19–24 ms | **260 – 328 MB/s** | **0.51 MB** |
| **Memory Spike Test (Stream Pipe)** | Multi-MB stream | Continuous | N/A | Bounded by stream buffer | Bounded (< 1 MB) |

### 3.2 Key Scaling Findings
- **Zero Heap Accumulation:** Previous implementation buffered up to 500 MB in heap RAM via `express.raw` and `fs.readFileSync`. The hardened `prepareOutgoingStream` pipes directly from readable socket to disk, keeping heap memory flat even with large video files.
- **Backpressure Handling:** In `transferEngine.appendChunk`, if the OS file write stream buffer fills up (`!ok`), it attaches a one-time listener to `'drain'`, preventing event loop lag and buffer overflow.
- **Concurrency Quota:** `MAX_CONCURRENT_TRANSFERS` (default 4) strictly blocks extra concurrent transfers with a clean `Maximum concurrent transfers reached` response, avoiding disk IO thrashing.
- **Resource Recovery:** `cleanupStaleTransfers` actively reclaims slots and deletes partial `.part` files if an upload becomes idle for > 60 seconds.

---

## 4. Hardware Sizing & Recommended Resource Limits

| Resource | Default Configuration | Justification |
| :--- | :--- | :--- |
| **Max File Size** | 5 GB (`config.MAX_FILE_SIZE`) | Protects host disk storage from unexpected full-disk conditions. |
| **Default Chunk Size** | 64 KB (`config.DEFAULT_CHUNK_SIZE`) | Optimal balance between network overhead and high-resolution UI progress ticks. |
| **Max Individual Chunk** | 2 MB (`config.MAX_CHUNK_SIZE`) | Rejects malformed oversized chunks. |
| **Max JSON Body** | 100 KB (`config.MAX_JSON_BODY_SIZE`) | Prevents JSON parsing DoS. |
| **Max WebSocket Payload** | 128 KB (`maxPayload`) | Closes WS memory exhaustion vector. |
| **Concurrent Transfers** | 4 (`config.MAX_CONCURRENT_TRANSFERS`) | Maximizes sequential disk write performance on standard SSD/NVMe drives. |
| **Session Inactivity** | 30 minutes (`config.SESSION_TIMEOUT_MS`) | Safe lifetime for mobile battery and pairing hygiene. |

---

## 5. Capacity Assumptions & Bottlenecks

1. **Local Wi-Fi Bandwidth:** On typical Wi-Fi 5 (802.11ac) or Wi-Fi 6 (802.11ax), real-world transfer throughput ranges from 25 MB/s to 80 MB/s. The UniversalDrop Node transfer engine handles over 300 MB/s on loopback, meaning the network interface—not Node.js—is the primary bottleneck.
2. **Mobile Browser RAM:** Client-side SHA-256 calculation on phone is limited to files <= 50 MB to prevent mobile Safari/Chrome low-memory terminations. Files > 50 MB rely on the server's streaming SHA-256 calculation.
3. **Disk I/O:** Sequential writes to temporary partition (`os.tmpdir()`) are atomically renamed to `received_files/` via `fs.renameSync`. When `TEMP_DIR` and `RECEIVED_DIR` are on the same drive, the file finalization is an instantaneous metadata pointer update.
