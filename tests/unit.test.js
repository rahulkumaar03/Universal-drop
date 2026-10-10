const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { sanitizeFilename, generateSecureToken, generatePairingPin, sha256, safeCompare } = require('../server/security');
const sessionManager = require('../server/session');
const transferEngine = require('../server/transfer');
const config = require('../server/config');

test('Security: sanitizeFilename prevents path traversal and malicious filenames', () => {
  // Test directory traversal attempts
  assert.strictEqual(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.strictEqual(sanitizeFilename('..\\..\\windows\\system32\\cmd.exe'), 'cmd.exe');
  assert.strictEqual(sanitizeFilename('foo/bar/test.png'), 'test.png');
  assert.strictEqual(sanitizeFilename('foo\\bar\\test.jpg'), 'test.jpg');

  // Test null bytes and control chars
  assert.strictEqual(sanitizeFilename('exploit\0.pdf'), 'exploit.pdf');
  assert.strictEqual(sanitizeFilename('bad\x08char.txt'), 'badchar.txt');

  // Test Windows invalid chars: <>:"/\|?*
  const cleaned = sanitizeFilename('my<strange>:file"name?.mp4');
  assert.ok(!/[<>:"/\\|?*]/.test(cleaned));

  // Test reserved Windows names
  const conFile = sanitizeFilename('CON.txt');
  assert.ok(conFile.startsWith('file_CON.txt_'));

  // Test empty/null input
  const defaultFile = sanitizeFilename(null);
  assert.ok(defaultFile.startsWith('received_'));
});

test('Security: Cryptographic token generation & constant-time comparison', () => {
  const token1 = generateSecureToken(32);
  const token2 = generateSecureToken(32);
  assert.strictEqual(token1.length, 64); // 32 bytes hex = 64 chars
  assert.notStrictEqual(token1, token2);

  // Timing safe comparison
  assert.strictEqual(safeCompare(token1, token1), true);
  assert.strictEqual(safeCompare(token1, token2), false);
  assert.strictEqual(safeCompare(token1, 'short'), false);

  // 6-digit PIN generator
  const pin = generatePairingPin();
  assert.strictEqual(pin.length, 6);
  assert.ok(/^[2-9A-HJ-NP-Z]{6}$/.test(pin)); // No confusing 0/O, 1/I
});

test('Session: Lifecycle, Pairing Request, and Mutual Approval', () => {
  const session = sessionManager.initNewSession();
  assert.strictEqual(session.status, 'waiting_for_scan');
  assert.ok(session.sessionId.startsWith('sess_'));
  assert.ok(session.pairingToken);

  // Unauthorized request with invalid token
  const badReq = sessionManager.requestPairing(session.sessionId, 'wrong_token', { name: 'Attacker' });
  assert.strictEqual(badReq.success, false);

  // Valid pairing request from mobile
  const validReq = sessionManager.requestPairing(session.sessionId, session.pairingToken, {
    name: 'iPhone 15 Pro',
    type: 'Mobile'
  });
  assert.strictEqual(validReq.success, true);
  assert.strictEqual(sessionManager.getCurrentSession().status, 'pending_approval');
  assert.strictEqual(sessionManager.getCurrentSession().clientDevice.name, 'iPhone 15 Pro');

  // PC user approves pairing
  const approval = sessionManager.approvePairing(session.sessionId);
  assert.strictEqual(approval.success, true);
  assert.ok(approval.authToken);
  assert.strictEqual(sessionManager.getCurrentSession().status, 'connected');

  // Verify auth validation
  assert.strictEqual(sessionManager.validateAuth(session.sessionId, approval.authToken), true);
  assert.strictEqual(sessionManager.validateAuth(session.sessionId, 'invalid_token'), false);
  assert.strictEqual(sessionManager.validateAuth('wrong_sess', approval.authToken), false);
});

test('Transfer Engine: Chunked file stream, reassembly, and SHA-256 integrity verification', async () => {
  const testData = Buffer.from('UniversalDrop Chunked Transfer Test Data Payload 1234567890!'.repeat(100));
  const expectedHash = crypto.createHash('sha256').update(testData).digest('hex');
  const transferId = 'test_tx_' + Date.now();
  const chunkSize = 256;
  const totalChunks = Math.ceil(testData.length / chunkSize);

  // 1. Start incoming transfer
  const transfer = transferEngine.startIncomingTransfer({
    transferId,
    fileName: 'test_document.txt',
    fileSize: testData.length,
    mimeType: 'text/plain',
    chunkSize,
    totalChunks,
    expectedSha256: expectedHash
  });
  assert.strictEqual(transfer.fileName, 'test_document.txt');
  assert.strictEqual(transfer.status, 'transferring');

  // 2. Stream chunks sequentially
  for (let i = 0; i < totalChunks; i++) {
    const chunk = testData.subarray(i * chunkSize, (i + 1) * chunkSize);
    const progress = await transferEngine.appendChunk(transferId, i, chunk);
    assert.strictEqual(progress.chunksReceived, i + 1);
  }

  // 3. Finalize and verify SHA-256
  const result = await transferEngine.completeIncomingTransfer(transferId, expectedHash);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.sha256, expectedHash);
  assert.ok(fs.existsSync(result.savedPath));

  // Verify content on disk matches exactly
  const savedContent = fs.readFileSync(result.savedPath);
  assert.deepStrictEqual(savedContent, testData);

  // Clean up test file
  fs.unlinkSync(result.savedPath);
});

test('Transfer Engine: Corrupt chunk causes integrity verification failure and cleanup', async () => {
  const testData = Buffer.from('Valid Content');
  const transferId = 'corrupt_tx_' + Date.now();

  transferEngine.startIncomingTransfer({
    transferId,
    fileName: 'corrupt_test.txt',
    fileSize: testData.length,
    chunkSize: testData.length,
    totalChunks: 1,
    expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000' // Intentionally wrong
  });

  await transferEngine.appendChunk(transferId, 0, testData);

  await assert.rejects(
    async () => {
      await transferEngine.completeIncomingTransfer(transferId, '0000000000000000000000000000000000000000000000000000000000000000');
    },
    /Integrity check failed/
  );
});

test('Transfer Engine: Transfer cancellation cleans up temporary partial files', async () => {
  const transferId = 'cancel_tx_' + Date.now();
  const transfer = transferEngine.startIncomingTransfer({
    transferId,
    fileName: 'cancelled_test.bin',
    fileSize: 1024,
    chunkSize: 512,
    totalChunks: 2
  });

  await transferEngine.appendChunk(transferId, 0, Buffer.alloc(512, 1));
  assert.ok(fs.existsSync(transfer.tempFilePath));

  // Cancel
  const cancelled = transferEngine.cancelTransfer(transferId);
  assert.strictEqual(cancelled, true);

  // Temp file should be removed
  assert.strictEqual(fs.existsSync(transfer.tempFilePath), false);
  assert.strictEqual(transferEngine.activeTransfers.has(transferId), false);
});
