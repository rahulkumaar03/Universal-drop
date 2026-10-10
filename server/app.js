const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode = require('qrcode');

const config = require('./config');
const { getNetworkInterfaces, getPrimaryLocalIp, isLoopbackAddress, isLocalClient } = require('./network');
const sessionManager = require('./session');
const transferEngine = require('./transfer');
const { sanitizeFilename, safeCompare, RateLimiter } = require('./security');
const { listReceivedFiles, cleanupTempDirectory } = require('./storage');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 128 * 1024 // 128 KB max payload to prevent WS DoS
});

wss.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error('WebSocket Server error:', err.message);
  }
});

let selectedNetworkIp = null;

// Brute-force pairing rate limiter
const pairingLimiter = new RateLimiter({
  maxAttempts: config.MAX_PAIRING_ATTEMPTS || 5,
  windowMs: 60000,
  lockoutMs: config.PAIRING_LOCKOUT_MS || 120000
});

// Clean up temporary storage on startup
cleanupTempDirectory();

// Periodic maintenance timers (stale transfers and temp files)
const staleTransferInterval = setInterval(() => {
  try {
    transferEngine.cleanupStaleTransfers(config.TRANSFER_IDLE_TIMEOUT_MS || 60000);
  } catch (e) {}
}, 30000);

const tempCleanInterval = setInterval(() => {
  try {
    cleanupTempDirectory();
  } catch (e) {}
}, 15 * 60 * 1000);

if (staleTransferInterval.unref) staleTransferInterval.unref();
if (tempCleanInterval.unref) tempCleanInterval.unref();

// Security HTTP Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self' ws: wss:; " +
    "object-src 'none'; " +
    "frame-ancestors 'none';"
  );
  next();
});

// Host header validation to mitigate DNS Rebinding
app.use((req, res, next) => {
  const host = req.headers.host;
  if (!host) {
    return res.status(400).send('Missing Host header');
  }
  const hostname = host.split(':')[0].toLowerCase();
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  try {
    for (const iface of getNetworkInterfaces()) {
      allowedHosts.add(iface.address.toLowerCase());
    }
  } catch (e) {}

  if (!allowedHosts.has(hostname)) {
    return res.status(403).send('Forbidden: Invalid Host header');
  }
  next();
});

// Middleware for body parsing & static asset delivery
app.use(express.json({ limit: config.MAX_JSON_BODY_SIZE || '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Store connected WebSocket clients
const clients = {
  pc: new Set(),
  mobile: new Set()
};

// Queue of recent outgoing file offers for mobile
const recentFileOffers = [];

function broadcastToPc(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const ws of clients.pc) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function broadcastToMobile(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const ws of clients.mobile) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function broadcastAll(type, data) {
  broadcastToPc(type, data);
  broadcastToMobile(type, data);
}

// Security Guard: PC Localhost Loopback Only (or host machine interface / cloud environment)
function requireLocalhost(req, res, next) {
  // Allow if running in cloud serverless environment (e.g. Vercel)
  if (process.env.VERCEL || process.env.CLOUD_DEPLOYMENT) {
    return next();
  }

  const clientIp = req.socket?.remoteAddress || req.ip;
  if (!isLocalClient(clientIp)) {
    return res.status(403).json({ error: 'Forbidden: PC Local loopback access only' });
  }

  // Cross-Origin check to prevent CSRF from internet pages visiting localhost
  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const originHost = originUrl.hostname.toLowerCase();
      if (!isLocalClient(originHost)) {
        return res.status(403).json({ error: 'Forbidden: Cross-site request rejected' });
      }
    } catch (e) {
      return res.status(403).json({ error: 'Forbidden: Malformed Origin' });
    }
  }

  next();
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const clientIp = req.socket?.remoteAddress;
  const isLocal = isLocalClient(clientIp) || Boolean(process.env.VERCEL);

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    ws.close(1002, 'Malformed URL');
    return;
  }

  const clientType = url.searchParams.get('type') || 'unknown'; // 'pc' or 'mobile'
  const sessionId = url.searchParams.get('session');
  const token = url.searchParams.get('token');

  if (clientType === 'pc') {
    // Strictly require localhost loopback or host interface for PC Dashboard WebSocket
    if (!isLocal) {
      ws.close(4403, 'PC Dashboard requires loopback connection');
      return;
    }

    // Origin check on PC WebSocket to prevent Cross-Site WebSocket Hijacking
    const origin = req.headers.origin;
    if (origin && !process.env.VERCEL) {
      try {
        const originUrl = new URL(origin);
        if (!isLocalClient(originUrl.hostname)) {
          ws.close(4403, 'Cross-origin PC WebSocket rejected');
          return;
        }
      } catch (e) {
        ws.close(4403, 'Invalid Origin');
        return;
      }
    }

    clients.pc.add(ws);
    // Send initial status
    ws.send(JSON.stringify({
      type: 'init',
      data: {
        session: sessionManager.getCurrentSession(),
        deviceName: config.DEVICE_NAME,
        activeIp: getPrimaryLocalIp(selectedNetworkIp)
      }
    }));
  } else if (clientType === 'mobile') {
    clients.mobile.add(ws);

    // Only deliver prior messages and pending file offers if mobile presents valid session authorization
    const isMobileAuth = sessionId && token && sessionManager.validateAuth(sessionId, token);
    if (isMobileAuth) {
      const recentMsgs = sessionManager.getMessages();
      for (const msgItem of recentMsgs) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'text:received', data: msgItem }));
        }
      }
      for (const offer of recentFileOffers) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'file:offered', data: offer }));
        }
      }
    }
  }

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message.toString());
      handleWsMessage(ws, clientType, msg);
    } catch (e) {
      console.error('WS parse error:', e.message);
    }
  });

  ws.on('close', () => {
    if (clientType === 'pc') clients.pc.delete(ws);
    if (clientType === 'mobile') {
      clients.mobile.delete(ws);
      if (sessionManager.currentSession && sessionManager.currentSession.status === 'connected') {
        broadcastToPc('peer:disconnected', { message: 'Phone disconnected' });
      }
    }
  });
});

function handleWsMessage(ws, clientType, msg) {
  switch (msg.type) {
    case 'text:send': {
      const { text, sender } = msg.data || {};
      if (!text || typeof text !== 'string') return;
      const textItem = {
        id: 'txt_' + Date.now(),
        text: text.slice(0, config.MAX_TEXT_LENGTH || 50000),
        sender: sender || (clientType === 'pc' ? 'PC' : 'Mobile'),
        timestamp: Date.now()
      };
      sessionManager.addMessage(textItem);
      broadcastAll('text:received', textItem);
      break;
    }
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;
    default:
      break;
  }
}

// Auth Middleware for protected transfer APIs
function requireSessionAuth(req, res, next) {
  const clientIp = req.socket?.remoteAddress || req.ip;
  const isLocal = isLocalClient(clientIp);

  // Allow local PC dashboard if role is PC
  if (isLocal && req.headers['x-client-role'] === 'pc') {
    return next();
  }

  const token = req.headers['x-auth-token'] || req.query.token;
  const sessionId = req.headers['x-session-id'] || req.query.sessionId;

  if (!sessionId || !token || !sessionManager.validateAuth(sessionId, token)) {
    return res.status(401).json({ error: 'Unauthorized: Session invalid or expired' });
  }

  next();
}

// Helper: build mobile URL
function buildMobileUrl(req = null) {
  const session = sessionManager.getCurrentSession();
  let baseUrl;
  const host = req?.headers?.host;
  const isVercel = Boolean(process.env.VERCEL);
  const isCloudHost = host && !host.includes('localhost') && !host.includes('127.0.0.1') && !host.startsWith('192.168.') && !host.startsWith('10.') && !host.startsWith('172.');

  if (req && (isVercel || isCloudHost)) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    baseUrl = `${proto}://${host}`;
  } else {
    const ip = getPrimaryLocalIp(selectedNetworkIp);
    baseUrl = `http://${ip}:${config.PORT}`;
  }
  return `${baseUrl}/mobile/index.html?session=${session.sessionId}&token=${session.pairingToken}&pin=${session.pairingPin}`;
}

// REST Routes

// Smart root redirect
app.get('/', (req, res) => {
  const userAgent = req.headers['user-agent'] || '';
  const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  if (isMobile) {
    return res.redirect('/mobile/index.html');
  }
  return res.redirect('/pc/index.html');
});

// Network adapters
app.get('/api/network/interfaces', (req, res) => {
  const interfaces = getNetworkInterfaces();
  const primary = getPrimaryLocalIp(selectedNetworkIp);
  res.json({
    interfaces,
    activeIp: primary,
    port: config.PORT,
    deviceName: config.DEVICE_NAME
  });
});

app.post('/api/network/select-ip', requireLocalhost, (req, res) => {
  const { ip } = req.body || {};
  selectedNetworkIp = ip;
  res.json({ success: true, activeIp: getPrimaryLocalIp(selectedNetworkIp) });
});

// Session status & QR Code (Restricted to Localhost PC Dashboard or Cloud Environment)
app.get('/api/session/current', requireLocalhost, async (req, res) => {
  let session = sessionManager.getCurrentSession();
  if (session.status === 'expired' || session.status === 'rejected' || (!session.pairingPin && session.status !== 'connected')) {
    session = sessionManager.initNewSession();
  }
  const mobileUrl = buildMobileUrl(req);
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(mobileUrl, {
      margin: 1,
      width: 280,
      color: {
        dark: '#1e293b',
        light: '#ffffff'
      }
    });
  } catch (err) {
    console.error('QR generation error:', err);
  }

  res.json({
    session: {
      sessionId: session.sessionId,
      pairingPin: session.pairingPin,
      status: session.status,
      clientDevice: session.clientDevice,
      expiresAt: session.expiresAt
    },
    deviceName: config.DEVICE_NAME,
    activeIp: getPrimaryLocalIp(selectedNetworkIp),
    port: config.PORT,
    mobileUrl,
    qrCode: qrDataUrl
  });
});

app.post('/api/session/new', requireLocalhost, async (req, res) => {
  transferEngine.cancelAllTransfers();
  sessionManager.initNewSession();
  broadcastAll('session:reset', { session: sessionManager.getCurrentSession() });
  res.json({ success: true, session: sessionManager.getCurrentSession() });
});

// Mobile requests pairing approval (Rate-limited, constant-time token comparison)
app.post('/api/pair/request', (req, res) => {
  const clientIp = req.socket?.remoteAddress || req.ip || 'unknown';

  if (pairingLimiter.isLocked(clientIp)) {
    const remainingMs = pairingLimiter.getLockoutRemainingMs(clientIp);
    return res.status(429).json({
      success: false,
      error: `Too many failed pairing attempts. Please wait ${Math.ceil(remainingMs / 1000)}s.`
    });
  }

  const { sessionId, pairingToken, pairingPin, deviceInfo } = req.body || {};
  const current = sessionManager.getCurrentSession();

  const tokenMatch = Boolean(pairingToken && current.pairingToken && safeCompare(pairingToken, current.pairingToken));
  const pinMatch = Boolean(
    pairingPin &&
    current.pairingPin &&
    safeCompare(pairingPin.toString().toUpperCase(), current.pairingPin.toUpperCase())
  );

  if (!tokenMatch && !pinMatch) {
    pairingLimiter.recordAttempt(clientIp, false);
    return res.status(403).json({ success: false, error: 'Invalid pairing token or PIN' });
  }

  // Valid attempt -> reset rate limiter for this IP
  pairingLimiter.recordAttempt(clientIp, true);

  const clientData = {
    name: deviceInfo?.name || 'Phone Device',
    type: deviceInfo?.type || 'Mobile Browser',
    userAgent: req.headers['user-agent'] || 'Unknown',
    ip: clientIp
  };

  const result = sessionManager.requestPairing(sessionId || current.sessionId, current.pairingToken, clientData);
  if (!result.success) {
    return res.status(400).json(result);
  }

  // Notify PC UI of incoming pair request
  broadcastToPc('pair:requested', {
    sessionId: current.sessionId,
    client: clientData
  });

  res.json({ success: true, status: 'pending_approval' });
});

// PC approves pairing (Localhost only)
app.post('/api/pair/approve', requireLocalhost, (req, res) => {
  const { sessionId } = req.body || {};
  const result = sessionManager.approvePairing(sessionId);
  if (!result.success) {
    return res.status(400).json(result);
  }

  // Notify Mobile client with the established authToken
  broadcastToMobile('pair:approved', {
    sessionId,
    authToken: result.authToken,
    deviceName: config.DEVICE_NAME
  });

  // Notify PC that connection is active
  broadcastToPc('pair:connected', {
    sessionId,
    clientDevice: result.clientDevice
  });

  res.json({ success: true, authToken: result.authToken });
});

// PC rejects pairing (Localhost only)
app.post('/api/pair/reject', requireLocalhost, (req, res) => {
  const { sessionId } = req.body || {};
  const result = sessionManager.rejectPairing(sessionId);

  broadcastToMobile('pair:rejected', {
    sessionId,
    reason: 'Connection rejected by host PC'
  });

  broadcastToPc('pair:rejected', { sessionId });
  res.json({ success: true });
});

// Disconnect
app.post('/api/pair/disconnect', (req, res) => {
  transferEngine.cancelAllTransfers();
  sessionManager.disconnect();
  broadcastAll('pair:disconnected', { message: 'Session disconnected' });
  res.json({ success: true });
});

// Transfer API

// 1. Negotiate transfer start
app.post('/api/transfer/start', requireSessionAuth, (req, res) => {
  const { transferId, fileName, fileSize, mimeType, chunkSize, totalChunks, expectedSha256 } = req.body || {};
  try {
    const transfer = transferEngine.startIncomingTransfer({
      transferId,
      fileName,
      fileSize,
      mimeType,
      chunkSize,
      totalChunks,
      expectedSha256
    });

    broadcastAll('transfer:started', {
      transferId,
      fileName: transfer.fileName,
      fileSize: transfer.fileSize,
      direction: transfer.direction
    });

    res.json({ success: true, transferId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 2. Binary Chunk Upload
app.post(
  '/api/transfer/chunk',
  requireSessionAuth,
  express.raw({ type: 'application/octet-stream', limit: '2mb' }),
  async (req, res) => {
    const transferId = req.headers['x-transfer-id'];
    const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);

    if (!transferId || isNaN(chunkIndex)) {
      return res.status(400).json({ error: 'Missing x-transfer-id or x-chunk-index header' });
    }

    const chunkBuffer = req.body;
    if (!chunkBuffer || chunkBuffer.length === 0) {
      return res.status(400).json({ error: 'Empty chunk body' });
    }

    try {
      const progress = await transferEngine.appendChunk(transferId, chunkIndex, chunkBuffer);

      // Broadcast progress update
      broadcastAll('transfer:progress', progress);

      res.json({ success: true, progress });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// 3. Finalize Transfer & Integrity Check
app.post('/api/transfer/complete', requireSessionAuth, async (req, res) => {
  const { transferId, sha256: clientSha256 } = req.body || {};
  try {
    const result = await transferEngine.completeIncomingTransfer(transferId, clientSha256);

    broadcastAll('transfer:completed', {
      transferId,
      fileName: result.fileName,
      fileSize: result.fileSize,
      sha256: result.sha256
    });

    res.json(result);
  } catch (err) {
    broadcastAll('transfer:failed', {
      transferId,
      error: err.message
    });
    res.status(400).json({ error: err.message });
  }
});

// 4. Cancel Transfer
app.post('/api/transfer/cancel', requireSessionAuth, (req, res) => {
  const { transferId } = req.body || {};
  const ok = transferEngine.cancelTransfer(transferId);
  if (ok) {
    broadcastAll('transfer:cancelled', { transferId });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Transfer not found or already ended' });
  }
});

// 5. Send file from PC to Phone (Streaming directly to disk without memory buffering)
app.post('/api/pc/send-file', requireLocalhost, async (req, res) => {
  const rawFileName = req.headers['x-file-name'] || 'file.bin';
  let fileName = 'file.bin';
  try {
    fileName = decodeURIComponent(rawFileName);
  } catch (e) {
    fileName = rawFileName;
  }

  const mimeType = req.headers['x-mime-type'] || req.headers['content-type'] || 'application/octet-stream';
  const safeName = sanitizeFilename(fileName);
  const fileId = 'out_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

  try {
    // Stream request body directly into temp storage while computing SHA-256 hash
    const meta = await transferEngine.prepareOutgoingStream(fileId, req, safeName, mimeType);

    const offerData = {
      fileId: meta.id,
      fileName: meta.fileName,
      fileSize: meta.fileSize,
      mimeType: meta.mimeType,
      sha256: meta.sha256,
      downloadUrl: `/api/files/download/${meta.id}`,
      timestamp: Date.now()
    };

    recentFileOffers.push(offerData);
    if (recentFileOffers.length > 25) recentFileOffers.shift();

    // Notify Phone client that a file is available to download
    broadcastToMobile('file:offered', offerData);

    sessionManager.recordHistory({
      id: meta.id,
      fileName: meta.fileName,
      fileSize: meta.fileSize,
      direction: 'outgoing',
      status: 'completed',
      sha256: meta.sha256
    });

    broadcastToPc('history:updated', { history: sessionManager.getHistory() });

    res.json({ success: true, file: meta, offer: offerData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint for mobile to fetch recent/pending file offers
app.get('/api/files/pending', requireSessionAuth, (req, res) => {
  res.json({ files: recentFileOffers });
});

// Download endpoint for received files or outgoing files (Protected)
app.get('/api/files/download/:idOrName', (req, res) => {
  const clientIp = req.socket?.remoteAddress || req.ip;
  const isLocal = isLocalClient(clientIp);

  const token = req.headers['x-auth-token'] || req.query.token;
  const sessionId = req.headers['x-session-id'] || req.query.sessionId;

  // Must be local PC dashboard or verified mobile session
  const isAuthorized = isLocal || (sessionId && token && sessionManager.validateAuth(sessionId, token));
  if (!isAuthorized) {
    return res.status(401).send('Unauthorized');
  }

  const idOrName = req.params.idOrName;

  // Check if it's an outgoing prepared file
  const outgoing = transferEngine.getOutgoingFile(idOrName);
  if (outgoing && fs.existsSync(outgoing.filePath)) {
    const isImage = (outgoing.mimeType && outgoing.mimeType.startsWith('image/')) ||
                    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(outgoing.fileName);
    const dispositionType = (req.query.download === '1' || !isImage) ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${dispositionType}; filename="${encodeURIComponent(outgoing.fileName)}"`);
    res.setHeader('Content-Type', outgoing.mimeType || 'application/octet-stream');
    return fs.createReadStream(outgoing.filePath).pipe(res);
  }

  // Check received files directory
  const safeName = sanitizeFilename(idOrName);
  const receivedPath = path.join(config.RECEIVED_DIR, safeName);
  if (fs.existsSync(receivedPath)) {
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    return fs.createReadStream(receivedPath).pipe(res);
  }

  res.status(404).send('File not found');
});

// Open received directory in Windows Explorer (Local PC only, safe execution)
app.post('/api/files/open-folder', requireLocalhost, (req, res) => {
  try {
    const child = spawn('explorer.exe', [config.RECEIVED_DIR], { detached: true, stdio: 'ignore' });
    child.unref();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List received files (Protected)
app.get('/api/files/received', requireSessionAuth, (req, res) => {
  res.json({ files: listReceivedFiles() });
});

// History endpoint (Protected)
app.get('/api/history', requireSessionAuth, (req, res) => {
  res.json({ history: sessionManager.getHistory() });
});

app.post('/api/history/clear', requireSessionAuth, (req, res) => {
  sessionManager.clearHistory();
  broadcastToPc('history:updated', { history: [] });
  res.json({ success: true });
});

// Messages & Instant Chat endpoints (Protected)
app.get('/api/messages', requireSessionAuth, (req, res) => {
  res.json({ messages: sessionManager.getMessages() });
});

app.post('/api/messages/clear', requireSessionAuth, (req, res) => {
  sessionManager.clearMessages();
  broadcastAll('messages:cleared', {});
  res.json({ success: true });
});

// Start listening
function startServer(port = config.PORT) {
  return new Promise((resolve, reject) => {
    server.listen(port, '0.0.0.0', () => {
      const activeIp = getPrimaryLocalIp();
      console.log(`\n======================================================`);
      console.log(`  UniversalDrop Desktop Agent running!`);
      console.log(`  PC Web Dashboard:   http://localhost:${port}/pc`);
      console.log(`  Mobile Connection:  http://${activeIp}:${port}/mobile`);
      console.log(`======================================================\n`);
      resolve({ server, port, activeIp });
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`Port ${port} in use, trying ${port + 1}...`);
        startServer(port + 1).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });
  });
}

if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = {
  app,
  server,
  startServer
};
