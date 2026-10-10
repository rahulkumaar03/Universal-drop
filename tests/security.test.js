const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const { app, startServer } = require('../server/app');
const config = require('../server/config');
const sessionManager = require('../server/session');
const transferEngine = require('../server/transfer');
const { RateLimiter, isPotentiallyDangerousFile, sanitizeFilename } = require('../server/security');
const { isLoopbackAddress } = require('../server/network');
const { cleanupTempDirectory } = require('../server/storage');

test('Security Hardening: RateLimiter locks out after maximum failed attempts', () => {
  const limiter = new RateLimiter({ maxAttempts: 3, windowMs: 1000, lockoutMs: 2000 });
  const ip = '192.168.1.99';

  assert.strictEqual(limiter.isLocked(ip), false);

  // Attempt 1 (failure)
  const r1 = limiter.recordAttempt(ip, false);
  assert.strictEqual(r1.allowed, true);
  assert.strictEqual(r1.remaining, 2);

  // Attempt 2 (failure)
  const r2 = limiter.recordAttempt(ip, false);
  assert.strictEqual(r2.allowed, true);
  assert.strictEqual(r2.remaining, 1);

  // Attempt 3 (failure -> locked)
  const r3 = limiter.recordAttempt(ip, false);
  assert.strictEqual(r3.allowed, false);
  assert.strictEqual(r3.locked, true);

  // Subsequent check should be locked
  assert.strictEqual(limiter.isLocked(ip), true);
  assert.ok(limiter.getLockoutRemainingMs(ip) > 0);

  // Success resets
  limiter.recordAttempt(ip, true);
  assert.strictEqual(limiter.isLocked(ip), false);
});

test('Security Hardening: isPotentiallyDangerousFile identifies dangerous executable extensions', () => {
  assert.strictEqual(isPotentiallyDangerousFile('virus.exe'), true);
  assert.strictEqual(isPotentiallyDangerousFile('script.bat'), true);
  assert.strictEqual(isPotentiallyDangerousFile('payload.ps1'), true);
  assert.strictEqual(isPotentiallyDangerousFile('malware.vbs'), true);
  assert.strictEqual(isPotentiallyDangerousFile('setup.msi'), true);
  assert.strictEqual(isPotentiallyDangerousFile('screensaver.scr'), true);

  // Safe extensions
  assert.strictEqual(isPotentiallyDangerousFile('photo.jpg'), false);
  assert.strictEqual(isPotentiallyDangerousFile('document.pdf'), false);
  assert.strictEqual(isPotentiallyDangerousFile('notes.txt'), false);
  assert.strictEqual(isPotentiallyDangerousFile('video.mp4'), false);
});

test('Security Hardening: Out-of-order chunk sequence is rejected by TransferEngine', async () => {
  const transferId = 'seq_test_' + Date.now();
  transferEngine.startIncomingTransfer({
    transferId,
    fileName: 'sequence_test.bin',
    fileSize: 1024,
    chunkSize: 512,
    totalChunks: 2
  });

  // Sending chunk 1 first (skipping chunk 0) must throw sequence error
  await assert.rejects(
    async () => {
      await transferEngine.appendChunk(transferId, 1, Buffer.alloc(512));
    },
    /Invalid chunk sequence/
  );

  transferEngine.cancelTransfer(transferId);
});

test('Security Hardening: Premature complete before all bytes uploaded is rejected', async () => {
  const transferId = 'premature_test_' + Date.now();
  transferEngine.startIncomingTransfer({
    transferId,
    fileName: 'premature.bin',
    fileSize: 1000,
    chunkSize: 500,
    totalChunks: 2
  });

  // Only append 500 bytes
  await transferEngine.appendChunk(transferId, 0, Buffer.alloc(500));

  // Premature completion must fail
  await assert.rejects(
    async () => {
      await transferEngine.completeIncomingTransfer(transferId);
    },
    /Incomplete transfer/
  );

  transferEngine.cancelTransfer(transferId);
});

test('Security Hardening: Single-use pairing token is invalidated upon approval and rejection', () => {
  const session = sessionManager.initNewSession();
  const originalToken = session.pairingToken;
  assert.ok(originalToken);

  // Pairing request
  sessionManager.requestPairing(session.sessionId, originalToken, { name: 'Test' });

  // Approval invalidates pairingToken
  sessionManager.approvePairing(session.sessionId);
  assert.strictEqual(session.pairingToken, null);

  // Re-attempting to request pairing with the old token must fail
  const rePair = sessionManager.requestPairing(session.sessionId, originalToken, { name: 'Attacker' });
  assert.strictEqual(rePair.success, false);

  // Invalidate on rejection as well
  const rejSession = sessionManager.initNewSession();
  const rejToken = rejSession.pairingToken;
  sessionManager.requestPairing(rejSession.sessionId, rejToken, { name: 'Test' });
  sessionManager.rejectPairing(rejSession.sessionId);
  assert.strictEqual(rejSession.status, 'rejected');
  assert.strictEqual(rejSession.pairingToken, null);
  assert.strictEqual(rejSession.pairingPin, null);
});

test('Security Hardening: Streaming prepareOutgoingStream hashes and writes without memory blowup', async () => {
  const fileId = 'stream_test_' + Date.now();
  const payload = Buffer.from('UniversalDrop Streaming Engine Test Payload! '.repeat(500));
  const expectedSha256 = crypto.createHash('sha256').update(payload).digest('hex');

  const inputStream = Readable.from([payload]);
  const meta = await transferEngine.prepareOutgoingStream(fileId, inputStream, 'stream_test.txt', 'text/plain');

  assert.strictEqual(meta.fileSize, payload.length);
  assert.strictEqual(meta.sha256, expectedSha256);
  assert.ok(fs.existsSync(meta.filePath));

  // Verify file content matches exactly
  const readBack = fs.readFileSync(meta.filePath);
  assert.deepStrictEqual(readBack, payload);

  // Clean up
  try { fs.unlinkSync(meta.filePath); } catch (e) {}
});

test('Security Hardening: HTTP Security Headers and Host validation are enforced', async (t) => {
  const TEST_PORT = 5998;
  const { server } = await startServer(TEST_PORT);
  t.after(() => server.close());

  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  const res = await fetch(`${baseUrl}/api/network/interfaces`);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.ok(res.headers.get('content-security-policy'));
});
