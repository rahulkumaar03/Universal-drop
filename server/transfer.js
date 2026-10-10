const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { sanitizeFilename } = require('./security');
const { getUniqueFilePath } = require('./storage');
const sessionManager = require('./session');

class TransferEngine {
  constructor() {
    this.activeTransfers = new Map();
    this.outgoingFiles = new Map(); // Files queued to send from PC to Phone
  }

  /**
   * Starts an incoming transfer (Phone -> PC)
   */
  startIncomingTransfer({ transferId, fileName, fileSize, mimeType, chunkSize, totalChunks, expectedSha256 }) {
    if (!transferId || !fileName || typeof fileSize !== 'number') {
      throw new Error('Invalid transfer metadata');
    }

    if (fileSize > config.MAX_FILE_SIZE) {
      throw new Error(`File size ${fileSize} exceeds maximum allowed (${config.MAX_FILE_SIZE} bytes)`);
    }

    if (this.activeTransfers.size >= config.MAX_CONCURRENT_TRANSFERS) {
      throw new Error('Maximum concurrent transfers reached. Please wait for ongoing transfers to finish.');
    }

    const safeName = sanitizeFilename(fileName);
    const tempFileName = `temp_${transferId}_${Date.now()}.part`;
    const tempFilePath = path.join(config.TEMP_DIR, tempFileName);

    const writeStream = fs.createWriteStream(tempFilePath, { flags: 'w' });
    const hash = crypto.createHash('sha256');

    const transfer = {
      id: transferId,
      direction: 'incoming',
      fileName: safeName,
      originalName: fileName,
      fileSize,
      mimeType: mimeType || 'application/octet-stream',
      chunkSize: chunkSize || config.DEFAULT_CHUNK_SIZE,
      totalChunks: totalChunks || Math.ceil(fileSize / (chunkSize || config.DEFAULT_CHUNK_SIZE)),
      expectedSha256: expectedSha256 ? expectedSha256.toLowerCase() : null,
      tempFilePath,
      writeStream,
      hash,
      bytesReceived: 0,
      chunksReceived: 0,
      status: 'transferring', // 'transferring', 'completed', 'cancelled', 'failed'
      startTime: Date.now(),
      lastChunkTime: Date.now(),
      speedBps: 0,
      etaSeconds: 0,
      error: null
    };

    this.activeTransfers.set(transferId, transfer);
    return transfer;
  }

  /**
   * Writes a binary chunk for an incoming transfer
   */
  async appendChunk(transferId, chunkIndex, chunkBuffer) {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) {
      throw new Error('Transfer not found or already completed/cancelled');
    }

    if (transfer.status !== 'transferring') {
      throw new Error(`Transfer is not in active state (status: ${transfer.status})`);
    }

    // Write chunk to file stream
    await new Promise((resolve, reject) => {
      const ok = transfer.writeStream.write(chunkBuffer, (err) => {
        if (err) reject(err);
        else resolve();
      });
      // Backpressure handling if stream buffer is full
      if (!ok) {
        transfer.writeStream.once('drain', resolve);
      }
    });

    // Update SHA-256 hash
    transfer.hash.update(chunkBuffer);

    // Update progress stats
    transfer.bytesReceived += chunkBuffer.length;
    transfer.chunksReceived++;
    const now = Date.now();
    const elapsedSeconds = Math.max(0.1, (now - transfer.startTime) / 1000);
    transfer.speedBps = Math.round(transfer.bytesReceived / elapsedSeconds);

    const remainingBytes = Math.max(0, transfer.fileSize - transfer.bytesReceived);
    transfer.etaSeconds = transfer.speedBps > 0 ? Math.ceil(remainingBytes / transfer.speedBps) : 0;
    transfer.lastChunkTime = now;

    return {
      id: transfer.id,
      bytesReceived: transfer.bytesReceived,
      fileSize: transfer.fileSize,
      progressPercent: Math.min(100, (transfer.bytesReceived / transfer.fileSize) * 100),
      chunksReceived: transfer.chunksReceived,
      totalChunks: transfer.totalChunks,
      speedBps: transfer.speedBps,
      etaSeconds: transfer.etaSeconds
    };
  }

  /**
   * Finalizes an incoming transfer, verifying integrity and safely moving the file
   */
  async completeIncomingTransfer(transferId, clientSha256 = null) {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) {
      throw new Error('Transfer not found');
    }

    // Close write stream
    await new Promise((resolve, reject) => {
      transfer.writeStream.end((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Compute final hash
    const computedSha256 = transfer.hash.digest('hex');
    const expectedHash = clientSha256 ? clientSha256.toLowerCase() : transfer.expectedSha256;

    if (expectedHash && computedSha256 !== expectedHash) {
      transfer.status = 'failed';
      transfer.error = `Integrity check failed! Expected SHA-256 ${expectedHash}, got ${computedSha256}`;
      // Clean up corrupt temp file
      if (fs.existsSync(transfer.tempFilePath)) {
        try { fs.unlinkSync(transfer.tempFilePath); } catch (e) {}
      }
      this.activeTransfers.delete(transferId);
      sessionManager.recordHistory({
        id: transfer.id,
        fileName: transfer.fileName,
        fileSize: transfer.fileSize,
        direction: 'incoming',
        status: 'failed',
        sha256: computedSha256
      });
      throw new Error(transfer.error);
    }

    // Integrity passed! Move temp file to received_files directory safely
    const finalPath = getUniqueFilePath(config.RECEIVED_DIR, transfer.fileName);
    try {
      fs.renameSync(transfer.tempFilePath, finalPath);
    } catch (renameErr) {
      // In case rename fails across drives, copy and unlink
      fs.copyFileSync(transfer.tempFilePath, finalPath);
      fs.unlinkSync(transfer.tempFilePath);
    }

    transfer.status = 'completed';
    transfer.finalPath = finalPath;
    transfer.finalFileName = path.basename(finalPath);
    transfer.sha256 = computedSha256;

    this.activeTransfers.delete(transferId);

    sessionManager.recordHistory({
      id: transfer.id,
      fileName: transfer.finalFileName,
      fileSize: transfer.fileSize,
      direction: 'incoming',
      status: 'completed',
      sha256: computedSha256
    });

    return {
      success: true,
      transferId,
      fileName: transfer.finalFileName,
      fileSize: transfer.fileSize,
      sha256: computedSha256,
      savedPath: finalPath
    };
  }

  /**
   * Cancels an incoming transfer and removes partial files
   */
  cancelTransfer(transferId) {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return false;

    transfer.status = 'cancelled';
    try {
      transfer.writeStream.destroy();
    } catch (e) {}

    if (fs.existsSync(transfer.tempFilePath)) {
      try {
        fs.unlinkSync(transfer.tempFilePath);
      } catch (e) {}
    }

    this.activeTransfers.delete(transferId);

    sessionManager.recordHistory({
      id: transfer.id,
      fileName: transfer.fileName,
      fileSize: transfer.fileSize,
      direction: transfer.direction,
      status: 'cancelled'
    });

    return true;
  }

  /**
   * Registers a file to be sent from PC to Phone
   */
  prepareOutgoingFile(fileId, filePath, fileName, fileSize, mimeType) {
    const stats = fs.statSync(filePath);
    const safeName = sanitizeFilename(fileName || path.basename(filePath));
    const size = fileSize || stats.size;

    // Compute SHA-256 for the outgoing file
    const fileBuffer = fs.readFileSync(filePath);
    const sha = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    const meta = {
      id: fileId,
      filePath,
      fileName: safeName,
      fileSize: size,
      mimeType: mimeType || 'application/octet-stream',
      sha256: sha,
      chunkSize: config.DEFAULT_CHUNK_SIZE,
      totalChunks: Math.ceil(size / config.DEFAULT_CHUNK_SIZE),
      createdAt: Date.now()
    };

    this.outgoingFiles.set(fileId, meta);
    return meta;
  }

  getOutgoingFile(fileId) {
    return this.outgoingFiles.get(fileId);
  }

  getActiveTransfers() {
    const list = [];
    for (const [id, t] of this.activeTransfers.entries()) {
      list.push({
        id,
        direction: t.direction,
        fileName: t.fileName,
        fileSize: t.fileSize,
        bytesReceived: t.bytesReceived,
        progressPercent: t.fileSize > 0 ? (t.bytesReceived / t.fileSize) * 100 : 0,
        speedBps: t.speedBps,
        etaSeconds: t.etaSeconds,
        status: t.status
      });
    }
    return list;
  }
}

module.exports = new TransferEngine();
