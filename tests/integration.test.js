const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');

const { app, startServer } = require('../server/app');
const config = require('../server/config');
const sessionManager = require('../server/session');

test('E2E Integration: QR Scan -> Pairing Approval -> Chunked File Transfer -> SHA-256 Verification -> Download', async (t) => {
  const TEST_PORT = 5999;
  const { server } = await startServer(TEST_PORT);

  t.after(() => {
    server.close();
  });

  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  const wsUrl = `ws://127.0.0.1:${TEST_PORT}/ws`;

  // 1. PC connects to WebSocket
  const pcWs = new WebSocket(`${wsUrl}?type=pc`);
  await new Promise(resolve => pcWs.once('open', resolve));

  // 2. Fetch current session & QR details
  const sessionRes = await fetch(`${baseUrl}/api/session/current`);
  const sessionData = await sessionRes.json();
  assert.ok(sessionData.session.sessionId);
  assert.ok(sessionData.qrCode);
  const sessionId = sessionData.session.sessionId;
  const pairingPin = sessionData.session.pairingPin;

  // 3. Phone initiates pairing request via PIN
  let pairRequestedReceived = false;
  pcWs.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'pair:requested') {
      pairRequestedReceived = true;
    }
  });

  const pairReqRes = await fetch(`${baseUrl}/api/pair/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      pairingPin,
      deviceInfo: {
        name: 'Pixel 8 Pro',
        type: 'Mobile'
      }
    })
  });
  const pairReqData = await pairReqRes.json();
  assert.strictEqual(pairReqData.success, true);
  assert.strictEqual(pairReqData.status, 'pending_approval');

  // Wait a moment for PC WS event
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(pairRequestedReceived, true);

  // 4. PC User clicks "Approve Connection"
  const approveRes = await fetch(`${baseUrl}/api/pair/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });
  const approveData = await approveRes.json();
  assert.strictEqual(approveData.success, true);
  assert.ok(approveData.authToken);
  const authToken = approveData.authToken;

  // 5. Phone client uploads a 300 KB file in 64 KB chunks
  const fileContent = crypto.randomBytes(300 * 1024);
  const expectedSha256 = crypto.createHash('sha256').update(fileContent).digest('hex');
  const transferId = 'tx_e2e_' + Date.now();
  const chunkSize = 64 * 1024;
  const totalChunks = Math.ceil(fileContent.length / chunkSize);

  // Negotiate start
  const startRes = await fetch(`${baseUrl}/api/transfer/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': authToken,
      'x-session-id': sessionId
    },
    body: JSON.stringify({
      transferId,
      fileName: 'trip_photo.jpg',
      fileSize: fileContent.length,
      mimeType: 'image/jpeg',
      chunkSize,
      totalChunks,
      expectedSha256
    })
  });
  const startData = await startRes.json();
  assert.strictEqual(startData.success, true);

  // Stream each chunk
  for (let i = 0; i < totalChunks; i++) {
    const chunk = fileContent.subarray(i * chunkSize, (i + 1) * chunkSize);
    const chunkRes = await fetch(`${baseUrl}/api/transfer/chunk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-auth-token': authToken,
        'x-session-id': sessionId,
        'x-transfer-id': transferId,
        'x-chunk-index': i.toString()
      },
      body: chunk
    });
    const chunkData = await chunkRes.json();
    assert.strictEqual(chunkData.success, true);
  }

  // Finalize & complete
  const completeRes = await fetch(`${baseUrl}/api/transfer/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': authToken,
      'x-session-id': sessionId
    },
    body: JSON.stringify({
      transferId,
      sha256: expectedSha256
    })
  });
  const completeData = await completeRes.json();
  assert.strictEqual(completeData.success, true);
  assert.strictEqual(completeData.sha256, expectedSha256);

  // 6. Verify file can be downloaded and matches bit-for-bit
  const downloadRes = await fetch(`${baseUrl}/api/files/download/${encodeURIComponent(completeData.fileName)}`);
  assert.strictEqual(downloadRes.status, 200);
  const downloadedBuf = Buffer.from(await downloadRes.arrayBuffer());
  assert.deepStrictEqual(downloadedBuf, fileContent);

  // Clean up
  try {
    fs.unlinkSync(path.join(config.RECEIVED_DIR, completeData.fileName));
  } catch (e) {}

  pcWs.close();
});
