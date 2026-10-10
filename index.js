const { exec } = require('child_process');
const http = require('http');
const { startServer } = require('./server/app');
const config = require('./server/config');

// Check if UniversalDrop is already active
function checkAlreadyRunning(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/session/current`, { timeout: 800 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function main() {
  const isRunning = await checkAlreadyRunning(config.PORT);
  if (isRunning) {
    const pcUrl = `http://localhost:${config.PORT}/pc`;
    console.log(`\n======================================================`);
    console.log(`  UniversalDrop is already running!`);
    console.log(`  Opening Dashboard: ${pcUrl}`);
    console.log(`======================================================\n`);
    exec(`start "" "${pcUrl}"`);
    return;
  }

  try {
    const { port } = await startServer(config.PORT);
    const pcUrl = `http://localhost:${port}/pc`;

    console.log(`[UniversalDrop] Opening Desktop Dashboard: ${pcUrl}`);
    exec(`start "" "${pcUrl}"`);
  } catch (err) {
    console.error('[UniversalDrop] Failed to start:', err.message);
    process.exit(1);
  }
}

main();
