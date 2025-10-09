/**
 * Hotkey Manager
 * Manages global hotkeys using uiohook-napi for recording control
 */

const { uIOhook, UiohookKey } = require('uiohook-napi');

class HotkeyManager {
  constructor(supervisorGetter, mainWindowGetter) {
    this.getSupervisor = supervisorGetter;
    this.getMainWindow = mainWindowGetter;
    this.registeredHotkeys = {};
    this.currentKeyState = new Set();
    this.uiohookStarted = false;
  }

  /**
   * Map key names to uiohook key codes
   */
  getUiohookKeyCode(keyName) {
    const keyMap = {
      'a': UiohookKey.A, 'b': UiohookKey.B, 'c': UiohookKey.C, 'd': UiohookKey.D,
      'e': UiohookKey.E, 'f': UiohookKey.F, 'g': UiohookKey.G, 'h': UiohookKey.H,
      'i': UiohookKey.I, 'j': UiohookKey.J, 'k': UiohookKey.K, 'l': UiohookKey.L,
      'm': UiohookKey.M, 'n': UiohookKey.N, 'o': UiohookKey.O, 'p': UiohookKey.P,
      'q': UiohookKey.Q, 'r': UiohookKey.R, 's': UiohookKey.S, 't': UiohookKey.T,
      'u': UiohookKey.U, 'v': UiohookKey.V, 'w': UiohookKey.W, 'x': UiohookKey.X,
      'y': UiohookKey.Y, 'z': UiohookKey.Z,
      '0': UiohookKey.Num0, '1': UiohookKey.Num1, '2': UiohookKey.Num2,
      '3': UiohookKey.Num3, '4': UiohookKey.Num4, '5': UiohookKey.Num5,
      '6': UiohookKey.Num6, '7': UiohookKey.Num7, '8': UiohookKey.Num8,
      '9': UiohookKey.Num9,
      'f1': UiohookKey.F1, 'f2': UiohookKey.F2, 'f3': UiohookKey.F3,
      'f4': UiohookKey.F4, 'f5': UiohookKey.F5, 'f6': UiohookKey.F6,
      'f7': UiohookKey.F7, 'f8': UiohookKey.F8, 'f9': UiohookKey.F9,
      'f10': UiohookKey.F10, 'f11': UiohookKey.F11, 'f12': UiohookKey.F12,
      'space': UiohookKey.Space, 'enter': UiohookKey.Enter, 'tab': UiohookKey.Tab,
      'escape': UiohookKey.Escape, 'backspace': UiohookKey.Backspace,
      'delete': UiohookKey.Delete, 'home': UiohookKey.Home, 'end': UiohookKey.End,
      'pageup': UiohookKey.PageUp, 'pagedown': UiohookKey.PageDown,
      'up': UiohookKey.Up, 'down': UiohookKey.Down,
      'left': UiohookKey.Left, 'right': UiohookKey.Right, 'insert': UiohookKey.Insert,
      '\\': UiohookKey.Backslash, 'backslash': UiohookKey.Backslash,
      'capslock': UiohookKey.CapsLock, 'caps': UiohookKey.CapsLock,
      '/': UiohookKey.Slash, 'slash': UiohookKey.Slash,
      '.': UiohookKey.Period, 'period': UiohookKey.Period,
      ',': UiohookKey.Comma, 'comma': UiohookKey.Comma,
      ';': UiohookKey.Semicolon, 'semicolon': UiohookKey.Semicolon,
      "'": UiohookKey.Quote, 'quote': UiohookKey.Quote,
      '[': UiohookKey.BracketLeft, ']': UiohookKey.BracketRight,
      '-': UiohookKey.Minus, 'minus': UiohookKey.Minus,
      '=': UiohookKey.Equal, 'equal': UiohookKey.Equal, 'equals': UiohookKey.Equal,
      '`': UiohookKey.Grave, 'grave': UiohookKey.Grave
    };

    return keyMap[keyName.toLowerCase()] || null;
  }

  /**
   * Convert string hotkey format to uiohook format
   */
  parseHotkey(hotkeyString) {
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
          key = this.getUiohookKeyCode(part);
      }
    }

    return { modifiers, key };
  }

  /**
   * Check if current key state matches a hotkey
   */
  checkHotkey(parsedHotkey, event) {
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

  /**
   * Start uiohook
   */
  startUiohook() {
    if (this.uiohookStarted) return;

    try {
      // Track key states
      uIOhook.on('keydown', (event) => {
        this.currentKeyState.add(event.keycode);

        // Check registered hotkeys
        for (const [action, hotkeyData] of Object.entries(this.registeredHotkeys)) {
          if (this.checkHotkey(hotkeyData.parsed, event)) {
            if (hotkeyData.callback) {
              hotkeyData.callback();
            }
          }
        }
      });

      uIOhook.on('keyup', (event) => {
        this.currentKeyState.delete(event.keycode);
      });

      uIOhook.start();
      this.uiohookStarted = true;
    } catch (error) {
      console.error('Failed to start uIOhook:', error);
    }
  }

  /**
   * Stop uiohook
   */
  stopUiohook() {
    if (!this.uiohookStarted) return;

    try {
      uIOhook.stop();
      this.uiohookStarted = false;
      this.currentKeyState.clear();
    } catch (error) {
      console.error('Failed to stop uIOhook:', error);
    }
  }

  /**
   * Register hotkeys from config
   */
  registerHotkeys(hotkeys) {
    const supervisor = this.getSupervisor();
    const mainWindow = this.getMainWindow();

    // Clear existing hotkeys
    this.registeredHotkeys = {};

    // Start uiohook if not already started
    this.startUiohook();

    // Register new hotkeys
    if (hotkeys?.startStop) {
      const parsed = this.parseHotkey(hotkeys.startStop);
      if (parsed) {
        this.registeredHotkeys.startStop = {
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
      const parsed = this.parseHotkey(hotkeys.split);
      if (parsed) {
        this.registeredHotkeys.split = {
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
      const parsed = this.parseHotkey(hotkeys.markEvent);
      if (parsed) {
        this.registeredHotkeys.markEvent = {
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

    return this.registeredHotkeys;
  }
}

module.exports = HotkeyManager;
