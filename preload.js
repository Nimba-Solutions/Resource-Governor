/**
 * @name         Resource Governor
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Preload script — exposes unified IPC bridge to the renderer process.
 * @author       Cloud Nimbus LLC
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // --- Bandwidth (bw-*) ---
  bwCreatePolicy: (data) => ipcRenderer.invoke('bw-create-policy', data),
  bwRemovePolicy: (name) => ipcRenderer.invoke('bw-remove-policy', name),
  bwRemoveAll: () => ipcRenderer.invoke('bw-remove-all'),
  bwGetPolicies: () => ipcRenderer.invoke('bw-get-policies'),
  bwGetBandwidth: () => ipcRenderer.invoke('bw-get-bandwidth'),
  bwGetEnabled: () => ipcRenderer.invoke('bw-get-enabled'),
  bwToggleEnabled: () => ipcRenderer.invoke('bw-toggle-enabled'),
  bwApplyPreset: (preset) => ipcRenderer.invoke('bw-apply-preset', { preset }),
  bwQuickLimitApp: (appName, uploadMbps) => ipcRenderer.invoke('bw-quick-limit-app', { appName, uploadMbps }),
  bwRunSpeedTest: () => ipcRenderer.invoke('bw-run-speed-test'),
  bwConfigureClaude: (uploadCapPercent, forceSpeedTest) => ipcRenderer.invoke('bw-configure-claude', { uploadCapPercent, forceSpeedTest }),
  getClaudeConfig: () => ipcRenderer.invoke('get-claude-config'),
  quickSetup: (uploadCapPercent) => ipcRenderer.invoke('quick-setup', { uploadCapPercent }),
  onBwEnabledChanged: (cb) => ipcRenderer.on('bw-enabled-changed', (_, val) => cb(val)),

  // --- Process (proc-*) ---
  procGetTopProcesses: () => ipcRenderer.invoke('proc-get-top-processes'),
  procGetSystemStats: () => ipcRenderer.invoke('proc-get-system-stats'),
  procGetRules: () => ipcRenderer.invoke('proc-get-rules'),
  procGetActiveRules: () => ipcRenderer.invoke('proc-get-active-rules'),
  procSaveRule: (rule) => ipcRenderer.invoke('proc-save-rule', rule),
  procRemoveRule: (id) => ipcRenderer.invoke('proc-remove-rule', id),
  procStartRule: (id) => ipcRenderer.invoke('proc-start-rule', id),
  procStopRule: (id) => ipcRenderer.invoke('proc-stop-rule', id),
  procStopAll: () => ipcRenderer.invoke('proc-stop-all'),
  procApplyPreset: (key) => ipcRenderer.invoke('proc-apply-preset', key),
  procGetPresets: () => ipcRenderer.invoke('proc-get-presets'),
  onProcRulesChanged: (cb) => ipcRenderer.on('proc-rules-changed', (_, ids) => cb(ids)),

  // --- Shared ---
  checkAdmin: () => ipcRenderer.invoke('check-admin'),
  selfElevate: () => ipcRenderer.invoke('self-elevate'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  killProcess: (pid) => ipcRenderer.invoke('kill-process', pid),
  setAutoStart: (v) => ipcRenderer.invoke('set-auto-start', v),

  // --- Launchers ---
  getLaunchers: () => ipcRenderer.invoke('get-launchers'),
  saveLauncher: (l) => ipcRenderer.invoke('save-launcher', l),
  removeLauncher: (id) => ipcRenderer.invoke('remove-launcher', id),
  launchClaude: (id, promptText) => ipcRenderer.invoke('launch-claude', { id, promptText }),
  browseFolder: () => ipcRenderer.invoke('browse-folder'),

  // --- Prompts ---
  getPrompts: () => ipcRenderer.invoke('get-prompts'),
  savePrompt: (p) => ipcRenderer.invoke('save-prompt', p),
  removePrompt: (id) => ipcRenderer.invoke('remove-prompt', id),
  reorderPrompts: (ids) => ipcRenderer.invoke('reorder-prompts', ids),
  updatePromptStatus: (id, status) => ipcRenderer.invoke('update-prompt-status', { id, status }),
});
