/**
 * @name         Resource Governor
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Electron main process — unified bandwidth, CPU, and memory governor.
 *               Windows: QoS policies + ProcessorAffinity/MaxWorkingSet via PowerShell
 *               macOS:   pfctl/dnctl + cpulimit/renice
 *               Linux:   tc (traffic control) + taskset/prlimit
 * @author       Cloud Nimbus LLC
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const Store = require('electron-store');

const platform = process.platform; // 'win32', 'darwin', 'linux'

const store = new Store({
  defaults: {
    // Bandwidth section
    policies: [],
    bandwidthEnabled: true,
    bandwidthSettings: {
      autoApplyOnLaunch: true,
      defaultUploadMbps: 5,
      defaultDownloadMbps: 0,
    },
    // Process section
    processRules: [],
    processSettings: {
      autoApplyOnLaunch: true,
    },
    // Shared
    settings: {
      autoStart: false,
      startMinimized: false,
      refreshInterval: 3,
    },
    launchers: [],
    prompts: [],
    claudeConfig: null, // { speed: {download, upload}, percent, limitMbps, testedAt }
    pipeCounter: 100, // macOS: next available dnctl pipe number
  },
});

let mainWindow = null;
let tray = null;
let isBandwidthEnabled = store.get('bandwidthEnabled', true);

// Track active CPU/memory limiters (child processes)
const activeLimiters = new Map(); // ruleId -> { interval, rule }

// ============================================================
// TRAY ICON — gradient style based on active state
// ============================================================

function createTrayIcon(bwActive, procActive) {
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const isBorder = x === 0 || x === size - 1 || y === 0 || y === size - 1;

      if (bwActive && procActive) {
        // Both active — green to orange gradient
        const t = x / (size - 1);
        canvas[i]     = isBorder ? Math.round(50 + t * 150) : Math.round(34 + t * 196);  // R
        canvas[i + 1] = isBorder ? Math.round(180 - t * 60) : Math.round(140 - t * 0);   // G
        canvas[i + 2] = isBorder ? Math.round(50 - t * 30)  : Math.round(34 - t * 4);    // B
      } else if (bwActive) {
        // Bandwidth only — green
        canvas[i]     = isBorder ? 50  : 34;
        canvas[i + 1] = isBorder ? 180 : 140;
        canvas[i + 2] = isBorder ? 50  : 34;
      } else if (procActive) {
        // Process only — orange
        canvas[i]     = isBorder ? 200 : 230;
        canvas[i + 1] = isBorder ? 120 : 150;
        canvas[i + 2] = isBorder ? 20  : 30;
      } else {
        // Idle — gray
        canvas[i]     = isBorder ? 100 : 80;
        canvas[i + 1] = isBorder ? 100 : 80;
        canvas[i + 2] = isBorder ? 100 : 80;
      }
      canvas[i + 3] = 255;
    }
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

// ============================================================
// WINDOW
// ============================================================

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const procActive = activeLimiters.size > 0;
  mainWindow = new BrowserWindow({
    width: 960,
    height: 780,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: createTrayIcon(isBandwidthEnabled, procActive),
    title: 'Resource Governor',
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ============================================================
// TRAY
// ============================================================

function updateTrayMenu() {
  if (!tray) return;
  const procActive = activeLimiters.size > 0;
  tray.setImage(createTrayIcon(isBandwidthEnabled, procActive));

  const bwStatus = isBandwidthEnabled ? 'ON' : 'OFF';
  const procStatus = procActive ? `${activeLimiters.size} rule(s) active` : 'idle';
  tray.setToolTip(`Resource Governor — BW: ${bwStatus} | Proc: ${procStatus}`);

  const contextMenu = Menu.buildFromTemplate([
    { label: `Bandwidth: ${bwStatus}`, enabled: false },
    { label: `Process: ${procStatus}`, enabled: false },
    { type: 'separator' },
    {
      label: isBandwidthEnabled ? 'Disable Bandwidth Limits' : 'Enable Bandwidth Limits',
      click: () => toggleBandwidthEnabled(),
    },
    {
      label: 'Stop All Process Rules',
      click: () => stopAllRules(),
      enabled: procActive,
    },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => createWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
}

function createTray() {
  const procActive = activeLimiters.size > 0;
  tray = new Tray(createTrayIcon(isBandwidthEnabled, procActive));
  updateTrayMenu();
  tray.on('double-click', () => createWindow());
}

// ============================================================
// SHELL HELPERS
// ============================================================

/**
 * Run a PowerShell command (Windows only).
 */
function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${command.replace(/"/g, '\\"')}"`;
    exec(psCmd, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

/**
 * Run a shell command via bash (macOS/Linux).
 */
function runShell(command) {
  return new Promise((resolve, reject) => {
    exec(command, { shell: '/bin/bash', maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ============================================================
// ADMIN CHECK
// ============================================================

async function checkAdmin() {
  try {
    if (platform === 'win32') {
      const result = await runPowerShell(
        `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
      );
      return result === 'True';
    } else if (platform === 'darwin') {
      const result = await runShell('id -Gn');
      return result.split(/\s+/).includes('admin');
    } else {
      // Linux: check if running as root
      const result = await runShell('id -u');
      return result.trim() === '0';
    }
  } catch (e) {
    return false;
  }
}

// ============================================================
// LINUX HELPER — get default network interface
// ============================================================

async function getDefaultInterface() {
  try {
    const result = await runShell("ip route show default | awk '{print $5}' | head -n1");
    return result || 'eth0';
  } catch (e) {
    return 'eth0';
  }
}

// ============================================================
// macOS HELPER — allocate a pipe number for dnctl
// ============================================================

function allocatePipeNumber() {
  const num = store.get('pipeCounter', 100);
  store.set('pipeCounter', num + 1);
  return num;
}

// ============================================================
// BANDWIDTH — Policy management (cross-platform)
// ============================================================

async function createPolicy({ name, appPath, uploadLimitMbps, downloadLimitMbps }) {
  const results = [];

  if (platform === 'win32') {
    // Windows: QoS policies via PowerShell
    if (uploadLimitMbps && uploadLimitMbps > 0) {
      const bitsPerSec = Math.round(uploadLimitMbps * 1000000);
      const policyName = `RG_UL_${name}`;
      let cmd = `New-NetQosPolicy -Name '${policyName}' -ThrottleRateActionBitsPerSecond ${bitsPerSec}`;
      if (appPath) cmd += ` -AppPathNameMatchCondition '${appPath}'`;
      cmd += ' -PolicyStore ActiveStore';
      try {
        await runPowerShell(cmd);
        results.push({ policy: policyName, status: 'created' });
      } catch (e) {
        results.push({ policy: policyName, status: 'error', message: e.message });
      }
    }

    if (downloadLimitMbps && downloadLimitMbps > 0) {
      const bitsPerSec = Math.round(downloadLimitMbps * 1000000);
      const policyName = `RG_DL_${name}`;
      let cmd = `New-NetQosPolicy -Name '${policyName}' -ThrottleRateActionBitsPerSecond ${bitsPerSec}`;
      if (appPath) cmd += ` -AppPathNameMatchCondition '${appPath}'`;
      cmd += ' -PolicyStore ActiveStore';
      try {
        await runPowerShell(cmd);
        results.push({ policy: policyName, status: 'created' });
      } catch (e) {
        results.push({ policy: policyName, status: 'error', message: e.message });
      }
    }
  } else if (platform === 'darwin') {
    // macOS: pfctl + dnctl (dummynet pipes)
    // NOTE: Per-app bandwidth limiting is not supported on macOS via pfctl.
    // pfctl operates on ports/IPs, not application paths. All limits are applied globally.
    // The appPath parameter is stored but ignored for enforcement on macOS.
    try {
      if (uploadLimitMbps && uploadLimitMbps > 0) {
        const pipeNum = allocatePipeNumber();
        const rateKbit = Math.round(uploadLimitMbps * 1000);
        await runShell(`sudo dnctl pipe ${pipeNum} config bw ${rateKbit}Kbit/s`);
        await runShell(`echo "dummynet out proto tcp from any to any pipe ${pipeNum}" | sudo pfctl -a "rg/${name}_ul" -f -`);
        await runShell('sudo pfctl -e 2>/dev/null || true');
        results.push({ policy: `rg/${name}_ul`, pipe: pipeNum, status: 'created' });
      }

      if (downloadLimitMbps && downloadLimitMbps > 0) {
        const pipeNum = allocatePipeNumber();
        const rateKbit = Math.round(downloadLimitMbps * 1000);
        await runShell(`sudo dnctl pipe ${pipeNum} config bw ${rateKbit}Kbit/s`);
        await runShell(`echo "dummynet in proto tcp from any to any pipe ${pipeNum}" | sudo pfctl -a "rg/${name}_dl" -f -`);
        await runShell('sudo pfctl -e 2>/dev/null || true');
        results.push({ policy: `rg/${name}_dl`, pipe: pipeNum, status: 'created' });
      }
    } catch (e) {
      results.push({ policy: name, status: 'error', message: e.message });
    }
  } else if (platform === 'linux') {
    // Linux: tc (traffic control) with tbf qdisc for simple global limiting.
    // NOTE: Per-app bandwidth limiting on Linux would require cgroups + net_cls,
    // which is not implemented here. All limits are applied globally.
    // The appPath parameter is stored but ignored for enforcement on Linux.
    try {
      const iface = await getDefaultInterface();

      if (uploadLimitMbps && uploadLimitMbps > 0) {
        const rateKbit = Math.round(uploadLimitMbps * 1000);
        // Remove any existing root qdisc first (ignore errors if none exists)
        await runShell(`sudo tc qdisc del dev ${iface} root 2>/dev/null || true`);
        await runShell(`sudo tc qdisc add dev ${iface} root tbf rate ${rateKbit}kbit burst 32kbit latency 400ms`);
        results.push({ policy: `tc_ul_${name}`, iface, status: 'created' });
      }

      if (downloadLimitMbps && downloadLimitMbps > 0) {
        const rateKbit = Math.round(downloadLimitMbps * 1000);
        // For download limiting on Linux, use an IFB (intermediate functional block) device
        await runShell('sudo modprobe ifb 2>/dev/null || true');
        await runShell('sudo ip link set dev ifb0 up 2>/dev/null || true');
        await runShell(`sudo tc qdisc del dev ${iface} ingress 2>/dev/null || true`);
        await runShell(`sudo tc qdisc add dev ${iface} ingress`);
        await runShell(`sudo tc filter add dev ${iface} parent ffff: protocol ip u32 match u32 0 0 flowid 1:1 action mirred egress redirect dev ifb0`);
        await runShell(`sudo tc qdisc del dev ifb0 root 2>/dev/null || true`);
        await runShell(`sudo tc qdisc add dev ifb0 root tbf rate ${rateKbit}kbit burst 32kbit latency 400ms`);
        results.push({ policy: `tc_dl_${name}`, iface, status: 'created' });
      }
    } catch (e) {
      results.push({ policy: name, status: 'error', message: e.message });
    }
  }

  // Save to persistent store (avoid duplicates)
  const saved = store.get('policies', []);
  const existing = saved.findIndex(p => p.name === name);
  const entry = {
    name,
    appPath,
    uploadLimitMbps,
    downloadLimitMbps,
    createdAt: new Date().toISOString(),
    platform,
    ...(platform === 'darwin' ? { pipes: results.filter(r => r.pipe).map(r => r.pipe) } : {}),
    ...(platform === 'linux' ? { iface: results.length > 0 ? results[0].iface : null } : {}),
  };
  if (existing >= 0) saved[existing] = entry;
  else saved.push(entry);
  store.set('policies', saved);

  return results;
}

async function removePolicy(name) {
  const results = [];
  const saved = store.get('policies', []);
  const policy = saved.find(p => p.name === name);

  if (platform === 'win32') {
    for (const prefix of ['RG_UL_', 'RG_DL_']) {
      const policyName = `${prefix}${name}`;
      try {
        await runPowerShell(`Remove-NetQosPolicy -Name '${policyName}' -PolicyStore ActiveStore -Confirm:$false`);
        results.push({ policy: policyName, status: 'removed' });
      } catch (e) {
        results.push({ policy: policyName, status: 'not_found' });
      }
    }
  } else if (platform === 'darwin') {
    // Remove pf anchor rules
    for (const suffix of ['_ul', '_dl']) {
      try {
        await runShell(`sudo pfctl -a "rg/${name}${suffix}" -F all 2>/dev/null || true`);
        results.push({ policy: `rg/${name}${suffix}`, status: 'removed' });
      } catch (e) {
        results.push({ policy: `rg/${name}${suffix}`, status: 'not_found' });
      }
    }
    // Delete associated dnctl pipes
    if (policy && policy.pipes) {
      for (const pipeNum of policy.pipes) {
        try {
          await runShell(`sudo dnctl pipe ${pipeNum} delete 2>/dev/null || true`);
        } catch (e) { /* ignore */ }
      }
    }
  } else if (platform === 'linux') {
    // Remove tc qdiscs — this removes all tc rules on the interface
    try {
      const iface = (policy && policy.iface) || await getDefaultInterface();
      await runShell(`sudo tc qdisc del dev ${iface} root 2>/dev/null || true`);
      await runShell(`sudo tc qdisc del dev ${iface} ingress 2>/dev/null || true`);
      await runShell(`sudo tc qdisc del dev ifb0 root 2>/dev/null || true`);
      results.push({ policy: `tc_${name}`, status: 'removed' });
    } catch (e) {
      results.push({ policy: `tc_${name}`, status: 'not_found' });
    }
  }

  store.set('policies', saved.filter(p => p.name !== name));
  return results;
}

async function removeAllPolicies() {
  try {
    if (platform === 'win32') {
      await runPowerShell(
        `Get-NetQosPolicy -PolicyStore ActiveStore | Where-Object { $_.Name -like 'RG_*' } | Remove-NetQosPolicy -Confirm:$false`
      );
    } else if (platform === 'darwin') {
      // Flush all rules under the "rg" anchor and delete all associated pipes
      await runShell('sudo pfctl -a "rg" -F all 2>/dev/null || true');
      const saved = store.get('policies', []);
      for (const policy of saved) {
        if (policy.pipes) {
          for (const pipeNum of policy.pipes) {
            try {
              await runShell(`sudo dnctl pipe ${pipeNum} delete 2>/dev/null || true`);
            } catch (e) { /* ignore */ }
          }
        }
      }
      // Reset pipe counter
      store.set('pipeCounter', 100);
    } else if (platform === 'linux') {
      const iface = await getDefaultInterface();
      await runShell(`sudo tc qdisc del dev ${iface} root 2>/dev/null || true`);
      await runShell(`sudo tc qdisc del dev ${iface} ingress 2>/dev/null || true`);
      await runShell(`sudo tc qdisc del dev ifb0 root 2>/dev/null || true`);
    }

    store.set('policies', []);
    return { status: 'all_removed' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

// --- Toggle bandwidth master on/off ---

async function toggleBandwidthEnabled() {
  isBandwidthEnabled = !isBandwidthEnabled;
  store.set('bandwidthEnabled', isBandwidthEnabled);

  if (isBandwidthEnabled) {
    await reapplyPolicies();
  } else {
    try {
      if (platform === 'win32') {
        await runPowerShell(
          `Get-NetQosPolicy -PolicyStore ActiveStore | Where-Object { $_.Name -like 'RG_*' } | Remove-NetQosPolicy -Confirm:$false`
        );
      } else if (platform === 'darwin') {
        await runShell('sudo pfctl -a "rg" -F all 2>/dev/null || true');
        const saved = store.get('policies', []);
        for (const policy of saved) {
          if (policy.pipes) {
            for (const pipeNum of policy.pipes) {
              try { await runShell(`sudo dnctl pipe ${pipeNum} delete 2>/dev/null || true`); } catch (e) { /* ignore */ }
            }
          }
        }
      } else if (platform === 'linux') {
        const iface = await getDefaultInterface();
        await runShell(`sudo tc qdisc del dev ${iface} root 2>/dev/null || true`);
        await runShell(`sudo tc qdisc del dev ${iface} ingress 2>/dev/null || true`);
        await runShell(`sudo tc qdisc del dev ifb0 root 2>/dev/null || true`);
      }
    } catch (e) { /* ignore */ }
  }

  updateTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bw-enabled-changed', isBandwidthEnabled);
  }
  return isBandwidthEnabled;
}

// --- Re-apply all saved policies (used on startup and re-enable) ---

async function reapplyPolicies() {
  const saved = store.get('policies', []);
  if (saved.length === 0) {
    const bwSettings = store.get('bandwidthSettings');
    if (bwSettings.autoApplyOnLaunch && (bwSettings.defaultUploadMbps > 0 || bwSettings.defaultDownloadMbps > 0)) {
      await createPolicy({
        name: 'Default',
        appPath: null,
        uploadLimitMbps: bwSettings.defaultUploadMbps,
        downloadLimitMbps: bwSettings.defaultDownloadMbps,
      });
    }
    return;
  }

  if (platform === 'win32') {
    // Windows: create QoS policies for each saved entry
    for (const p of saved) {
      if (p.uploadLimitMbps && p.uploadLimitMbps > 0) {
        const bitsPerSec = Math.round(p.uploadLimitMbps * 1000000);
        const policyName = `RG_UL_${p.name}`;
        let cmd = `New-NetQosPolicy -Name '${policyName}' -ThrottleRateActionBitsPerSecond ${bitsPerSec}`;
        if (p.appPath) cmd += ` -AppPathNameMatchCondition '${p.appPath}'`;
        cmd += ' -PolicyStore ActiveStore';
        try { await runPowerShell(cmd); } catch (e) { /* ignore duplicates */ }
      }
      if (p.downloadLimitMbps && p.downloadLimitMbps > 0) {
        const bitsPerSec = Math.round(p.downloadLimitMbps * 1000000);
        const policyName = `RG_DL_${p.name}`;
        let cmd = `New-NetQosPolicy -Name '${policyName}' -ThrottleRateActionBitsPerSecond ${bitsPerSec}`;
        if (p.appPath) cmd += ` -AppPathNameMatchCondition '${p.appPath}'`;
        cmd += ' -PolicyStore ActiveStore';
        try { await runPowerShell(cmd); } catch (e) { /* ignore duplicates */ }
      }
    }
  } else {
    // macOS/Linux: re-create policies via the normal createPolicy flow.
    // We clear first, then re-apply each saved policy.
    const savedCopy = JSON.parse(JSON.stringify(saved));

    if (platform === 'darwin') {
      await runShell('sudo pfctl -a "rg" -F all 2>/dev/null || true');
      store.set('pipeCounter', 100);
    } else if (platform === 'linux') {
      const iface = await getDefaultInterface();
      await runShell(`sudo tc qdisc del dev ${iface} root 2>/dev/null || true`);
      await runShell(`sudo tc qdisc del dev ${iface} ingress 2>/dev/null || true`);
      await runShell(`sudo tc qdisc del dev ifb0 root 2>/dev/null || true`);
    }

    for (const p of savedCopy) {
      await createPolicy({
        name: p.name,
        appPath: p.appPath,
        uploadLimitMbps: p.uploadLimitMbps,
        downloadLimitMbps: p.downloadLimitMbps,
      });
    }
  }
}

// --- Bandwidth monitoring ---

let lastStats = null;
let lastStatsTime = null;

async function getBandwidthUsage() {
  try {
    if (platform === 'win32') {
      // Windows: Get-NetAdapterStatistics via PowerShell
      const raw = await runPowerShell(
        `Get-NetAdapterStatistics | Select-Object Name, SentBytes, ReceivedBytes | ConvertTo-Json -Compress`
      );
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const stats = Array.isArray(parsed) ? parsed : [parsed];
      const now = Date.now();

      if (lastStats && lastStatsTime) {
        const elapsed = (now - lastStatsTime) / 1000;
        const results = stats.map((s) => {
          const prev = lastStats.find(p => p.Name === s.Name);
          if (!prev) return { name: s.Name, uploadMbps: 0, downloadMbps: 0 };
          const uploadBytes = s.SentBytes - prev.SentBytes;
          const downloadBytes = s.ReceivedBytes - prev.ReceivedBytes;
          return {
            name: s.Name,
            uploadMbps: Math.max(0, (uploadBytes * 8 / 1000000) / elapsed).toFixed(2),
            downloadMbps: Math.max(0, (downloadBytes * 8 / 1000000) / elapsed).toFixed(2),
          };
        });
        lastStats = stats;
        lastStatsTime = now;
        return results;
      }

      lastStats = stats;
      lastStatsTime = now;
      return stats.map(s => ({ name: s.Name, uploadMbps: '0.00', downloadMbps: '0.00' }));

    } else if (platform === 'darwin') {
      // macOS: parse netstat -ib for interface byte counts
      const raw = await runShell('/usr/sbin/netstat -ib');
      const lines = raw.split('\n');
      // Header: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
      const stats = [];
      for (const line of lines.slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;
        // Only include entries with a Link#N address (physical interfaces)
        if (!parts[3] || !parts[3].startsWith('Link#')) continue;
        const name = parts[0];
        const receivedBytes = parseInt(parts[6], 10) || 0;
        const sentBytes = parseInt(parts[9], 10) || 0;
        stats.push({ Name: name, SentBytes: sentBytes, ReceivedBytes: receivedBytes });
      }
      if (stats.length === 0) return null;

      const now = Date.now();
      if (lastStats && lastStatsTime) {
        const elapsed = (now - lastStatsTime) / 1000;
        const results = stats.map((s) => {
          const prev = lastStats.find(p => p.Name === s.Name);
          if (!prev) return { name: s.Name, uploadMbps: 0, downloadMbps: 0 };
          const uploadBytes = s.SentBytes - prev.SentBytes;
          const downloadBytes = s.ReceivedBytes - prev.ReceivedBytes;
          return {
            name: s.Name,
            uploadMbps: Math.max(0, (uploadBytes * 8 / 1000000) / elapsed).toFixed(2),
            downloadMbps: Math.max(0, (downloadBytes * 8 / 1000000) / elapsed).toFixed(2),
          };
        });
        lastStats = stats;
        lastStatsTime = now;
        return results;
      }

      lastStats = stats;
      lastStatsTime = now;
      return stats.map(s => ({ name: s.Name, uploadMbps: '0.00', downloadMbps: '0.00' }));

    } else if (platform === 'linux') {
      // Linux: read /proc/net/dev for interface byte counts
      const raw = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = raw.split('\n');
      // Skip header lines (first 2 lines)
      const stats = [];
      for (const line of lines.slice(2)) {
        const match = line.trim().match(/^(\S+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
        if (!match) continue;
        const name = match[1];
        if (name === 'lo') continue; // skip loopback
        const receivedBytes = parseInt(match[2], 10);
        const sentBytes = parseInt(match[3], 10);
        stats.push({ Name: name, SentBytes: sentBytes, ReceivedBytes: receivedBytes });
      }
      if (stats.length === 0) return null;

      const now = Date.now();
      if (lastStats && lastStatsTime) {
        const elapsed = (now - lastStatsTime) / 1000;
        const results = stats.map((s) => {
          const prev = lastStats.find(p => p.Name === s.Name);
          if (!prev) return { name: s.Name, uploadMbps: 0, downloadMbps: 0 };
          const uploadBytes = s.SentBytes - prev.SentBytes;
          const downloadBytes = s.ReceivedBytes - prev.ReceivedBytes;
          return {
            name: s.Name,
            uploadMbps: Math.max(0, (uploadBytes * 8 / 1000000) / elapsed).toFixed(2),
            downloadMbps: Math.max(0, (downloadBytes * 8 / 1000000) / elapsed).toFixed(2),
          };
        });
        lastStats = stats;
        lastStatsTime = now;
        return results;
      }

      lastStats = stats;
      lastStatsTime = now;
      return stats.map(s => ({ name: s.Name, uploadMbps: '0.00', downloadMbps: '0.00' }));
    }
  } catch (e) {
    return null;
  }
}

// --- Speed test ---

async function runSpeedTest() {
  const results = { download: 0, upload: 0 };
  const nullDev = platform === 'win32' ? 'NUL' : '/dev/null';
  const hideOpts = platform === 'win32' ? { windowsHide: true, timeout: 30000 } : { timeout: 30000 };

  try {
    const dlResult = await new Promise((resolve, reject) => {
      const testSize = 10000000;
      exec(
        `curl -s -o ${nullDev} -w "%{speed_download}" "https://speed.cloudflare.com/__down?bytes=${testSize}"`,
        hideOpts,
        (err, stdout) => {
          if (err) return reject(err);
          const bytesPerSec = parseFloat(stdout.replace(/"/g, ''));
          resolve((bytesPerSec * 8) / 1000000);
        }
      );
    });
    results.download = Math.round(dlResult * 10) / 10;
  } catch (e) {
    console.error('Download test failed:', e.message);
  }

  try {
    const ulResult = await new Promise((resolve, reject) => {
      const tempFile = path.join(app.getPath('temp'), 'rg-speedtest.bin');
      fs.writeFileSync(tempFile, Buffer.alloc(2000000, 0x41));

      exec(
        `curl -s -w "%{speed_upload}" -X POST -F "file=@${tempFile.replace(/\\/g, '/')}" "https://speed.cloudflare.com/__up" -o ${nullDev}`,
        hideOpts,
        (err, stdout) => {
          try { fs.unlinkSync(tempFile); } catch (e) {}
          if (err) return reject(err);
          const bytesPerSec = parseFloat(stdout.replace(/"/g, ''));
          resolve((bytesPerSec * 8) / 1000000);
        }
      );
    });
    results.upload = Math.round(ulResult * 10) / 10;
  } catch (e) {
    console.error('Upload test failed:', e.message);
  }

  return results;
}

// --- Bandwidth presets ---

const BANDWIDTH_PRESETS = {
  'upload-only-light':  { upload: 10, download: 0,  label: 'Upload Light (10 Mbps)' },
  'upload-only-medium': { upload: 5,  download: 0,  label: 'Upload Medium (5 Mbps)' },
  'upload-only-strict': { upload: 2,  download: 0,  label: 'Upload Strict (2 Mbps)' },
  'balanced-light':     { upload: 10, download: 50, label: 'Balanced Light' },
  'balanced-medium':    { upload: 5,  download: 20, label: 'Balanced Medium' },
  'balanced-strict':    { upload: 2,  download: 10, label: 'Balanced Strict' },
};

// ============================================================
// PROCESS — CPU/Memory limiting (cross-platform)
// ============================================================

async function getTopProcesses() {
  if (platform === 'win32') {
    return getTopProcessesWindows();
  }
  // macOS and Linux both use `ps aux`
  return getTopProcessesUnix();
}

async function getTopProcessesWindows() {
  const cmd = `Get-Process | Where-Object { $_.CPU -gt 0 } | Sort-Object CPU -Descending | Select-Object -First 50 Id, ProcessName, CPU, @{N='MemoryMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}, Path | ConvertTo-Json -Compress`;
  try {
    const raw = await runPowerShell(cmd);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(p => ({
      pid: p.Id,
      name: p.ProcessName,
      cpuTime: Math.round((p.CPU || 0) * 100) / 100,
      memoryMb: p.MemoryMB || 0,
      path: p.Path || '',
    }));
  } catch (e) {
    return [];
  }
}

async function getTopProcessesUnix() {
  // ps aux columns: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND
  // Sort by CPU descending, take top 50
  try {
    const raw = await runShell('ps aux --sort=-%cpu 2>/dev/null || ps aux -r');
    if (!raw) return [];
    const lines = raw.split('\n');
    // Skip header line
    const processes = [];
    for (let i = 1; i < lines.length && processes.length < 50; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      // Split on whitespace, but COMMAND can contain spaces so limit the split
      const parts = line.split(/\s+/);
      if (parts.length < 11) continue;
      const pid = parseInt(parts[1], 10);
      const cpuPercent = parseFloat(parts[2]) || 0;
      const rssMb = Math.round((parseInt(parts[5], 10) || 0) / 1024 * 10) / 10; // RSS is in KB
      const command = parts.slice(10).join(' ');
      // Extract the process name from the command path
      const name = path.basename(command.split(' ')[0]);
      if (cpuPercent <= 0) continue;
      processes.push({
        pid,
        name,
        cpuTime: cpuPercent, // on Unix we report current CPU% rather than cumulative time
        memoryMb: rssMb,
        path: command.split(' ')[0],
      });
    }
    return processes;
  } catch (e) {
    return [];
  }
}

async function getSystemStats() {
  if (platform === 'win32') {
    return getSystemStatsWindows();
  }
  return getSystemStatsUnix();
}

async function getSystemStatsWindows() {
  const cmd = `$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; $mem = Get-CimInstance Win32_OperatingSystem; @{CPU=[math]::Round($cpu,1);TotalMemGB=[math]::Round($mem.TotalVisibleMemorySize/1MB,1);FreeMemGB=[math]::Round($mem.FreePhysicalMemory/1MB,1);Cores=(Get-CimInstance Win32_Processor).NumberOfLogicalProcessors} | ConvertTo-Json -Compress`;
  try {
    const raw = await runPowerShell(cmd);
    return JSON.parse(raw);
  } catch (e) {
    return { CPU: 0, TotalMemGB: 0, FreeMemGB: 0, Cores: 1 };
  }
}

async function getSystemStatsUnix() {
  // Use Node.js os module for cross-platform system info
  const cores = os.cpus().length;
  const totalMemGB = Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10;
  const freeMemGB = Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10;

  // Get CPU load percentage from os.loadavg (1-minute average, normalized to core count)
  const loadAvg1m = os.loadavg()[0];
  const cpuPercent = Math.round((loadAvg1m / cores) * 100 * 10) / 10;

  return {
    CPU: Math.min(cpuPercent, 100),
    TotalMemGB: totalMemGB,
    FreeMemGB: freeMemGB,
    Cores: cores,
  };
}

// --- CPU Limiting ---
// Windows: ProcessorAffinity + PriorityClass via PowerShell
// Linux:   taskset for CPU affinity (direct equivalent of ProcessorAffinity)
// macOS:   cpulimit (brew) for percentage-based throttling, renice as fallback

async function applyCpuLimit(processName, cpuPercent) {
  if (platform === 'win32') {
    return applyCpuLimitWindows(processName, cpuPercent);
  }
  if (platform === 'linux') {
    return applyCpuLimitLinux(processName, cpuPercent);
  }
  // darwin
  return applyCpuLimitMac(processName, cpuPercent);
}

async function applyCpuLimitWindows(processName, cpuPercent) {
  const cores = os.cpus().length;
  const allowedCores = Math.max(1, Math.round(cores * (cpuPercent / 100)));

  let mask = 0;
  for (let i = 0; i < allowedCores; i++) {
    mask |= (1 << i);
  }

  const cmd = `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessorAffinity = ${mask}; $_.PriorityClass = 'BelowNormal' }`;
  try {
    await runPowerShell(cmd);
    return { status: 'ok', allowedCores, totalCores: cores, mask };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function applyCpuLimitLinux(processName, cpuPercent) {
  const cores = os.cpus().length;
  const allowedCores = Math.max(1, Math.round(cores * (cpuPercent / 100)));

  // Build affinity mask (enable first N cores) — same concept as Windows ProcessorAffinity
  let mask = 0;
  for (let i = 0; i < allowedCores; i++) {
    mask |= (1 << i);
  }
  const hexMask = '0x' + mask.toString(16);

  try {
    // Find all PIDs matching the process name
    const pidOutput = await runShell(`pgrep -x '${processName}' 2>/dev/null || true`);
    const pids = pidOutput.split('\n').filter(p => p.trim());
    if (pids.length === 0) {
      return { status: 'ok', allowedCores, totalCores: cores, mask, note: 'No matching processes found' };
    }

    const errors = [];
    for (const pid of pids) {
      try {
        // taskset is the direct Linux equivalent of Windows ProcessorAffinity
        await runShell(`taskset -p ${hexMask} ${pid.trim()}`);
        // Also lower the priority (renice)
        await runShell(`renice +10 -p ${pid.trim()} 2>/dev/null || true`);
      } catch (e) {
        errors.push(`PID ${pid}: ${e.message}`);
      }
    }

    if (errors.length > 0 && errors.length === pids.length) {
      return { status: 'error', message: errors.join('; ') };
    }
    return { status: 'ok', allowedCores, totalCores: cores, mask };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function applyCpuLimitMac(processName, cpuPercent) {
  // macOS does NOT support CPU affinity (the OS does not expose per-process core pinning).
  // Strategy:
  //   1. Try cpulimit (brew install cpulimit) for percentage-based throttling
  //   2. Fall back to renice for soft priority-based limiting
  const cores = os.cpus().length;

  try {
    const pidOutput = await runShell(`pgrep -x '${processName}' 2>/dev/null || true`);
    const pids = pidOutput.split('\n').filter(p => p.trim());
    if (pids.length === 0) {
      return { status: 'ok', totalCores: cores, note: 'No matching processes found' };
    }

    // Check if cpulimit is available
    let hasCpulimit = false;
    try {
      await runShell('which cpulimit');
      hasCpulimit = true;
    } catch (_) { /* not installed */ }

    const results = [];
    for (const pid of pids) {
      const trimmedPid = pid.trim();
      if (hasCpulimit) {
        try {
          // Kill any existing cpulimit for this PID first
          await runShell(`pkill -f 'cpulimit.*-p ${trimmedPid}' 2>/dev/null || true`);
          // Launch cpulimit in background — it will throttle the process continuously
          const perProcessLimit = Math.max(1, Math.round(cpuPercent));
          await runShell(`cpulimit -p ${trimmedPid} -l ${perProcessLimit} -b 2>/dev/null`);
          results.push({ pid: trimmedPid, method: 'cpulimit' });
        } catch (e) {
          // Fall back to renice
          await runShell(`renice +10 -p ${trimmedPid} 2>/dev/null || true`);
          results.push({ pid: trimmedPid, method: 'renice', note: 'cpulimit failed, used renice' });
        }
      } else {
        // No cpulimit available, use renice as a soft alternative
        await runShell(`renice +10 -p ${trimmedPid} 2>/dev/null || true`);
        results.push({ pid: trimmedPid, method: 'renice' });
      }
    }

    return {
      status: 'ok',
      totalCores: cores,
      method: hasCpulimit ? 'cpulimit' : 'renice',
      note: hasCpulimit
        ? undefined
        : 'CPU affinity not supported on macOS. Using renice for priority-based limiting. Install cpulimit (brew install cpulimit) for percentage-based throttling.',
      results,
    };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

// --- Memory Limiting ---
// Windows: MaxWorkingSet via PowerShell
// Linux:   prlimit --as=<bytes> for existing processes
// macOS:   Very limited — no reliable way to limit memory of running processes

async function applyMemoryLimit(processName, memoryMb) {
  if (platform === 'win32') {
    return applyMemoryLimitWindows(processName, memoryMb);
  }
  if (platform === 'linux') {
    return applyMemoryLimitLinux(processName, memoryMb);
  }
  // darwin
  return applyMemoryLimitMac(processName, memoryMb);
}

async function applyMemoryLimitWindows(processName, memoryMb) {
  const bytes = memoryMb * 1024 * 1024;
  const cmd = `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | ForEach-Object { $_.MaxWorkingSet = ${bytes} }`;
  try {
    await runPowerShell(cmd);
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function applyMemoryLimitLinux(processName, memoryMb) {
  // Use prlimit to set address space limit on existing processes.
  const bytes = memoryMb * 1024 * 1024;

  try {
    const pidOutput = await runShell(`pgrep -x '${processName}' 2>/dev/null || true`);
    const pids = pidOutput.split('\n').filter(p => p.trim());
    if (pids.length === 0) {
      return { status: 'ok', note: 'No matching processes found' };
    }

    const errors = [];
    for (const pid of pids) {
      try {
        await runShell(`prlimit --pid ${pid.trim()} --as=${bytes}`);
      } catch (e) {
        errors.push(`PID ${pid}: ${e.message}`);
      }
    }

    if (errors.length > 0 && errors.length === pids.length) {
      return { status: 'error', message: errors.join('; ') };
    }
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function applyMemoryLimitMac(processName, memoryMb) {
  // macOS limitation: there is no reliable way to limit memory of an already-running process.
  return {
    status: 'unsupported',
    message: 'Memory limiting for existing processes is not supported on macOS. '
      + 'The OS does not provide an API to cap memory of running processes. '
      + 'ulimit -v only applies to newly spawned child processes.',
    note: 'macOS does not support memory limits on running processes.',
  };
}

// --- Reset / remove limits ---

async function resetProcessLimits(processName) {
  if (platform === 'win32') {
    return resetProcessLimitsWindows(processName);
  }
  if (platform === 'linux') {
    return resetProcessLimitsLinux(processName);
  }
  return resetProcessLimitsMac(processName);
}

async function resetProcessLimitsWindows(processName) {
  const cores = os.cpus().length;
  let fullMask = 0;
  for (let i = 0; i < cores; i++) fullMask |= (1 << i);

  const cmd = `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessorAffinity = ${fullMask}; $_.PriorityClass = 'Normal' }`;
  try {
    await runPowerShell(cmd);
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function resetProcessLimitsLinux(processName) {
  const cores = os.cpus().length;
  let fullMask = 0;
  for (let i = 0; i < cores; i++) fullMask |= (1 << i);
  const hexMask = '0x' + fullMask.toString(16);

  try {
    const pidOutput = await runShell(`pgrep -x '${processName}' 2>/dev/null || true`);
    const pids = pidOutput.split('\n').filter(p => p.trim());
    for (const pid of pids) {
      const trimmedPid = pid.trim();
      // Restore full CPU affinity
      await runShell(`taskset -p ${hexMask} ${trimmedPid} 2>/dev/null || true`);
      // Restore normal priority
      await runShell(`renice 0 -p ${trimmedPid} 2>/dev/null || true`);
      // Remove prlimit memory restriction (set to unlimited)
      await runShell(`prlimit --pid ${trimmedPid} --as=unlimited 2>/dev/null || true`);
    }
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function resetProcessLimitsMac(processName) {
  try {
    const pidOutput = await runShell(`pgrep -x '${processName}' 2>/dev/null || true`);
    const pids = pidOutput.split('\n').filter(p => p.trim());
    for (const pid of pids) {
      const trimmedPid = pid.trim();
      // Kill any cpulimit processes targeting this PID
      await runShell(`pkill -f 'cpulimit.*-p ${trimmedPid}' 2>/dev/null || true`);
      // Restore normal priority
      await runShell(`renice 0 -p ${trimmedPid} 2>/dev/null || true`);
    }
    // Also kill any cpulimit targeting by name (belt and suspenders)
    await runShell(`pkill -f 'cpulimit.*${processName}' 2>/dev/null || true`);
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

// --- Process rule management ---

function startRule(rule) {
  if (activeLimiters.has(rule.id)) return;

  const apply = async () => {
    if (rule.cpuPercent && rule.cpuPercent < 100) {
      await applyCpuLimit(rule.processName, rule.cpuPercent);
    }
    if (rule.memoryMb && rule.memoryMb > 0) {
      await applyMemoryLimit(rule.processName, rule.memoryMb);
    }
  };

  apply();
  const interval = setInterval(apply, 5000);
  activeLimiters.set(rule.id, { interval, rule });
  updateTrayMenu();
  notifyRenderer();
}

function stopRule(ruleId) {
  const limiter = activeLimiters.get(ruleId);
  if (!limiter) return;

  clearInterval(limiter.interval);
  resetProcessLimits(limiter.rule.processName);
  activeLimiters.delete(ruleId);
  updateTrayMenu();
  notifyRenderer();
}

function stopAllRules() {
  for (const [id] of activeLimiters) {
    stopRule(id);
  }
}

function notifyRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('proc-rules-changed', getActiveRuleIds());
  }
}

function getActiveRuleIds() {
  return [...activeLimiters.keys()];
}

// --- Process presets ---

const PROCESS_PRESETS = {
  'claude-light': {
    name: 'Claude Code — Light',
    rules: [
      { processName: 'node', cpuPercent: 75, memoryMb: 0 },
    ],
  },
  'claude-strict': {
    name: 'Claude Code — Strict',
    rules: [
      { processName: 'node', cpuPercent: 50, memoryMb: 2048 },
      { processName: 'git', cpuPercent: 50, memoryMb: 0 },
    ],
  },
  'build-tools': {
    name: 'Build Tools',
    rules: [
      { processName: 'node', cpuPercent: 60, memoryMb: 0 },
      { processName: 'msbuild', cpuPercent: 60, memoryMb: 0 },
      { processName: 'cl', cpuPercent: 60, memoryMb: 0 },
    ],
  },
  'background-apps': {
    name: 'Background Apps',
    rules: [
      { processName: 'OneDrive', cpuPercent: 25, memoryMb: 512 },
      { processName: 'Teams', cpuPercent: 50, memoryMb: 1024 },
      { processName: 'Slack', cpuPercent: 50, memoryMb: 1024 },
    ],
  },
};

// ============================================================
// AUTO-START (cross-platform)
// ============================================================

async function setAutoStart(enabled) {
  const exePath = process.execPath;
  const appPath = app.getAppPath();
  const launchCmd = exePath.includes('electron') ? `"${exePath}" "${appPath}"` : `"${exePath}"`;

  try {
    if (platform === 'win32') {
      // Windows: registry-based auto-start
      if (enabled) {
        await runPowerShell(
          `New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'ResourceGovernor' -Value '${launchCmd}' -PropertyType String -Force`
        );
      } else {
        await runPowerShell(
          `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'ResourceGovernor' -ErrorAction SilentlyContinue`
        );
      }
    } else if (platform === 'darwin') {
      // macOS: LaunchAgent plist
      const plistName = 'com.cloudnimbus.resource-governor';
      const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
      const plistPath = path.join(plistDir, `${plistName}.plist`);
      if (enabled) {
        const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${plistName}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${exePath}</string>${exePath.includes('electron') ? `\n        <string>${appPath}</string>` : ''}
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>`;
        if (!fs.existsSync(plistDir)) {
          fs.mkdirSync(plistDir, { recursive: true });
        }
        fs.writeFileSync(plistPath, plistContent, 'utf8');
      } else {
        try { fs.unlinkSync(plistPath); } catch (e) { /* ignore if not found */ }
      }
    } else if (platform === 'linux') {
      // Linux: .desktop file in autostart directory
      const autostartDir = path.join(os.homedir(), '.config', 'autostart');
      const desktopPath = path.join(autostartDir, 'resource-governor.desktop');
      if (enabled) {
        const desktopContent = `[Desktop Entry]
Type=Application
Name=Resource Governor
Exec=${launchCmd}
X-GNOME-Autostart-enabled=true
Hidden=false
NoDisplay=false
Comment=Bandwidth, CPU, and memory governor
`;
        if (!fs.existsSync(autostartDir)) {
          fs.mkdirSync(autostartDir, { recursive: true });
        }
        fs.writeFileSync(desktopPath, desktopContent, 'utf8');
      } else {
        try { fs.unlinkSync(desktopPath); } catch (e) { /* ignore if not found */ }
      }
    }

    const settings = store.get('settings');
    settings.autoStart = enabled;
    store.set('settings', settings);
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

// ============================================================
// IPC HANDLERS — Bandwidth (bw-* prefix)
// ============================================================

ipcMain.handle('bw-create-policy', (_, data) => createPolicy(data));
ipcMain.handle('bw-remove-policy', (_, name) => removePolicy(name));
ipcMain.handle('bw-remove-all', () => removeAllPolicies());
ipcMain.handle('bw-get-policies', () => store.get('policies', []));
ipcMain.handle('bw-get-bandwidth', () => getBandwidthUsage());
ipcMain.handle('bw-get-enabled', () => isBandwidthEnabled);
ipcMain.handle('bw-toggle-enabled', () => toggleBandwidthEnabled());

ipcMain.handle('bw-apply-preset', async (_, { preset }) => {
  await removeAllPolicies();

  const p = BANDWIDTH_PRESETS[preset];
  if (!p) return { status: 'error', message: 'Unknown preset' };

  isBandwidthEnabled = true;
  store.set('bandwidthEnabled', true);
  updateTrayMenu();

  return await createPolicy({
    name: `Preset_${preset}`,
    appPath: null,
    uploadLimitMbps: p.upload,
    downloadLimitMbps: p.download,
  });
});

ipcMain.handle('bw-quick-limit-app', async (_, { appName, uploadMbps }) => {
  return await createPolicy({
    name: `App_${appName.replace(/\.exe$/i, '')}`,
    appPath: appName,
    uploadLimitMbps: uploadMbps,
    downloadLimitMbps: 0,
  });
});

ipcMain.handle('bw-run-speed-test', async () => {
  return await runSpeedTest();
});

ipcMain.handle('bw-configure-claude', async (_, { uploadCapPercent, forceSpeedTest }) => {
  // Step 1: Use saved speed or run test
  let speed;
  const savedConfig = store.get('claudeConfig');
  if (!forceSpeedTest && savedConfig && savedConfig.speed && savedConfig.speed.upload > 0) {
    speed = savedConfig.speed;
  } else {
    speed = await runSpeedTest();
    if (speed.upload <= 0) {
      return { status: 'error', message: 'Speed test failed - could not measure upload speed', speed };
    }
  }

  // Step 2: Calculate limit
  const percent = uploadCapPercent || 50;
  const limitMbps = Math.max(0.5, Math.round(speed.upload * (percent / 100) * 10) / 10);

  // Step 3 & 4: Remove existing and apply new Claude policies
  if (platform === 'win32') {
    // Windows: per-app limiting targets specific executables
    const claudeApps = ['node.exe', 'claude.exe', 'git.exe', 'git-remote-https.exe', 'ssh.exe', 'scp.exe'];
    for (const a of claudeApps) {
      try { await removePolicy(`Claude_${a.replace('.exe', '')}`); } catch (e) {}
    }

    const results = [];
    for (const appName of claudeApps) {
      const r = await createPolicy({
        name: `Claude_${appName.replace('.exe', '')}`,
        appPath: appName,
        uploadLimitMbps: limitMbps,
        downloadLimitMbps: 0,
      });
      results.push({ app: appName, result: r });
    }

    isBandwidthEnabled = true;
    store.set('bandwidthEnabled', true);
    updateTrayMenu();

    const claudeConfig = { speed, percent, limitMbps, testedAt: new Date().toISOString() };
    store.set('claudeConfig', claudeConfig);

    return {
      status: 'ok',
      speed,
      percent,
      limitMbps,
      results,
      usedSavedSpeed: !forceSpeedTest && savedConfig && savedConfig.speed && savedConfig.speed.upload > 0,
    };
  } else {
    // macOS/Linux: apply a single global upload limit (per-app not supported)
    try { await removePolicy('Claude_global'); } catch (e) {}

    const r = await createPolicy({
      name: 'Claude_global',
      appPath: null,
      uploadLimitMbps: limitMbps,
      downloadLimitMbps: 0,
    });

    isBandwidthEnabled = true;
    store.set('bandwidthEnabled', true);
    updateTrayMenu();

    const claudeConfig = { speed, percent, limitMbps, testedAt: new Date().toISOString() };
    store.set('claudeConfig', claudeConfig);

    return {
      status: 'ok',
      speed,
      percent,
      limitMbps,
      results: [{ app: 'global', result: r }],
      usedSavedSpeed: !forceSpeedTest && savedConfig && savedConfig.speed && savedConfig.speed.upload > 0,
      note: 'Per-app limiting is only available on Windows. A global upload limit has been applied.',
    };
  }
});

ipcMain.handle('get-claude-config', () => store.get('claudeConfig'));

ipcMain.handle('quick-setup', async (_, { uploadCapPercent }) => {
  let speed;
  const savedConfig = store.get('claudeConfig');
  if (savedConfig && savedConfig.speed && savedConfig.speed.upload > 0) {
    speed = savedConfig.speed;
  } else {
    speed = await runSpeedTest();
    if (speed.upload <= 0) {
      return { status: 'error', message: 'Speed test failed', speed };
    }
  }

  const percent = uploadCapPercent || 50;
  const limitMbps = Math.max(0.5, Math.round(speed.upload * (percent / 100) * 10) / 10);

  if (platform === 'win32') {
    const claudeApps = ['node.exe', 'claude.exe', 'git.exe', 'git-remote-https.exe', 'ssh.exe', 'scp.exe'];
    for (const a of claudeApps) {
      try { await removePolicy(`Claude_${a.replace('.exe', '')}`); } catch (e) {}
    }
    for (const appName of claudeApps) {
      await createPolicy({
        name: `Claude_${appName.replace('.exe', '')}`,
        appPath: appName,
        uploadLimitMbps: limitMbps,
        downloadLimitMbps: 0,
      });
    }
  } else {
    // macOS/Linux: single global limit (per-app not supported)
    try { await removePolicy('Claude_global'); } catch (e) {}
    await createPolicy({
      name: 'Claude_global',
      appPath: null,
      uploadLimitMbps: limitMbps,
      downloadLimitMbps: 0,
    });
  }

  isBandwidthEnabled = true;
  store.set('bandwidthEnabled', true);
  updateTrayMenu();

  // Save claude config
  store.set('claudeConfig', { speed, percent, limitMbps, testedAt: new Date().toISOString() });

  // Enable auto-start
  await setAutoStart(true);

  // Set start-minimized
  const settings = store.get('settings');
  settings.autoStart = true;
  settings.startMinimized = true;
  settings.autoApplyOnLaunch = true;
  store.set('settings', settings);

  // Minimize to tray
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }

  return {
    status: 'ok',
    speed,
    percent,
    limitMbps,
    ...(platform !== 'win32' ? { note: 'Per-app limiting is only available on Windows. A global upload limit has been applied.' } : {}),
  };
});

// ============================================================
// IPC HANDLERS — Process (proc-* prefix)
// ============================================================

ipcMain.handle('proc-get-top-processes', () => getTopProcesses());
ipcMain.handle('proc-get-system-stats', () => getSystemStats());
ipcMain.handle('proc-get-rules', () => store.get('processRules', []));
ipcMain.handle('proc-get-active-rules', () => getActiveRuleIds());

ipcMain.handle('proc-save-rule', (_, rule) => {
  const rules = store.get('processRules', []);
  if (!rule.id) {
    rule.id = `rule_${Date.now()}`;
    rule.createdAt = new Date().toISOString();
    rules.push(rule);
  } else {
    const idx = rules.findIndex(r => r.id === rule.id);
    if (idx >= 0) {
      if (activeLimiters.has(rule.id)) {
        stopRule(rule.id);
      }
      rules[idx] = { ...rules[idx], ...rule };
    }
  }
  store.set('processRules', rules);
  return rule;
});

ipcMain.handle('proc-remove-rule', (_, id) => {
  stopRule(id);
  const rules = store.get('processRules', []).filter(r => r.id !== id);
  store.set('processRules', rules);
  return { status: 'ok' };
});

ipcMain.handle('proc-start-rule', (_, id) => {
  const rules = store.get('processRules', []);
  const rule = rules.find(r => r.id === id);
  if (!rule) return { status: 'error', message: 'Rule not found' };
  startRule(rule);
  return { status: 'ok' };
});

ipcMain.handle('proc-stop-rule', (_, id) => {
  stopRule(id);
  return { status: 'ok' };
});

ipcMain.handle('proc-stop-all', () => {
  stopAllRules();
  return { status: 'ok' };
});

ipcMain.handle('proc-apply-preset', (_, presetKey) => {
  const preset = PROCESS_PRESETS[presetKey];
  if (!preset) return { status: 'error', message: 'Unknown preset' };

  const rules = store.get('processRules', []);
  const newRules = [];

  for (const pr of preset.rules) {
    const existing = rules.find(r => r.processName === pr.processName);
    if (existing) {
      existing.cpuPercent = pr.cpuPercent;
      existing.memoryMb = pr.memoryMb;
      if (activeLimiters.has(existing.id)) stopRule(existing.id);
      startRule(existing);
      newRules.push(existing);
    } else {
      const rule = {
        id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: `${preset.name} — ${pr.processName}`,
        processName: pr.processName,
        cpuPercent: pr.cpuPercent,
        memoryMb: pr.memoryMb,
        createdAt: new Date().toISOString(),
      };
      rules.push(rule);
      startRule(rule);
      newRules.push(rule);
    }
  }

  store.set('processRules', rules);
  return { status: 'ok', rules: newRules };
});

ipcMain.handle('proc-get-presets', () => PROCESS_PRESETS);

// ============================================================
// IPC HANDLERS — Shared
// ============================================================

ipcMain.handle('check-admin', () => checkAdmin());

ipcMain.handle('self-elevate', async () => {
  const exePath = process.execPath;
  const appPath = app.getAppPath();
  try {
    if (platform === 'win32') {
      await runPowerShell(
        `Start-Process '${exePath}' -ArgumentList '"${appPath}"' -Verb RunAs`
      );
    } else if (platform === 'darwin') {
      // macOS: relaunch with admin privileges via osascript
      const launchCmd = exePath.includes('electron')
        ? `\\"${exePath}\\" \\"${appPath}\\"`
        : `open \\"${exePath}\\"`;
      await runShell(
        `osascript -e 'do shell script "${launchCmd}" with administrator privileges'`
      );
    } else if (platform === 'linux') {
      // Linux: relaunch with pkexec for graphical sudo
      const launchArgs = exePath.includes('electron') ? `"${exePath}" "${appPath}"` : `"${exePath}"`;
      await runShell(`pkexec ${launchArgs} &`);
    }
    app.isQuitting = true;
    app.quit();
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('get-settings', () => store.get('settings'));
ipcMain.handle('save-settings', (_, settings) => {
  store.set('settings', settings);
  return { status: 'ok' };
});

ipcMain.handle('kill-process', async (_, pid) => {
  try {
    if (platform === 'win32') {
      await runPowerShell(`Stop-Process -Id ${pid} -Force -ErrorAction Stop`);
    } else {
      await runShell(`kill -9 ${pid}`);
    }
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('set-auto-start', (_, enabled) => setAutoStart(enabled));

ipcMain.handle('get-platform', () => platform);

// --- Launchers ---

ipcMain.handle('get-launchers', () => store.get('launchers', []));

ipcMain.handle('save-launcher', (_, launcher) => {
  const launchers = store.get('launchers', []);
  if (!launcher.id) {
    launcher.id = `launch_${Date.now()}`;
    launchers.push(launcher);
  } else {
    const idx = launchers.findIndex(l => l.id === launcher.id);
    if (idx >= 0) launchers[idx] = launcher;
    else launchers.push(launcher);
  }
  store.set('launchers', launchers);
  return launcher;
});

ipcMain.handle('remove-launcher', (_, id) => {
  const launchers = store.get('launchers', []).filter(l => l.id !== id);
  store.set('launchers', launchers);
  return { status: 'ok' };
});

ipcMain.handle('launch-claude', (_, { id, promptText }) => {
  const launchers = store.get('launchers', []);
  const launcher = launchers.find(l => l.id === id);
  if (!launcher) return { status: 'error', message: 'Launcher not found' };

  const args = launcher.claudeArgs || '--dangerously-skip-permissions';

  let cmd;
  if (platform === 'win32') {
    const folder = launcher.folder.replace(/\//g, '\\');
    if (promptText) {
      cmd = `start cmd.exe /k "cd /d ${folder} && echo Prompt copied to clipboard. && claude ${args}"`;
      const { clipboard } = require('electron');
      clipboard.writeText(promptText);
    } else {
      cmd = `start cmd.exe /k "cd /d ${folder} && claude ${args}"`;
    }
  } else if (platform === 'darwin') {
    // macOS: open a new Terminal.app window
    const folder = launcher.folder;
    if (promptText) {
      const { clipboard } = require('electron');
      clipboard.writeText(promptText);
    }
    const escapedFolder = folder.replace(/'/g, "'\\''");
    const termCmd = `cd '${escapedFolder}' && claude ${args}`;
    cmd = `osascript -e 'tell application "Terminal" to do script "${termCmd.replace(/"/g, '\\"')}"'`;
  } else {
    // Linux: try common terminal emulators
    const folder = launcher.folder;
    if (promptText) {
      const { clipboard } = require('electron');
      clipboard.writeText(promptText);
    }
    const escapedFolder = folder.replace(/'/g, "'\\''");
    const innerCmd = `cd '${escapedFolder}' && claude ${args}`;
    // Try x-terminal-emulator (Debian/Ubuntu default), then xterm as fallback
    cmd = `x-terminal-emulator -e bash -c '${innerCmd.replace(/'/g, "'\\''")}; exec bash' 2>/dev/null || xterm -e bash -c '${innerCmd.replace(/'/g, "'\\''")}; exec bash' 2>/dev/null`;
  }

  exec(cmd, { windowsHide: false, shell: platform === 'win32' ? true : '/bin/bash' }, (err) => {
    if (err) console.error('Launch error:', err.message);
  });

  return { status: 'ok', folder: launcher.folder };
});

ipcMain.handle('browse-folder', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select project folder',
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// --- Prompt Backlog ---

ipcMain.handle('get-prompts', () => store.get('prompts', []));

ipcMain.handle('save-prompt', (_, prompt) => {
  const prompts = store.get('prompts', []);
  if (!prompt.id) {
    prompt.id = `prompt_${Date.now()}`;
    prompt.createdAt = new Date().toISOString();
    prompt.status = prompt.status || 'queued';
    prompt.priority = prompt.priority || prompts.length;
    prompts.push(prompt);
  } else {
    const idx = prompts.findIndex(p => p.id === prompt.id);
    if (idx >= 0) prompts[idx] = { ...prompts[idx], ...prompt };
  }
  store.set('prompts', prompts);
  return prompt;
});

ipcMain.handle('remove-prompt', (_, id) => {
  const prompts = store.get('prompts', []).filter(p => p.id !== id);
  store.set('prompts', prompts);
  return { status: 'ok' };
});

ipcMain.handle('reorder-prompts', (_, ids) => {
  const prompts = store.get('prompts', []);
  const reordered = ids.map((id, i) => {
    const p = prompts.find(pr => pr.id === id);
    if (p) p.priority = i;
    return p;
  }).filter(Boolean);
  for (const p of prompts) {
    if (!ids.includes(p.id)) reordered.push(p);
  }
  store.set('prompts', reordered);
  return { status: 'ok' };
});

ipcMain.handle('update-prompt-status', (_, { id, status }) => {
  const prompts = store.get('prompts', []);
  const p = prompts.find(pr => pr.id === id);
  if (p) {
    p.status = status;
    if (status === 'done') p.completedAt = new Date().toISOString();
    store.set('prompts', prompts);
  }
  return { status: 'ok' };
});

// --- Single instance lock ---

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  // Another instance is already running — show a dialog and quit
  app.whenReady().then(() => {
    const { dialog } = require('electron');
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Resource Governor',
      message: 'Resource Governor is already running!',
      detail: 'Another instance is active in the system tray. Running multiple instances causes QoS policy conflicts.\n\nClick OK to close this duplicate.',
      buttons: ['OK'],
    });
    app.quit();
  });
} else {
  // When a second instance tries to launch, focus the existing window
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// ============================================================
// APP LIFECYCLE
// ============================================================

if (gotLock) {
app.whenReady().then(async () => {
  createTray();

  const settings = store.get('settings');
  const bwSettings = store.get('bandwidthSettings');
  const procSettings = store.get('processSettings');

  // Auto-apply bandwidth policies on launch
  if (isBandwidthEnabled && bwSettings.autoApplyOnLaunch) {
    await reapplyPolicies();
  }

  // Auto-apply process rules on launch
  if (procSettings.autoApplyOnLaunch) {
    const rules = store.get('processRules', []);
    for (const rule of rules) {
      if (rule.enabled !== false) {
        startRule(rule);
      }
    }
  }

  // Show window unless start-minimized is on
  if (!settings.startMinimized) {
    createWindow();
  }
});
}

app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('activate', () => { if (gotLock) createWindow(); });
app.on('before-quit', () => {
  app.isQuitting = true;
  stopAllRules();
});
