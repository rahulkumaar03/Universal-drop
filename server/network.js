const os = require('os');

/**
 * Discovers all active non-internal IPv4 interfaces on the host.
 * Prioritizes Wi-Fi and common local subnets (192.168.*, 10.*, 172.16-31.*, 192.168.137.* for Windows Hotspot).
 */
function getNetworkInterfaces() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      // We only care about IPv4 non-internal addresses
      if (addr.family === 'IPv4' && !addr.internal) {
        const isHotspot = addr.address.startsWith('192.168.137.') || name.toLowerCase().includes('hotspot');
        const isWiFi = name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('wireless') || name.toLowerCase().includes('wlan');
        const isEthernet = name.toLowerCase().includes('ethernet') || name.toLowerCase().includes('eth');

        let score = 10;
        if (isHotspot) score += 50; // Hotspot is highest priority for direct offline transfer
        else if (isWiFi) score += 40;
        else if (isEthernet) score += 30;

        // Private LAN IP checks
        if (addr.address.startsWith('192.168.') || addr.address.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(addr.address)) {
          score += 10;
        }

        candidates.push({
          name,
          address: addr.address,
          netmask: addr.netmask,
          isWiFi,
          isHotspot,
          isEthernet,
          score
        });
      }
    }
  }

  // Sort candidates by priority score descending
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}

/**
 * Returns the best selected IPv4 address, or fallback to 127.0.0.1.
 */
function getPrimaryLocalIp(selectedIp = null) {
  const interfaces = getNetworkInterfaces();
  if (selectedIp) {
    const found = interfaces.find(i => i.address === selectedIp);
    if (found) return found.address;
  }
  if (interfaces.length > 0) {
    return interfaces[0].address;
  }
  return '127.0.0.1';
}

module.exports = {
  getNetworkInterfaces,
  getPrimaryLocalIp
};
