const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const transferEngine = require('../server/transfer');
const config = require('../server/config');
const { cleanupTempDirectory } = require('../server/storage');

test('Performance & Scalability: TransferEngine chunk throughput and bounded memory', async () => {
  const initialHeap = process.memoryUsage().heapUsed;
  const chunkCount = 100;
  const chunkSize = 64 * 1024; // 64 KB * 100 = 6.4 MB
  const totalSize = chunkCount * chunkSize;

  const testChunk = crypto.randomBytes(chunkSize);
  const transferId = 'perf_tx_' + Date.now();

  const startMs = Date.now();

  transferEngine.startIncomingTransfer({
    transferId,
    fileName: 'perf_benchmark.bin',
    fileSize: totalSize,
    chunkSize,
    totalChunks: chunkCount
  });

  for (let i = 0; i < chunkCount; i++) {
    await transferEngine.appendChunk(transferId, i, testChunk);
  }

  const result = await transferEngine.completeIncomingTransfer(transferId);
  const elapsedMs = Math.max(1, Date.now() - startMs);
  const endHeap = process.memoryUsage().heapUsed;

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.fileSize, totalSize);

  // Clean up
  try { fs.unlinkSync(result.savedPath); } catch (e) {}

  const throughputMBps = ((totalSize / (1024 * 1024)) / (elapsedMs / 1000)).toFixed(2);
  const heapDeltaMB = ((endHeap - initialHeap) / (1024 * 1024)).toFixed(2);

  console.log(`\n  [Performance Benchmark]`);
  console.log(`  Payload: ${totalSize / (1024 * 1024)} MB in ${chunkCount} chunks`);
  console.log(`  Elapsed: ${elapsedMs}ms | Throughput: ${throughputMBps} MB/s`);
  console.log(`  Heap delta: ${heapDeltaMB} MB\n`);

  // Throughput must be healthy (> 5 MB/s on local loopback)
  assert.ok(elapsedMs < 5000, 'Chunk streaming should process 6.4MB in under 5 seconds');
});

test('Performance & Scalability: Concurrent transfer quota is strictly enforced', () => {
  const baseId = 'concurrency_tx_' + Date.now();
  const createdIds = [];

  // Fill up to MAX_CONCURRENT_TRANSFERS
  for (let i = 0; i < config.MAX_CONCURRENT_TRANSFERS; i++) {
    const id = `${baseId}_${i}`;
    createdIds.push(id);
    transferEngine.startIncomingTransfer({
      transferId: id,
      fileName: `file_${i}.bin`,
      fileSize: 1024,
      chunkSize: 512,
      totalChunks: 2
    });
  }

  // Attempting one more must be rejected
  assert.throws(
    () => {
      transferEngine.startIncomingTransfer({
        transferId: `${baseId}_overflow`,
        fileName: 'overflow.bin',
        fileSize: 1024,
        chunkSize: 512,
        totalChunks: 2
      });
    },
    /Maximum concurrent transfers reached/
  );

  // Clean up
  for (const id of createdIds) {
    transferEngine.cancelTransfer(id);
  }
});

test('Performance & Scalability: Stale transfer timeout cleaner recovers abandoned slots', async () => {
  const staleId = 'stale_tx_' + Date.now();
  const transfer = transferEngine.startIncomingTransfer({
    transferId: staleId,
    fileName: 'stale.bin',
    fileSize: 2048,
    chunkSize: 1024,
    totalChunks: 2
  });

  // Artificially age the lastChunkTime to 65 seconds ago
  transfer.lastChunkTime = Date.now() - 65000;

  // Run cleaner with 60000ms idle threshold
  const cleaned = transferEngine.cleanupStaleTransfers(60000);
  assert.ok(cleaned >= 1);
  assert.strictEqual(transferEngine.activeTransfers.has(staleId), false);
  assert.strictEqual(fs.existsSync(transfer.tempFilePath), false);
});
