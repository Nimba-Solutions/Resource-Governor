/**
 * @name         Resource Governor
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Electron main process — unified bandwidth, CPU, and memory governor for Windows.
 * @author       Cloud Nimbus LLC
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const Store = require('electron-store');

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
// POWERSHELL RUNNER
// ============================================================

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${command.replace(/"/g, '\\"')}"`;
    exec(psCmd, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
    const result = await runPowerShell(
      `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
    );
    return result === 'True';
  } catch (e) {
    return false;
  }
}

// ============================================================
// BANDWIDTH — Policy management via Windows QoS
// ============================================================

async function createPolicy({ name, appPath, uploadLimitMbps, downloadLimitMbps }) {
  const results = [];

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

  // Save to persistent store (avoid duplicates)
  const saved = store.get('policies', []);
  const existing = saved.findIndex(p => p.name === name);
  const entry = { name, appPath, uploadLimitMbps, downloadLimitMbps, createdAt: new Date().toISOString() };
  if (existing >= 0) saved[existing] = entry;
  else saved.push(entry);
  store.set('policies', saved);

  return results;
}

async function removePolicy(name) {
  const results = [];
  for (const prefix of ['RG_UL_', 'RG_DL_']) {
    const policyName = `${prefix}${name}`;
    try {
      await runPowerShell(`Remove-NetQosPolicy -Name '${policyName}' -PolicyStore ActiveStore -Confirm:$false`);
      results.push({ policy: policyName, status: 'removed' });
    } catch (e) {
      results.push({ policy: policyName, status: 'not_found' });
    }
  }
  const saved = store.get('policies', []);
  store.set('policies', saved.filter(p => p.name !== name));
  return results;
}

async function removeAllPolicies() {
  try {
    await runPowerShell(
      `Get-NetQosPolicy -PolicyStore ActiveStore | Where-Object { $_.Name -like 'RG_*' } | Remove-NetQosPolicy -Confirm:$false`
    );
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
      await runPowerShell(
        `Get-NetQosPolicy -PolicyStore ActiveStore | Where-Object { $_.Name -like 'RG_*' } | Remove-NetQosPolicy -Confirm:$false`
      );
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
}

// --- Bandwidth monitoring ---

let lastStats = null;
let lastStatsTime = null;

async function getBandwidthUsage() {
  try {
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
  } catch (e) {
    return null;
  }
}

// --- Speed test ---

async function runSpeedTest() {
  const results = { download: 0, upload: 0 };

  try {
    const dlResult = await new Promise((resolve, reject) => {
      const testSize = 10000000;
      exec(
        `curl -s -o /dev/null -w "%{speed_download}" "https://speed.cloudflare.com/__down?bytes=${testSize}"`,
        { windowsHide: true, timeout: 30000 },
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
      const fs = require('fs');
      fs.writeFileSync(tempFile, Buffer.alloc(2000000, 0x41));

      exec(
        `curl -s -w "%{speed_upload}" -X POST -F "file=@${tempFile.replace(/\\/g, '/')}" "https://speed.cloudflare.com/__up" -o /dev/null`,
        { windowsHide: true, timeout: 30000 },
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
// PROCESS — CPU/Memory limiting via affinity & working set
// ============================================================

async function getTopProcesses() {
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

async function getSystemStats() {
  const cmd = `$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; $mem = Get-CimInstance Win32_OperatingSystem; @{CPU=[math]::Round($cpu,1);TotalMemGB=[math]::Round($mem.TotalVisibleMemorySize/1MB,1);FreeMemGB=[math]::Round($mem.FreePhysicalMemory/1MB,1);Cores=(Get-CimInstance Win32_Processor).NumberOfLogicalProcessors} | ConvertTo-Json -Compress`;
  try {
    const raw = await runPowerShell(cmd);
    return JSON.parse(raw);
  } catch (e) {
    return { CPU: 0, TotalMemGB: 0, FreeMemGB: 0, Cores: 1 };
  }
}

async function applyCpuLimit(processName, cpuPercent) {
  const cores = require('os').cpus().length;
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

async function applyMemoryLimit(processName, memoryMb) {
  const bytes = memoryMb * 1024 * 1024;
  const cmd = `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | ForEach-Object { $_.MaxWorkingSet = ${bytes} }`;
  try {
    await runPowerShell(cmd);
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function resetProcessLimits(processName) {
  const cores = require('os').cpus().length;
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
// AUTO-START (Windows registry)
// ============================================================

async function setAutoStart(enabled) {
  const exePath = process.execPath;
  const appPath = app.getAppPath();
  const launchCmd = exePath.includes('electron') ? `"${exePath}" "${appPath}"` : `"${exePath}"`;

  try {
    if (enabled) {
      await runPowerShell(
        `New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'ResourceGovernor' -Value '${launchCmd}' -PropertyType String -Force`
      );
    } else {
      await runPowerShell(
        `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'ResourceGovernor' -ErrorAction SilentlyContinue`
      );
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
    name: `App_${appName.replace('.exe', '')}`,
    appPath: appName,
    uploadLimitMbps: uploadMbps,
    downloadLimitMbps: 0,
  });
});

ipcMain.handle('bw-run-speed-test', async () => {
  return await runSpeedTest();
});

ipcMain.handle('bw-configure-claude', async (_, { uploadCapPercent }) => {
  const speed = await runSpeedTest();
  if (speed.upload <= 0) {
    return { status: 'error', message: 'Speed test failed - could not measure upload speed', speed };
  }

  const percent = uploadCapPercent || 50;
  const limitMbps = Math.max(0.5, Math.round(speed.upload * (percent / 100) * 10) / 10);

  const claudeApps = ['node.exe', 'claude.exe', 'git.exe', 'git-remote-https.exe', 'ssh.exe', 'scp.exe'];
  for (const appName of claudeApps) {
    try { await removePolicy(`Claude_${appName.replace('.exe', '')}`); } catch (e) {}
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

  return { status: 'ok', speed, percent, limitMbps, results };
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
    await runPowerShell(
      `Start-Process '${exePath}' -ArgumentList '"${appPath}"' -Verb RunAs`
    );
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
    await runPowerShell(`Stop-Process -Id ${pid} -Force -ErrorAction Stop`);
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('set-auto-start', (_, enabled) => setAutoStart(enabled));

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

  const folder = launcher.folder.replace(/\//g, '\\');
  const args = launcher.claudeArgs || '--dangerously-skip-permissions';

  let cmd;
  if (promptText) {
    cmd = `start cmd.exe /k "cd /d ${folder} && echo Prompt copied to clipboard. && claude ${args}"`;
    const { clipboard } = require('electron');
    clipboard.writeText(promptText);
  } else {
    cmd = `start cmd.exe /k "cd /d ${folder} && claude ${args}"`;
  }

  exec(cmd, { windowsHide: false, shell: true }, (err) => {
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

// ============================================================
// APP LIFECYCLE
// ============================================================

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

app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('activate', () => createWindow());
app.on('before-quit', () => {
  app.isQuitting = true;
  stopAllRules();
});
