const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sanitizeFilename, isPotentiallyDangerousFile } = require('./security');

// Ensure directories exist
function ensureDirectories() {
  if (!fs.existsSync(config.RECEIVED_DIR)) {
    fs.mkdirSync(config.RECEIVED_DIR, { recursive: true });
  }
  if (!fs.existsSync(config.TEMP_DIR)) {
    fs.mkdirSync(config.TEMP_DIR, { recursive: true });
  }
}

ensureDirectories();

/**
 * Cleans up abandoned temporary files older than maxAgeMs (default: 1 hour)
 */
function cleanupTempDirectory(maxAgeMs = config.TEMP_FILE_MAX_AGE_MS || 3600000) {
  ensureDirectories();
  try {
    const files = fs.readdirSync(config.TEMP_DIR);
    const now = Date.now();
    let cleanedCount = 0;

    for (const file of files) {
      const fullPath = path.join(config.TEMP_DIR, file);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
          cleanedCount++;
        }
      } catch (e) {
        // Ignore single-file deletion error
      }
    }
    return cleanedCount;
  } catch (err) {
    return 0;
  }
}

/**
 * Finds a unique filename in target directory to prevent overwriting existing files.
 */
function getUniqueFilePath(dir, filename) {
  const safeName = sanitizeFilename(filename);
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext) || 'file';

  let targetPath = path.join(dir, safeName);
  let counter = 1;

  while (fs.existsSync(targetPath)) {
    targetPath = path.join(dir, `${base} (${counter})${ext}`);
    counter++;
  }

  return targetPath;
}

/**
 * Lists received files with stats
 */
function listReceivedFiles() {
  ensureDirectories();
  try {
    const files = fs.readdirSync(config.RECEIVED_DIR);
    return files.map(file => {
      const fullPath = path.join(config.RECEIVED_DIR, file);
      const stat = fs.statSync(fullPath);
      return {
        name: file,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        isExecutable: isPotentiallyDangerousFile(file)
      };
    }).sort((a, b) => b.modifiedAt - a.modifiedAt);
  } catch (err) {
    return [];
  }
}

module.exports = {
  ensureDirectories,
  cleanupTempDirectory,
  getUniqueFilePath,
  listReceivedFiles
};
