const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sanitizeFilename } = require('./security');

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
 * Finds a unique filename in target directory to prevent overwriting existing files.
 */
function getUniqueFilePath(dir, filename) {
  const safeName = sanitizeFilename(filename);
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);

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
        isExecutable: false
      };
    }).sort((a, b) => b.modifiedAt - a.modifiedAt);
  } catch (err) {
    return [];
  }
}

module.exports = {
  ensureDirectories,
  getUniqueFilePath,
  listReceivedFiles
};
