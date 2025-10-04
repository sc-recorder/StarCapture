const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const https = require('https');
const extract = require('extract-zip');
const SupervisorModule = require('./lib/supervisor-module');
const ConfigManager = require('./lib/config-manager');
const OBSTemplateGenerator = require('./lib/obs-template-generator');
const OBSCapabilityDetector = require('./lib/obs-capability-detector');
const PatternUpdater = require('./lib/pattern-updater');
const AutoUpdater = require('./lib/auto-updater');

// Add handlers for uncaught errors to prevent crashes
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  console.error('Stack:', error.stack);
  // Don't exit - try to recover
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - try to recover
});

// Hardware acceleration settings
// Enable GPU acceleration for all video codecs

// Enable hardware decoding for multiple codecs
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,VaapiVideoDecoder,VaapiVideoEncoder');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-gpu-rasterization');

// Note: NOT calling app.disableHardwareAcceleration()
// All GPU features are enabled for optimal video playback performance
// This enables hardware acceleration for H.264, H.265/HEVC, and AV1 (if GPU supports it)

let mainWindow;
let splashWindow;
let setupWindow;
let supervisor;
let configManager;
let isFirstRun = false;
let supervisorListenersAttached = false;
let recordingStatsPromise = null; // Prevent concurrent stats calls

// OAuth proxy configuration
const OAUTH_PROXY_URL = 'https://auth.sc-recorder.video';

// Helper function to attach supervisor event listeners (only once)
function attachSupervisorListeners() {
  if (supervisorListenersAttached || !supervisor) {
    return;
  }

  console.log('Attaching supervisor event listeners...');

  supervisor.on('state-changed', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('status-update', state);
    }
  });

  supervisor.on('event', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('event', event);
    }
  });

  supervisor.on('recording-status', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-status', data);
    }
  });

  supervisor.on('events-saved', (result) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('events-saved', result);
    }
  });

  supervisor.on('recording-stats', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-stats', data);
    }
  });

  supervisor.on('audio-devices', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio-devices', data);
    }
  });

  supervisor.on('applications', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('applications', data);
    }
  });

  supervisor.on('upload-state-changed', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload-state-changed', state);
    }
  });

  supervisor.on('upload-started', (upload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload-started', upload);
    }
  });

  supervisor.on('upload-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload-progress', progress);
    }
  });

  supervisor.on('upload-completed', (upload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload-completed', upload);
    }
  });

  supervisor.on('upload-failed', (upload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload-failed', upload);
    }
  });

  supervisor.on('error', (data) => {
    console.error('Supervisor error:', data);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('supervisor-error', data);
    }
  });

  supervisorListenersAttached = true;
  console.log('Supervisor event listeners attached');
}

// Register custom protocol for OAuth callbacks
function registerProtocolHandler() {
    // Register sc-recorder:// protocol
    if (process.defaultApp) {
        if (process.argv.length >= 2) {
            app.setAsDefaultProtocolClient('sc-recorder', process.execPath, [path.resolve(process.argv[1])]);
        }
    } else {
        app.setAsDefaultProtocolClient('sc-recorder');
    }
}

// Handle OAuth callback URLs
function handleOAuthCallback(url) {

    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.host === 'auth' && parsedUrl.pathname === '/callback') {
            const params = parsedUrl.searchParams;
            const success = params.get('success') === 'true';
            const service = params.get('service');

            if (success) {
                const tokens = {
                    access_token: params.get('access_token'),
                    refresh_token: params.get('refresh_token'),
                    expires_in: parseInt(params.get('expires_in')) || 3600,
                    service: service
                };

                // Add client ID for Twitch (needed for API calls)
                if (service === 'twitch') {
                    const oauthConfig = oauthConfigLoader.load();
                    if (oauthConfig?.twitch?.clientId) {
                        tokens.client_id = oauthConfig.twitch.clientId;
                    }
                }

                // Extract user info if present
                const userInfo = params.get('user_info') ? JSON.parse(decodeURIComponent(params.get('user_info'))) : null;

                // Send tokens and user info to renderer
                if (mainWindow) {
                    mainWindow.webContents.send('oauth-callback', {
                        success: true,
                        service: service,
                        tokens: tokens,
                        userInfo: userInfo
                    });
                }

            } else {
                const error = params.get('error');
                if (mainWindow) {
                    mainWindow.webContents.send('oauth-callback', {
                        success: false,
                        error: error
                    });
                }
                console.error('[OAuth] Authentication failed:', error);
            }

            // Focus the app window
            if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.focus();
            }
        }
    } catch (error) {
        console.error('[OAuth] Error handling callback:', error);
    }
}

function createSplashWindow() {
  return new Promise((resolve) => {
    splashWindow = new BrowserWindow({
      width: 600,
      height: 600,
      frame: false,
      alwaysOnTop: false,
      transparent: false,
      resizable: false,
      show: false,
      icon: path.join(__dirname, 'build', 'icon.ico'),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    splashWindow.loadFile('splash.html');

    splashWindow.once('ready-to-show', () => {
      splashWindow.center();
      splashWindow.show();
      resolve();
    });
  });
}

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 800,
    height: 775,
    frame: true,
    resizable: false,
    show: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: 'StarCapture Setup',
    autoHideMenuBar: true
  });

  setupWindow.loadFile('setup-wizard.html');

  setupWindow.once('ready-to-show', () => {
    // Add 2 second delay before closing splash and showing setup window
    setTimeout(() => {
      if (splashWindow) {
        splashWindow.close();
        splashWindow = null;
      }
      setupWindow.center();
      setupWindow.show();
    }, 2000);
  });

  setupWindow.on('closed', () => {
    setupWindow = null;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    show: false,
    frame: false,  // Remove default title bar
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    title: 'StarCapture',
    autoHideMenuBar: true,
    backgroundColor: '#080d18'
  });

  require('@electron/remote/main').initialize();
  require('@electron/remote/main').enable(mainWindow.webContents);

  mainWindow.loadFile('index.html');

  // Handle window controls for frameless window
  ipcMain.on('window-control', (event, action) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      switch (action) {
        case 'minimize':
          mainWindow.minimize();
          break;
        case 'maximize':
          if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
          } else {
            mainWindow.maximize();
          }
          break;
        case 'close':
          mainWindow.close();
          break;
      }
    }
  });

  mainWindow.once('ready-to-show', () => {
    // Add 2 second delay before closing splash and showing main window
    setTimeout(() => {
      if (splashWindow) {
        splashWindow.close();
        splashWindow = null;
      }
      mainWindow.show();

      // Send initial status update
      if (supervisor) {
        const initialState = supervisor.getState();
        mainWindow.webContents.send('status-update', initialState);
      }
    }, 2000);

    // Set up periodic status sync to catch any missed updates
    setInterval(() => {
      if (supervisor && mainWindow && !mainWindow.isDestroyed()) {
        try {
          const currentState = supervisor.getState();
          // Check if webContents is valid and ready before sending
          if (mainWindow.webContents &&
              !mainWindow.webContents.isDestroyed() &&
              !mainWindow.webContents.isCrashed() &&
              !mainWindow.webContents.isLoading()) {
            // Use executeJavaScript to check if renderer is responsive
            mainWindow.webContents.executeJavaScript('true', true)
              .then(() => {
                // Renderer is responsive, safe to send
                mainWindow.webContents.send('status-update', currentState);
              })
              .catch(() => {
                // Renderer not responsive, skip this update
              });
          }
        } catch (error) {
          // Silently ignore errors from disposed frames
          if (!error.message?.includes('disposed') && !error.message?.includes('WebFrameMain')) {
            console.error('Error sending status update:', error);
          }
        }
      }
    }, 3000); // Sync every 3 seconds

    // Open DevTools for development
    if (!app.isPackaged) {
      mainWindow.webContents.openDevTools();
    }

    // Notify renderer if this is first run
    if (isFirstRun) {
      setTimeout(() => {
        mainWindow.webContents.send('first-run');
      }, 100);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function initializeApp() {
  console.log('Initializing SC Recorder...');

  try {
    // Initialize configuration manager if not already done
    if (!configManager) {
      configManager = new ConfigManager();
    }

    // Check if configuration exists
    const configExists = await configManager.exists();

    if (!configExists) {
      console.log('First run detected - no configuration found');
      isFirstRun = true;

      // Don't initialize supervisor yet - wait for setup wizard completion
      return true;
    }

    // Load existing configuration
    const config = await configManager.load();

    if (!config || !config.settings) {
      console.log('Invalid configuration - treating as first run');
      isFirstRun = true;
      return true;
    }

    console.log('Configuration loaded successfully');

    // Register hotkeys if configured
    if (config.settings?.hotkeys) {
      registerHotkeys(config.settings.hotkeys);
    }

    // Check if OBS and FFmpeg binaries exist
    const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
    const resourcesBase = path.join(localAppData, 'sc-recorder', 'resources');
    const obsPath = path.join(resourcesBase, 'obs-studio', 'bin', '64bit', 'obs64.exe');
    const ffmpegPath = path.join(resourcesBase, 'ffmpeg', 'ffmpeg.exe');

    try {
      await fs.access(obsPath);
      await fs.access(ffmpegPath);
    } catch {
      console.log('Missing required dependencies - treating as first run');
      // Clear encoder cache since we need to re-detect after installing dependencies
      try {
        await configManager.saveEncodersCache(null);
      } catch (e) {
        console.log('Could not clear encoder cache:', e);
      }
      isFirstRun = true;
      return true;
    }

    // IMPORTANT: Ensure templates are generated BEFORE starting OBS
    console.log('Verifying/generating OBS templates...');
    try {
      const templateGenerator = new OBSTemplateGenerator();
      const result = await templateGenerator.generateFromConfig(config);
    } catch (error) {
      console.error('Failed to generate OBS templates:', error);
      // Continue anyway - OBS might work with existing config
    }

    // Add a small delay to ensure file system writes are complete
    await new Promise(resolve => setTimeout(resolve, 500));

    // NOW initialize supervisor after templates are ready
    console.log('Starting supervisor with OBS...');
    supervisor = new SupervisorModule();

    // Attach event listeners (only once)
    attachSupervisorListeners();

    // Initialize supervisor with config that includes auto-start settings
    const supervisorConfig = {
      ...configManager.config,
      autoStartOBS: true,  // Start OBS automatically
      autoMonitorSC: true, // Start monitoring Star Citizen
      obs: {
        profile: 'SC-Recorder',
        collection: 'SC-Recording'
      }
    };

    const success = await supervisor.initialize(supervisorConfig);

    if (!success) {
      throw new Error('Supervisor initialization failed');
    }

    return true;
  } catch (error) {
    console.error('Failed to initialize app:', error);
    return false;
  }
}

// Check for pattern updates during initialization
async function checkPatternUpdates() {
  if (splashWindow) {
    splashWindow.webContents.send('splash-progress', {
      message: 'Checking for pattern updates...',
      progress: 10
    });
  }

  try {
    const updater = new PatternUpdater();
    const updateInfo = await updater.checkForUpdate();

    if (updateInfo) {
      // Check if patterns are incompatible with app version
      if (updateInfo.incompatible) {
        console.error(`Cannot restore patterns: v${updateInfo.newVersion} incompatible - app supports v${updateInfo.supportedVersion}`);

        if (splashWindow) {
          splashWindow.webContents.send('splash-progress', {
            message: `Pattern v${updateInfo.newVersion} incompatible - app supports v${updateInfo.supportedVersion}`,
            progress: 15
          });
        }

        // Show dialog warning after a delay
        setTimeout(() => {
          const { dialog } = require('electron');
          dialog.showErrorBox(
            'Pattern File Incompatible',
            `The pattern file is missing and cannot be restored.\n\n` +
            `The online patterns are version ${updateInfo.newVersion}.\n` +
            `This version of SC Recorder supports patterns v${updateInfo.supportedVersion}.\n\n` +
            `The patterns are incompatible. Please check for an app update or contact support.`
          );
        }, 2000);

        // Continue loading but patterns will be missing
      } else if (updateInfo.isMissing) {

        if (splashWindow) {
          splashWindow.webContents.send('splash-progress', {
            message: `Downloading pattern file v${updateInfo.newVersion}...`,
            progress: 15
          });
        }

        const success = await updater.applyUpdate(updateInfo);
        if (success) {
          // Update config tracking
          if (configManager) {
            await configManager.updatePatternTracking(updateInfo.newVersion);
          }
        }
      } else {

        if (splashWindow) {
          splashWindow.webContents.send('splash-progress', {
            message: `Updating patterns to v${updateInfo.newVersion}...`,
            progress: 15
          });
        }

        const success = await updater.applyUpdate(updateInfo);
        if (success) {
          // Update config tracking
          if (configManager) {
            await configManager.updatePatternTracking(updateInfo.newVersion);
          }
        }
      }
    } else {
    }
  } catch (error) {
    console.log('Pattern update check failed (non-blocking):', error.message);
  }

  if (splashWindow) {
    splashWindow.webContents.send('splash-progress', {
      message: 'Loading configuration...',
      progress: 20
    });
  }
}

app.whenReady().then(async () => {
  // Register protocol handler for OAuth callbacks
  registerProtocolHandler();

  await createSplashWindow();

  // Initialize config manager early to check auto-update setting
  configManager = new ConfigManager();
  const config = configManager.load();

  // Check if auto-updates are enabled (default to true if not set)
  const autoUpdateEnabled = config?.settings?.autoUpdateEnabled !== false;

  // Check for application updates first (if enabled)
  if (autoUpdateEnabled) {
    const autoUpdater = new AutoUpdater();

    // Set progress callback to update splash screen
    autoUpdater.setProgressCallback((progress, downloaded, total) => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        const mb = (size) => (size / 1024 / 1024).toFixed(1);
        splashWindow.webContents.send('splash-progress', {
          message: `Downloading update... ${mb(downloaded)}MB / ${mb(total)}MB (${progress}%)`,
          progress: 20 + (progress * 0.7) // Scale progress from 20% to 90%
        });
      }
    });

    // Check for updates and prompt user if available
    const updateInfo = await autoUpdater.checkForUpdates();

    if (updateInfo.hasUpdate) {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.webContents.send('splash-progress', {
          message: `Update available: v${updateInfo.latestVersion}`,
          progress: 15
        });
      }

      const shouldUpdate = await autoUpdater.promptUserForUpdate(updateInfo);

      if (shouldUpdate) {
        if (splashWindow && !splashWindow.isDestroyed()) {
          splashWindow.webContents.send('splash-progress', {
            message: 'Preparing to install update...',
            progress: 20
          });
        }

        const success = await autoUpdater.performUpdate();

        if (success) {
          // App will quit and installer will run
          return;
        }
      }
    }
  }

  // Check for pattern updates before initialization
  await checkPatternUpdates();

  const initSuccess = await initializeApp();

  if (!initSuccess) {
    console.error('Initialization failed');
  }

  await new Promise(resolve => setTimeout(resolve, 200));

  // Show setup wizard if first run, otherwise main window
  if (isFirstRun) {
    createSetupWindow();
  } else {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Handle protocol for Windows
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleOAuthCallback(url);
});

// Handle protocol for Windows when app is already running
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window instead.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }

    // Check for protocol URL in command line
    const url = commandLine.find(arg => arg.startsWith('sc-recorder://'));
    if (url) {
      handleOAuthCallback(url);
    }
  });
}

app.on('before-quit', async (event) => {
  event.preventDefault();

  console.log('Shutting down SC Recorder...');

  // Clean up audio temp files
  try {
    const AudioTrackManager = require('./lib/audio-track-manager');
    const manager = new AudioTrackManager();
    await manager.cleanupTempRoot();
  } catch (error) {
    console.error('Failed to clean up audio temp files:', error);
  }

  // Stop uiohook if running
  stopUiohook();

  if (supervisor) {
    await supervisor.shutdown();
  }

  app.exit(0);
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Hotkey management with uiohook-napi
const { uIOhook, UiohookKey } = require('uiohook-napi');

let registeredHotkeys = {};
let currentKeyState = new Set();

// Convert string hotkey format to uiohook format
function parseHotkey(hotkeyString) {
  if (!hotkeyString) return null;

  const parts = hotkeyString.split('+').map(p => p.trim().toLowerCase());
  const modifiers = [];
  let key = null;

  for (const part of parts) {
    switch(part) {
      case 'ctrl':
      case 'control':
        modifiers.push('ctrl');
        break;
      case 'alt':
        modifiers.push('alt');
        break;
      case 'shift':
        modifiers.push('shift');
        break;
      case 'cmd':
      case 'command':
      case 'super':
      case 'meta':
        modifiers.push('meta');
        break;
      default:
        // Map key names to uiohook key codes
        key = getUiohookKeyCode(part);
    }
  }

  return { modifiers, key };
}

// Map key names to uiohook key codes
function getUiohookKeyCode(keyName) {
  const keyMap = {
    'a': UiohookKey.A,
    'b': UiohookKey.B,
    'c': UiohookKey.C,
    'd': UiohookKey.D,
    'e': UiohookKey.E,
    'f': UiohookKey.F,
    'g': UiohookKey.G,
    'h': UiohookKey.H,
    'i': UiohookKey.I,
    'j': UiohookKey.J,
    'k': UiohookKey.K,
    'l': UiohookKey.L,
    'm': UiohookKey.M,
    'n': UiohookKey.N,
    'o': UiohookKey.O,
    'p': UiohookKey.P,
    'q': UiohookKey.Q,
    'r': UiohookKey.R,
    's': UiohookKey.S,
    't': UiohookKey.T,
    'u': UiohookKey.U,
    'v': UiohookKey.V,
    'w': UiohookKey.W,
    'x': UiohookKey.X,
    'y': UiohookKey.Y,
    'z': UiohookKey.Z,
    '0': UiohookKey.Num0,
    '1': UiohookKey.Num1,
    '2': UiohookKey.Num2,
    '3': UiohookKey.Num3,
    '4': UiohookKey.Num4,
    '5': UiohookKey.Num5,
    '6': UiohookKey.Num6,
    '7': UiohookKey.Num7,
    '8': UiohookKey.Num8,
    '9': UiohookKey.Num9,
    'f1': UiohookKey.F1,
    'f2': UiohookKey.F2,
    'f3': UiohookKey.F3,
    'f4': UiohookKey.F4,
    'f5': UiohookKey.F5,
    'f6': UiohookKey.F6,
    'f7': UiohookKey.F7,
    'f8': UiohookKey.F8,
    'f9': UiohookKey.F9,
    'f10': UiohookKey.F10,
    'f11': UiohookKey.F11,
    'f12': UiohookKey.F12,
    'space': UiohookKey.Space,
    'enter': UiohookKey.Enter,
    'tab': UiohookKey.Tab,
    'escape': UiohookKey.Escape,
    'backspace': UiohookKey.Backspace,
    'delete': UiohookKey.Delete,
    'home': UiohookKey.Home,
    'end': UiohookKey.End,
    'pageup': UiohookKey.PageUp,
    'pagedown': UiohookKey.PageDown,
    'up': UiohookKey.Up,
    'down': UiohookKey.Down,
    'left': UiohookKey.Left,
    'right': UiohookKey.Right,
    'insert': UiohookKey.Insert,
    // Add missing special keys
    '\\': UiohookKey.Backslash,
    'backslash': UiohookKey.Backslash,
    'capslock': UiohookKey.CapsLock,
    'caps': UiohookKey.CapsLock,
    '/': UiohookKey.Slash,
    'slash': UiohookKey.Slash,
    '.': UiohookKey.Period,
    'period': UiohookKey.Period,
    ',': UiohookKey.Comma,
    'comma': UiohookKey.Comma,
    ';': UiohookKey.Semicolon,
    'semicolon': UiohookKey.Semicolon,
    "'": UiohookKey.Quote,
    'quote': UiohookKey.Quote,
    '[': UiohookKey.BracketLeft,
    ']': UiohookKey.BracketRight,
    '-': UiohookKey.Minus,
    'minus': UiohookKey.Minus,
    '=': UiohookKey.Equal,
    'equal': UiohookKey.Equal,
    'equals': UiohookKey.Equal,
    '`': UiohookKey.Grave,
    'grave': UiohookKey.Grave
  };

  return keyMap[keyName.toLowerCase()] || null;
}

// Check if current key state matches a hotkey
function checkHotkey(parsedHotkey, event) {
  if (!parsedHotkey || !parsedHotkey.key) return false;

  // Check if the main key matches
  if (event.keycode !== parsedHotkey.key) return false;

  // Check modifiers - use event properties directly as they're more reliable
  const hasCtrl = event.ctrlKey;
  const hasAlt = event.altKey;
  const hasShift = event.shiftKey;
  const hasMeta = event.metaKey;


  // Check required modifiers are pressed
  for (const mod of parsedHotkey.modifiers) {
    if (mod === 'ctrl' && !hasCtrl) return false;
    if (mod === 'alt' && !hasAlt) return false;
    if (mod === 'shift' && !hasShift) return false;
    if (mod === 'meta' && !hasMeta) return false;
  }

  // Only check for extra modifiers if we have no modifiers defined
  // This allows flexibility for system-level combinations
  if (parsedHotkey.modifiers.length === 0) {
    // For standalone keys, we might want to allow shift for capitalization
    // but not ctrl/alt/meta as those are typically intentional modifiers
    if (hasCtrl || hasAlt || hasMeta) return false;
  }

  return true;
}

// Initialize uiohook
let uiohookStarted = false;

function startUiohook() {
  if (uiohookStarted) return;

  try {
    // Track key states
    uIOhook.on('keydown', (event) => {
      currentKeyState.add(event.keycode);


      // Check registered hotkeys
      for (const [action, hotkeyData] of Object.entries(registeredHotkeys)) {
        if (checkHotkey(hotkeyData.parsed, event)) {
          if (hotkeyData.callback) {
            hotkeyData.callback();
          }
        }
      }
    });

    uIOhook.on('keyup', (event) => {
      currentKeyState.delete(event.keycode);
    });

    uIOhook.start();
    uiohookStarted = true;
  } catch (error) {
    console.error('Failed to start uIOhook:', error);
  }
}

function stopUiohook() {
  if (!uiohookStarted) return;

  try {
    uIOhook.stop();
    uiohookStarted = false;
    currentKeyState.clear();
  } catch (error) {
    console.error('Failed to stop uIOhook:', error);
  }
}

function registerHotkeys(hotkeys) {
  // Clear existing hotkeys
  registeredHotkeys = {};

  // Start uiohook if not already started
  startUiohook();

  // Register new hotkeys
  if (hotkeys?.startStop) {
    const parsed = parseHotkey(hotkeys.startStop);
    if (parsed) {
      registeredHotkeys.startStop = {
        original: hotkeys.startStop,
        parsed: parsed,
        callback: () => {
          if (supervisor) {
            supervisor.toggleRecording();
          }
        }
      };
    }
  }

  if (hotkeys?.split) {
    const parsed = parseHotkey(hotkeys.split);
    if (parsed) {
      registeredHotkeys.split = {
        original: hotkeys.split,
        parsed: parsed,
        callback: () => {
          if (supervisor) {
            supervisor.splitRecording();
          }
        }
      };
    }
  }

  if (hotkeys?.markEvent) {
    const parsed = parseHotkey(hotkeys.markEvent);
    if (parsed) {
      registeredHotkeys.markEvent = {
        original: hotkeys.markEvent,
        parsed: parsed,
        callback: () => {
          if (supervisor) {
            // Create a manual event
            const manualEvent = {
              type: 'manual',
              subtype: 'user_marked',
              name: 'Manual Event',
              message: 'User marked event - click to edit description',
              severity: 'medium',
              category: 'manual',
              data: {
                userNote: 'Click to add description',
                editable: true,
                markedAt: new Date().toISOString()
              }
            };
            supervisor.addManualEvent(manualEvent);

            // Notify the UI
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('manual-event-created', manualEvent);
            }
          }
        }
      };
    }
  }

  return registeredHotkeys;
}

// IPC handlers
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-status', () => {
  if (supervisor) {
    return supervisor.getState();
  }

  return {
    supervisor: 'not-initialized',
    obs: { process: 'stopped', websocket: 'disconnected' },
    recording: { active: false },
    starCitizen: { running: false }
  };
});

ipcMain.handle('start-recording', async () => {
  if (supervisor) {
    await supervisor.startRecording();
    return { success: true };
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('stop-recording', async () => {
  if (supervisor) {
    await supervisor.stopRecording();
    return { success: true };
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('split-recording', async () => {
  if (supervisor) {
    await supervisor.splitRecording();
    return { success: true };
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('mark-manual-event', async () => {
  if (supervisor) {
    const manualEvent = {
      type: 'manual',
      subtype: 'user_marked',
      name: 'Manual Event',
      message: 'User marked event - click to edit description',
      severity: 'medium',
      category: 'manual',
      data: {
        userNote: 'Click to add description',
        editable: true,
        markedAt: new Date().toISOString()
      }
    };
    supervisor.addManualEvent(manualEvent);
    return { success: true, event: manualEvent };
  }
  return { success: false, error: 'Supervisor not initialized' };
});

// Upload account management handlers
ipcMain.handle('upload:add-account', async (event, data) => {
  if (supervisor) {
    try {
      const result = await supervisor.addUploadAccount(data);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('upload:update-account', async (event, data) => {
  if (supervisor) {
    try {
      const result = await supervisor.updateUploadAccount(data);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('upload:delete-account', async (event, data) => {
  if (supervisor) {
    try {
      const result = await supervisor.deleteUploadAccount(data);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('upload:list-accounts', async (event, data) => {
  if (supervisor) {
    try {
      const accounts = await supervisor.listUploadAccounts(data);
      return { success: true, accounts };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('upload:test-account', async (event, data) => {
  if (supervisor) {
    try {
      const result = await supervisor.testUploadAccount(data);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

// Upload operation handlers
ipcMain.handle('upload:upload-file', async (event, data) => {
  if (supervisor) {
    try {
      const result = await supervisor.uploadFile(data);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('upload:cancel-upload', async (event, data) => {
  if (supervisor) {
    try {
      const result = await supervisor.cancelUpload(data);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('upload:clear-completed', async () => {
  if (supervisor) {
    try {
      const result = await supervisor.clearCompletedUploads();
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('upload:remove-from-queue', async (event, data) => {
  if (supervisor) {
    try {
      const result = await supervisor.removeFromQueue(data);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('upload:remove-completed', async (event, data) => {
  if (supervisor) {
    try {
      const result = await supervisor.removeCompletedUpload(data);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('upload:start-queue', async () => {
  if (supervisor) {
    try {
      const result = await supervisor.startUploadQueue();
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('upload:pause-queue', async () => {
  if (supervisor) {
    try {
      const result = await supervisor.pauseUploadQueue();
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('upload:get-queue-status', async () => {
  if (supervisor) {
    try {
      const result = await supervisor.getUploadQueueStatus();
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('upload:get-status', async () => {
  if (supervisor) {
    try {
      const status = await supervisor.getUploadStatus();
      return { success: true, status };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

ipcMain.handle('upload:get-state', async () => {
  if (supervisor) {
    try {
      const state = await supervisor.getUploadState();
      return { success: true, state };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Supervisor not initialized' };
});

// OAuth Authentication Handlers
const OAuthPKCE = require('./lib/oauth-pkce');
const oauthConfigLoader = require('./lib/oauth-config-loader');
let oauthHandler = null;

ipcMain.handle('oauth:authenticate', async (event, service) => {
  try {
    // Use OAuth proxy server for authentication
    const authUrl = `${OAUTH_PROXY_URL}/auth/${service === 'google' ? 'google' : 'twitch'}`;


    // Open the OAuth URL in the default browser
    const { shell } = require('electron');
    await shell.openExternal(authUrl);

    // Return a pending status - the actual tokens will come via the protocol handler
    return {
      success: true,
      pending: true,
      message: 'Authentication window opened. Please complete login in your browser.'
    };
  } catch (error) {
    console.error(`[OAuth] Authentication failed for ${service}:`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('oauth:refresh-token', async (event, { refreshToken, service }) => {
  try {
    // Use OAuth proxy server for token refresh
    const response = await fetch(`${OAUTH_PROXY_URL}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        service: service,
        refresh_token: refreshToken
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Token refresh failed');
    }

    const tokens = await response.json();
    return { success: true, tokens };
  } catch (error) {
    console.error('[OAuth] Token refresh failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('oauth:check-config', async () => {
  // OAuth is now handled by the proxy server
  return {
    configured: true,
    twitch: true,
    google: true,
    proxyUrl: OAUTH_PROXY_URL
  };
});

ipcMain.handle('get-recording-stats', async () => {
  if (!supervisor) {
    return null;
  }

  // If there's already a pending request, return that promise instead of creating a new one
  if (recordingStatsPromise) {
    return recordingStatsPromise;
  }

  recordingStatsPromise = new Promise((resolve) => {
    let resolved = false;
    let timeoutHandle;

    // Set up one-time listener for the response
    const handler = (data) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutHandle);
        supervisor.removeListener('recording-stats', handler);
        recordingStatsPromise = null; // Clear the lock
        resolve(data);
      }
    };

    supervisor.on('recording-stats', handler);
    supervisor.getRecordingStats();

    // Timeout after 2 seconds
    timeoutHandle = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        supervisor.removeListener('recording-stats', handler);
        recordingStatsPromise = null; // Clear the lock
        resolve(null);
      }
    }, 2000);
  });

  return recordingStatsPromise;
});

// Keep detector instance alive during setup wizard
let setupDetector = null;

// Setup wizard IPC handlers  
ipcMain.handle('detect-encoders', async (event, forceRescan = false) => {
  try {
    console.log('Starting encoder detection...', { forceRescan });

    let encoders = null;

    // Check if we should use cache
    if (!forceRescan && configManager) {
      const cached = await configManager.loadEncodersCache();
      if (cached) {
        // Return wrapped response for settings view compatibility
        return { success: true, encoders: cached };
      }
    }

    // For rescan from settings, just parse the existing OBS log
    // OBS should already be running via supervisor
    if (forceRescan) {
      const detector = new OBSCapabilityDetector();

      // Just parse the log, don't start OBS
      encoders = await detector.parseEncodersFromLog();

      if (encoders && (encoders.hardware.length > 0 || encoders.software.length > 0)) {
        // Save to cache
        if (configManager) {
          await configManager.saveEncodersCache(encoders);
        }
        // Return wrapped response for settings view compatibility
        return { success: true, encoders: encoders };
      } else {
        // If log parsing fails, return cached encoders or defaults
        const cached = await configManager.loadEncodersCache();
        if (cached) {
          return { success: true, encoders: cached };
        }
        // Return basic fallback
        encoders = {
          hardware: [],
          software: [{ name: 'x264', vendor: 'Software', codec: 'h264', id: 'obs_x264' }]
        };
        return { success: true, encoders: encoders };
      }
    }

    // For initial detection (from setup wizard), we need to detect capabilities
    // Keep OBS alive for audio detection next
    setupDetector = new OBSCapabilityDetector();
    const capabilities = await setupDetector.detectCapabilities(true); // keepAlive = true

    // Save to cache for future use
    if (configManager) {
      await configManager.saveEncodersCache(capabilities.encoders);
    }

    // Return wrapped response for settings view compatibility
    return { success: true, encoders: capabilities.encoders };
  } catch (error) {
    console.error('Failed to detect encoders:', error);
    // Return error response
    return {
      success: false,
      error: error.message || 'Unknown error occurred',
      encoders: {
        hardware: [],
        software: [{ name: 'x264', vendor: 'Software', codec: 'h264', id: 'obs_x264' }]
      }
    };
  }
});

// Handle folder selection dialog
ipcMain.handle('select-folder', async (event, options) => {
  const defaultOptions = {
    properties: ['openDirectory', 'createDirectory']
  };

  const dialogOptions = { ...defaultOptions, ...options };

  // Show dialog and return result
  return dialog.showOpenDialog(setupWindow || mainWindow, dialogOptions);
});

// Get all available displays
ipcMain.handle('get-displays', async () => {
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();

  console.log('===== DEBUG: Display Detection =====');
  displays.forEach((display, index) => {
    console.log(`Display ${index}:`, {
      id: display.id,
      'bounds.width': display.bounds.width,
      'bounds.height': display.bounds.height,
      'size.width': display.size.width,
      'size.height': display.size.height,
      scaleFactor: display.scaleFactor,
      isPrimary: display.id === primaryDisplay.id
    });
  });

  // Format display information for the UI
  const result = displays.map(display => {
    // On Windows, bounds already contains scaled resolution
    // To get native/physical resolution: bounds × scaleFactor
    const nativeWidth = Math.round(display.bounds.width * display.scaleFactor);
    const nativeHeight = Math.round(display.bounds.height * display.scaleFactor);
    
    return {
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      // Native/physical resolution (actual monitor pixels)
      width: nativeWidth,
      height: nativeHeight,
      // Logical/scaled resolution (OS scaled)
      logicalWidth: display.size.width,
      logicalHeight: display.size.height,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
      isPrimary: display.id === primaryDisplay.id,
      label: `Display ${display.id === primaryDisplay.id ? '(Primary)' : ''} - ${nativeWidth}x${nativeHeight}`
    };
  });

  console.log('===== DEBUG: Returning to frontend =====');
  console.log(JSON.stringify(result, null, 2));
  console.log('=====================================');

  return result;
});

// Get display by ID
ipcMain.handle('get-display-by-id', async (event, displayId) => {
  const displays = screen.getAllDisplays();
  return displays.find(d => d.id === displayId) || null;
});

// Get cached encoders without running OBS
ipcMain.handle('get-cached-encoders', async () => {
  try {
    if (!configManager) {
      configManager = new ConfigManager();
    }

    const cachedEncoders = await configManager.loadEncodersCache();
    if (cachedEncoders) {
      return cachedEncoders;
    }

    return null;
  } catch (error) {
    console.error('Failed to load cached encoders:', error);
    return null;
  }
});

ipcMain.handle('detect-audio-devices', async () => {
  try {
    console.log('Requesting audio devices and scanning for applications...');

    // Detect running applications
    let applications = [];
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      // Get all processes with windows
      const { stdout } = await execAsync(
        'powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object ProcessName, MainWindowTitle | ConvertTo-Json"'
      );

      const processes = JSON.parse(stdout);
      const seen = new Set();

      // Map of known executables to friendly names
      const appNameMap = {
        'discord': 'Discord',
        'discordcanary': 'Discord Canary',
        'discordptb': 'Discord PTB',
        'ts3client_win64': 'TeamSpeak 3',
        'teamspeak': 'TeamSpeak',
        'mumble': 'Mumble',
        'ventrilo': 'Ventrilo',
        'steam': 'Steam',
        'skype': 'Skype',
        'zoom': 'Zoom',
        'slack': 'Slack',
        'telegram': 'Telegram',
        'whatsapp': 'WhatsApp',
        'signal': 'Signal',
        'element': 'Element',
        'chrome': 'Google Chrome',
        'firefox': 'Firefox',
        'msedge': 'Microsoft Edge'
      };

      processes.forEach(proc => {
        const processName = proc.ProcessName.toLowerCase();

        // Skip if we've already seen this app
        if (seen.has(processName)) return;
        seen.add(processName);

        // Find friendly name
        let friendlyName = proc.MainWindowTitle || proc.ProcessName;
        for (const [key, name] of Object.entries(appNameMap)) {
          if (processName.includes(key)) {
            friendlyName = name;
            break;
          }
        }

        applications.push({
          id: processName,
          name: friendlyName,
          executable: proc.ProcessName + '.exe'
        });
      });

    } catch (error) {
      console.error('Failed to detect running applications:', error);
      // Fall back to cached applications
      const config = await configManager.load();
      applications = config?.audio?.applications || [];
    }

    // During setup wizard, use the existing detector instance
    if (setupDetector && setupDetector.obs) {
      console.log('Using setup detector for audio devices');
      try {
        const audioDevices = await setupDetector.detectAudioDevices();

        // Format response for both settings page and wizard
        return {
          success: true,
          applications: applications,
          inputDevices: audioDevices.inputs || [],
          outputDevices: audioDevices.outputs || [],
          // Also include old format for wizard compatibility
          inputs: audioDevices.inputs || [],
          outputs: audioDevices.outputs || []
        };
      } catch (error) {
        console.error('Failed to get audio devices from setup detector:', error);
        return {
          success: false,
          error: error.message
        };
      }
    }

    // Otherwise check if WebSocket is connected (normal operation)
    const state = supervisor?.getState();
    if (!state || state.obs.websocket !== 'connected') {
      console.warn('WebSocket not connected, cannot detect audio devices');

      // Try to use cached values from config
      if (config?.audio) {
        return {
          success: true,
          applications: applications,
          inputDevices: config.audio.inputDevices || [],
          outputDevices: config.audio.outputDevices || [],
          // Also include old format for wizard compatibility
          inputs: config.audio.inputDevices || [],
          outputs: config.audio.outputDevices || []
        };
      }

      return {
        success: false,
        error: 'OBS WebSocket not connected. Please ensure OBS is running.'
      };
    }

    // Request audio devices through supervisor
    return new Promise((resolve) => {
      let resolved = false;
      let timeoutHandle;

      // Set up one-time listener for response
      const responseHandler = (audioData) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          supervisor.removeListener('audio-devices', responseHandler);
          // Format response for both settings page and wizard
          resolve({
            success: true,
            applications: applications,
            inputDevices: audioData.inputs || [],
            outputDevices: audioData.outputs || [],
            // Also include old format for wizard compatibility
            inputs: audioData.inputs || [],
            outputs: audioData.outputs || []
          });
        }
      };

      supervisor.on('audio-devices', responseHandler);

      // Request audio devices
      supervisor.getAudioDevices();

      // Timeout after 5 seconds
      timeoutHandle = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          supervisor.removeListener('audio-devices', responseHandler);
          console.warn('Audio device detection timed out');
          const defaultInputs = [{ id: 'default', name: 'Default Microphone', isDefault: true }];
          const defaultOutputs = [{ id: 'default', name: 'Default Speakers', isDefault: true }];
          resolve({
            success: true,
            applications: applications,
            inputDevices: defaultInputs,
            outputDevices: defaultOutputs,
            // Also include old format for wizard compatibility
            inputs: defaultInputs,
            outputs: defaultOutputs
          });
        }
      }, 5000);
    });
  } catch (error) {
    console.error('Failed to detect audio devices:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

ipcMain.handle('detect-applications', async () => {
  try {
    console.log('Starting application detection...');

    // Use PowerShell to get running processes with window titles
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    // Get all processes with windows
    const { stdout } = await execAsync(
      'powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object ProcessName, MainWindowTitle | ConvertTo-Json"'
    );

    const processes = JSON.parse(stdout);
    const applications = [];
    const seen = new Set();

    // Map of known executables to friendly names
    const appNameMap = {
      'discord': 'Discord',
      'discordcanary': 'Discord Canary',
      'discordptb': 'Discord PTB',
      'ts3client_win64': 'TeamSpeak 3',
      'teamspeak': 'TeamSpeak',
      'mumble': 'Mumble',
      'ventrilo': 'Ventrilo',
      'steam': 'Steam',
      'skype': 'Skype',
      'zoom': 'Zoom',
      'slack': 'Slack',
      'telegram': 'Telegram',
      'whatsapp': 'WhatsApp',
      'signal': 'Signal',
      'element': 'Element',
      'chrome': 'Google Chrome',
      'firefox': 'Firefox',
      'msedge': 'Microsoft Edge',
      'starcitizen': 'Star Citizen'
    };

    processes.forEach(proc => {
      const processName = proc.ProcessName.toLowerCase();

      // Skip if we've already seen this app
      if (seen.has(processName)) return;
      seen.add(processName);

      // Find friendly name
      let friendlyName = proc.MainWindowTitle || proc.ProcessName;
      for (const [key, name] of Object.entries(appNameMap)) {
        if (processName.includes(key)) {
          friendlyName = name;
          break;
        }
      }

      applications.push({
        id: processName,
        name: friendlyName,
        executable: proc.ProcessName + '.exe'
      });
    });

    return applications;

  } catch (error) {
    console.error('Failed to detect applications:', error);
    return [];
  }
});

ipcMain.handle('is-obs-running', async () => {
  try {
    // Check if OBS process is running
    const { exec } = require('child_process');
    const isWindows = process.platform === 'win32';

    return new Promise((resolve) => {
      if (isWindows) {
        exec('tasklist /FI "IMAGENAME eq obs64.exe"', (error, stdout) => {
          if (error) {
            resolve(false);
            return;
          }
          resolve(stdout.toLowerCase().includes('obs64.exe'));
        });
      } else {
        // For Linux/Mac if needed
        exec('pgrep -x obs', (error) => {
          resolve(!error);
        });
      }
    });
  } catch (error) {
    console.error('Error checking OBS status:', error);
    return false;
  }
});

// FFmpeg handlers
ipcMain.handle('download-ffmpeg', async () => {
  try {
    const FFmpegDetector = require('./lib/ffmpeg-detector');
    const detector = new FFmpegDetector();

    const ffmpegPath = await detector.downloadFFmpeg((progress) => {
      if (setupWindow && !setupWindow.isDestroyed()) {
        setupWindow.webContents.send('ffmpeg-download-progress', progress);
      }
    });

    return { success: true, path: ffmpegPath };
  } catch (error) {
    console.error('Failed to download FFmpeg:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('detect-ffmpeg-capabilities', async () => {
  try {
    const FFmpegDetector = require('./lib/ffmpeg-detector');
    const detector = new FFmpegDetector();

    const capabilities = await detector.detectCapabilities();

    // Always save to APPDATA for config
    const configPath = path.join(process.env.APPDATA || process.env.HOME, 'sc-recorder');
    await detector.saveCapabilities(configPath);

    return { success: true, capabilities };
  } catch (error) {
    console.error('Failed to detect FFmpeg capabilities:', error);
    return { success: false, error: error.message };
  }
});

// Audio track management for video editor
let audioTrackManager = null;

ipcMain.handle('init-audio-track-manager', async () => {
  console.log('[Main] init-audio-track-manager IPC called');
  try {
    const AudioTrackManager = require('./lib/audio-track-manager');
    audioTrackManager = new AudioTrackManager();

    // Get config using the global configManager instance
    const config = configManager ? configManager.get() : {};

    // Use LOCALAPPDATA for downloaded resources
    const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
    const resourcesBase = path.join(localAppData, 'sc-recorder', 'resources');
    const ffmpegPath = config.ffmpegPath || path.join(resourcesBase, 'ffmpeg', 'ffmpeg.exe');
    const ffprobePath = config.ffprobePath || path.join(resourcesBase, 'ffmpeg', 'ffprobe.exe');

    await audioTrackManager.initialize(ffmpegPath, ffprobePath);
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to initialize AudioTrackManager:', error);
    console.error('[Main] Error stack:', error.stack);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('detect-audio-tracks', async (event, videoPath) => {
  console.log(`[Main] detect-audio-tracks IPC called for: ${videoPath}`);
  try {
    // Force recreation if paths are wrong (contain app.asar)
    if (!audioTrackManager || (audioTrackManager.ffmpegPath && audioTrackManager.ffmpegPath.includes('app.asar'))) {
      audioTrackManager = null; // Clear old instance
      const AudioTrackManager = require('./lib/audio-track-manager');
      audioTrackManager = new AudioTrackManager();

      const config = configManager ? configManager.get() : {};
      // Use the same path resolution as OBS - get base directory correctly for packaged apps
      const baseDir = app.isPackaged
        ? path.dirname(app.getPath('exe'))
        : __dirname;
      const ffmpegPath = config.ffmpegPath || path.join(baseDir, 'resources', 'ffmpeg', 'ffmpeg.exe');
      const ffprobePath = config.ffprobePath || path.join(baseDir, 'resources', 'ffmpeg', 'ffprobe.exe');

      await audioTrackManager.initialize(ffmpegPath, ffprobePath);
    }

    const tracks = await audioTrackManager.detectAudioTracks(videoPath);
    return { success: true, tracks };
  } catch (error) {
    console.error('Failed to detect audio tracks:', error);
    return { success: false, error: error.message, tracks: [] };
  }
});

ipcMain.handle('extract-audio-tracks', async (event, videoPath) => {
  console.log(`[Main] extract-audio-tracks IPC called for: ${videoPath}`);

  const Logger = require('./lib/logger');
  const extractLogger = new Logger('audio-extraction');

  extractLogger.log('===== AUDIO EXTRACTION SESSION STARTED =====');
  extractLogger.log('Video path:', videoPath);

  try {
    // Force recreation if paths are wrong (contain app.asar)
    if (!audioTrackManager || (audioTrackManager.ffmpegPath && audioTrackManager.ffmpegPath.includes('app.asar'))) {
      audioTrackManager = null; // Clear old instance
      const AudioTrackManager = require('./lib/audio-track-manager');
      audioTrackManager = new AudioTrackManager();

      const config = configManager ? configManager.get() : {};
      // Use the same path resolution as OBS - get base directory correctly for packaged apps
      const baseDir = app.isPackaged
        ? path.dirname(app.getPath('exe'))
        : __dirname;
      const ffmpegPath = config.ffmpegPath || path.join(baseDir, 'resources', 'ffmpeg', 'ffmpeg.exe');
      const ffprobePath = config.ffprobePath || path.join(baseDir, 'resources', 'ffmpeg', 'ffprobe.exe');

      await audioTrackManager.initialize(ffmpegPath, ffprobePath);
    }

    // Send progress updates back to renderer
    const progressCallback = (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          if (mainWindow.webContents &&
              !mainWindow.webContents.isDestroyed() &&
              !mainWindow.webContents.isCrashed()) {
            mainWindow.webContents.send('audio-extraction-progress', progress);
          }
        } catch (error) {
          // Silently ignore send errors during extraction
          if (!error.message?.includes('disposed') && !error.message?.includes('WebFrameMain')) {
            console.error('Error sending extraction progress:', error);
          }
        }
      }
    };

    const extractedTracks = await audioTrackManager.extractAudioTracks(videoPath, progressCallback);

    extractLogger.log(`Successfully extracted ${extractedTracks.length} audio tracks`);
    extractedTracks.forEach(track => {
      extractLogger.log(`Track ${track.trackIndex}: ${track.path}`);
    });
    extractLogger.log('===== AUDIO EXTRACTION SESSION COMPLETED =====');

    return { success: true, tracks: extractedTracks };
  } catch (error) {
    console.error('Failed to extract audio tracks:', error);
    extractLogger.error('Failed to extract audio tracks:', error.message);
    extractLogger.error('Error stack:', error.stack);
    extractLogger.error('===== AUDIO EXTRACTION SESSION FAILED =====');
    return { success: false, error: error.message, tracks: [] };
  }
});

ipcMain.handle('cleanup-audio-tracks', async () => {
  try {
    if (audioTrackManager) {
      await audioTrackManager.cleanupExtractedTracks();
    }
    return { success: true };
  } catch (error) {
    console.error('Failed to cleanup audio tracks:', error);
    return { success: false, error: error.message };
  }
});

// Remove this handler completely - it wasn't needed before OAuth changes
// ipcMain.handle('read-audio-file-chunked', async (event, filePath) => {
//   // Handler removed - WebAudioManager should use fetch directly
// });

// Get FFmpeg path handler
ipcMain.handle('get-ffmpeg-path', async () => {
  const config = configManager ? configManager.get() : {};
  // Use the same path resolution as OBS - get base directory correctly for packaged apps
  const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
  const resourcesBase = path.join(localAppData, 'sc-recorder', 'resources');
  const ffmpegPath = config.ffmpegPath || path.join(resourcesBase, 'ffmpeg', 'ffmpeg.exe');
  const ffprobePath = config.ffprobePath || path.join(resourcesBase, 'ffmpeg', 'ffprobe.exe');

  return { ffmpegPath, ffprobePath };
});

// Thumbnail generation handlers
ipcMain.handle('generate-thumbnails', async (event, options) => {
  const ThumbnailGenerator = require('./lib/thumbnail-generator');
  const generator = new ThumbnailGenerator();

  try {

    await generator.initialize();

    // Set up progress reporting
    const progressOptions = {
      ...options,
      onProgress: (progress) => {
        // Send progress updates to renderer
        event.sender.send('thumbnail-progress', progress);
      }
    };

    const result = await generator.generateFromVideo(
      options.videoPath,
      options.events,
      options.outputFolder,
      {
        mainEventId: options.mainEventId,
        onProgress: progressOptions.onProgress
      }
    );

    return result;
  } catch (error) {
    console.error('[Main] Thumbnail generation failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

// Check if thumbnails exist
ipcMain.handle('check-thumbnails', async (event, videoPath) => {
  const ThumbnailGenerator = require('./lib/thumbnail-generator');
  const generator = new ThumbnailGenerator();

  try {
    const result = await generator.checkThumbnails(videoPath);
    return result;
  } catch (error) {
    console.error('[Main] Thumbnail check failed:', error);
    return {
      exists: false,
      error: error.message
    };
  }
});

// Validate SC Player required files for direct upload
ipcMain.handle('validate-sc-player-files', async (event, options) => {
  try {
    const SCPlayerProvider = require('./lib/providers/sc-player-provider');
    const provider = new SCPlayerProvider();

    console.log('[Main] Validating SC Player files for:', options.filePath);

    const validation = provider.validateRequiredFiles(options.filePath);

    if (validation.valid) {
      // Add additional info for UI display
      validation.eventThumbnailCount = validation.eventThumbnails.length;
    }

    console.log('[Main] SC Player validation result:', validation);
    return validation;
  } catch (error) {
    console.error('Failed to validate SC Player files:', error);
    return {
      success: false,
      valid: false,
      error: error.message
    };
  }
});

// Helper function to export filtered events for edited videos
async function exportFilteredEvents(options, exportLogger) {
  const path = require('path');
  const fs = require('fs').promises;

  try {
    // Calculate the JSON file path (same name as video but with .json extension)
    const videoPath = options.outputPath;
    const jsonPath = videoPath.substring(0, videoPath.lastIndexOf('.')) + '.json';

    // Try to read the original JSON to get the base metadata structure
    let originalMetadata = null;
    const originalJsonPath = options.inputPath.replace(/\.[^.]+$/, '.json');

    try {
      const originalContent = await fs.readFile(originalJsonPath, 'utf8');
      const originalJson = JSON.parse(originalContent);
      originalMetadata = originalJson.metadata;
    } catch (err) {
      exportLogger.log('No original JSON found at:', originalJsonPath);
    }

    // Filter events within the mark in/out range and adjust offsets
    const markIn = options.markIn || 0;
    const markOut = options.markOut || Infinity;
    const duration = markOut - markIn;

    const filteredEvents = options.events.filter(event => {
      const eventTime = event.videoOffset || 0;
      return eventTime >= markIn && eventTime <= markOut;
    }).map(event => {
      // Adjust video offset and timecode to be relative to the new start time
      const newOffset = (event.videoOffset || 0) - markIn;
      const newTimecode = formatTimecode(newOffset);

      // Create a clean event object without any file paths
      const cleanEvent = {
        ...event,
        videoOffset: newOffset,
        videoTimecode: newTimecode
      };

      // Remove any fields that contain file paths or weren't in the original format
      if (cleanEvent.data) {
        // Remove recordingPath if it exists in data
        delete cleanEvent.data.recordingPath;
        // Remove any other full paths that might have been added
        delete cleanEvent.data.originalVideo;
        delete cleanEvent.data.exportedVideo;
      }

      return cleanEvent;
    });

    // Recalculate category statistics based on filtered events
    const categories = {};
    filteredEvents.forEach(event => {
      const category = event.category || 'unknown';
      const subtype = event.subtype || event.type || 'unknown';

      if (!categories[category]) {
        categories[category] = {
          count: 0,
          types: {}
        };
      }

      categories[category].count++;
      categories[category].types[subtype] = (categories[category].types[subtype] || 0) + 1;
    });

    // Create metadata structure, preserving original structure but updating values
    const metadata = {
      version: originalMetadata?.version || "1.0.0",
      recorder: originalMetadata?.recorder || "SC-Recorder",
      recordingStartTime: originalMetadata?.recordingStartTime || new Date().toISOString(),
      recordingStartTimecode: originalMetadata?.recordingStartTimecode || Date.now(),
      recordingDuration: duration,  // Updated to reflect edited duration
      eventCount: filteredEvents.length,  // Updated to reflect filtered events
      categories: categories,  // Recalculated from filtered events
      savedAt: new Date().toISOString()  // Updated to current save time
    };

    // Create the final JSON structure matching original format
    const jsonData = {
      metadata: metadata,
      events: filteredEvents
    };

    // Write the JSON file
    await fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2));

    exportLogger.log(`Exported ${filteredEvents.length} events to: ${jsonPath}`);
    exportLogger.log('Events JSON saved successfully with updated metadata');

  } catch (error) {
    console.error('Failed to export events JSON:', error);
    exportLogger.error('Failed to export events JSON:', error.message);
    // Don't throw - we don't want to fail the video export if JSON export fails
  }
}

// Helper function to format seconds into timecode
function formatTimecode(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// Video export IPC handlers using fluent-ffmpeg
ipcMain.handle('export-video-fluent', async (event, options) => {
  const ffmpeg = require('fluent-ffmpeg');
  const path = require('path');
  const fs = require('fs');
  const fsPromises = require('fs').promises;
  const Logger = require('./lib/logger');

  // Create logger for this export session
  const exportLogger = new Logger('video-export');

  try {
    console.log('Starting video export with fluent-ffmpeg...');

    // Log export session start
    exportLogger.log('===== VIDEO EXPORT SESSION STARTED =====');
    exportLogger.log('Export options:', JSON.stringify(options, null, 2));
    exportLogger.log('Input path:', options.inputPath);
    exportLogger.log('Output path:', options.outputPath);
    exportLogger.log('Mark In:', options.markIn);
    exportLogger.log('Mark Out:', options.markOut);
    exportLogger.log('Video codec:', options.videoCodec);
    exportLogger.log('Has multiple tracks:', options.hasMultipleTracks);
    exportLogger.log('Is multi-track mode:', options.isMultiTrackMode);
    exportLogger.log('Number of audio segments:', options.audioSegments ? options.audioSegments.length : 0);
    if (options.extractedTracks) {
      exportLogger.log('Extracted tracks:', options.extractedTracks.map(t => ({
        trackIndex: t.trackIndex,
        path: t.path
      })));
    }

    // Ensure output directory exists
    const outputDir = path.dirname(options.outputPath);
    await fsPromises.mkdir(outputDir, { recursive: true });

    // Get FFmpeg path
    const config = configManager ? configManager.get() : {};
    // Use LOCALAPPDATA for downloaded resources
    const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
    const resourcesBase = path.join(localAppData, 'sc-recorder', 'resources');
    const ffmpegPath = config.ffmpegPath || path.join(resourcesBase, 'ffmpeg', 'ffmpeg.exe');
    const ffprobePath = config.ffprobePath || path.join(resourcesBase, 'ffmpeg', 'ffprobe.exe');


    // Set FFmpeg and FFprobe paths
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);

    // Multi-step approach for multi-track audio with segments
    if (options.isMultiTrackMode && options.audioSegments && options.audioSegments.length > 0) {
      exportLogger.log('Using multi-step approach for multi-track audio export');

      // Step 1: Create trimmed temporary file with all audio tracks
      const tempDir = app.getPath('temp');
      const tempFile = path.join(tempDir, `sc_recorder_temp_${Date.now()}.mkv`);
      let tempFileCreated = false;

      exportLogger.log('Step 1: Creating trimmed temp file with all tracks:', tempFile);

      try {
        await new Promise((resolve, reject) => {
          const trimCommand = ffmpeg();

          // Add main input with seek
          trimCommand.input(options.inputPath);
          if (options.markIn !== null && options.markIn !== undefined) {
            trimCommand.seekInput(options.markIn);
          }

          // Add extracted audio tracks with the same seek
          if (options.extractedTracks && options.extractedTracks.length > 0) {
            options.extractedTracks.forEach(track => {
              trimCommand.input(track.path);
              if (options.markIn !== null && options.markIn !== undefined) {
                trimCommand.seekInput(options.markIn);
              }
            });
          }

          // Set duration
          if (options.markOut !== null && options.markOut !== undefined) {
            const duration = options.markOut - (options.markIn || 0);
            trimCommand.duration(duration);
          }

          // Map all video and audio streams
          let mapOptions = [
            '-c:v', 'copy',  // Copy video codec
            '-c:a', 'copy',  // Copy audio codec
            '-map', '0:v'    // Map video from first input
          ];

          // Map all audio tracks
          if (options.hasMultipleTracks) {
            // Map audio from main file (all tracks)
            mapOptions.push('-map', '0:a');

            // Map audio from extracted files if any
            if (options.extractedTracks && options.extractedTracks.length > 0) {
              options.extractedTracks.forEach((track, idx) => {
                mapOptions.push('-map', `${idx + 1}:a:0`);
              });
            }
          } else {
            // Single audio track
            mapOptions.push('-map', '0:a');
          }

          trimCommand.outputOptions(mapOptions);
          trimCommand.output(tempFile);

          trimCommand.on('start', (commandLine) => {
            exportLogger.log('Step 1 FFmpeg command:', commandLine);
          });

          trimCommand.on('progress', (progress) => {
            event.sender.send('export-progress', {
              percent: progress.percent ? progress.percent / 2 : 0,  // First 50% of total progress
              currentTime: progress.timemark,
              step: 'Preparing tracks...'
            });
          });

          trimCommand.on('error', (err, stdout, stderr) => {
            console.error('Step 1 FFmpeg error:', err.message);
            console.error('Step 1 FFmpeg stderr:', stderr);
            exportLogger.error('Step 1 FFmpeg error:', err.message);
            exportLogger.error('Step 1 FFmpeg stderr:', stderr);
            reject(err);
          });

          trimCommand.on('end', () => {
            exportLogger.log('Step 1 completed: Trimmed file created successfully');
            tempFileCreated = true;
            resolve();
          });

          trimCommand.run();
        });

        // Step 2: Apply audio segments and mix
        exportLogger.log('Step 2: Applying audio segments and mixing');

        await new Promise((resolve, reject) => {
          const mixCommand = ffmpeg();

          // Use the temp file as input
          mixCommand.input(tempFile);

          // Build the audio mixing filter
          const filters = [];
          const inputs = [];

          // Group segments by track
          const segmentsByTrack = {};
          options.audioSegments.forEach(segment => {
            const trackId = segment.trackId;
            if (!segmentsByTrack[trackId]) {
              segmentsByTrack[trackId] = [];
            }
            segmentsByTrack[trackId].push(segment);
          });

          exportLogger.log('Segments grouped by track:', JSON.stringify(segmentsByTrack, null, 2));

          // Process each track's segments
          // Now all times are relative to 0 since we have a trimmed file
          Object.entries(segmentsByTrack).forEach(([trackId, segments]) => {
            const trackNum = parseInt(trackId.split('-')[1]);

            // In the temp file, tracks are in order: video, then audio tracks
            // Audio track indices in temp file:
            // Track 1 (from main) = 0:a:0
            // Track 2 (from main or first extracted) = 0:a:1
            // Track 3 = 0:a:2
            // Track 4 = 0:a:3
            const audioStreamIndex = trackNum - 1;
            const audioStream = `0:a:${audioStreamIndex}`;

            // Since the temp file is already trimmed, adjust segment times
            const clipStart = options.markIn || 0;
            const clipEnd = options.markOut || Infinity;

            // Filter and adjust segments for the trimmed timeline
            const validSegments = segments.filter(segment => {
              return segment.endTime > clipStart && segment.startTime < clipEnd;
            }).map(segment => ({
              ...segment,
              // Adjust times relative to the trimmed file (starting at 0)
              startTime: Math.max(0, segment.startTime - clipStart),
              endTime: Math.min(clipEnd - clipStart, segment.endTime - clipStart)
            }));

            if (validSegments.length === 0) {
              return;
            }

            // Build filter for this track's segments
            const trackFilterName = `track${trackNum}_processed`;

            if (validSegments.length === 1) {
              // Single segment
              const segment = validSegments[0];
              let segmentFilter = `[${audioStream}]`;

              // Trim to segment duration
              segmentFilter += `atrim=start=${segment.startTime}:end=${segment.endTime},asetpts=PTS-STARTPTS`;

              // Add delay if segment doesn't start at 0
              if (segment.startTime > 0) {
                const delayMs = Math.round(segment.startTime * 1000);
                segmentFilter += `,adelay=${delayMs}|${delayMs}`;
              }

              // Apply volume adjustment
              if (segment.volume && segment.volume !== 0) {
                segmentFilter += `,volume=${segment.volume}dB`;
              }

              segmentFilter += `[${trackFilterName}]`;

              filters.push(segmentFilter);
              inputs.push(`[${trackFilterName}]`);

            } else {
              // Multiple segments - need to split and process each
              const splitOutputs = validSegments.map((_, idx) => `[t${trackNum}_split${idx}]`).join('');
              filters.push(`[${audioStream}]asplit=${validSegments.length}${splitOutputs}`);

              const segmentOutputs = [];
              validSegments.forEach((segment, idx) => {
                const splitName = `t${trackNum}_split${idx}`;
                const segName = `t${trackNum}_seg${idx}`;

                let segmentFilter = `[${splitName}]`;
                segmentFilter += `atrim=start=${segment.startTime}:end=${segment.endTime},asetpts=PTS-STARTPTS`;

                if (segment.startTime > 0) {
                  const delayMs = Math.round(segment.startTime * 1000);
                  segmentFilter += `,adelay=${delayMs}|${delayMs}`;
                }

                if (segment.volume && segment.volume !== 0) {
                  segmentFilter += `,volume=${segment.volume}dB`;
                }

                segmentFilter += `[${segName}]`;
                filters.push(segmentFilter);
                segmentOutputs.push(`[${segName}]`);
              });

              // Mix this track's segments
              if (segmentOutputs.length > 0) {
                const mixFilter = `${segmentOutputs.join('')}amix=inputs=${segmentOutputs.length}:duration=longest[${trackFilterName}]`;
                filters.push(mixFilter);
                inputs.push(`[${trackFilterName}]`);
              }
            }
          });

          // Mix all tracks together
          if (inputs.length > 0) {
            const finalMixFilter = `${inputs.join('')}amix=inputs=${inputs.length}:duration=longest[mixed]`;
            filters.push(finalMixFilter);

            const complexFilter = filters.join(';');
            exportLogger.log('Complex filter for mixing:', complexFilter);

            mixCommand.complexFilter(complexFilter);
            mixCommand.outputOptions([
              '-map', '0:v',      // Map video from temp file
              '-map', '[mixed]'   // Map mixed audio
            ]);
          } else {
            // No segments, just copy
            mixCommand.outputOptions([
              '-map', '0:v',
              '-map', '0:a:0'  // Use first audio track
            ]);
          }

          // Video codec settings
          if (options.videoCodec === 'copy') {
            mixCommand.videoCodec('copy');
          } else if (options.videoCodec === 'libx264') {
            mixCommand.videoCodec('libx264')
              .outputOptions([
                '-crf', options.videoQuality || '23',
                '-preset', options.videoPreset || 'medium'
              ]);
          } else if (options.videoCodec === 'libx265') {
            mixCommand.videoCodec('libx265')
              .outputOptions([
                '-crf', options.videoQuality || '23',
                '-preset', options.videoPreset || 'medium'
              ]);
          }

          // Audio codec - re-encode when mixing
          mixCommand.audioCodec('aac').audioBitrate('192k');

          // Set output
          mixCommand.output(options.outputPath);

          mixCommand.on('start', (commandLine) => {
            exportLogger.log('Step 2 FFmpeg command:', commandLine);
          });

          mixCommand.on('progress', (progress) => {
            event.sender.send('export-progress', {
              percent: 50 + (progress.percent ? progress.percent / 2 : 0),  // Second 50% of total progress
              currentTime: progress.timemark,
              step: 'Mixing audio tracks...'
            });
          });

          mixCommand.on('error', (err, stdout, stderr) => {
            console.error('Step 2 FFmpeg error:', err.message);
            console.error('Step 2 FFmpeg stderr:', stderr);
            exportLogger.error('Step 2 FFmpeg error:', err.message);
            exportLogger.error('Step 2 FFmpeg stderr:', stderr);
            reject(err);
          });

          mixCommand.on('end', async () => {
            exportLogger.log('Step 2 completed: Export finished successfully');
            exportLogger.log('Output file:', options.outputPath);

            // Export filtered events to JSON
            if (options.events && options.events.length > 0) {
              await exportFilteredEvents(options, exportLogger);
            }

            resolve({ success: true });
          });

          mixCommand.run();
        });

        // Clean up temp file
        try {
          fs.unlinkSync(tempFile);
        } catch (err) {
          console.warn('Failed to clean up temp file:', err);
        }

        exportLogger.log('===== VIDEO EXPORT SESSION COMPLETED SUCCESSFULLY =====');
        return { success: true };

      } catch (error) {
        exportLogger.error('Export failed during multi-step process:', error.message);
        exportLogger.error('Error stack:', error.stack);
        // Clean up temp file on error
        if (tempFileCreated) {
          try {
            fs.unlinkSync(tempFile);
              exportLogger.log('Temp file cleaned up after error');
          } catch (e) {
            console.warn('Failed to clean up temp file:', e);
            exportLogger.warn('Failed to clean up temp file:', e.message);
          }
        }
        throw error;
      }

    } else {
      // Original single-pass approach for non-multi-track or no segments
      exportLogger.log('Using single-pass export (no multi-track segments)');

      return new Promise((resolve, reject) => {
        const command = ffmpeg();

        // Add main input with seek if needed
        command.input(options.inputPath);
        if (options.markIn !== null && options.markIn !== undefined) {
          command.seekInput(options.markIn);
        }

        if (options.markOut !== null && options.markOut !== undefined) {
          const duration = options.markOut - (options.markIn || 0);
          command.duration(duration);
        }

        // For non-multi-track mode, use simple mapping
        if (options.hasMultipleTracks && !options.isMultiTrackMode) {
          // Multi-track file but not in multi-track mode - use only first audio track
          command.outputOptions([
            '-map', '0:v',
            '-map', '0:a:0'
          ]);
        } else {
          // Simple copy - map all streams
          command.outputOptions([
            '-map', '0:v',
            '-map', '0:a'
          ]);
        }

          // Video codec settings
        if (options.videoCodec === 'copy') {
          command.videoCodec('copy');
        } else if (options.videoCodec === 'libx264') {
          command.videoCodec('libx264')
            .outputOptions([
              '-crf', options.videoQuality || '23',
              '-preset', options.videoPreset || 'medium'
            ]);
        } else if (options.videoCodec === 'libx265') {
          command.videoCodec('libx265')
            .outputOptions([
              '-crf', options.videoQuality || '23',
              '-preset', options.videoPreset || 'medium'
            ]);
        }

        // Audio codec - copy when not doing complex filtering
        command.audioCodec('copy');

        // Set output
        command.output(options.outputPath);

        // Progress tracking
        command.on('start', (commandLine) => {
          exportLogger.log('Single-pass FFmpeg command:', commandLine);
        });

        command.on('progress', (progress) => {
          event.sender.send('export-progress', {
            percent: progress.percent,
            currentTime: progress.timemark,
            targetSize: progress.targetSize
          });
        });

        command.on('error', (err, stdout, stderr) => {
          console.error('FFmpeg error:', err.message);
          console.error('FFmpeg stderr:', stderr);
          exportLogger.error('Single-pass FFmpeg error:', err.message);
          exportLogger.error('FFmpeg stderr:', stderr);
          resolve({ success: false, error: err.message });
        });

        command.on('end', async () => {
          exportLogger.log('Single-pass export completed successfully');
          exportLogger.log('Output file:', options.outputPath);

          // Export filtered events to JSON
          if (options.events && options.events.length > 0) {
            await exportFilteredEvents(options, exportLogger);
          }

          exportLogger.log('===== VIDEO EXPORT SESSION COMPLETED SUCCESSFULLY =====');
          resolve({ success: true });
        });

          // Run the command
        command.run();
      });
    }
  } catch (error) {
    console.error('Export error:', error);
    exportLogger.error('Export error:', error.message);
    exportLogger.error('Error stack:', error.stack);
    exportLogger.error('===== VIDEO EXPORT SESSION FAILED =====');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-folder', async (event, folderPath) => {
  const { shell } = require('electron');
  try {
    shell.openPath(folderPath);
    return { success: true };
  } catch (error) {
    console.error('Failed to open folder:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-file-stats', async (event, filePath) => {
  const fs = require('fs').promises;
  try {
    const stats = await fs.stat(filePath);
    return {
      success: true,
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime
    };
  } catch (error) {
    console.error('Failed to get file stats:', error);
    return { success: false, error: error.message };
  }
});

// Move recording from recordings folder to saved folder
ipcMain.handle('move-recording', async (event, recordingPath) => {
  const fs = require('fs').promises;
  const path = require('path');

  try {
    console.log('Moving recording to saved folder:', recordingPath);

    // Get the base recording folder from config
    const config = configManager.get();
    const basePath = config?.settings?.recording?.outputPath || path.join(app.getPath('videos'), 'SC-Recorder');

    // Get filename
    const filename = path.basename(recordingPath);
    const baseName = path.basename(recordingPath, path.extname(recordingPath));

    // Determine source and destination folders
    const sourceFolder = path.dirname(recordingPath);
    const savedFolder = path.join(basePath, 'saved');

    // Ensure saved folder exists
    await fs.mkdir(savedFolder, { recursive: true });

    // Move video file
    const destVideoPath = path.join(savedFolder, filename);
    await fs.rename(recordingPath, destVideoPath);

    // Also move JSON file if it exists
    const jsonSourcePath = path.join(sourceFolder, `${baseName}.json`);
    let newEventsPath = null;
    try {
      await fs.access(jsonSourcePath);
      const jsonDestPath = path.join(savedFolder, `${baseName}.json`);
      await fs.rename(jsonSourcePath, jsonDestPath);
      newEventsPath = jsonDestPath;
    } catch (error) {
      // JSON file doesn't exist or couldn't be moved
    }

    return { success: true, newPath: destVideoPath, newEventsPath };
  } catch (error) {
    console.error('Failed to move recording:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-configuration', async (event, configuration) => {
  try {
    console.log('Saving configuration from wizard...');

    // Convert wizard config to our config format
    const config = configManager.getCapabilitiesTemplate();

    // Update with wizard selections
    config.encoders = configuration.encoders;
    config.audio.outputDevices = [configuration.audio.outputDevice].filter(Boolean);
    config.audio.inputDevices = [configuration.audio.inputDevice].filter(Boolean);
    config.audio.applications = configuration.audio.voiceApp ? [configuration.audio.voiceApp] : [];

    config.settings.resolution = {
      preset: configuration.resolution.preset === 'display' ? 'native' : configuration.resolution.preset,
      width: configuration.resolution.width,
      height: configuration.resolution.height,
      scaleFactor: 1
    };

    // Set display configuration from wizard
    if (configuration.display) {
      config.display = {
        id: configuration.display.id,
        width: configuration.display.width,
        height: configuration.display.height
      };
    } else {
      // If no display provided, use resolution as display
      config.display = {
        width: configuration.resolution.width,
        height: configuration.resolution.height,
        refreshRate: 60
      };
    }

    // Set recording output path and create folder structure
    if (configuration.recordingFolder) {
      config.settings.recording.outputPath = configuration.recordingFolder;

      // Create the 3 subfolders: recordings, saved, edited
      const fs = require('fs').promises;
      const path = require('path');
      const subfolders = ['recordings', 'saved', 'edited'];

      for (const subfolder of subfolders) {
        const folderPath = path.join(configuration.recordingFolder, subfolder);
        try {
          await fs.mkdir(folderPath, { recursive: true });
        } catch (error) {
          console.error(`Failed to create folder ${folderPath}:`, error);
        }
      }
    }

    // Set Star Citizen path
    if (configuration.starCitizen) {
      config.settings.starCitizen = {
        path: configuration.starCitizen.path,
        build: configuration.starCitizen.hasLive ? 'LIVE' : 'PTU'
      };
    }

    // Select best encoder - prefer AV1 > H.265 > H.264
    let selectedEncoder = null;

    if (configuration.encoders.hardware.length > 0) {
      // First try to find AV1
      selectedEncoder = configuration.encoders.hardware.find(e =>
        e.codec === 'av1' || e.name.toLowerCase().includes('av1')
      );

      // If no AV1, try H.265/HEVC
      if (!selectedEncoder) {
        selectedEncoder = configuration.encoders.hardware.find(e =>
          e.codec === 'h265' || e.name.toLowerCase().includes('h.265') ||
          e.name.toLowerCase().includes('hevc') || e.name.toLowerCase().includes('h265')
        );
      }

      // If no H.265, use H.264
      if (!selectedEncoder) {
        selectedEncoder = configuration.encoders.hardware.find(e =>
          e.codec === 'h264' || e.name.toLowerCase().includes('h.264') ||
          e.name.toLowerCase().includes('h264') || e.name.toLowerCase().includes('avc')
        );
      }

      // Fallback to first available hardware encoder
      if (!selectedEncoder) {
        selectedEncoder = configuration.encoders.hardware[0];
      }
    }

    // Fallback to software if no hardware
    if (!selectedEncoder && configuration.encoders.software.length > 0) {
      selectedEncoder = configuration.encoders.software[0];
    }

    if (selectedEncoder) {
      config.settings.recording.encoder = selectedEncoder.name;
      config.settings.recording.encoderId = selectedEncoder.id;
      config.settings.recording.codec = selectedEncoder.codec || 'h264';
    }

    // Set audio tracks
    if (configuration.audio.voiceApp) {
      config.settings.audio.track2 = {
        enabled: true,
        source: configuration.audio.voiceApp.id,
        type: 'application'
      };
    }

    if (configuration.audio.inputDevice) {
      config.settings.audio.track3 = {
        enabled: true,
        source: configuration.audio.inputDevice.id,
        type: 'device'
      };
    }

    // Log final config before saving

    // Save configuration
    const saved = await configManager.save(config);

    if (saved) {
      // Save encoders to separate cache file for quick access
      await configManager.saveEncodersCache(configuration.encoders);

      try {
        // Generate OBS templates with new configuration
        console.log('Generating OBS templates...');
        const templateGenerator = new OBSTemplateGenerator();
        await templateGenerator.generateFromConfig(config);
      } catch (templateError) {
        console.error('Failed to generate OBS templates:', templateError);
        // Don't fail the whole save if templates fail
      }
    }

    return saved;
  } catch (error) {
    console.error('Failed to save configuration:', error);
    return false;
  }
});

ipcMain.on('setup-complete', async () => {
  // Clean up the setup detector
  if (setupDetector) {
    console.log('Cleaning up setup detector...');
    await setupDetector.cleanup();
    setupDetector = null;
  }

  // Close setup window and create main window
  if (setupWindow) {
    setupWindow.close();
  }

  // Reload configuration
  await configManager.load();
  isFirstRun = false;

  // Initialize supervisor with new configuration
  supervisor = new SupervisorModule();

  // Attach event listeners (only once, even after setup)
  attachSupervisorListeners();

  // Initialize supervisor with config that includes auto-start settings
  const supervisorConfig = {
    ...configManager.config,
    autoStartOBS: true,  // Start OBS automatically
    autoMonitorSC: true, // Start monitoring Star Citizen
    obs: {
      profile: 'SC-Recorder',
      collection: 'SC-Recording'
    }
  };

  await supervisor.initialize(supervisorConfig);

  // Create main window
  createWindow();
});

// Combined dependencies download handler (OBS + FFmpeg)
ipcMain.on('download-dependencies', async (event) => {
  const OBS_DOWNLOAD_URL = 'https://github.com/obsproject/obs-studio/releases/download/31.1.0/OBS-Studio-31.1.0-Windows-x64.zip';
  const FFMPEG_DOWNLOAD_URL = 'https://github.com/GyanD/codexffmpeg/releases/download/8.0/ffmpeg-8.0-essentials_build.zip';

  // Use LOCALAPPDATA for downloaded resources
  const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
  const resourcesBase = path.join(localAppData, 'sc-recorder', 'resources');
  const obsDir = path.join(resourcesBase, 'obs-studio');
  const ffmpegDir = path.join(resourcesBase, 'ffmpeg');
  const obsZipPath = path.join(app.getPath('temp'), 'obs-studio.zip');
  const ffmpegZipPath = path.join(app.getPath('temp'), 'ffmpeg.zip');

  try {
    // Create directories if they don't exist
    await fs.mkdir(obsDir, { recursive: true });
    await fs.mkdir(ffmpegDir, { recursive: true });

    // Check what needs to be downloaded
    const obsExePath = path.join(obsDir, 'bin', '64bit', 'obs64.exe');
    const ffmpegExePath = path.join(ffmpegDir, 'ffmpeg.exe');

    let needOBS = true;
    let needFFmpeg = true;

    try {
      await fs.access(obsExePath);
      needOBS = false;
    } catch (e) {
    }

    try {
      await fs.access(ffmpegExePath);
      needFFmpeg = false;
    } catch (e) {
    }

    if (!needOBS && !needFFmpeg) {
      // Dependencies exist, but still need to detect FFmpeg capabilities
      event.sender.send('dependencies-download-progress', {
        type: 'detecting',
        message: 'Detecting FFmpeg capabilities...'
      });

      const FFmpegDetector = require('./lib/ffmpeg-detector');
      const detector = new FFmpegDetector();
      detector.ffmpegPath = ffmpegExePath;
      const capabilities = await detector.detectCapabilities();
      const configPath = app.getPath('userData');
      await detector.saveCapabilities(configPath);


      event.sender.send('dependencies-download-progress', {
        type: 'complete',
        message: 'All dependencies already installed',
        obsPath: obsExePath,
        ffmpegPath: ffmpegExePath,
        ffmpegCapabilities: capabilities
      });

      return;
    }

    let totalSteps = (needOBS ? 2 : 0) + (needFFmpeg ? 2 : 0); // Download + Extract for each
    let currentStep = 0;

    // Download and install OBS if needed
    if (needOBS) {
      event.sender.send('dependencies-download-progress', {
        type: 'status',
        message: 'Downloading OBS Studio...',
        progress: (currentStep / totalSteps) * 100
      });

      await downloadFile(OBS_DOWNLOAD_URL, obsZipPath, (progress) => {
        event.sender.send('dependencies-download-progress', {
          type: 'progress',
          component: 'obs',
          percent: progress,
          message: 'Downloading OBS Studio...',
          progress: ((currentStep + progress) / totalSteps) * 100
        });
      });

      currentStep++;

      event.sender.send('dependencies-download-progress', {
        type: 'extracting',
        component: 'obs',
        message: 'Extracting OBS Studio...',
        progress: (currentStep / totalSteps) * 100
      });

      await extract(obsZipPath, { dir: obsDir });

      // Clean up temp file
      await fs.unlink(obsZipPath).catch(() => { });
      currentStep++;
    }

    // Download and install FFmpeg if needed
    if (needFFmpeg) {
      event.sender.send('dependencies-download-progress', {
        type: 'status',
        message: 'Downloading FFmpeg...',
        progress: (currentStep / totalSteps) * 100
      });

      await downloadFile(FFMPEG_DOWNLOAD_URL, ffmpegZipPath, (progress) => {
        event.sender.send('dependencies-download-progress', {
          type: 'progress',
          component: 'ffmpeg',
          percent: progress,
          message: 'Downloading FFmpeg...',
          progress: ((currentStep + progress) / totalSteps) * 100
        });
      });

      currentStep++;

      event.sender.send('dependencies-download-progress', {
        type: 'extracting',
        component: 'ffmpeg',
        message: 'Extracting FFmpeg...',
        progress: (currentStep / totalSteps) * 100
      });

      await extract(ffmpegZipPath, { dir: resourcesBase });

      // Move ffmpeg files from the extracted folder to our ffmpeg directory
      const extractedFolder = path.join(resourcesBase, 'ffmpeg-8.0-essentials_build');
      const binPath = path.join(extractedFolder, 'bin');

      try {
        const files = await fs.readdir(binPath);
        for (const file of files) {
          const srcPath = path.join(binPath, file);
          const destPath = path.join(ffmpegDir, file);
          await fs.rename(srcPath, destPath);
        }

        // Clean up extracted folder
        await fs.rm(extractedFolder, { recursive: true, force: true });
      } catch (e) {
        console.error('Failed to move FFmpeg files:', e);
      }

      // Clean up temp file
      await fs.unlink(ffmpegZipPath).catch(() => { });
      currentStep++;
    }

    // Detect FFmpeg capabilities
    event.sender.send('dependencies-download-progress', {
      type: 'detecting',
      message: 'Detecting FFmpeg capabilities...'
    });

    const FFmpegDetector = require('./lib/ffmpeg-detector');
    const detector = new FFmpegDetector();
    detector.ffmpegPath = ffmpegExePath;
    const capabilities = await detector.detectCapabilities();
    const configPath = app.getPath('userData');
    await detector.saveCapabilities(configPath);

    console.log('FFmpeg capabilities:', capabilities);

    event.sender.send('dependencies-download-progress', {
      type: 'complete',
      message: 'All dependencies installed successfully',
      obsPath: obsExePath,
      ffmpegPath: ffmpegExePath,
      ffmpegCapabilities: capabilities
    });

  } catch (error) {
    console.error('Failed to download dependencies:', error);
    event.sender.send('dependencies-download-progress', {
      type: 'error',
      message: error.message
    });
  }
});

// Legacy OBS-only download handler (kept for compatibility)
ipcMain.on('download-obs', async (event) => {
  const OBS_DOWNLOAD_URL = 'https://github.com/obsproject/obs-studio/releases/download/31.1.0/OBS-Studio-31.1.0-Windows-x64.zip';
  // Use LOCALAPPDATA for downloaded resources
  const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
  const resourcesBase = path.join(localAppData, 'sc-recorder', 'resources');
  const obsDir = path.join(resourcesBase, 'obs-studio');
  const zipPath = path.join(app.getPath('temp'), 'obs-studio.zip');

  try {
    // Create directory if it doesn't exist
    await fs.mkdir(obsDir, { recursive: true });

    // Check if already exists
    const obsExePath = path.join(obsDir, 'bin', '64bit', 'obs64.exe');
    try {
      await fs.access(obsExePath, fs.constants.F_OK);
      event.reply('obs-download-progress', {
        type: 'complete',
        path: obsExePath
      });
      return;
    } catch {
      // OBS doesn't exist, continue with download
    }


    // Download OBS
    await downloadFile(OBS_DOWNLOAD_URL, zipPath, (progress) => {
      event.reply('obs-download-progress', {
        type: 'progress',
        percent: progress.percent,
        downloaded: progress.downloaded,
        total: progress.total
      });
    });


    // Extract
    event.reply('obs-download-progress', { type: 'extracting' });
    await extract(zipPath, { dir: obsDir });


    // Clean up zip file
    await fs.unlink(zipPath).catch(() => { });

    // Verify extraction
    try {
      await fs.access(obsExePath, fs.constants.F_OK);

      // Success
      event.reply('obs-download-progress', {
        type: 'complete',
        path: obsExePath
      });
    } catch (error) {
      throw new Error('OBS extraction failed - exe not found at expected location');
    }

  } catch (error) {
    console.error('Failed to download/extract OBS:', error);
    event.reply('obs-download-progress', {
      type: 'error',
      message: error.message
    });
  }
});

// IPC Handlers for Settings
ipcMain.handle('load-config', async () => {
  try {
    await configManager.load();
    return configManager.config;
  } catch (error) {
    console.error('Error loading config:', error);
    throw error;
  }
});

ipcMain.handle('update-config', async (event, settings) => {
  try {
    // Update and save settings
    configManager.updateSettings(settings);
    await configManager.save(configManager.config);

    // If recording output path changed, create the subfolder structure
    if (settings.recording && settings.recording.outputPath) {
      const fs = require('fs').promises;
      const path = require('path');
      const subfolders = ['recordings', 'saved', 'edited'];

      console.log('Recording output path changed, creating folder structure...');

      for (const subfolder of subfolders) {
        const folderPath = path.join(settings.recording.outputPath, subfolder);
        try {
          await fs.mkdir(folderPath, { recursive: true });
          console.log(`Created folder: ${folderPath}`);
        } catch (error) {
          console.error(`Failed to create folder ${folderPath}:`, error);
        }
      }
    }

    // Register hotkeys if they changed
    if (settings.hotkeys) {
      registerHotkeys(settings.hotkeys);
    }

    // Update recording options in supervisor if they changed
    if (settings.recordingOptions && supervisor) {
      supervisor.updateRecordingOptions(configManager.config);
    }

    // Check if we need to regenerate templates (if recording settings changed)
    const needsRegeneration = settings.resolution || settings.recording || settings.performance;

    if (needsRegeneration && supervisor) {
      console.log('Settings changed, regenerating OBS templates...');

      // Step 1: Stop OBS via supervisor
      await supervisor.stopOBS();

      // Wait a bit for OBS to fully shut down
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 2: Generate new templates
      const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
      const resourcesBase = path.join(localAppData, 'sc-recorder', 'resources');
      const obsPath = path.join(resourcesBase, 'obs-studio');
      const templateGenerator = new OBSTemplateGenerator(path.join(obsPath, 'config', 'obs-studio'));
      await templateGenerator.generateFromConfig(configManager.config);

      // Step 3: Restart OBS via supervisor
      await supervisor.startOBS();

      // Wait for WebSocket to reconnect and force state update
      setTimeout(() => {
        if (supervisor && mainWindow && !mainWindow.isDestroyed()) {
          const currentState = supervisor.getState();
          mainWindow.webContents.send('status-update', currentState);
        }
      }, 4000); // Give WebSocket time to reconnect

      return { success: true, regenerated: true };
    }

    return { success: true, regenerated: false };
  } catch (error) {
    console.error('Error updating config:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-encoders-cache', async (event, encoders) => {
  try {
    await configManager.saveEncodersCache(encoders);
    return { success: true };
  } catch (error) {
    console.error('Error saving encoders cache:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-display-settings', async (event, display) => {
  try {
    configManager.config.display = display;
    await configManager.save();
    return { success: true };
  } catch (error) {
    console.error('Error saving display settings:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-audio-config', async (event, audioConfig) => {
  try {
    // Update the audio section of the config
    if (configManager.config) {
      configManager.config.audio = {
        ...configManager.config.audio,
        ...audioConfig
      };
      await configManager.save(configManager.config);
    }
    return { success: true };
  } catch (error) {
    console.error('Error saving audio config:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('regenerate-templates', async (event, config) => {
  try {
    console.log('Regenerating OBS templates...');

    // Step 1: Stop OBS via supervisor
    if (supervisor) {
      await supervisor.stopOBS();

      // Wait a bit for OBS to fully shut down
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Step 2: Check if custom OBS files should be used
    const settings = config || configManager.config;
    const useCustomProfile = settings?.settings?.customOBS?.useCustomProfile;
    const useCustomScene = settings?.settings?.customOBS?.useCustomScene;

    const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
    const resourcesBase = path.join(localAppData, 'sc-recorder', 'resources');
    const obsPath = path.join(resourcesBase, 'obs-studio');
    const configPath = path.join(obsPath, 'config', 'obs-studio');

    if (useCustomProfile || useCustomScene) {

      // Copy custom files if enabled
      if (useCustomProfile && settings.settings.customOBS.customProfileFilename) {
        const customProfilePath = path.join(app.getPath('userData'), 'custom-obs-profile.ini');
        const targetProfilePath = path.join(configPath, 'profiles', 'SC Recorder', 'basic.ini');
        if (fs.existsSync(customProfilePath)) {
          fs.copyFileSync(customProfilePath, targetProfilePath);
        }
      }

      if (useCustomScene && settings.settings.customOBS.customSceneFilename) {
        const customScenePath = path.join(app.getPath('userData'), 'custom-obs-scene.json');
        const targetScenePath = path.join(configPath, 'basic', 'scenes', 'SC_Recorder.json');
        if (fs.existsSync(customScenePath)) {
          fs.copyFileSync(customScenePath, targetScenePath);
        }
      }

      // If not both custom, generate the missing one
      if (!useCustomProfile || !useCustomScene) {
        const templateGenerator = new OBSTemplateGenerator(configPath);
        if (!useCustomProfile) {
          // Generate only profile
          await templateGenerator.generateProfile(settings);
        }
        if (!useCustomScene) {
          // Generate only scene
          await templateGenerator.generateSceneCollection(settings);
        }
      }
    } else {
      // Generate templates from the provided config
      const templateGenerator = new OBSTemplateGenerator(configPath);
      const result = await templateGenerator.generateFromConfig(settings);
    }

    // Step 3: Restart OBS via supervisor
    if (supervisor) {
      await supervisor.startOBS();

      // Wait for WebSocket to reconnect and force state update
      setTimeout(() => {
        if (supervisor && mainWindow && !mainWindow.isDestroyed()) {
          const currentState = supervisor.getState();
          mainWindow.webContents.send('status-update', currentState);
        }
      }, 4000);
    }

    return { success: true };
  } catch (error) {
    console.error('Error regenerating templates:', error);

    // Try to restart OBS even if template generation failed
    if (supervisor) {
      try {
        await supervisor.startOBS();

        // Force state update even after error recovery
        setTimeout(() => {
          if (supervisor && mainWindow && !mainWindow.isDestroyed()) {
            const currentState = supervisor.getState();
            mainWindow.webContents.send('status-update', currentState);
          }
        }, 4000);
      } catch (e) {
        console.error('Failed to restart OBS after template error:', e);
      }
    }

    return { success: false, error: error.message };
  }
});

// Custom OBS file handlers
ipcMain.handle('save-custom-obs-profile', async (event, data) => {
  try {
    const customProfilePath = path.join(app.getPath('userData'), 'custom-obs-profile.ini');
    fs.writeFileSync(customProfilePath, data.content, 'utf8');

    // Update config to remember the filename
    if (configManager.config?.settings) {
      if (!configManager.config.settings.customOBS) {
        configManager.config.settings.customOBS = {};
      }
      configManager.config.settings.customOBS.customProfileFilename = data.filename;
      await configManager.save(configManager.config);
    }

    return { success: true };
  } catch (error) {
    console.error('Error saving custom OBS profile:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-custom-obs-scene', async (event, data) => {
  try {
    const customScenePath = path.join(app.getPath('userData'), 'custom-obs-scene.json');
    fs.writeFileSync(customScenePath, data.content, 'utf8');

    // Update config to remember the filename
    if (configManager.config?.settings) {
      if (!configManager.config.settings.customOBS) {
        configManager.config.settings.customOBS = {};
      }
      configManager.config.settings.customOBS.customSceneFilename = data.filename;
      await configManager.save(configManager.config);
    }

    return { success: true };
  } catch (error) {
    console.error('Error saving custom OBS scene:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('clear-custom-obs-files', async () => {
  try {
    const customProfilePath = path.join(app.getPath('userData'), 'custom-obs-profile.ini');
    const customScenePath = path.join(app.getPath('userData'), 'custom-obs-scene.json');

    // Delete files if they exist
    if (fs.existsSync(customProfilePath)) {
      fs.unlinkSync(customProfilePath);
    }
    if (fs.existsSync(customScenePath)) {
      fs.unlinkSync(customScenePath);
    }

    // Clear from config
    if (configManager.config?.settings?.customOBS) {
      configManager.config.settings.customOBS = {
        useCustomProfile: false,
        useCustomScene: false,
        customProfileFilename: null,
        customSceneFilename: null
      };
      await configManager.save(configManager.config);
    }

    return { success: true };
  } catch (error) {
    console.error('Error clearing custom OBS files:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.on('rerun-wizard', () => {
  // Close main window and show setup wizard
  if (mainWindow) {
    mainWindow.close();
  }

  // Clear config to trigger first-run
  configManager.config = null;
  configManager.isFirstRun = true;

  // Show setup wizard
  showSetupWizard();
});

// Helper function to download files
function downloadFile(url, dest, progressCallback) {
  return new Promise((resolve, reject) => {
    const file = require('fs').createWriteStream(dest);

    https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        return downloadFile(response.headers.location, dest, progressCallback)
          .then(resolve)
          .catch(reject);
      }

      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (progressCallback) {
          progressCallback({
            percent: downloadedSize / totalSize,
            downloaded: downloadedSize,
            total: totalSize
          });
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close(resolve);
      });

    }).on('error', (err) => {
      fs.unlink(dest).catch(() => { });
      reject(err);
    });
  });
}

// Handler to open recording folder
ipcMain.handle('open-recording-folder', async () => {
  try {
    const config = await configManager.load();
    const recordingPath = config?.settings?.recording?.outputPath ||
      path.join(process.env.USERPROFILE, 'Videos', 'SC-Recorder');

    // Ensure folder exists
    await fs.mkdir(recordingPath, { recursive: true });

    // Open folder in file explorer
    require('electron').shell.openPath(recordingPath);

    return { success: true, path: recordingPath };
  } catch (error) {
    console.error('Error opening recording folder:', error);
    return { success: false, error: error.message };
  }
});

// Get event capture status
ipcMain.handle('get-event-capture-status', () => {
  if (supervisor && supervisor.eventCapture) {
    return supervisor.eventCapture.getStatus();
  }
  return {
    recordingActive: false,
    eventCount: 0,
    categories: {}
  };
});

// Get captured events
ipcMain.handle('get-captured-events', () => {
  if (supervisor && supervisor.eventCapture) {
    return supervisor.eventCapture.getAllEvents();
  }
  return [];
});

// Save events manually
ipcMain.handle('save-events', async () => {
  if (supervisor && supervisor.eventCapture) {
    const result = await supervisor.eventCapture.saveEvents();
    return result;
  }
  return { success: false, error: 'Event capture not available' };
});

// Show open dialog for file selection
ipcMain.handle('show-open-dialog', async (event, options) => {
  const { dialog } = require('electron');
  return dialog.showOpenDialog(mainWindow, options);
});

// Show save dialog for file selection
ipcMain.handle('show-save-dialog', async (event, options) => {
  const { dialog } = require('electron');
  return dialog.showSaveDialog(mainWindow, options);
});

// Browse for folder selection
ipcMain.handle('browse-folder', async (event, options) => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Select Folder',
    defaultPath: options.defaultPath || '',
    properties: ['openDirectory', 'createDirectory']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return { success: true, path: result.filePaths[0] };
  }
  return { success: false };
});

// Check if file exists
ipcMain.handle('file-exists', async (event, filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
});

// Write file content
ipcMain.handle('write-file', async (event, filePath, content) => {
  try {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(filePath, content, 'utf8');
    return { success: true };
  } catch (error) {
    console.error('Failed to write file:', error);
    return { success: false, error: error.message };
  }
});

// Read file content
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content;
  } catch (error) {
    console.error('Failed to read file:', error);
    throw error;
  }
});

// Save default filter template for recording notifications
ipcMain.handle('save-default-filter', async (event, filterData) => {
  try {
    const config = await configManager.load();
    if (!config.settings) config.settings = {};

    config.settings.defaultNotificationFilter = filterData;

    await configManager.save(config);

    // TODO: Implement notification filter in new supervisor architecture
    // if (supervisor) {
    //   supervisor.setNotificationFilter(filterData.template);
    // }

    return { success: true };
  } catch (error) {
    console.error('Failed to save default filter:', error);
    return { success: false, error: error.message };
  }
});

// Clear default filter
ipcMain.handle('clear-default-filter', async () => {
  try {
    const config = await configManager.load();
    if (config.settings) {
      delete config.settings.defaultNotificationFilter;
      await configManager.save(config);
    }

    // TODO: Implement notification filter in new supervisor architecture
    // if (supervisor) {
    //   supervisor.clearNotificationFilter();
    // }

    return { success: true };
  } catch (error) {
    console.error('Failed to clear default filter:', error);
    return { success: false, error: error.message };
  }
});

// Get event patterns for filter editor
ipcMain.handle('get-event-patterns', async () => {
  try {
    const { getPatternsPath } = require('./lib/config-path-helper');
    const patternsPath = getPatternsPath();
    const content = await fs.readFile(patternsPath, 'utf8');
    const patterns = JSON.parse(content);

    return patterns;
  } catch (error) {
    console.error('Error loading event patterns:', error);
    return null;
  }
});

// Load filter templates from file
ipcMain.handle('load-filter-templates', async () => {
  try {
    const templatesPath = configManager.getFilterTemplatesPath();

    // Check if file exists
    try {
      await fs.access(templatesPath);
    } catch {
      // File doesn't exist, return empty object
      return {};
    }

    const content = await fs.readFile(templatesPath, 'utf8');
    const templates = JSON.parse(content);

    return templates;
  } catch (error) {
    console.error('Error loading filter templates:', error);
    return {};
  }
});

// Save filter templates to file
ipcMain.handle('save-filter-templates', async (event, templates) => {
  try {
    const templatesPath = configManager.getFilterTemplatesPath();

    // Ensure directory exists
    const dir = path.dirname(templatesPath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(templatesPath, JSON.stringify(templates, null, 2));

    return { success: true };
  } catch (error) {
    console.error('Error saving filter templates:', error);
    return { success: false, error: error.message };
  }
});

// Get list of recordings with matching JSON files
ipcMain.handle('get-recordings-list', async (event, folder = 'recordings') => {
  try {
    const config = configManager.get();
    const basePath = config?.settings?.recording?.outputPath || path.join(app.getPath('videos'), 'SC-Recorder');

    // Append the requested folder (recordings, saved, or edited)
    const recordingPath = path.join(basePath, folder);


    // Ensure directory exists
    try {
      await fs.access(recordingPath);
    } catch (error) {
      return [];
    }

    // Get all files in the directory
    const files = await fs.readdir(recordingPath);

    // Filter for video files
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.webm', '.mov'];
    const videoFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return videoExtensions.includes(ext);
    });

    // Build list with metadata
    const recordings = [];
    for (const videoFile of videoFiles) {
      const videoPath = path.join(recordingPath, videoFile);
      const baseName = path.basename(videoFile, path.extname(videoFile));
      const jsonPath = path.join(recordingPath, `${baseName}.json`);

      try {
        // Get video file stats
        const stats = await fs.stat(videoPath);

        // Check for matching JSON file
        let hasEvents = false;
        let eventCount = 0;
        try {
          await fs.access(jsonPath);
          hasEvents = true;

          // Try to read event count
          try {
            const jsonContent = await fs.readFile(jsonPath, 'utf8');
            const eventData = JSON.parse(jsonContent);
            if (Array.isArray(eventData.events)) {
              eventCount = eventData.events.length;
            }
          } catch (e) {
            console.error(`Failed to parse JSON for ${baseName}:`, e);
          }
        } catch {
          // No JSON file
        }

        recordings.push({
          name: videoFile,
          path: videoPath,
          jsonPath: hasEvents ? jsonPath : null,
          hasEvents,
          eventCount,
          size: stats.size,
          modified: stats.mtime,
          created: stats.birthtime || stats.ctime
        });
      } catch (error) {
        console.error(`Failed to get stats for ${videoFile}:`, error);
      }
    }

    // Sort by modified date, newest first
    recordings.sort((a, b) => b.modified - a.modified);

    return recordings;
  } catch (error) {
    console.error('Failed to get recordings list:', error);
    return [];
  }
});
