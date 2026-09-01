const path = require('path');
const fs = require('fs');
const {
  classifyWorkerApiError,
  parseWorkerStopReasonLine,
  mapStopReasonToWorkerExitReason,
} = require('./workerHubErrorTaxonomy.cjs');

const LIFECYCLE_DEFAULTS = {
  launchAtStartup: false,
  startWorkerOnLaunch: false,
  minimizeToTrayOnClose: true,
  showCloseToTrayHint: true,
  developerMode: false,
};

// Module-level reference so the tray is never GC'd while the app runs.
let activeTray = null;
const trayStatus = {
  initialized: false,
  active: false,
  resolvedPath: '',
  exists: false,
  unavailableReason: '',
};

function mergeLifecycleDefaults(config = {}) {
  return {
    ...LIFECYCLE_DEFAULTS,
    ...config,
    launchAtStartup: Boolean(config.launchAtStartup),
    startWorkerOnLaunch: Boolean(config.startWorkerOnLaunch),
    minimizeToTrayOnClose: config.minimizeToTrayOnClose !== false,
    showCloseToTrayHint: config.showCloseToTrayHint !== false,
    developerMode: Boolean(config.developerMode),
  };
}

function createAppLifecycleManager({
  app,
  Tray,
  Menu,
  nativeImage,
  Notification,
  getMainWindow,
  loadConfig,
  saveConfig,
  startWorker,
  stopWorkerInternal,
  prepareRuntime,
  checkRuntime,
  fetchWorkerOverview,
  getStoredToken,
  getWorkerState,
  sendLog,
  safeSendToRenderer,
}) {
  let isQuitting = false;
  let userStoppedWorker = false;
  let workerAutoRestartAttempts = 0;
  let workerExitReason = null;
  let trayHubStatus = 'unchecked';
  let cachedAppConfig = null;
  let workerRestartTimer = null;

  function resolveWindowsTrayIconPath() {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'assets', 'tray.ico')
      : path.join(__dirname, '..', 'assets', 'tray.ico');
  }

  function resolveTrayIconCandidates() {
    if (process.platform === 'win32') {
      return [resolveWindowsTrayIconPath()];
    }
    const candidates = [];
    if (app.isPackaged) {
      candidates.push(path.join(process.resourcesPath, 'assets', 'tray.ico'));
      candidates.push(path.join(process.resourcesPath, 'assets', 'tray.png'));
    }
    candidates.push(path.join(__dirname, '..', 'assets', 'tray.ico'));
    candidates.push(path.join(__dirname, '..', 'assets', 'tray.png'));
    return candidates;
  }

  function loadTrayNativeImage() {
    if (process.platform === 'win32') {
      const iconPath = resolveWindowsTrayIconPath();
      if (!fs.existsSync(iconPath)) {
        sendLog('warn', 'Tray unavailable: icon_missing');
        sendLog('info', `Tray icon path: ${iconPath}`);
        return { image: null, iconPath, exists: false };
      }
      try {
        const image = nativeImage.createFromPath(iconPath);
        if (image.isEmpty()) {
          sendLog('warn', 'Tray unavailable: icon_empty');
          sendLog('info', `Tray icon path: ${iconPath}`);
          return { image: null, iconPath, exists: true };
        }
        return { image, iconPath, exists: true };
      } catch (error) {
        sendLog('warn', `Tray unavailable: icon_load_failed (${error?.message || String(error)})`);
        sendLog('info', `Tray icon path: ${iconPath}`);
        return { image: null, iconPath, exists: true };
      }
    }

    const candidates = resolveTrayIconCandidates();
    for (const iconPath of candidates) {
      if (!iconPath || !fs.existsSync(iconPath)) {
        continue;
      }
      try {
        const image = nativeImage.createFromPath(iconPath);
        if (!image.isEmpty()) {
          return { image, iconPath, exists: true };
        }
      } catch {}
    }
    const iconPath = candidates[0] || '';
    sendLog('warn', 'Tray unavailable: icon_missing');
    if (iconPath) sendLog('info', `Tray icon path: ${iconPath}`);
    return { image: null, iconPath, exists: false };
  }

  function ensureTray() {
    if (activeTray) {
      trayStatus.initialized = true;
      trayStatus.active = true;
      return activeTray;
    }

    if (!Tray) {
      trayStatus.unavailableReason = 'Tray API unavailable';
      sendLog('warn', 'Tray unavailable: Tray API missing');
      return null;
    }

    const { image, iconPath, exists } = loadTrayNativeImage();
    trayStatus.resolvedPath = iconPath || '';
    trayStatus.exists = exists;

    if (!image || image.isEmpty()) {
      trayStatus.unavailableReason = trayStatus.exists ? 'Tray icon empty' : 'Tray icon missing';
      sendLog('warn', trayStatus.exists ? 'Tray unavailable: icon_empty' : 'Tray unavailable: icon_missing');
      if (iconPath) sendLog('info', `Tray icon path: ${iconPath}`);
      return null;
    }

    try {
      activeTray = new Tray(image);
      activeTray.setToolTip('Quavence AI Worker');
      activeTray.on('double-click', () => showMainWindow());
      trayStatus.initialized = true;
      trayStatus.active = true;
      trayStatus.unavailableReason = '';
      sendLog('info', `Tray initialized: ${iconPath}`);
      sendLog('info', 'Tray icon exists: true');
      updateTrayMenu();
      return activeTray;
    } catch (error) {
      activeTray = null;
      trayStatus.initialized = false;
      trayStatus.active = false;
      trayStatus.unavailableReason = error?.message || 'Tray creation failed';
      sendLog('warn', `Tray initialization failed: ${trayStatus.unavailableReason}`);
      return null;
    }
  }

  function workerStatusLabel() {
    const state = getWorkerState();
    if (state?.running) {
      if (trayHubStatus === 'retrying') return 'Status: Hub retrying';
      if (trayHubStatus === 'offline') return 'Status: Hub offline';
      if (trayHubStatus === 'token_invalid') return 'Status: Token invalid';
      return 'Status: Running';
    }
    return 'Status: Stopped';
  }

  async function refreshCachedConfig() {
    cachedAppConfig = mergeLifecycleDefaults(await loadConfig());
    applyLaunchAtLoginSettings(cachedAppConfig);
    return cachedAppConfig;
  }

  function applyLaunchAtLoginSettings(config) {
    const openAtLogin = Boolean(config?.launchAtStartup);
    try {
      if (app.isPackaged) {
        app.setLoginItemSettings({ openAtLogin, path: process.execPath });
        return;
      }
      app.setLoginItemSettings({
        openAtLogin,
        path: process.execPath,
        args: [path.resolve(process.cwd())],
      });
    } catch (error) {
      sendLog('warn', `Launch at startup setting failed: ${error?.message || String(error)}`);
    }
  }

  function showMainWindow() {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setSkipTaskbar(false);
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }

  function hideMainWindowToTray() {
    ensureTray();
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setSkipTaskbar(true);
    mainWindow.hide();
    sendLog('info', 'Window closed to tray');
  }

  function getCachedOrDefaultConfig() {
    return cachedAppConfig || mergeLifecycleDefaults({});
  }

  function shouldHideWindowOnClose() {
    if (isQuitting) return false;
    const config = getCachedOrDefaultConfig();
    const minimizeToTray = config.minimizeToTrayOnClose !== false;
    const workerRunning = Boolean(getWorkerState()?.running);
    return workerRunning || minimizeToTray;
  }

  function handleWindowCloseSync(event) {
    if (isQuitting) return 'allow';

    if (shouldHideWindowOnClose()) {
      event.preventDefault();
      return 'hide';
    }

    event.preventDefault();
    return 'quit';
  }

  async function finalizeWindowClose(action) {
    if (action === 'hide') {
      const config = cachedAppConfig || mergeLifecycleDefaults(await loadConfig());
      hideMainWindowToTray();
      if (Boolean(getWorkerState()?.running)) {
        await showCloseToTrayHintIfNeeded(config);
      }
      return;
    }
    if (action === 'quit') {
      await quitAppFully();
    }
  }

  async function toggleLaunchAtStartup() {
    const config = await refreshCachedConfig();
    const next = { ...config, launchAtStartup: !config.launchAtStartup };
    await saveConfig(next);
    cachedAppConfig = mergeLifecycleDefaults({ ...next, hasStoredToken: Boolean(await getStoredToken()) });
    applyLaunchAtLoginSettings(cachedAppConfig);
    updateTrayMenu();
  }

  async function toggleStartWorkerOnLaunch() {
    const config = await refreshCachedConfig();
    const next = { ...config, startWorkerOnLaunch: !config.startWorkerOnLaunch };
    await saveConfig(next);
    cachedAppConfig = mergeLifecycleDefaults({ ...next, hasStoredToken: Boolean(await getStoredToken()) });
    updateTrayMenu();
  }

  async function trayStartWorker() {
    try {
      const config = await refreshCachedConfig();
      const token = await getStoredToken();
      if (!token) {
        sendLog('warn', 'Save worker token before starting from tray');
        showMainWindow();
        return;
      }
      if (workerExitReason === 'invalid_token') {
        sendLog('warn', 'Worker token invalid. Replace token before starting.');
        showMainWindow();
        return;
      }
      const prepared = await prepareRuntime(config);
      if (!prepared.ok) {
        sendLog('warn', prepared.reason || 'Runtime not ready');
        showMainWindow();
        return;
      }
      await startWorker({ ...config, useStoredToken: true, token: '' });
    } catch (error) {
      sendLog('error', error?.message || String(error));
      showMainWindow();
    }
  }

  async function trayStopWorker() {
    userStoppedWorker = true;
    workerAutoRestartAttempts = 0;
    if (workerRestartTimer) {
      clearTimeout(workerRestartTimer);
      workerRestartTimer = null;
    }
    stopWorkerInternal();
  }

  async function quitAppFully() {
    isQuitting = true;
    userStoppedWorker = true;
    sendLog('info', 'Tray quit requested');
    if (workerRestartTimer) {
      clearTimeout(workerRestartTimer);
      workerRestartTimer = null;
    }
    stopWorkerInternal();
    if (activeTray) {
      activeTray.destroy();
      activeTray = null;
      trayStatus.active = false;
    }
    app.quit();
  }

  function buildTrayMenu() {
    const state = getWorkerState();
    const config = getCachedOrDefaultConfig();
    return Menu.buildFromTemplate([
      {
        label: 'Show Dashboard',
        click: () => showMainWindow(),
      },
      { type: 'separator' },
      {
        label: 'Start Worker',
        enabled: !state?.running,
        click: () => {
          void trayStartWorker();
        },
      },
      {
        label: 'Stop Worker',
        enabled: Boolean(state?.running),
        click: () => {
          void trayStopWorker();
        },
      },
      {
        label: workerStatusLabel(),
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Launch at startup',
        type: 'checkbox',
        checked: Boolean(config.launchAtStartup),
        click: () => {
          void toggleLaunchAtStartup();
        },
      },
      {
        label: 'Start worker on app launch',
        type: 'checkbox',
        checked: Boolean(config.startWorkerOnLaunch),
        click: () => {
          void toggleStartWorkerOnLaunch();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit App',
        click: () => {
          void quitAppFully();
        },
      },
    ]);
  }

  function updateTrayMenu() {
    if (!activeTray) return;
    activeTray.setToolTip('Quavence AI Worker');
    activeTray.setContextMenu(buildTrayMenu());
  }

  function noteWorkerLogHint(message) {
    const raw = String(message || '');
    const parsedStop = parseWorkerStopReasonLine(raw);
    if (parsedStop?.code) {
      const mapped = mapStopReasonToWorkerExitReason(parsedStop.code);
      if (mapped) {
        workerExitReason = mapped;
        return;
      }
    }

    const classified = classifyWorkerApiError({
      error: raw,
      message: raw,
    });
    if (classified === 'token_invalid') {
      workerExitReason = 'invalid_token';
      return;
    }
    if (classified === 'hub_suspended') {
      workerExitReason = 'hub_suspended';
      return;
    }
    if (classified === 'terms_required') {
      workerExitReason = 'terms_required';
      return;
    }
    if (classified === 'runtime_blocked') {
      workerExitReason = 'runtime';
      return;
    }
    if (classified === 'retrying' || classified === 'throttled' || classified === 'waiting' || classified === 'duplicate_blocked') {
      if (!workerExitReason || workerExitReason === 'network') workerExitReason = 'network';
      return;
    }

    const text = raw.toLowerCase();
    if (/worker access suspended|hub policy suspended|not active|auto_suspend|worker_stop_reason code=hub_suspended/.test(text)) {
      workerExitReason = 'hub_suspended';
      return;
    }
    if (/worker_stop_reason code=token_invalid|invalid node token|node token expired/.test(text)) {
      workerExitReason = 'invalid_token';
      return;
    }
    if (/runtime|ollama|model.*not|endpoint is not reachable|prepare runtime/i.test(text)) {
      if (workerExitReason !== 'invalid_token') workerExitReason = 'runtime';
      return;
    }
    if (/network|timeout|rate.?limit|429|econnrefused|fetch failed/i.test(text)) {
      if (!workerExitReason || workerExitReason === 'network') workerExitReason = 'network';
    }
  }

  function classifyWorkerExitReason(exitCode) {
    if (workerExitReason === 'invalid_token' || workerExitReason === 'runtime' || workerExitReason === 'hub_suspended') {
      return workerExitReason;
    }
    if (exitCode && exitCode !== 0) {
      return workerExitReason || 'network';
    }
    return workerExitReason || 'normal';
  }

  async function maybeRestartWorkerAfterExit(reason) {
    if (isQuitting || userStoppedWorker) return;
    if (reason === 'invalid_token') {
      sendLog('error', 'Worker stopped: invalid token. Replace token before restarting.');
      safeSendToRenderer('app:lifecycle', { type: 'worker_fatal', reason: 'invalid_token' });
      showMainWindow();
      updateTrayMenu();
      return;
    }
    if (reason === 'hub_suspended') {
      sendLog('error', 'Worker stopped: Hub suspended worker access. Open Workers page or contact admin.');
      safeSendToRenderer('app:lifecycle', { type: 'worker_fatal', reason: 'hub_suspended' });
      showMainWindow();
      updateTrayMenu();
      return;
    }
    if (reason === 'terms_required') {
      sendLog('error', 'Worker stopped: accept updated worker terms in the web app.');
      safeSendToRenderer('app:lifecycle', { type: 'worker_fatal', reason: 'terms_required' });
      showMainWindow();
      updateTrayMenu();
      return;
    }
    if (reason === 'runtime') {
      sendLog('warn', 'Worker stopped: runtime issue. Check runtime settings.');
      safeSendToRenderer('app:lifecycle', { type: 'worker_fatal', reason: 'runtime' });
      showMainWindow();
      updateTrayMenu();
      return;
    }
    if (reason !== 'network' && reason !== 'normal') {
      updateTrayMenu();
      return;
    }
    if (workerAutoRestartAttempts >= 3) {
      sendLog('warn', 'Worker stopped after repeated retries. Open dashboard to review logs.');
      safeSendToRenderer('app:lifecycle', { type: 'worker_fatal', reason: 'crashed' });
      showMainWindow();
      updateTrayMenu();
      return;
    }
    workerAutoRestartAttempts += 1;
    sendLog('warn', `Worker exited unexpectedly; retry ${workerAutoRestartAttempts}/3 in 5s`);
    workerRestartTimer = setTimeout(() => {
      workerRestartTimer = null;
      void (async () => {
        try {
          const config = await refreshCachedConfig();
          const token = await getStoredToken();
          if (!token || workerExitReason === 'invalid_token') return;
          await startWorker({ ...config, useStoredToken: true, token: '' });
        } catch (error) {
          sendLog('error', error?.message || String(error));
        }
      })();
    }, 5000);
    updateTrayMenu();
  }

  function onWorkerStarted() {
    userStoppedWorker = false;
    workerAutoRestartAttempts = 0;
    workerExitReason = null;
    updateTrayMenu();
  }

  function onWorkerStoppedByUser() {
    userStoppedWorker = true;
    workerAutoRestartAttempts = 0;
    if (workerRestartTimer) {
      clearTimeout(workerRestartTimer);
      workerRestartTimer = null;
    }
    updateTrayMenu();
  }

  async function onWorkerProcessExit(exitCode, signal) {
    const reason = classifyWorkerExitReason(exitCode);
    updateTrayMenu();
    if (userStoppedWorker || isQuitting) return;
    await maybeRestartWorkerAfterExit(reason, exitCode, signal);
  }

  async function showCloseToTrayHintIfNeeded(config) {
    if (!getWorkerState()?.running) return;
    if (config.showCloseToTrayHint === false) return;
    safeSendToRenderer('app:close-to-tray-hint', {
      message: 'Quavence AI Worker is still running in the tray. Check hidden icons (^) if you do not see it.',
    });
    if (Notification.isSupported()) {
      try {
        new Notification({
          title: 'Quavence AI Worker',
          body: 'Worker keeps running in the background. Open from the system tray (^ hidden icons).',
        }).show();
      } catch {}
    }
    const next = { ...config, showCloseToTrayHint: false };
    await saveConfig(next);
    cachedAppConfig = mergeLifecycleDefaults({ ...next, hasStoredToken: Boolean(await getStoredToken()) });
  }

  async function maybeAutoStartWorkerOnLaunch() {
    const config = cachedAppConfig || mergeLifecycleDefaults(await loadConfig());
    if (!config.startWorkerOnLaunch) return;
    if (workerExitReason === 'invalid_token') {
      sendLog('warn', 'Auto-start skipped: worker token invalid');
      showMainWindow();
      return;
    }

    const token = await getStoredToken();
    if (!token) {
      sendLog('info', 'Auto-start skipped: no saved token');
      return;
    }

    const overview = await fetchWorkerOverview({ ...config, useStoredToken: true, token: '' });
    const suspended = String(overview?.data?.node?.status || '').toLowerCase() === 'suspended';
    if (suspended || /not active|auto_suspend/i.test(String(overview?.error || overview?.reason || ''))) {
      workerExitReason = 'hub_suspended';
      sendLog('warn', 'Auto-start skipped: worker access suspended by Hub policy');
      showMainWindow();
      return;
    }
    if (
      overview?.status === 401
      || classifyWorkerApiError({
        status: overview?.status,
        error: overview?.error,
        reason: overview?.reason,
        code: overview?.code,
        message: overview?.message,
      }) === 'token_invalid'
    ) {
      workerExitReason = 'invalid_token';
      sendLog('warn', 'Auto-start skipped: invalid worker token');
      showMainWindow();
      return;
    }

    const runtime = await checkRuntime(config);
    if (!runtime?.ready) {
      sendLog('info', 'Auto-start skipped: runtime not ready');
      return;
    }

    try {
      const prepared = await prepareRuntime(config);
      if (!prepared.ok) {
        sendLog('info', `Auto-start skipped: ${prepared.reason || 'runtime not ready'}`);
        return;
      }
      await startWorker({ ...config, useStoredToken: true, token: '' });
      sendLog('info', 'Worker auto-started on launch');
    } catch (error) {
      sendLog('warn', `Auto-start failed: ${error?.message || String(error)}`);
    }
  }

  async function init() {
    cachedAppConfig = mergeLifecycleDefaults(await loadConfig());
    applyLaunchAtLoginSettings(cachedAppConfig);
    ensureTray();
    await maybeAutoStartWorkerOnLaunch();
    updateTrayMenu();
  }

  function setTrayHubStatus(status) {
    trayHubStatus = String(status || 'unchecked');
    if (!activeTray) return;
    updateTrayMenu();
  }

  function onConfigSaved(config) {
    cachedAppConfig = mergeLifecycleDefaults(config || {});
    applyLaunchAtLoginSettings(cachedAppConfig);
    updateTrayMenu();
  }

  function getTrayStatus() {
    const config = getCachedOrDefaultConfig();
    const available = Boolean(activeTray) && trayStatus.active;
    const iconPath = trayStatus.resolvedPath
      || (process.platform === 'win32' ? resolveWindowsTrayIconPath() : '');
    const iconExists = trayStatus.exists
      || (iconPath && fs.existsSync(iconPath));
    return {
      available,
      active: available,
      initialized: trayStatus.initialized,
      resolvedPath: iconPath,
      iconPath,
      iconExists,
      exists: iconExists,
      unavailableReason: trayStatus.unavailableReason || null,
      minimizeToTrayOnClose: config.minimizeToTrayOnClose !== false,
      launchAtStartup: Boolean(config.launchAtStartup),
      startWorkerOnLaunch: Boolean(config.startWorkerOnLaunch),
    };
  }

  return {
    LIFECYCLE_DEFAULTS,
    mergeLifecycleDefaults,
    init,
    ensureTray,
    updateTrayMenu,
    showMainWindow,
    hideMainWindowToTray,
    handleWindowCloseSync,
    finalizeWindowClose,
    quitAppFully,
    onWorkerStarted,
    onWorkerStoppedByUser,
    onWorkerProcessExit,
    noteWorkerLogHint,
    setTrayHubStatus,
    onConfigSaved,
    refreshCachedConfig,
    getTrayStatus,
    getIsQuitting: () => isQuitting,
    setQuitting: (value) => {
      isQuitting = Boolean(value);
    },
  };
}

module.exports = {
  LIFECYCLE_DEFAULTS,
  mergeLifecycleDefaults,
  createAppLifecycleManager,
};
