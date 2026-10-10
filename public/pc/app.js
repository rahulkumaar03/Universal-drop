// UniversalDrop — Apple/macOS Glassmorphism Frontend Logic

// State
let currentSession = null;
let activeTransfers = new Map();
let ws = null;
let currentPendingSessionId = null;
let activeNetworkIp = null;
let networkInterfaces = [];
let chatMessages = [];

// DOM References
const activeNetworkLabel = document.getElementById('activeNetworkLabel');
const networkPillBtn = document.getElementById('networkPillBtn');
const networkPopover = document.getElementById('networkPopover');
const interfacesList = document.getElementById('interfacesList');
const btnThemeToggle = document.getElementById('btnThemeToggle');
const btnHelp = document.getElementById('btnHelp');
const helpModal = document.getElementById('helpModal');
const btnHelpClose = document.getElementById('btnHelpClose');

// Connect Your Phone Elements
const qrCodeImg = document.getElementById('qrCodeImg');
const qrLoadingSpinner = document.getElementById('qrLoadingSpinner');
const pairCodeDisplay = document.getElementById('pairCodeDisplay');
const localUrlInput = document.getElementById('localUrlInput');
const btnCopyPairCode = document.getElementById('btnCopyPairCode');
const btnCopyUrl = document.getElementById('btnCopyUrl');

// Send Files Elements
const fileDropZone = document.getElementById('fileDropZone');
const systemFileInput = document.getElementById('systemFileInput');
const btnSelectFiles = document.getElementById('btnSelectFiles');

// Connected Devices Elements
const devicesContainer = document.getElementById('devicesContainer');
const emptyDevicesState = document.getElementById('emptyDevicesState');
const connectedCountSubtitle = document.getElementById('connectedCountSubtitle');
const btnPairNewDevice = document.getElementById('btnPairNewDevice');

// Messages & Chat Elements
const chatSection = document.getElementById('chatSection');
const chatMessageCount = document.getElementById('chatMessageCount');
const btnClearChat = document.getElementById('btnClearChat');
const chatStreamBox = document.getElementById('chatStreamBox');
const emptyChatState = document.getElementById('emptyChatState');
const chatBubblesList = document.getElementById('chatBubblesList');
const chatComposeForm = document.getElementById('chatComposeForm');
const pcChatInput = document.getElementById('pcChatInput');
const btnSendChat = document.getElementById('btnSendChat');

// Live Transfers Elements
const liveTransfersList = document.getElementById('liveTransfersList');
const emptyTransfersState = document.getElementById('emptyTransfersState');
const liveTransferCount = document.getElementById('liveTransferCount');

// Transfer History Elements
const historyRecordsList = document.getElementById('historyRecordsList');
const emptyHistoryState = document.getElementById('emptyHistoryState');
const btnClearHistory = document.getElementById('btnClearHistory');

// Modals
const incomingPairModal = document.getElementById('incomingPairModal');
const modalDeviceTitle = document.getElementById('modalDeviceTitle');
const modalDeviceIp = document.getElementById('modalDeviceIp');
const btnModalApprove = document.getElementById('btnModalApprove');
const btnModalDecline = document.getElementById('btnModalDecline');
const appToast = document.getElementById('appToast');

// Navigation Items
const navItems = document.querySelectorAll('.sidebar-nav .nav-item');

// Initialize Application
window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initWebSocket();
  loadNetworkInterfaces();
  loadSessionStatus();
  loadChatMessages();
  loadHistory();
  setupEventListeners();
});

// Theme Management (Light / Dark glass)
function initTheme() {
  const savedTheme = localStorage.getItem('ud_theme') || 'light';
  applyTheme(savedTheme);
}

function applyTheme(theme) {
  if (theme === 'dark') {
    document.body.classList.add('theme-dark');
    document.body.classList.remove('theme-light');
    document.querySelector('.theme-icon-moon').classList.add('hidden');
    document.querySelector('.theme-icon-sun').classList.remove('hidden');
  } else {
    document.body.classList.remove('theme-dark');
    document.body.classList.add('theme-light');
    document.querySelector('.theme-icon-moon').classList.remove('hidden');
    document.querySelector('.theme-icon-sun').classList.add('hidden');
  }
  localStorage.setItem('ud_theme', theme);
}

// WebSocket Setup
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?type=pc`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[UniversalDrop] Desktop Agent WebSocket connected');
    document.getElementById('sidebarStatusText').textContent = 'Ready';
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsEvent(msg);
    } catch (err) {
      console.error('[UniversalDrop] WS parse error:', err);
    }
  };

  ws.onclose = () => {
    document.getElementById('sidebarStatusText').textContent = 'Reconnecting';
    setTimeout(initWebSocket, 2000);
  };
}

// Handle Real-time WS Events
function handleWsEvent(msg) {
  switch (msg.type) {
    case 'pair:requested':
      currentPendingSessionId = msg.data.sessionId;
      modalDeviceTitle.textContent = `${msg.data.client.name} (${msg.data.client.type})`;
      modalDeviceIp.textContent = msg.data.client.ip || 'Local Network';
      incomingPairModal.classList.remove('hidden');
      if (btnModalApprove) setTimeout(() => btnModalApprove.focus(), 50);
      if (window.soundChime) window.soundChime.playPing();
      break;

    case 'pair:connected':
      incomingPairModal.classList.add('hidden');
      renderConnectedDevice(msg.data.clientDevice);
      if (window.soundChime) window.soundChime.playSuccess();
      showToast(`${msg.data.clientDevice?.name || 'Device'} connected securely`);
      break;

    case 'pair:rejected':
    case 'peer:disconnected':
    case 'pair:disconnected':
      incomingPairModal.classList.add('hidden');
      renderDisconnectedDevice();
      showToast('Device disconnected');
      break;

    case 'session:reset':
      loadSessionStatus();
      break;

    case 'text:received':
      addChatMessage(msg.data);
      if (window.soundChime) window.soundChime.playPing();
      const snippet = msg.data.text.length > 30 ? msg.data.text.slice(0, 30) + '...' : msg.data.text;
      showToast(`Text received: "${snippet}"`);
      break;

    case 'messages:cleared':
      chatMessages = [];
      renderChatMessages();
      break;

    case 'transfer:started':
      activeTransfers.set(msg.data.transferId, {
        id: msg.data.transferId,
        fileName: msg.data.fileName,
        fileSize: msg.data.fileSize,
        progressPercent: 0,
        speedBps: 0,
        etaSeconds: 0
      });
      renderLiveTransfers();
      break;

    case 'transfer:progress':
      if (activeTransfers.has(msg.data.id)) {
        const t = activeTransfers.get(msg.data.id);
        Object.assign(t, msg.data);
        renderLiveTransfers();
      }
      break;

    case 'transfer:completed':
      activeTransfers.delete(msg.data.transferId);
      renderLiveTransfers();
      loadHistory();
      if (window.soundChime) window.soundChime.playSuccess();
      showToast(`Transfer complete: ${msg.data.fileName}`);
      break;

    case 'transfer:cancelled':
    case 'transfer:failed':
      activeTransfers.delete(msg.data.transferId);
      renderLiveTransfers();
      loadHistory();
      if (window.soundChime) window.soundChime.playAlert();
      showToast(`Transfer cancelled: ${msg.data.fileName || 'file'}`);
      break;

    case 'history:updated':
      renderHistory(msg.data.history || []);
      break;
  }
}

// Fetch session status and QR Code
async function loadSessionStatus() {
  const offlineNotice = document.getElementById('qrOfflineNotice');
  if (offlineNotice) offlineNotice.style.display = 'none';
  if (qrLoadingSpinner) qrLoadingSpinner.style.display = 'flex';
  if (qrCodeImg) qrCodeImg.style.display = 'none';

  try {
    const res = await fetch('/api/session/current');
    if (!res.ok) {
      throw new Error(`Server returned HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data || !data.session) {
      throw new Error('Invalid session response from server');
    }

    currentSession = data.session;

    // Spaced out pair code (e.g., "B S 8 K M F")
    const rawPin = data.session.pairingPin || '------';
    pairCodeDisplay.textContent = rawPin.split('').join(' ');
    if (data.mobileUrl) {
      localUrlInput.value = data.mobileUrl;
    }

    if (data.qrCode) {
      qrCodeImg.onload = () => {
        qrCodeImg.style.display = 'block';
        if (qrLoadingSpinner) qrLoadingSpinner.style.display = 'none';
        if (offlineNotice) offlineNotice.style.display = 'none';
      };
      qrCodeImg.src = data.qrCode;
    }

    if (data.session.status === 'connected' && data.session.clientDevice) {
      renderConnectedDevice(data.session.clientDevice);
    } else {
      renderDisconnectedDevice();
    }
  } catch (err) {
    console.error('[UniversalDrop] Failed to load session:', err);
    if (qrLoadingSpinner) qrLoadingSpinner.style.display = 'none';
    if (qrCodeImg) qrCodeImg.style.display = 'none';
    if (offlineNotice) offlineNotice.style.display = 'flex';
    localUrlInput.value = 'Desktop Agent Offline (start agent on PC)';
    pairCodeDisplay.textContent = '- - - - - -';
  }
}

// Load Network Interfaces
async function loadNetworkInterfaces() {
  try {
    const res = await fetch('/api/network/interfaces');
    const data = await res.json();
    activeNetworkIp = data.activeIp;
    networkInterfaces = data.interfaces || [];

    // Format active network label
    const activeIface = networkInterfaces.find(i => i.address === activeNetworkIp);
    const prefix = activeIface?.isHotspot ? 'Hotspot' : activeIface?.isWiFi ? 'Wi-Fi' : 'LAN';
    activeNetworkLabel.textContent = `${prefix} ${activeNetworkIp}`;

    // Populate popover
    interfacesList.innerHTML = '';
    if (networkInterfaces.length > 0) {
      networkInterfaces.forEach(iface => {
        const item = document.createElement('div');
        item.className = `interface-option ${iface.address === activeNetworkIp ? 'selected' : ''}`;
        const tag = iface.isHotspot ? 'Hotspot' : iface.isWiFi ? 'Wi-Fi' : 'Ethernet';
        item.innerHTML = `
          <span>${tag} • ${iface.address}</span>
          ${iface.address === activeNetworkIp ? '✓' : ''}
        `;
        item.addEventListener('click', async () => {
          await selectNetworkIp(iface.address);
          networkPopover.classList.add('hidden');
        });
        interfacesList.appendChild(item);
      });
    } else {
      interfacesList.innerHTML = '<div style="padding:6px;font-size:0.75rem;color:var(--text-dim);">127.0.0.1 (Localhost)</div>';
    }
  } catch (err) {
    console.error('[UniversalDrop] Failed to load interfaces:', err);
  }
}

async function selectNetworkIp(ip) {
  try {
    const res = await fetch('/api/network/select-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip })
    });
    const data = await res.json();
    if (data.success) {
      await loadNetworkInterfaces();
      await loadSessionStatus();
      showToast(`Switched network interface to ${ip}`);
    }
  } catch (e) {
    console.error('Failed to switch IP:', e);
  }
}

// Render Connected Device Item
function renderConnectedDevice(client) {
  connectedCountSubtitle.textContent = '1 device connected';
  devicesContainer.innerHTML = `
    <div class="device-connected-row">
      <div class="device-left-meta">
        <div class="device-glyph-box">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
            <line x1="12" y1="18" x2="12.01" y2="18"/>
          </svg>
        </div>
        <div class="device-text-meta">
          <div class="device-name-title">
            <span>${escapeHtml(client.name || 'Phone Device')}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-dim);cursor:pointer;" title="Connected device">
              <path d="M12 20h9"/>
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
          </div>
          <div class="device-connection-meta">
            <span>${client.ip || '192.168.x.x'}</span>
            <span>•</span>
            <span class="connected-dot-inline"></span>
            <span class="connected-text-inline">Connected</span>
          </div>
        </div>
      </div>
      <div class="device-actions-right">
        <button class="btn-disconnect-subtle" onclick="disconnectDevice()" title="Disconnect this device">Disconnect</button>
      </div>
    </div>
  `;
}

function renderDisconnectedDevice() {
  connectedCountSubtitle.textContent = '0 devices connected';
  devicesContainer.innerHTML = `
    <div class="empty-state-notice" id="emptyDevicesState">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
        <line x1="12" y1="18" x2="12.01" y2="18"/>
      </svg>
      <span>No devices connected yet. Scan the QR code to pair.</span>
    </div>
  `;
}

window.disconnectDevice = async function() {
  try {
    await fetch('/api/pair/disconnect', { method: 'POST' });
    renderDisconnectedDevice();
    loadSessionStatus();
    showToast('Device disconnected');
  } catch (e) {
    console.error('Disconnect failed:', e);
  }
};

// ==========================================================================
// Messages & Instant Chat
// ==========================================================================

async function loadChatMessages() {
  try {
    const res = await fetch('/api/messages');
    const data = await res.json();
    chatMessages = data.messages || [];
    renderChatMessages();
  } catch (err) {
    console.error('[UniversalDrop] Failed to load messages:', err);
  }
}

function addChatMessage(msg) {
  chatMessages.push(msg);
  if (chatMessages.length > 100) chatMessages.shift();
  renderChatMessages();
}

function renderChatMessages() {
  const count = chatMessages.length;
  chatMessageCount.textContent = `${count} message${count === 1 ? '' : 's'}`;

  if (count === 0) {
    emptyChatState.classList.remove('hidden');
    chatBubblesList.innerHTML = '';
    return;
  }

  emptyChatState.classList.add('hidden');
  chatBubblesList.innerHTML = '';

  chatMessages.forEach(msg => {
    const isPc = msg.sender === 'PC' || msg.sender === 'PC Host';
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${isPc ? 'bubble-outgoing' : 'bubble-incoming'}`;

    const d = new Date(msg.timestamp || Date.now());
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const formattedText = msg.text ? linkify(escapeHtml(msg.text)) : '';
    const imgHtml = msg.imageUrl ? `<img src="${msg.imageUrl}" class="chat-bubble-image" alt="Pasted Image" onclick="window.open('${msg.imageUrl}')" title="Click to view full image">` : '';

    bubble.innerHTML = `
      <div class="bubble-meta-header">
        <span>${isPc ? '💻 PC Host' : `📱 ${escapeHtml(msg.sender || 'Phone')}`}</span>
      </div>
      ${formattedText ? `<div class="bubble-text-content">${formattedText}</div>` : ''}
      ${imgHtml}
      <div class="bubble-footer">
        <span class="bubble-time">${timeStr}</span>
        ${msg.text ? `
        <button class="bubble-copy-btn" onclick="copySnippet('${encodeURIComponent(msg.text)}')" title="Copy text" aria-label="Copy">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          Copy
        </button>` : ''}
      </div>
    `;
    chatBubblesList.appendChild(bubble);
  });

  // Auto scroll to bottom
  chatStreamBox.scrollTop = chatStreamBox.scrollHeight;
}

window.copySnippet = function(encodedText) {
  const text = decodeURIComponent(encodedText);
  navigator.clipboard.writeText(text);
  showToast('Copied to clipboard!');
};

function sendChatMessage(text) {
  if (!text || !text.trim()) return;
  const trimmed = text.trim();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'text:send',
      data: { text: trimmed, sender: 'PC Host' }
    }));
    pcChatInput.value = '';
    if (window.soundChime) window.soundChime.playSuccess();
  } else {
    showToast('WebSocket not connected. Please wait a moment.');
  }
}

async function clearChatMessages() {
  try {
    const res = await fetch('/api/messages/clear', { method: 'POST' });
    if (res.ok) {
      chatMessages = [];
      renderChatMessages();
      showToast('Chat history cleared');
    }
  } catch (err) {
    console.error('Failed to clear messages:', err);
  }
}

// Render Live Transfers
function renderLiveTransfers() {
  const count = activeTransfers.size;
  liveTransferCount.textContent = `${count} active transfer${count === 1 ? '' : 's'}`;

  if (count === 0) {
    liveTransfersList.innerHTML = `
      <div class="empty-state-transfers" id="emptyTransfersState">
        <div class="empty-bubble-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </div>
        <h4 class="empty-title">No active transfers</h4>
        <p class="empty-sub">Send files to see live progress here.</p>
      </div>
    `;
    return;
  }

  liveTransfersList.innerHTML = '';
  activeTransfers.forEach(t => {
    const item = document.createElement('div');
    item.className = 'active-transfer-item';
    const percent = Math.round(t.progressPercent || 0);
    const speedMB = (t.speedBps / (1024 * 1024)).toFixed(1);
    const sizeStr = formatBytes(t.fileSize);

    item.innerHTML = `
      <div class="transfer-top-line">
        <div class="transfer-file-left">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--blue-primary);flex-shrink:0;">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span class="transfer-name" title="${escapeHtml(t.fileName)}">${escapeHtml(t.fileName)}</span>
          <span class="transfer-size">${sizeStr}</span>
        </div>
        <div class="transfer-speed-right">
          <span>${percent}% • ${speedMB} MB/s</span>
          <button class="btn-cancel-transfer" onclick="cancelTransfer('${t.id}')">Cancel</button>
        </div>
      </div>
      <div class="transfer-progress-track">
        <div class="transfer-progress-fill" style="width: ${percent}%;"></div>
      </div>
    `;
    liveTransfersList.appendChild(item);
  });
}

window.cancelTransfer = async function(transferId) {
  try {
    await fetch('/api/transfer/cancel', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-role': 'pc'
      },
      body: JSON.stringify({ transferId })
    });
  } catch (e) {
    console.error('Cancel failed:', e);
  }
};

// Render Transfer History
async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    renderHistory(data.history || []);
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

function renderHistory(items) {
  if (!items || items.length === 0) {
    historyRecordsList.innerHTML = `<div class="empty-history-text" id="emptyHistoryState">No transfer history recorded yet.</div>`;
    return;
  }

  historyRecordsList.innerHTML = '';
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'history-row-item';

    const d = new Date(item.timestamp);
    const dateFormatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timeFormatted = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    const sizeStr = formatBytes(item.fileSize);
    const deviceName = item.device || 'Android Device';

    row.innerHTML = `
      <div class="history-item-left">
        <svg class="history-file-glyph" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <div class="history-details">
          <span class="history-filename" title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)}</span>
          <span class="history-metadata">${sizeStr} • ${escapeHtml(deviceName)}</span>
        </div>
      </div>
      <div class="history-item-right">
        <div class="history-timestamp-col">
          <span>${dateFormatted}</span>
          <span>${timeFormatted}</span>
        </div>
        <a href="/api/files/download/${encodeURIComponent(item.fileName)}" download="${escapeHtml(item.fileName)}" class="three-dots-btn" title="Download file" aria-label="Download">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </a>
      </div>
    `;
    historyRecordsList.appendChild(row);
  });
}

// Clear Transfer History
async function clearHistory() {
  try {
    const res = await fetch('/api/history/clear', { method: 'POST' });
    if (res.ok) {
      renderHistory([]);
      showToast('Transfer history cleared');
    }
  } catch (err) {
    console.error('Clear history error:', err);
  }
}

// Event Listeners
function setupEventListeners() {
  // Navigation tabs
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const view = item.getAttribute('data-view');
      handleNavView(view);
    });
  });

  // Chat submit form
  chatComposeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendChatMessage(pcChatInput.value);
  });

  // Attach button in chat compose bar
  const btnChatAttach = document.getElementById('btnChatAttach');
  if (btnChatAttach) {
    btnChatAttach.addEventListener('click', () => {
      systemFileInput.click();
    });
  }

  // Clipboard Paste Handler for Images & Screenshots
  function handleClipboardPaste(e) {
    const clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;

    const filesToUpload = [];

    if (clipboardData.items) {
      for (let i = 0; i < clipboardData.items.length; i++) {
        const item = clipboardData.items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            let filename = file.name;
            if (!filename || filename === 'image.png' || filename === 'blob') {
              const ext = file.type ? (file.type.split('/')[1] || 'png') : 'png';
              const now = new Date();
              const dateTag = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
              filename = `Screenshot_${dateTag}.${ext}`;
            }
            const renamedFile = new File([file], filename, { type: file.type || 'image/png' });
            filesToUpload.push(renamedFile);
          }
        }
      }
    } else if (clipboardData.files && clipboardData.files.length > 0) {
      for (let i = 0; i < clipboardData.files.length; i++) {
        filesToUpload.push(clipboardData.files[i]);
      }
    }

    if (filesToUpload.length > 0) {
      e.preventDefault();
      showToast(`Pasted image: "${filesToUpload[0].name}" — sending to phone...`);
      handleFilesSend(filesToUpload);
    }
  }

  // Paste on chat input box
  pcChatInput.addEventListener('paste', handleClipboardPaste);

  // Paste globally on window (press Ctrl+V anywhere in UniversalDrop)
  window.addEventListener('paste', (e) => {
    // If target is pcChatInput, it was already handled by the listener above
    if (e.target === pcChatInput) return;
    const clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;

    // Only handle if clipboard contains files/images
    let hasFiles = (clipboardData.files && clipboardData.files.length > 0);
    if (!hasFiles && clipboardData.items) {
      for (let i = 0; i < clipboardData.items.length; i++) {
        if (clipboardData.items[i].kind === 'file') {
          hasFiles = true;
          break;
        }
      }
    }

    if (hasFiles) {
      handleClipboardPaste(e);
    }
  });

  // Clear chat button
  btnClearChat.addEventListener('click', () => {
    clearChatMessages();
  });

  // Select files button
  btnSelectFiles.addEventListener('click', (e) => {
    e.stopPropagation();
    systemFileInput.click();
  });

  fileDropZone.addEventListener('click', () => {
    systemFileInput.click();
  });

  systemFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFilesSend(e.target.files);
    }
  });

  // Drag and drop events
  ['dragenter', 'dragover'].forEach(eventName => {
    fileDropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      fileDropZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    fileDropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      fileDropZone.classList.remove('dragover');
    });
  });

  fileDropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length > 0) {
      handleFilesSend(e.dataTransfer.files);
    }
  });

  // Copy buttons
  btnCopyPairCode.addEventListener('click', () => {
    const code = pairCodeDisplay.textContent.replace(/\s+/g, '');
    navigator.clipboard.writeText(code);
    showToast('Pair code copied to clipboard');
  });

  btnCopyUrl.addEventListener('click', () => {
    navigator.clipboard.writeText(localUrlInput.value);
    showToast('Local URL copied to clipboard');
  });

  // Network popover toggle
  networkPillBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    networkPopover.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!networkPopover.contains(e.target) && !networkPillBtn.contains(e.target)) {
      networkPopover.classList.add('hidden');
    }
  });

  // Theme toggle
  btnThemeToggle.addEventListener('click', () => {
    const isDark = document.body.classList.contains('theme-dark');
    applyTheme(isDark ? 'light' : 'dark');
  });

  // Help modal
  btnHelp.addEventListener('click', () => {
    helpModal.classList.remove('hidden');
  });

  btnHelpClose.addEventListener('click', () => {
    helpModal.classList.add('hidden');
  });

  // Accessibility: Escape key closes open modals and popovers
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!helpModal.classList.contains('hidden')) {
        helpModal.classList.add('hidden');
      } else if (!networkPopover.classList.contains('hidden')) {
        networkPopover.classList.add('hidden');
      }
    }
  });

  // Pair new device
  btnPairNewDevice.addEventListener('click', async () => {
    await fetch('/api/session/new', { method: 'POST' });
    await loadSessionStatus();
    showToast('Generated fresh pairing session & QR code');
  });

  // Retry desktop agent connection
  const btnRetryAgent = document.getElementById('btnRetryAgent');
  if (btnRetryAgent) {
    btnRetryAgent.addEventListener('click', () => {
      loadSessionStatus();
      loadNetworkInterfaces();
      initWebSocket();
    });
  }

  // Clear history
  btnClearHistory.addEventListener('click', () => {
    clearHistory();
  });

  // Modal Approve / Decline
  btnModalApprove.addEventListener('click', async () => {
    if (!currentPendingSessionId) return;
    try {
      await fetch('/api/pair/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentPendingSessionId })
      });
      incomingPairModal.classList.add('hidden');
    } catch (e) {
      console.error('Approve failed:', e);
    }
  });

  btnModalDecline.addEventListener('click', async () => {
    if (!currentPendingSessionId) return;
    try {
      await fetch('/api/pair/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentPendingSessionId })
      });
      incomingPairModal.classList.add('hidden');
    } catch (e) {
      console.error('Decline failed:', e);
    }
  });
}

function handleNavView(view) {
  if (view === 'send') {
    fileDropZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (view === 'devices') {
    devicesContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (view === 'messages') {
    chatSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    pcChatInput.focus();
  } else if (view === 'history') {
    historyRecordsList.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (view === 'receive') {
    fetch('/api/files/open-folder', { method: 'POST' });
    showToast('Opened Received Files folder in File Explorer');
  } else if (view === 'settings') {
    helpModal.classList.remove('hidden');
  }
}

// Upload file from PC to outgoing queue for phone
async function handleFilesSend(fileList) {
  for (const file of fileList) {
    try {
      showToast(`Sending "${file.name}" to phone...`);

      // If it's an image, display thumbnail preview in chat stream
      if ((file.type && file.type.startsWith('image/')) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name)) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          addChatMessage({
            id: 'img_' + Date.now(),
            text: file.name,
            imageUrl: ev.target.result,
            sender: 'PC Host',
            timestamp: Date.now()
          });
        };
        reader.readAsDataURL(file);
      }

      let mimeType = file.type;
      if (!mimeType) {
        if (/\.png$/i.test(file.name)) mimeType = 'image/png';
        else if (/\.jpe?g$/i.test(file.name)) mimeType = 'image/jpeg';
        else if (/\.gif$/i.test(file.name)) mimeType = 'image/gif';
        else if (/\.webp$/i.test(file.name)) mimeType = 'image/webp';
        else mimeType = 'application/octet-stream';
      }

      const res = await fetch('/api/pc/send-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-mime-type': mimeType,
          'x-file-name': encodeURIComponent(file.name)
        },
        body: file
      });
      if (res.ok) {
        if (window.soundChime) window.soundChime.playSuccess();
        showToast(`Sent "${file.name}" successfully!`);
      }
    } catch (err) {
      console.error('File send error:', err);
      showToast(`Error sending "${file.name}"`);
    }
  }
}

// Utilities
function showToast(message) {
  appToast.textContent = message;
  appToast.classList.remove('hidden');
  clearTimeout(appToast._timer);
  appToast._timer = setTimeout(() => {
    appToast.classList.add('hidden');
  }, 2800);
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}

function linkify(str) {
  const urlRegex = /(https?:\/\/[^\s<]+)/g;
  return str.replace(urlRegex, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}
